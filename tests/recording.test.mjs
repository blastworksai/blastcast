// CodexBWAI — real disposable disk exercises, including failures and isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRecordingStore, MAX_CHUNK } from '../desktop/recording.cjs';

async function fixture(t, options = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), 'blastcast-record-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const store = createRecordingStore({ folder: () => folder, finalize: async (input, output, io) => {
    const data = await readFile(input); await io.writeFile(output, data, { flag: 'wx' });
  }, ...options });
  return { store, folder };
}
const chunk = () => new Uint8Array([1, 2, 3]).buffer;
test('drains durable chunks, completes and starts another isolated recording', async t => {
  const { store, folder } = await fixture(t);
  const first = await store.begin();
  assert.equal(first.ok, true);
  assert.equal((await store.append(first.id, 0, chunk())).ok, true);
  const done = await store.finish(first.id);
  assert.equal(done.ok, true);
  assert.deepEqual([...await readFile(path.join(folder, done.name))], [1, 2, 3]);
  const second = await store.begin();
  assert.notEqual(second.id, first.id);
  assert.equal((await store.append(first.id, 1, chunk())).ok, false);
  assert.equal((await store.append(second.id, 0, chunk())).ok, true);
  assert.equal((await store.finish(second.id)).ok, true);
});
test('rejects oversized and out-of-order chunks, never presents partial as completed', async t => {
  const { store, folder } = await fixture(t);
  const started = await store.begin();
  assert.equal((await store.append(started.id, 1, chunk())).ok, false);
  assert.equal((await store.append(started.id, 0, new ArrayBuffer(MAX_CHUNK + 1))).ok, false);
  await store.abort(started.id, 'Capture failed');
  assert.equal((await store.finish(started.id)).ok, false);
  assert.equal((await readdir(folder)).some(name => name.endsWith('.webm')), false);
});
test('finalization failure preserves partial, second recording remains available', async t => {
  const { store, folder } = await fixture(t, { finalize: async () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); } });
  const first = await store.begin();
  await store.append(first.id, 0, chunk());
  const done = await store.finish(first.id);
  assert.equal(done.ok, false);
  assert.match(done.message, /space/i);
  assert.equal((await readdir(folder)).filter(name => name.endsWith('.partial')).length, 1);
  assert.equal((await store.begin()).ok, true);
  await store.shutdown();
});
test('empty recordings fail and active recordings cannot be replaced', async t => {
  const { store } = await fixture(t);
  const first = await store.begin();
  assert.equal((await store.begin()).ok, false);
  assert.equal((await store.finish(first.id)).ok, false);
});

for (const code of ['ENOSPC', 'EIO', 'EACCES']) test(`append ${code} is explicit, closes handle and retains partial`, async t => {
  const real = await import('node:fs/promises');
  const io = { ...real, open: async (...args) => {
    const handle = await real.open(...args);
    return { close: () => handle.close(), sync: () => handle.sync(), write: async () => { throw Object.assign(new Error(code), { code }); } };
  } };
  const { store, folder } = await fixture(t, { io });
  const first = await store.begin();
  const result = await store.append(first.id, 0, chunk());
  assert.equal(result.ok, false);
  assert.equal((await store.finish(first.id)).ok, false);
  assert.equal((await readdir(folder)).every(name => name.endsWith('.partial')), true);
});
test('finish waits for in-flight durable append and refuses overlapping calls', async t => {
  const real = await import('node:fs/promises');
  let release; let entered;
  const writing = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const io = { ...real, open: async (...args) => {
    const h = await real.open(...args);
    return { close: () => h.close(), sync: () => h.sync(), write: async (...a) => { entered(); await barrier; return h.write(...a); } };
  } };
  const { store } = await fixture(t, { io });
  const first = await store.begin(); const append = store.append(first.id, 0, chunk());
  await writing;
  assert.equal((await store.append(first.id, 1, chunk())).ok, false);
  const done = store.finish(first.id);
  assert.equal((await store.finish(first.id)).ok, false);
  release(); assert.equal((await append).ok, true); assert.equal((await done).ok, true);
});
test('destination loss before publication retains the source and never offers playback', async t => {
  const real = await import('node:fs/promises');
  const io = { ...real, link: async () => { throw Object.assign(new Error('unmounted'), { code: 'ENOENT' }); } };
  const { store, folder } = await fixture(t, { io });
  const first = await store.begin(); await store.append(first.id, 0, chunk());
  const done = await store.finish(first.id);
  assert.equal(done.ok, false); assert.match(done.message, /unavailable/);
  assert.equal((await store.openLatest()).ok, false);
  assert.equal((await readdir(folder)).some(name => name.endsWith('.partial')), true);
});
test('publication collision never replaces existing user bytes', async t => {
  const real = await import('node:fs/promises');
  const { store, folder } = await fixture(t);
  const first = await store.begin();
  await real.writeFile(path.join(folder, first.name), 'original');
  await store.append(first.id, 0, chunk());
  assert.equal((await store.finish(first.id)).ok, false);
  assert.equal(await readFile(path.join(folder, first.name), 'utf8'), 'original');
  assert.equal((await store.openLatest()).ok, false);
});
for (const stage of ['link', 'unlink']) test(`publication ${stage} failure never reports completion`, async t => {
  const real = await import('node:fs/promises');
  const io = { ...real, [stage]: async () => { throw Object.assign(new Error(stage), { code: stage === 'link' ? 'EOPNOTSUPP' : 'EACCES' }); } };
  const { store, folder } = await fixture(t, { io });
  const first = await store.begin(); await store.append(first.id, 0, chunk());
  const result = await store.finish(first.id);
  assert.equal(result.ok, false);
  if (stage === 'unlink') assert.match(result.message, /finalized file.*cleanup failed/);
  assert.equal((await store.openLatest()).ok, false);
  assert.equal((await readdir(folder)).some(name => name.endsWith('.partial')), true);
});
test('shutdown drains an outstanding write, closes it, and preserves the incomplete source', async t => {
  const { store, folder } = await fixture(t);
  const first = await store.begin(); const pending = store.append(first.id, 0, chunk());
  await store.shutdown(); await pending;
  assert.equal(store.isBusy(), false);
  assert.equal((await store.finish(first.id)).ok, false);
  assert.deepEqual([...await readFile(path.join(folder, first.name + '.partial'))], [1, 2, 3]);
  const second = await store.begin(); assert.equal(second.ok, true); await store.shutdown();
});

test('library metadata failure cannot turn a finalized recording into a failed recording', async t => {
  const {store,folder} = await fixture(t,{onFinalized:()=>{throw new Error('metadata unavailable');}});
  const start=await store.begin(); await store.append(start.id,0,chunk());
  const done=await store.finish(start.id);
  assert.equal(done.ok,true); assert.match(done.warning,/library/);
  assert.deepEqual([...await readFile(path.join(folder,done.name))],[1,2,3]);
});
