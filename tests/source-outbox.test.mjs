// CodexBWAI — sender fault contracts; actual IndexedDB is checked in the browser proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceOutbox, SourceTransportError } from '../dist/source-outbox.js';
const descriptor = {episodeId:'episode',epochId:'epoch',mimeType:'video/webm;codecs=vp8,opus',startedMonoMs:0,hostStartedMs:0,clockUncertaintyMs:0,width:1280,height:720};
const chunk = {episodeId:'episode',epochId:'epoch',sequence:0,byteLength:3,sha256:'a'.repeat(64),startMonoMs:0,endMonoMs:500};
const end = {episodeId:'episode',epochId:'epoch',chunkCount:1,endedMonoMs:500};
class Queue {
  record; chunks = new Map(); removed = false;
  async create(d) { this.record = {descriptor:d,next:0,acked:0,bytes:0,ackedBytes:0,end:null}; }
  async append(c,b) { this.chunks.set(c.sequence,{chunk:c,bytes:b}); this.record.next++;this.record.bytes+=b.byteLength; }
  async peek() { return {record:structuredClone(this.record),item:this.chunks.get(this.record.acked)??null}; }
  async acknowledge(c) { assert.equal(c.sequence,this.record.acked);this.chunks.delete(c.sequence);this.record.acked++;this.record.ackedBytes+=c.byteLength; }
  async seal(e) { this.record.end=e; }
  async complete() { this.removed=true; }
  close() {}
}
const tick = () => new Promise(r=>setTimeout(r,1));
async function until(fn) { for(let i=0;i<200&&!fn();i++)await tick();assert.ok(fn()); }
function fixture(overrides={}) {
 const store=new Queue(),progress=[],failures=[],sleeps=[]; let now=0;
 const transport={begin:async d=>({ok:true,...d}),append:async c=>({ok:true,...c}),finish:async e=>({ok:true,...e,bytes:3,name:'original.webm'}),...overrides};
 const outbox=new SourceOutbox({store,transport,progress:p=>progress.push(p),failed:e=>failures.push(e),now:()=>now,sleep:async ms=>{sleeps.push(ms);now+=ms;}});
 return {outbox,store,progress,failures,sleeps};
}
test('lost durable chunk and final acknowledgements retry exactly; only matching host receipts release bytes',async()=>{
 let appends=0,finishes=0;
 const f=fixture({append:async c=>{if(++appends===1)throw new SourceTransportError('network',true);return {ok:true,...c};},finish:async e=>{if(++finishes===1)throw new SourceTransportError('timeout',true);return {ok:true,...e,bytes:3,name:'saved.webm'};}});
 await f.outbox.open(descriptor);await f.outbox.append(chunk,new Uint8Array([1,2,3]).buffer);
 const ack=await f.outbox.finish(end);
 assert.equal(ack.bytes,3);assert.equal(appends,2);assert.equal(finishes,2);assert.equal(f.store.removed,true);assert.equal(f.progress.at(-1).acknowledgedBytes,3);assert.deepEqual(f.failures,[]);
});
test('mismatched receipt is permanent and preserves pending bytes',async()=>{
 const f=fixture({append:async c=>({ok:true,...c,sha256:'b'.repeat(64)})});
 await f.outbox.open(descriptor);await f.outbox.append(chunk,new ArrayBuffer(3));
 await until(()=>f.failures.length>0);assert.equal(f.store.chunks.size,1);assert.equal(f.store.record.ackedBytes,0);assert.equal(f.store.removed,false);
});
test('permanent rejection does not spin; transient retry delays are capped',async()=>{
 let attempts=0;
 const f=fixture({begin:async()=>{attempts++;if(attempts<=6)throw new SourceTransportError('temporary',true);return {ok:false,message:'closed'};}});
 await f.outbox.open(descriptor);await until(()=>f.failures.length>0);
 assert.equal(attempts,7);assert.equal(Math.max(...f.sleeps),5000);assert.equal(f.store.removed,false);
});
test('serialized uploads reserve pacing before every attempt including lost acknowledgements',async()=>{
 let active=0,max=0;
 const f=fixture({append:async c=>{active++;max=Math.max(max,active);await tick();active--;return {ok:true,...c};},finish:async e=>({ok:true,...e,bytes:131072,name:'saved.webm'})});
 await f.outbox.open(descriptor);
 for(let sequence=0;sequence<2;sequence++)await f.outbox.append({...chunk,sequence,byteLength:65536},new ArrayBuffer(65536));
 await until(()=>f.store.record.acked===2);
 assert.equal(max,1);assert.ok(f.sleeps.some(ms=>ms>=250));
 await f.outbox.finish({...end,chunkCount:2});
});
test('cancellation during request keeps data despite late receipt',async()=>{
 let resolve;
 const f=fixture({append:c=>new Promise(r=>{resolve=()=>r({ok:true,...c});})});
 await f.outbox.open(descriptor);await f.outbox.append(chunk,new ArrayBuffer(3));await until(()=>resolve);
 f.outbox.cancel();resolve();await tick();assert.equal(f.store.chunks.size,1);assert.equal(f.store.record.ackedBytes,0);
});
