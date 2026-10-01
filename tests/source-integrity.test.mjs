// CodexBWAI — regression proof for native storage review findings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createSourceStore } from '../desktop/sources.cjs';
async function setup(t, options = {}) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-integrity-'));
  const store = createSourceStore({ folder: () => folder, ...options });
  t.after(async () => { await store.shutdown({ timeoutMs: 100 }); await fs.rm(folder, { recursive: true, force: true }); });
  const id = randomUUID();
  assert.equal((await store.beginEpisode({ id, participants: [{ id:'host',label:'Host' }] })).ok, true);
  const descriptor = { episodeId:id,epochId:randomUUID(),mimeType:'video/webm;codecs=vp8,opus',startedMonoMs:100,hostStartedMs:50,clockUncertaintyMs:1,width:1280,height:720 };
  return { folder, store, id, descriptor };
}
test('null metadata is rejected without throwing at all untrusted source boundaries', async t => {
  const {store} = await setup(t);
  assert.equal((await store.beginSource('host', null)).ok, false);
  assert.equal((await store.appendSource('host', null, new ArrayBuffer(1))).ok, false);
  assert.equal((await store.finishSource('host', null)).ok, false);
});
test('a failed metadata replacement retains the preceding durable descriptor', async t => {
  let failPublish = false;
  const io = { ...fs,
    link: async (source, target) => { if (failPublish && target.endsWith('metadata.json')) throw new Error('injected publication failure'); return fs.link(source,target); },
    rename: async (source, target) => { if (failPublish && target.endsWith('metadata.json')) throw new Error('injected publication failure'); return fs.rename(source,target); },
  };
  const {store,folder,id,descriptor} = await setup(t,{io});
  const file=path.join(folder,`sources-${id}`,'metadata.json');
  const prior=await fs.readFile(file);
  failPublish=true;
  assert.equal((await store.beginSource('host',descriptor)).ok,false);
  assert.deepEqual(await fs.readFile(file),prior,'durable metadata must survive failed replacement');
  failPublish=false;
});
test('stop cannot claim success after its metadata persistence fails', async t => {
  let fail = false;
  const io = { ...fs, open: async (...args) => { if (fail && String(args[0]).includes('metadata-')) throw new Error('disk unavailable'); return fs.open(...args); } };
  const {store,id} = await setup(t,{io});
  fail=true;
  assert.equal((await store.stopEpisode(id)).ok,false);
  fail=false;
});

function chunk(descriptor, bytes, sequence = 0) {
  return { episodeId:descriptor.episodeId,epochId:descriptor.epochId,sequence,byteLength:bytes.byteLength,
    sha256:createHash('sha256').update(new Uint8Array(bytes)).digest('hex'),startMonoMs:100+sequence,endMonoMs:101+sequence };
}
const finishCopy = async (input,output) => fs.writeFile(output,await fs.readFile(input),{flag:'wx'});
const deferred = () => { let resolve; const promise = new Promise(r=>resolve=r); return {promise,resolve}; };

test('short writes, short journal reads and caller mutation preserve exact durable bytes', async t => {
  const io = { open: async (...args) => {
    const handle=await fs.open(...args);
    return { write:(b,o,n)=>handle.write(b,o,Math.min(n,7)), read:(b,o,n,p)=>handle.read(b,o,Math.min(n,17),p),
      sync:()=>handle.sync(),close:()=>handle.close() };
  } };
  const {store,descriptor,folder,id}=await setup(t,{io,finalize:finishCopy});
  assert.equal((await store.beginSource('host',descriptor)).ok,true);
  const bytes=new TextEncoder().encode('Unmodified participant device data').buffer;
  const original=Buffer.from(new Uint8Array(bytes)),meta=chunk(descriptor,bytes);
  const append=store.appendSource('host',meta,bytes);
  new Uint8Array(bytes).fill(0); meta.sha256='0'.repeat(64);
  assert.equal((await append).ok,true);
  const stable=original.buffer.slice(original.byteOffset,original.byteOffset+original.byteLength),duplicate=chunk(descriptor,stable);
  assert.equal((await store.appendSource('host',duplicate,stable)).ok,true);
  const end={episodeId:id,epochId:descriptor.epochId,chunkCount:1,endedMonoMs:101};
  assert.equal((await store.finishSource('host',end)).ok,true);
  assert.equal((await store.appendSource('host',duplicate,stable)).ok,true,'duplicate receipt survives closed journal handle');
  const source=path.join(folder,`sources-${id}`,`host-${descriptor.epochId}.webm.partial`);
  assert.deepEqual(await fs.readFile(source),original);
});

test('finish reserves its epoch while the final append drains and stays unverified until metadata is durable', async t => {
  const writeEntered=deferred(),writeRelease=deferred(),metadataEntered=deferred(),metadataRelease=deferred();
  t.after(()=>{writeRelease.resolve();metadataRelease.resolve();});
  const io = { open:async (file,...args)=>{
    const handle=await fs.open(file,...args);
    return { write:async (...args)=>{if(file.endsWith('.partial')){writeEntered.resolve();await writeRelease.promise;}return handle.write(...args);},
      sync:()=>handle.sync(),close:()=>handle.close(),read:(...args)=>handle.read(...args) };
  },rename:async (from,to)=>{
    const data=JSON.parse(await fs.readFile(from,'utf8'));
    if(data.sources[0].phase==='complete'){metadataEntered.resolve();await metadataRelease.promise;}
    return fs.rename(from,to);
  } };
  const {store,descriptor,id}=await setup(t,{io,finalize:finishCopy});
  await store.beginSource('host',descriptor);
  const bytes=new Uint8Array([1,2,3]).buffer,meta=chunk(descriptor,bytes);
  const append=store.appendSource('host',meta,bytes);await writeEntered.promise;
  const end={episodeId:id,epochId:descriptor.epochId,chunkCount:1,endedMonoMs:101};
  const finish=store.finishSource('host',end);
  assert.equal(store.finishSource('host',end),finish,'identical finish shares the pending operation');
  writeRelease.resolve();assert.equal((await append).ok,true);
  assert.equal((await store.appendSource('host',chunk(descriptor,bytes,1),bytes)).ok,false);
  await metadataEntered.promise;
  const stop=store.stopEpisode(id);
  assert.equal(store.status().sources[0].phase,'finalizing');
  assert.equal(store.status().allSourcesComplete,false,'metadata has not reached durable publication');
  metadataRelease.resolve();assert.equal((await finish).ok,true);assert.equal((await stop).ok,true);
  assert.equal(store.status().allSourcesComplete,true);
});

test('close waits for in-flight finalization and cannot open a replacement episode early', async t => {
  const entered=deferred(),release=deferred();t.after(()=>release.resolve());
  const {store,descriptor,id}=await setup(t,{finalize:async (...args)=>{entered.resolve();await release.promise;await finishCopy(...args);}});
  await store.beginSource('host',descriptor);
  const bytes=new Uint8Array([1,2,3]).buffer;
  await store.appendSource('host',chunk(descriptor,bytes),bytes);
  const finish=store.finishSource('host',{episodeId:id,epochId:descriptor.epochId,chunkCount:1,endedMonoMs:101});await entered.promise;
  const closing=store.closeEpisode(id);
  assert.equal(store.status().closing,true);
  assert.equal((await store.beginEpisode({id:randomUUID(),participants:[{id:'host',label:'Host'}]})).ok,false);
  release.resolve();assert.equal((await finish).ok,false);assert.equal((await closing).ok,true);
  assert.equal(store.status().closing,false);assert.equal(store.status().allSourcesComplete,false);
  assert.equal(store.status().sources[0].phase,'incomplete');
});

test('shutdown waits for a new episode startup even when the preceding episode already closed', async t => {
  const entered=deferred(),release=deferred();let blockStartup=false;
  t.after(()=>release.resolve());
  const io={mkdir:async (...args)=>{
    if(blockStartup){entered.resolve();await release.promise;}
    return fs.mkdir(...args);
  }};
  const {store,id}=await setup(t,{io});
  assert.equal((await store.closeEpisode(id)).ok,true);
  blockStartup=true;
  const next=store.beginEpisode({id:randomUUID(),participants:[{id:'host',label:'Host'}]});
  await entered.promise;
  const result=await store.shutdown({timeoutMs:10});
  assert.equal(result.ok,false,'a completed prior close cannot stand in for outstanding startup I/O');
  release.resolve();assert.equal((await next).ok,false);
  assert.equal((await store.shutdown()).ok,true);
});
