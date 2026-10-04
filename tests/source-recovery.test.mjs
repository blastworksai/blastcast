// CodexBWAI — restart recovery trusts durable journals and media, never metadata alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createSourceStore } from '../desktop/sources.cjs';

async function fixture(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-recovery-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const episodeId = crypto.randomUUID(), epochId = crypto.randomUUID();
  const bytes = Buffer.from('durable-original-chunk');
  const store = createSourceStore({ folder: () => folder,
    finalize: async (input, output) => fs.copyFile(input, output) });
  assert.equal((await store.beginEpisode({ id:episodeId, participants:[{id:'host',label:'Host'}] })).ok, true);
  const descriptor = { episodeId, epochId, mimeType:'video/webm;codecs=vp8,opus', startedMonoMs:10,
    hostStartedMs:5, clockUncertaintyMs:1, width:1280, height:720 };
  assert.equal((await store.beginSource('host', descriptor)).ok, true);
  const chunk = { episodeId, epochId, sequence:0, byteLength:bytes.length,
    sha256:crypto.createHash('sha256').update(bytes).digest('hex'), startMonoMs:10, endMonoMs:20 };
  assert.equal((await store.appendSource('host', chunk, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))).ok, true);
  return { folder, episodeId, epochId, bytes, descriptor, chunk, store,
    directory:path.join(folder, `sources-${episodeId}`),
    media:path.join(folder, `sources-${episodeId}`, `host-${epochId}.webm.partial`),
    journal:path.join(folder, `sources-${episodeId}`, `host-${epochId}.journal`) };
}

async function digestTree(directory) {
  const result = {};
  for (const name of (await fs.readdir(directory)).sort()) {
    const bytes = await fs.readFile(path.join(directory, name));
    const stat = await fs.stat(path.join(directory, name));
    result[name] = `${stat.size}:${stat.mtimeMs}:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  }
  return result;
}

test('a new store recovers journaled bytes read-only and keeps duplicate semantics', async t => {
  const f = await fixture(t);
  assert.equal((await f.store.interrupt()).ok, true);
  const before = await digestTree(f.directory);
  const recovered = createSourceStore({ folder: () => f.folder });
  assert.deepEqual(await recovered.recover(), { ok:true, recovered:true, episodeId:f.episodeId });
  const state = recovered.status();
  assert.equal(state.recovered, true);
  assert.equal(state.phase, 'stopped');
  assert.equal(state.sources[0].phase, 'incomplete');
  assert.equal(state.sources[0].bytes, f.bytes.length);
  assert.equal(state.sources[0].epochs[0].chunks, 1);
  assert.equal((await recovered.beginSource('host', f.descriptor)).ok, true, 'an exact begin retry is idempotent');
  assert.equal((await recovered.appendSource('host', f.chunk,
    f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength))).ok, true);
  assert.equal((await recovered.appendSource('host', { ...f.chunk, endMonoMs:21 },
    f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength))).ok, false);
  const next = Buffer.from('new');
  assert.equal((await recovered.appendSource('host', { ...f.chunk, sequence:1, byteLength:next.length,
    sha256:crypto.createHash('sha256').update(next).digest('hex'), startMonoMs:20, endMonoMs:21 },
    next.buffer.slice(next.byteOffset,next.byteOffset+next.byteLength))).ok, false, 'recovery is read-only');
  assert.equal((await recovered.finishSource('host', { episodeId:f.episodeId, epochId:f.epochId,
    chunkCount:1, endedMonoMs:20 })).ok, false);
  assert.deepEqual(await digestTree(f.directory), before, 'recovery and retries do not mutate original files');
});

test('tampered media and truncated journals mark the participant damaged without deleting bytes', async t => {
  for (const damage of ['media', 'journal']) {
    const f = await fixture(t);
    assert.equal((await f.store.interrupt()).ok, true);
    if (damage === 'media') await fs.writeFile(f.media, Buffer.from('forged-original-chunk'));
    else await fs.truncate(f.journal, 511);
    const before = await digestTree(f.directory);
    const recovered = createSourceStore({ folder: () => f.folder });
    const result = await recovered.recover();
    assert.equal(result.ok, true, damage);
    const [source] = recovered.status().sources;
    // forged media is damage; a torn lone journal record is only a trimmed tail (metadata never claimed it)
    assert.equal(source.damaged, damage === 'media' ? true : undefined, damage);
    assert.equal(source.phase, 'incomplete');
    assert.equal(source.bytes, 0, 'nothing unverified is claimed');
    assert.deepEqual(await digestTree(f.directory), before);
  }
});

test('unjournaled media tail is retained and reported incomplete from the durable cursor', async t => {
  const f = await fixture(t);
  assert.equal((await f.store.interrupt()).ok, true);
  await fs.appendFile(f.media, 'unacknowledged-tail');
  const before = await fs.readFile(f.media);
  const recovered = createSourceStore({ folder: () => f.folder });
  assert.equal((await recovered.recover()).ok, true);
  const [source] = recovered.status().sources;
  assert.equal(source.phase, 'incomplete');
  assert.equal(source.bytes, f.bytes.length);
  assert.deepEqual(await fs.readFile(f.media), before);
});

test('a missing finalized file downgrades the epoch to incomplete and preserves partial media', async t => {
  const f = await fixture(t);
  assert.equal((await f.store.finishSource('host', { episodeId:f.episodeId, epochId:f.epochId,
    chunkCount:1, endedMonoMs:20 })).ok, true);
  assert.equal((await f.store.stopEpisode(f.episodeId)).ok, true);
  assert.equal((await f.store.interrupt()).ok, true);
  await fs.rm(path.join(f.directory, `${f.epochId}.webm`));
  const recovered = createSourceStore({ folder: () => f.folder });
  assert.equal((await recovered.recover()).ok, true);
  assert.equal(recovered.status().sources[0].phase, 'incomplete');
  assert.deepEqual(await fs.readFile(f.media), f.bytes);
});

test('cleanly closed episodes are historical and hostile metadata cannot grant a path', async t => {
  const closed = await fixture(t);
  assert.equal((await closed.store.closeEpisode(closed.episodeId)).ok, true);
  const empty = createSourceStore({ folder: () => closed.folder });
  assert.deepEqual(await empty.recover(), { ok:true, recovered:false });

  const hostile = await fixture(t);
  assert.equal((await hostile.store.interrupt()).ok, true);
  const metadataPath = path.join(hostile.directory, 'metadata.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  metadata.descriptors[0].participantId = '../outside';
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
  const before = await digestTree(hostile.directory);
  const rejected = createSourceStore({ folder: () => hostile.folder });
  const hostileResult = await rejected.recover();
  assert.equal(hostileResult.ok, true);
  assert.equal(hostileResult.recovered, false);
  assert.deepEqual(hostileResult.damagedEpisodes.map(d => d.directory), [hostile.directory]);
  assert.deepEqual(hostileResult.notices, [`One earlier recording could not be read; its files were left untouched in ${hostile.directory}.`]);
  assert.deepEqual(await digestTree(hostile.directory), before);

  const storage = await fixture(t);
  assert.equal((await storage.store.interrupt()).ok,true);
  const storageMetadataPath=path.join(storage.directory,'metadata.json');
  const storageMetadata=JSON.parse(await fs.readFile(storageMetadataPath,'utf8'));
  storageMetadata.descriptors[0].storageId='../outside';
  await fs.writeFile(storageMetadataPath,JSON.stringify(storageMetadata));
  const storageBefore=await digestTree(storage.directory),storageRejected=createSourceStore({folder:()=>storage.folder});
  const storageResult=await storageRejected.recover();
  assert.equal(storageResult.ok,true);
  assert.equal(storageResult.damagedEpisodes.length,1);
  assert.deepEqual(await digestTree(storage.directory),storageBefore);
});

test('recovery is serialized and retains a persisted participant failure', async t => {
  const f = await fixture(t);
  assert.equal((await f.store.interrupt()).ok,true);
  const metadataPath=path.join(f.directory,'metadata.json');
  const metadata=JSON.parse(await fs.readFile(metadataPath,'utf8'));
  metadata.sources[0].phase='incomplete'; metadata.sources[0].failed=true;
  metadata.sources[0].epochs[0].phase='incomplete';
  await fs.writeFile(metadataPath,JSON.stringify(metadata));
  let entered, release, delayed=false;
  const waiting=new Promise(resolve=>{entered=resolve;});
  const barrier=new Promise(resolve=>{release=resolve;});
  const recovered=createSourceStore({folder:()=>f.folder,io:{readFile:async(file,...args)=>{
    if(!delayed&&file===metadataPath){delayed=true;entered();await barrier;}
    return fs.readFile(file,...args);
  }}});
  const first=recovered.recover(); await waiting;
  assert.equal((await recovered.recover()).ok,false,'a second recovery cannot replace in-flight state');
  assert.equal((await recovered.beginEpisode({id:crypto.randomUUID(),participants:[{id:'host',label:'Host'}]})).ok,false,
    'recording cannot begin before recovery completes');
  release(); assert.equal((await first).ok,true);
  assert.equal(recovered.status().sources[0].failed,true,'durable failure evidence survives restart');
});

// ClaudeBWAI — per-participant crash recovery (einh, 4 Oct 2026).
const guestId = 'abcdefghijklmnopqrstuv';
async function twoParticipants(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-recovery-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const episodeId = crypto.randomUUID();
  const store = createSourceStore({ folder: () => folder, finalize: async (input, output) => fs.copyFile(input, output) });
  assert.equal((await store.beginEpisode({ id:episodeId, participants:[{id:'host',label:'Host'},{id:guestId,label:'Guest'}] })).ok, true);
  const directory = path.join(folder, `sources-${episodeId}`), out = { folder, episodeId, directory, who:{} };
  for (const [id, chunks] of [['host',['aaaa-one','bbbb-two','cccc-three']], [guestId,['guest-one','guest-two']]]) {
    const epochId = crypto.randomUUID();
    const descriptor = { episodeId, epochId, mimeType:'video/webm;codecs=vp8,opus', startedMonoMs:10, hostStartedMs:5, clockUncertaintyMs:1, width:1280, height:720 };
    assert.equal((await store.beginSource(id, descriptor)).ok, true);
    let at = 10; const bufs = chunks.map(c => Buffer.from(c));
    for (const [sequence, bytes] of bufs.entries()) {
      assert.equal((await store.appendSource(id, { episodeId, epochId, sequence, byteLength:bytes.length,
        sha256:crypto.createHash('sha256').update(bytes).digest('hex'), startMonoMs:at, endMonoMs:at+10 },
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))).ok, true);
      at += 10;
    }
    out.who[id] = { epochId, bufs, journal:path.join(directory, `${id}-${epochId}.journal`), media:path.join(directory, `${id}-${epochId}.webm.partial`) };
  }
  assert.equal((await store.interrupt()).ok, true);
  return out;
}
async function treeStats(directory) {
  const result = {};
  for (const name of (await fs.readdir(directory)).sort()) {
    const full = path.join(directory, name), stat = await fs.stat(full);
    result[name] = { size:stat.size, mtimeMs:stat.mtimeMs, sha:crypto.createHash('sha256').update(await fs.readFile(full)).digest('hex') };
  }
  return result;
}
const source = (store, id) => store.status().sources.find(item => item.participantId === id);

test('a torn journal tail is trimmed in memory and every earlier record is recovered', async t => {
  for (const tear of ['partial', 'garbled']) {
    const f = await twoParticipants(t), host = f.who.host;
    if (tear === 'partial') await fs.truncate(host.journal, 512 * 2 + 200);
    else { const fd = await fs.open(host.journal, 'r+'); await fd.write(Buffer.alloc(512, 0x7a), 0, 512, 512 * 2); await fd.close(); }
    const before = await treeStats(f.directory);
    const recovered = createSourceStore({ folder: () => f.folder });
    assert.equal((await recovered.recover()).ok, true, tear);
    const got = source(recovered, 'host');
    assert.equal(got.epochs[0].chunks, 2, tear);
    assert.equal(got.bytes, host.bufs[0].length + host.bufs[1].length, tear);
    assert.equal(got.phase, 'incomplete');
    assert.deepEqual(await treeStats(f.directory), before, 'recovery does not touch any file on disk');
  }
});

test('middle corruption stops that participant at the last good record', async t => {
  const f = await twoParticipants(t), host = f.who.host;
  const fd = await fs.open(host.journal, 'r+'); await fd.write(Buffer.alloc(512, 0x7a), 0, 512, 512); await fd.close();
  const before = await treeStats(f.directory);
  const recovered = createSourceStore({ folder: () => f.folder });
  assert.equal((await recovered.recover()).ok, true);
  const got = source(recovered, 'host');
  assert.equal(got.damaged, true);
  assert.equal(got.epochs[0].chunks, 1);
  assert.equal(got.bytes, host.bufs[0].length);
  assert.deepEqual(await treeStats(f.directory), before);
  // hash mismatch in the middle behaves the same
  const g = await twoParticipants(t);
  const media = await fs.readFile(g.who.host.media); media[g.who.host.bufs[0].length] ^= 0xff; await fs.writeFile(g.who.host.media, media);
  const again = createSourceStore({ folder: () => g.folder });
  assert.equal((await again.recover()).ok, true);
  assert.equal(source(again, 'host').epochs[0].chunks, 1);
  assert.equal(source(again, 'host').damaged, true);
});

test('one damaged participant does not block another', async t => {
  const f = await twoParticipants(t);
  await fs.writeFile(f.who.host.media, Buffer.from('totally forged media'));
  const before = await treeStats(f.directory);
  const recovered = createSourceStore({ folder: () => f.folder });
  assert.deepEqual(await recovered.recover(), { ok:true, recovered:true, episodeId:f.episodeId });
  assert.equal(source(recovered, 'host').damaged, true);
  assert.equal(source(recovered, 'host').bytes, 0);
  const guest = source(recovered, guestId);
  assert.equal(guest.damaged, undefined);
  assert.equal(guest.epochs[0].chunks, 2);
  assert.equal(guest.bytes, f.who[guestId].bufs.reduce((n, b) => n + b.length, 0));
  assert.deepEqual(await treeStats(f.directory), before);
});

test('a participant whose files are missing is damaged while the others recover', async t => {
  const f = await twoParticipants(t);
  await fs.rename(f.who.host.journal, f.who.host.journal + '.moved');
  const recovered = createSourceStore({ folder: () => f.folder });
  assert.equal((await recovered.recover()).ok, true);
  assert.equal(source(recovered, 'host').damaged, true);
  assert.equal(source(recovered, guestId).epochs[0].chunks, 2);
});

test('an unreadable newest episode is noted and the older unclosed one is recovered; recording stays allowed', async t => {
  const older = await fixture(t);
  assert.equal((await older.store.interrupt()).ok, true);
  const old = new Date(Date.now() - 60000);
  await fs.utimes(path.join(older.directory,'metadata.json'),old,old);
  const newer = await fixture(t);
  assert.equal((await newer.store.interrupt()).ok, true);
  // fixture() uses its own temp folder; move the newer episode beside the older one.
  const moved = path.join(older.folder, `sources-${newer.episodeId}`);
  await fs.cp(newer.directory, moved, { recursive:true });
  await fs.writeFile(path.join(moved,'metadata.json'),'{ not json');
  const before = await digestTree(moved);
  const store = createSourceStore({ folder: () => older.folder, finalize: async (i,o) => fs.copyFile(i,o) });
  const result = await store.recover();
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.equal(result.episodeId, older.episodeId);
  assert.deepEqual(result.damagedEpisodes.map(d => d.directory), [moved]);
  assert.deepEqual(await digestTree(moved), before);
  assert.equal((await store.stopEpisode(older.episodeId)).ok, true);
  assert.equal((await store.closeEpisode(older.episodeId)).ok, true);
  assert.equal((await store.beginEpisode({ id:crypto.randomUUID(), participants:[{id:'host',label:'Host'}] })).ok, true);
});

test('recording begins after a damaged episode with nothing else to recover', async t => {
  const f = await fixture(t);
  assert.equal((await f.store.interrupt()).ok, true);
  await fs.writeFile(path.join(f.directory,'metadata.json'),'garbage');
  const store = createSourceStore({ folder: () => f.folder, finalize: async (i,o) => fs.copyFile(i,o) });
  const result = await store.recover();
  assert.equal(result.ok, true);
  assert.equal(result.damagedEpisodes.length, 1);
  assert.equal((await store.beginEpisode({ id:crypto.randomUUID(), participants:[{id:'host',label:'Host'}] })).ok, true);
});

test('an episode-level throw while reconciling is noted as damaged, an older episode is recovered and nothing is written', async t => {
  // MAX_EPISODE cannot be crossed (8 participants x 16 GiB is exactly the limit), so inject the throw where reconcile builds epoch state.
  const older = await fixture(t);
  assert.equal((await older.store.interrupt()).ok, true);
  const old = new Date(Date.now() - 60000);
  await fs.utimes(path.join(older.directory,'metadata.json'),old,old);
  const newer = await fixture(t);
  assert.equal((await newer.store.interrupt()).ok, true);
  const moved = path.join(older.folder, `sources-${newer.episodeId}`);
  await fs.cp(newer.directory, moved, { recursive:true });
  const before = await digestTree(moved), beforeOlder = await digestTree(older.directory);
  const realFromEntries = Object.fromEntries;
  Object.fromEntries = entries => {
    const list = Array.isArray(entries) ? entries : [...entries];
    if (list[0]?.[0] === 'episodeId' && list[0][1] === newer.episodeId) throw new Error('episode state could not be built');
    return realFromEntries(list);
  };
  let result;
  try {
    const store = createSourceStore({ folder: () => older.folder, finalize: async (i,o) => fs.copyFile(i,o) });
    result = await store.recover();
  } finally { Object.fromEntries = realFromEntries; }
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.equal(result.episodeId, older.episodeId);
  assert.deepEqual(result.damagedEpisodes.map(d => d.directory), [moved]);
  assert.deepEqual(await digestTree(moved), before);
  assert.deepEqual(await digestTree(older.directory), beforeOlder);
});
