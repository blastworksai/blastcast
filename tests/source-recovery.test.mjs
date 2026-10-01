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
    result[name] = crypto.createHash('sha256').update(bytes).digest('hex');
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

test('tampered media and truncated journals block recovery without deleting bytes', async t => {
  for (const damage of ['media', 'journal']) {
    const f = await fixture(t);
    assert.equal((await f.store.interrupt()).ok, true);
    if (damage === 'media') await fs.writeFile(f.media, Buffer.from('forged-original-chunk'));
    else await fs.truncate(f.journal, 511);
    const before = await digestTree(f.directory);
    const recovered = createSourceStore({ folder: () => f.folder });
    const result = await recovered.recover();
    assert.equal(result.ok, false, damage);
    assert.equal(result.message, 'Interrupted originals could not be verified. Existing files were left unchanged.');
    assert.equal((await recovered.beginEpisode({ id:crypto.randomUUID(), participants:[{id:'host',label:'Host'}] })).ok, false);
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
  assert.equal((await rejected.recover()).ok, false);
  assert.deepEqual(await digestTree(hostile.directory), before);

  const storage = await fixture(t);
  assert.equal((await storage.store.interrupt()).ok,true);
  const storageMetadataPath=path.join(storage.directory,'metadata.json');
  const storageMetadata=JSON.parse(await fs.readFile(storageMetadataPath,'utf8'));
  storageMetadata.descriptors[0].storageId='../outside';
  await fs.writeFile(storageMetadataPath,JSON.stringify(storageMetadata));
  const storageBefore=await digestTree(storage.directory),storageRejected=createSourceStore({folder:()=>storage.folder});
  assert.equal((await storageRejected.recover()).ok,false);
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
