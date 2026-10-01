// CodexBWAI — recovery export is a bounded snapshot, independent of host reachability.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RECOVERY_MAGIC, writeSourceRecovery } from '../dist/source-recovery.js';

const participantId = '1234567890123456789012';
const recoveryKey = 'A'.repeat(43);
const episodeId = '11111111-1111-4111-8111-111111111111';
const epochId = '22222222-2222-4222-8222-222222222222';
const descriptor = { episodeId,epochId,mimeType:'video/webm;codecs=vp8,opus',startedMonoMs:10,
  hostStartedMs:5,clockUncertaintyMs:1,width:1280,height:720 };
const bytes = new TextEncoder().encode('tail!');
const chunk = { episodeId,epochId,sequence:1,byteLength:bytes.byteLength,
  sha256:createHash('sha256').update(bytes).digest('hex'),startMonoMs:20,endMonoMs:30 };
const record = { descriptor,participantId,recoveryKey,next:2,acked:1,bytes:8,ackedBytes:3,
  end:{episodeId,epochId,chunkCount:2,endedMonoMs:30} };

class Writer {
  writes=[]; closed=false; aborted=false;
  async write(data) { this.writes.push(new Uint8Array(data)); }
  async close() { this.closed=true; }
  async abort() { this.aborted=true; }
  joined() { const size=this.writes.reduce((n,b)=>n+b.length,0), out=new Uint8Array(size); let at=0;
    for(const part of this.writes){out.set(part,at);at+=part.length;} return out; }
}
function queue(records=[record], item={chunk,bytes:bytes.buffer}) {
  return { snapshot: action => action({ records:async()=>structuredClone(records),
    chunk:async(id,sequence)=>id===epochId&&sequence===1?structuredClone(item):null }) };
}
function parse(output) {
  let at=0;
  assert.deepEqual(output.slice(at,at+RECOVERY_MAGIC.length),RECOVERY_MAGIC); at+=RECOVERY_MAGIC.length;
  const view=new DataView(output.buffer,output.byteOffset,output.byteLength);
  const manifestLength=view.getUint32(at,false);at+=4;
  const manifest=JSON.parse(new TextDecoder().decode(output.slice(at,at+manifestLength)));at+=manifestLength;
  const frames=[];
  while(at<output.length){const metaLength=view.getUint32(at,false);at+=4;
    const metadata=JSON.parse(new TextDecoder().decode(output.slice(at,at+metaLength)));at+=metaLength;
    const length=view.getUint32(at,false);at+=4;const data=output.slice(at,at+length);at+=length;frames.push({metadata,data});}
  return {manifest,frames};
}

test('streams exact manifest and retained frames without contacting the host',async()=>{
  const writer=new Writer();
  const result=await writeSourceRecovery(queue(),{participantId,recoveryKey,episodeId},writer);
  assert.deepEqual(result,{epochs:1,chunks:1,bytes:5});assert.equal(writer.closed,true);assert.equal(writer.aborted,false);
  const parsed=parse(writer.joined());
  assert.deepEqual(Object.keys(parsed.manifest),['version','participantId','recoveryKey','episodeId','epochs']);
  assert.equal(parsed.manifest.epochs[0].acked,1);assert.equal(parsed.manifest.epochs[0].retainedBytes,5);
  assert.deepEqual(parsed.frames,[{metadata:chunk,data:bytes}]);
  assert.ok(writer.writes.every(part=>part.byteLength<=1024*1024),'no write accumulates the recovery payload');
});

test('a sealed record with every chunk acknowledged still exports its lost finish receipt',async()=>{
  const sealed={...record,next:1,acked:1,bytes:3,ackedBytes:3,end:{episodeId,epochId,chunkCount:1,endedMonoMs:20}};
  const writer=new Writer(), result=await writeSourceRecovery(queue([sealed],null),{participantId,recoveryKey,episodeId},writer);
  assert.deepEqual(result,{epochs:1,chunks:0,bytes:0});assert.equal(parse(writer.joined()).frames.length,0);
});

test('same-episode records cannot be relabelled across authenticated participants',async()=>{
  const writer=new Writer(), mixed={...record,participantId:'abcdefghijklmnopqrstuv'};
  await assert.rejects(writeSourceRecovery(queue([record,mixed]),{participantId,recoveryKey,episodeId},writer),/do not match/);
  assert.equal(writer.closed,false);assert.equal(writer.aborted,true);
});

test('missing, reordered or tampered retained bytes abort the partial output',async()=>{
  for(const item of [null,{chunk:{...chunk,sequence:2},bytes:bytes.buffer},{chunk,bytes:new TextEncoder().encode('wrong').buffer}]){
    const writer=new Writer();
    await assert.rejects(writeSourceRecovery(queue([record],item),{participantId,recoveryKey,episodeId},writer),/invalid/);
    assert.equal(writer.closed,false);assert.equal(writer.aborted,true);
  }
});
