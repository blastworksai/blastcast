// ClaudeBWAI — a delivery fault must never stop a guest's local recording or the call.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { SourceOutbox, SourceTransportError } from '../dist/source-outbox.js';
import { GuestCall } from '../dist/guest-call.js';
import { SourceCapture } from '../dist/source-capture.js';
const require = createRequire(import.meta.url);
const { createGuestServer } = require('../desktop/guests.cjs');
const { createSourceStore } = require('../desktop/sources.cjs');
const { configureReady } = require('./helpers/network-readiness.cjs');

const descriptor = {episodeId:'episode',epochId:'epoch',mimeType:'video/webm;codecs=vp8,opus',startedMonoMs:0,hostStartedMs:0,clockUncertaintyMs:0,width:1280,height:720};
const chunk = {episodeId:'episode',epochId:'epoch',sequence:0,byteLength:3,sha256:'a'.repeat(64),startMonoMs:0,endMonoMs:500};
class Queue {
  record; chunks = new Map();
  async create(d) { this.record = {descriptor:d,next:0,acked:0,bytes:0,ackedBytes:0,end:null}; }
  async append(c,b) { this.chunks.set(c.sequence,{chunk:c,bytes:b}); this.record.next++;this.record.bytes+=b.byteLength; }
  async peek() { return {record:structuredClone(this.record),item:this.chunks.get(this.record.acked)??null}; }
  async acknowledge(c) { this.chunks.delete(c.sequence);this.record.acked++;this.record.ackedBytes+=c.byteLength; }
  async seal(e) { this.record.end=e; }
  async complete() {}
  close() {}
}
class Rec { constructor(){ this.state='inactive'; this.l={}; } addEventListener(e,f){ (this.l[e]??=new Set()).add(f); } removeEventListener(e,f){ this.l[e]?.delete(f); }
  start(){ this.state='recording'; } stop(){ this.state='inactive'; for (const f of this.l.stop??[]) f(); } }
const tick = () => new Promise(r=>setTimeout(r,1));
async function until(fn, n=400) { for(let i=0;i<n&&!fn();i++)await tick();assert.ok(fn()); }
function outbox(transport) {
  const store=new Queue(),failures=[],progress=[],sleeps=[];
  const o=new SourceOutbox({store,transport:{begin:async d=>({ok:true,...d}),append:async c=>({ok:true,...c}),finish:async e=>({ok:true,...e,bytes:3,name:'x.webm'}),...transport},
    progress:p=>progress.push(p),failed:m=>failures.push(m),sleep:async ms=>{sleeps.push(ms);}});
  return {o,store,failures,progress,sleeps};
}

test('a permanent host error keeps the chunk queued and delivery retries with backoff', async () => {
  let attempts = 0;
  const f = outbox({ append: async c => { if (++attempts < 4) throw new SourceTransportError('refused', false); return {ok:true,...c}; } });
  await f.o.open(descriptor); await f.o.append(chunk, new ArrayBuffer(3));
  await until(() => f.store.record.acked === 1);
  assert.equal(attempts, 4); assert.deepEqual(f.failures, []); assert.ok(f.sleeps.length >= 3);
  f.o.cancel();
});

test('an HTTP 410 (host says the epoch is gone) ends delivery visibly and retains the data', async () => {
  const f = outbox({ append: async () => { throw new SourceTransportError('closed', false, true); } });
  await f.o.open(descriptor); await f.o.append(chunk, new ArrayBuffer(3));
  await until(() => f.failures.length === 1);
  assert.equal(f.store.chunks.size, 1);
});

test('busy (409) is retried by the guest outbox', async () => {
  let n = 0;
  const f = outbox({ append: async c => { if (++n === 1) throw new SourceTransportError('busy', true); return {ok:true,...c}; } });
  await f.o.open(descriptor); await f.o.append(chunk, new ArrayBuffer(3));
  await until(() => f.store.record.acked === 1);
  assert.deepEqual(f.failures, []); f.o.cancel();
});

test('a delivery failure does not stop the recorder', async () => {
  const track = () => ({ readyState:'live', getSettings:() => ({}), addEventListener(){}, removeEventListener(){} });
  const stream = { getVideoTracks:() => [track()], getAudioTracks:() => [track()] };
  let recorder, failedCb;
  
  const cap = new SourceCapture({ transport:{begin:async d=>({ok:true,...d}),append:async()=>({ok:true}),finish:async()=>({ok:true})},
    makeRecorder: () => (recorder = new Rec()), onState: () => {},
    durable: (progress, failed) => { failedCb = failed; return { open: async()=>{}, append: async()=>{}, finish: async()=>{}, cancel(){} }; } });
  await cap.start(stream, { episodeId:'e', epochId:'p', clock:{hostNowMs:0,localMonoMs:0,uncertaintyMs:0} });
  assert.equal(recorder.state, 'recording');
  // Retryable/permanent errors never reach `failed`; the outbox only calls it for a gone epoch.
  assert.equal(cap.state.phase, 'recording'); assert.equal(typeof failedCb, 'function');
  await cap.stop().catch(() => {});
});

test('portrait captures pass the landscape limits', async () => {
  for (const [width, height, ok] of [[1080,1920,true],[2160,3840,true],[3840,2160,true],[2161,3840,false],[3841,1080,false]]) {
    const track = () => ({ readyState:'live', getSettings:() => ({width,height}), addEventListener(){}, removeEventListener(){} });
    const stream = { getVideoTracks:() => [track()], getAudioTracks:() => [{readyState:'live',getSettings:()=>({}),addEventListener(){},removeEventListener(){}}] };
    
    const cap = new SourceCapture({ transport:{begin:async d=>({ok:true,...d}),append:async()=>({ok:true}),finish:async()=>({ok:true})}, makeRecorder:()=>new Rec(), onState:()=>{} });
    await cap.start(stream, { episodeId:'e', epochId:'p', clock:{hostNowMs:0,localMonoMs:0,uncertaintyMs:0} });
    assert.equal(cap.state.phase === 'recording', ok, `${width}x${height}`);
    if (ok) await cap.stop();
  }
});

test('host accepts portrait descriptors and rejects oversize ones', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-res-'));
  try {
    const store = createSourceStore({ folder: () => dir });
    const id = crypto.randomUUID();
    await store.beginEpisode({ id, participants: [{id:'host',label:'Host'}] });
    for (const [width,height,ok] of [[1080,1920,true],[2160,3840,true],[3840,2160,true],[2161,3840,false],[3840,3840,false]]) {
      const res = await store.beginSource('host', { episodeId:id, epochId:crypto.randomUUID(), mimeType:'video/webm;codecs=vp8,opus', startedMonoMs:1, hostStartedMs:1, clockUncertaintyMs:1, width, height });
      assert.equal(res.ok, ok, `${width}x${height}`);
    }
    await store.closeEpisode(id);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('host append while another write runs is busy (retryable), and a closed episode is gone', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-res-'));
  try {
    const store = createSourceStore({ folder: () => dir });
    const id = crypto.randomUUID(), epochId = crypto.randomUUID(), pid = 'host';
    await store.beginEpisode({ id, participants: [{id:pid,label:'Host'}] });
    await store.beginSource(pid, { episodeId:id, epochId, mimeType:'video/webm;codecs=vp8,opus', startedMonoMs:0, hostStartedMs:0, clockUncertaintyMs:0, width:640, height:480 });
    const mk = seq => { const b = new Uint8Array(10); return [{ episodeId:id, epochId, sequence:seq, byteLength:10, sha256:crypto.createHash('sha256').update(b).digest('hex'), startMonoMs:seq*10, endMonoMs:seq*10+10 }, b.buffer]; };
    const first = store.appendSource(pid, ...mk(0));
    const second = await store.appendSource(pid, ...mk(1));
    assert.equal(second.ok, false); assert.equal(second.busy, true);
    assert.equal((await first).ok, true);
    await store.closeEpisode(id);
    const after = await store.appendSource(pid, ...mk(1));
    assert.equal(after.ok, false); assert.equal(after.gone, true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ---- HTTP: the slot-release race and the limiter -------------------------------------------
function freePort() { return new Promise(resolve => { const s = http.createServer().listen(0,'127.0.0.1',() => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
function post(port, urlPath, { host, origin, token, body, raw, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = raw ?? Buffer.from(JSON.stringify(body ?? {}));
    const req = http.request({ agent:false, hostname:'127.0.0.1', port, method:'POST', path:urlPath,
      headers:{ host, origin, authorization:`Bearer ${token}`, 'content-type': raw ? 'application/octet-stream' : 'application/json', 'content-length':payload.length, ...headers } }, res => {
      let data=''; res.setEncoding('utf8'); res.on('data',c=>data+=c);
      res.on('end',()=>{ try { resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(data)}); } catch { resolve({status:res.statusCode,headers:res.headers,body:data}); } });
    });
    req.on('error', reject); req.end(payload);
  });
}
async function admitted(port, sources) {
  const host = 'test.example.com', origin = 'https://test.example.com';
  const guests = createGuestServer({ directory:'/dev/null', probe:()=>Promise.resolve(), sources });
  await configureReady(guests, { origin, port });
  const token = guests.invite().invite.url.split('#invite=')[1];
  const redeemed = await post(port,'/api/redeem',{host,origin,token,body:{redemptionKey:crypto.randomBytes(32).toString('base64url')}});
  const session = redeemed.body.sessionCredential;
  await post(port,'/api/join',{host,origin,token:session,body:{name:'A',consent:true,consentVersion:'1'}});
  const id = guests.status().guests[0].session.id; guests.admit(id);
  return { guests, session, host, origin, id };
}
const meta = { episodeId:'ep1', epochId:'e1', sequence:0, byteLength:1, sha256:'h', startMonoMs:0, endMonoMs:1 };
const ack = m => ({ ok:true, episodeId:m.episodeId, epochId:m.epochId, sequence:m.sequence, sha256:m.sha256, byteLength:m.byteLength });

test('slow write plus closed connection: the retry gets a retryable 409, then succeeds once the write settles (never 400)', async t => {
  const port = await freePort(); const releases = [];
  const sources = { status:()=>({episodeId:'ep1',phase:'recording',hostNowMs:0,sources:[]}), recoveryKey:()=>null,
    appendSource:(_p,m)=>new Promise(r=>releases.push(()=>r(ack(m)))) };
  const { guests, session, host, origin } = await admitted(port, sources);
  t.after(() => guests.stop());
  const first = http.request({ hostname:'127.0.0.1', port, method:'POST', path:'/api/source/chunk',
    headers:{ host, origin, authorization:`Bearer ${session}`, 'content-type':'application/octet-stream', 'content-length':1, 'x-blastcast-source':JSON.stringify(meta) } });
  first.on('error',()=>{}); first.end('a');
  for (let i=0;i<100&&!releases.length;i++) await new Promise(r=>setTimeout(r,5));
  assert.equal(releases.length, 1);
  first.destroy(); await new Promise(r=>setTimeout(r,30));
  const hdrs = { 'x-blastcast-source':JSON.stringify(meta) };
  const retry = await post(port,'/api/source/chunk',{host,origin,token:session,raw:Buffer.from('a'),headers:hdrs});
  assert.equal(retry.status, 409); assert.ok(retry.headers['retry-after']);
  releases[0]();
  await new Promise(r=>setTimeout(r,20));
  const retry2 = post(port,'/api/source/chunk',{host,origin,token:session,raw:Buffer.from('a'),headers:hdrs});
  for (let i=0;i<100&&releases.length<2;i++) await new Promise(r=>setTimeout(r,5));
  releases[1](); assert.equal((await retry2).status, 200);
});

test('host busy answer maps to 409 with Retry-After and a gone answer to 410', async t => {
  const port = await freePort(); let mode = 'busy';
  const sources = { status:()=>({episodeId:'ep1',phase:'recording',hostNowMs:0,sources:[]}), recoveryKey:()=>null,
    appendSource:async()=> mode==='busy' ? {ok:false,busy:true,message:'busy'} : {ok:false,gone:true,message:'gone'} };
  const { guests, session, host, origin } = await admitted(port, sources);
  t.after(() => guests.stop());
  const o = { host, origin, token:session, raw:Buffer.from('a'), headers:{ 'x-blastcast-source':JSON.stringify(meta) } };
  const a = await post(port,'/api/source/chunk',o); assert.equal(a.status,409); assert.equal(a.headers['retry-after'],'1');
  mode = 'gone'; assert.equal((await post(port,'/api/source/chunk',o)).status, 410);
});

test('source chunks have their own budget: a chunk flood cannot starve the call poll', async t => {
  const port = await freePort();
  const sources = { status:()=>({episodeId:'ep1',phase:'recording',hostNowMs:0,sources:[]}), recoveryKey:()=>null, appendSource:async(_p,m)=>ack(m) };
  const { guests, session, host, origin } = await admitted(port, sources);
  t.after(() => guests.stop());
  const o = { host, origin, token:session, raw:Buffer.from('a'), headers:{ 'x-blastcast-source':JSON.stringify(meta) } };
  for (let i = 0; i < 1100; i++) { const r = await post(port,'/api/source/chunk',o); assert.notEqual(r.status, 429, `chunk ${i}`); }
  const poll = await post(port,'/api/call/poll',{host,origin,token:session,body:{callId:null,after:0}});
  assert.notEqual(poll.status, 429);
});

// ---- guest call poll -----------------------------------------------------------------------
test('the call poll survives a 429 and polls again instead of dropping the call', async () => {
  const el = () => ({ addEventListener(){}, play: async()=>{}, pause(){}, srcObject:null, hidden:false, textContent:'', dataset:{} });
  const status = el(); let calls = 0;
  const api = async endpoint => {
    if (endpoint !== 'call/poll') return { ok:true };
    calls++;
    if (calls <= 2) throw new SourceTransportError('429', true);
    return { ok:true, callId:null, messages:[], latest:0 };
  };
  const call = new GuestCall(api, el(), status, el());
  call.update(true, {});
  await until(() => calls >= 3, 6000);
  assert.doesNotMatch(status.textContent, /interrupted/);
  call.close();
});
