// CodexBWAI — offline guest import extends only a derived copy of host-proven bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSourceStore } from '../desktop/sources.cjs';
import { writeSourceRecovery } from '../dist/source-recovery.js';

const guestId='1234567890123456789012';
const descriptor=(episodeId,epochId)=>({episodeId,epochId,mimeType:'video/webm;codecs=vp8,opus',startedMonoMs:10,
  hostStartedMs:5,clockUncertaintyMs:1,width:1280,height:720});
const metadata=(d,sequence,data,start,end)=>({episodeId:d.episodeId,epochId:d.epochId,sequence,byteLength:data.length,
  sha256:crypto.createHash('sha256').update(data).digest('hex'),startMonoMs:start,endMonoMs:end});
async function temporary(t){const folder=await fs.mkdtemp(path.join(os.tmpdir(),'blastcast-import-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));return folder;}
async function hashes(directory){const result={};for(const name of (await fs.readdir(directory)).sort()){
  const data=await fs.readFile(path.join(directory,name));result[name]=crypto.createHash('sha256').update(data).digest('hex');}return result;}
async function bundle(file,identity,record,items){const writes=[];const writer={write:async data=>writes.push(Buffer.from(data)),close:async()=>{},abort:async()=>{}};
  const queue={snapshot:action=>action({records:async()=>[record],chunk:async(_id,sequence)=>items.get(sequence)??null})};
  await writeSourceRecovery(queue,identity,writer);await fs.writeFile(file,Buffer.concat(writes));}
const finalize=async(input,output)=>{await fs.copyFile(input,output);return{durationSeconds:1,clusters:1,cues:1,copyBufferBytes:1024};};

function shortReadIo(limit=3){
  let enabled=false;
  return {enable(){enabled=true;},io:{open:async(file,flags,...args)=>{
    const handle=await fs.open(file,flags,...args);
    if(!enabled||flags!=='r')return handle;
    return {stat:(...values)=>handle.stat(...values),close:(...values)=>handle.close(...values),
      read:(buffer,offset,length,position)=>handle.read(buffer,offset,Math.min(length,limit),position)};
  }}};
}

async function seeded(t,{withPrefix=true,io=fs}={}){
  const folder=await temporary(t),episodeId=crypto.randomUUID(),epochId=crypto.randomUUID();
  const store=createSourceStore({folder:()=>folder,io,finalize});
  assert.equal((await store.beginEpisode({id:episodeId,participants:[{id:'host',label:'Host'},{id:guestId,label:'Alice'}]})).ok,true);
  const recoveryKey=store.recoveryKey(guestId);assert.match(recoveryKey,/^[A-Za-z0-9_-]{43}$/);
  const d=descriptor(episodeId,epochId),prefix=Buffer.from('host-prefix'),tail=Buffer.from('guest-tail');
  if(withPrefix){assert.equal((await store.beginSource(guestId,d)).ok,true);const c0=metadata(d,0,prefix,10,20);
    assert.equal((await store.appendSource(guestId,c0,prefix.buffer.slice(prefix.byteOffset,prefix.byteOffset+prefix.byteLength))).ok,true);}
  assert.equal((await store.stopEpisode(episodeId)).ok,true);
  return{folder,episodeId,epochId,store,recoveryKey,d,prefix,tail};
}

test('imports a lost-ack suffix into derived files, preserves originals, restarts and repeats idempotently',async t=>{
  const f=await seeded(t),directory=path.join(f.folder,`sources-${f.episodeId}`),file=path.join(f.folder,'guest.bcr');
  const c0=metadata(f.d,0,f.prefix,10,20),c1=metadata(f.d,1,f.tail,20,30);
  await bundle(file,{participantId:guestId,recoveryKey:f.recoveryKey,episodeId:f.episodeId},
    {descriptor:f.d,participantId:guestId,recoveryKey:f.recoveryKey,next:2,acked:0,bytes:f.prefix.length+f.tail.length,ackedBytes:0,
      end:{episodeId:f.episodeId,epochId:f.epochId,chunkCount:2,endedMonoMs:30}},
    new Map([[0,{chunk:c0,bytes:f.prefix.buffer.slice(f.prefix.byteOffset,f.prefix.byteOffset+f.prefix.byteLength)}],
      [1,{chunk:c1,bytes:f.tail.buffer.slice(f.tail.byteOffset,f.tail.byteOffset+f.tail.byteLength)}]]));
  const originals=(await fs.readdir(directory)).filter(name=>name!=='metadata.json');const before={};
  for(const name of originals)before[name]=crypto.createHash('sha256').update(await fs.readFile(path.join(directory,name))).digest('hex');
  const bundleHash=crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const imported=await f.store.importRecovery(file);assert.equal(imported.ok,true);assert.equal(imported.complete,true);assert.equal(imported.unchanged,false);
  assert.equal((await f.store.status()).sources.find(source=>source.participantId===guestId).phase,'complete');
  for(const [name,digest] of Object.entries(before))assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(directory,name))).digest('hex'),digest,name);
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'),bundleHash);
  const saved=JSON.parse(await fs.readFile(path.join(directory,'metadata.json'),'utf8'));
  assert.equal(saved.version,2);const importedDescriptor=saved.descriptors.find(item=>item.epochId===f.epochId);assert.match(importedDescriptor.storageId,/^[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(saved).includes(f.recoveryKey),false,'metadata stores only the recovery capability hash');
  assert.match(saved.participants.find(item=>item.id===guestId).recoveryHash,/^[0-9a-f]{64}$/);
  assert.equal(await fs.readFile(path.join(directory,`${f.epochId}.webm`),'utf8'),'host-prefixguest-tail');
  assert.equal((await f.store.importRecovery(file)).unchanged,true);
  await f.store.interrupt();const restarted=createSourceStore({folder:()=>f.folder,finalize});assert.equal((await restarted.recover()).ok,true);
  const recovered=restarted.status().sources.find(source=>source.participantId===guestId);assert.equal(recovered.phase,'complete');assert.equal(recovered.bytes,f.prefix.length+f.tail.length);
  assert.equal(restarted.recoveryKey(guestId),null,'plaintext capability is not recovered from disk');
  await restarted.interrupt();
});

test('continues valid import when filesystem reads return short progress',async t=>{
  const short=shortReadIo(),f=await seeded(t,{io:short.io}),file=path.join(f.folder,'guest.bcr');
  const c0=metadata(f.d,0,f.prefix,10,20),c1=metadata(f.d,1,f.tail,20,30);
  await bundle(file,{participantId:guestId,recoveryKey:f.recoveryKey,episodeId:f.episodeId},
    {descriptor:f.d,participantId:guestId,recoveryKey:f.recoveryKey,next:2,acked:0,bytes:f.prefix.length+f.tail.length,ackedBytes:0,
      end:{episodeId:f.episodeId,epochId:f.epochId,chunkCount:2,endedMonoMs:30}},
    new Map([[0,{chunk:c0,bytes:f.prefix.buffer.slice(f.prefix.byteOffset,f.prefix.byteOffset+f.prefix.byteLength)}],
      [1,{chunk:c1,bytes:f.tail.buffer.slice(f.tail.byteOffset,f.tail.byteOffset+f.tail.byteLength)}]]));
  short.enable();
  const result=await f.store.importRecovery(file);assert.equal(result.ok,true);
  assert.equal(await fs.readFile(path.join(f.folder,`sources-${f.episodeId}`,`${f.epochId}.webm`),'utf8'),'host-prefixguest-tail');
  await f.store.interrupt();
});

test('admits an epoch the host never began and keeps an unsealed import incomplete',async t=>{
  const f=await seeded(t,{withPrefix:false}),file=path.join(f.folder,'guest.bcr'),chunk=metadata(f.d,0,f.tail,10,20);
  await bundle(file,{participantId:guestId,recoveryKey:f.recoveryKey,episodeId:f.episodeId},
    {descriptor:f.d,participantId:guestId,recoveryKey:f.recoveryKey,next:1,acked:0,bytes:f.tail.length,ackedBytes:0,end:null},
    new Map([[0,{chunk,bytes:f.tail.buffer.slice(f.tail.byteOffset,f.tail.byteOffset+f.tail.byteLength)}]]));
  const result=await f.store.importRecovery(file);assert.equal(result.ok,true);assert.equal(result.complete,false);
  const source=f.store.status().sources.find(item=>item.participantId===guestId);assert.equal(source.phase,'incomplete');assert.equal(source.bytes,f.tail.length);
  await f.store.interrupt();
});

test('rejects wrong capability, tampered bytes, truncation and trailing data without changing prior files',async t=>{
  const f=await seeded(t),directory=path.join(f.folder,`sources-${f.episodeId}`),valid=path.join(f.folder,'valid.bcr');
  const c0=metadata(f.d,0,f.prefix,10,20),c1=metadata(f.d,1,f.tail,20,30),identity={participantId:guestId,recoveryKey:f.recoveryKey,episodeId:f.episodeId};
  await bundle(valid,identity,{descriptor:f.d,participantId:guestId,recoveryKey:f.recoveryKey,next:2,acked:0,bytes:f.prefix.length+f.tail.length,ackedBytes:0,
    end:{episodeId:f.episodeId,epochId:f.epochId,chunkCount:2,endedMonoMs:30}},new Map([[0,{chunk:c0,bytes:f.prefix.buffer.slice(f.prefix.byteOffset,f.prefix.byteOffset+f.prefix.byteLength)}],[1,{chunk:c1,bytes:f.tail.buffer.slice(f.tail.byteOffset,f.tail.byteOffset+f.tail.byteLength)}]]));
  const wrong=path.join(f.folder,'wrong.bcr');await bundle(wrong,{...identity,recoveryKey:'B'.repeat(43)},
    {descriptor:f.d,participantId:guestId,recoveryKey:'B'.repeat(43),next:1,acked:0,bytes:f.prefix.length,ackedBytes:0,end:null},new Map([[0,{chunk:c0,bytes:f.prefix.buffer.slice(f.prefix.byteOffset,f.prefix.byteOffset+f.prefix.byteLength)}]]));
  const bytes=await fs.readFile(valid),cases=[[wrong,null],[path.join(f.folder,'truncated.bcr'),bytes.subarray(0,bytes.length-1)],
    [path.join(f.folder,'trailing.bcr'),Buffer.concat([bytes,Buffer.from([0])])],[path.join(f.folder,'tampered.bcr'),Buffer.from(bytes)]];
  cases[3][1][cases[3][1].length-1]^=1;for(const [name,data] of cases)if(data)await fs.writeFile(name,data);
  const before=await hashes(directory);
  for(const [name] of cases){const result=await f.store.importRecovery(name);assert.equal(result.ok,false,name);assert.deepEqual(await hashes(directory),before,name);}
  await f.store.interrupt();
});

test('version-one restart data stays recoverable but cannot authenticate an offline guest import',async t=>{
  const f=await seeded(t),file=path.join(f.folder,'guest.bcr'),chunk=metadata(f.d,0,f.prefix,10,20);
  await bundle(file,{participantId:guestId,recoveryKey:f.recoveryKey,episodeId:f.episodeId},
    {descriptor:f.d,participantId:guestId,recoveryKey:f.recoveryKey,next:1,acked:0,bytes:f.prefix.length,ackedBytes:0,
      end:{episodeId:f.episodeId,epochId:f.epochId,chunkCount:1,endedMonoMs:20}},
    new Map([[0,{chunk,bytes:f.prefix.buffer.slice(f.prefix.byteOffset,f.prefix.byteOffset+f.prefix.byteLength)}]]));
  await f.store.interrupt();const metadataFile=path.join(f.folder,`sources-${f.episodeId}`,'metadata.json');
  const old=JSON.parse(await fs.readFile(metadataFile,'utf8'));old.version=1;
  for(const participant of old.participants)delete participant.recoveryHash;for(const item of old.descriptors)delete item.storageId;
  await fs.writeFile(metadataFile,JSON.stringify(old));
  const restarted=createSourceStore({folder:()=>f.folder,finalize});assert.equal((await restarted.recover()).ok,true);
  assert.equal((await restarted.importRecovery(file)).ok,false);await restarted.interrupt();
});
