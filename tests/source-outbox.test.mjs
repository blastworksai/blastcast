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
test('mismatched receipt keeps pending bytes and keeps retrying; the recording is never stopped',async()=>{
 let attempts=0;
 const f=fixture({append:async c=>++attempts<3?{ok:true,...c,sha256:'b'.repeat(64)}:{ok:true,...c}});
 await f.outbox.open(descriptor);await f.outbox.append(chunk,new ArrayBuffer(3));
 await until(()=>f.store.record.acked===1);assert.ok(attempts>=3);assert.deepEqual(f.failures,[]);f.outbox.cancel();
});
test('host rejection does not stop delivery or spin; transient retry delays are capped',async()=>{
 let attempts=0;
 const f=fixture({begin:async d=>{attempts++;if(attempts<=6)throw new SourceTransportError('temporary',true);if(attempts===7)return {ok:false,message:'closed'};return {ok:true,...d};}});
 await f.outbox.open(descriptor);await until(()=>attempts>=8);
 assert.equal(Math.max(...f.sleeps.slice(0,6)),5000);assert.deepEqual(f.failures,[]);assert.equal(f.store.removed,false);f.outbox.cancel();
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

// Minimal in-memory IndexedDB stand-in: an explicit tx.abort() fires onabort with tx.error left null, as the real one does.
function fakeIndexedDB() {
  const data = { records: new Map(), chunks: new Map(), budget: new Map() };
  const key = k => JSON.stringify(k);
  const db = { createObjectStore() {}, close() {}, transaction() {
    const tx = { error: null, aborted: false, pending: 0 };
    const settle = () => setTimeout(() => { if (!tx.aborted && tx.pending === 0 && !tx.done) { tx.done = true; tx.oncomplete?.(); } }, 0);
    const req = fn => { const r = {}; tx.pending++; setTimeout(() => { if (!tx.aborted) { r.result = fn(); r.onsuccess?.(); } tx.pending--; settle(); }, 0); return r; };
    tx.objectStore = name => { const m = data[name]; return {
      get: k => req(() => m.get(key(k))), count: () => req(() => m.size),
      add: (v, k) => req(() => { m.set(key(k), v); }), put: (v, k) => req(() => { m.set(key(k), v); }), delete: k => req(() => { m.delete(key(k)); }),
      getAll: () => req(() => [...m.values()]) }; };
    tx.abort = () => { tx.aborted = true; tx.done = true; setTimeout(() => tx.onabort?.(), 0); };
    settle();
    return tx;
  } };
  return { open() { const r = {}; setTimeout(() => { r.result = db; r.onupgradeneeded?.(); r.onsuccess?.(); }, 0); return r; } };
}
test('an explicit storage refusal names its own reason, not the generic failure', async () => {
  const { IndexedSourceQueue } = await import('../dist/source-outbox.js');
  const saved = { idb: globalThis.indexedDB, nav: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
  globalThis.indexedDB = fakeIndexedDB();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: (_n, _o, fn) => fn() } } });
  try {
    const queue = new IndexedSourceQueue('t', 4);
    await queue.create(descriptor);
    await assert.rejects(queue.append({ ...chunk, byteLength: 8 }, new ArrayBuffer(8)), /4-byte budget/);
    await assert.rejects(queue.append({ ...chunk, sequence: 3, byteLength: 2 }, new ArrayBuffer(2)), /out of order/);
    await queue.close();
  } finally {
    globalThis.indexedDB = saved.idb;
    if (saved.nav) Object.defineProperty(globalThis, 'navigator', saved.nav); else delete globalThis.navigator;
  }
});
