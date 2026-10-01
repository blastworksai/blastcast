import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceCapture } from '../dist/source-capture.js';
import crypto from 'node:crypto';

if (!global.crypto) {
  global.crypto = { subtle: crypto.webcrypto.subtle };
}
if (!global.Blob) {
  global.Blob = class Blob {
    constructor(parts, options) {
      this.parts = parts;
      this.size = parts.reduce((acc, part) => acc + (part.byteLength || part.length || 0), 0);
    }
    async arrayBuffer() {
      const buffers = this.parts.map(p => p instanceof Buffer ? p : Buffer.from(p));
      const buf = Buffer.concat(buffers);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
  };
}

class FakeTrack {
  constructor() {
    this.readyState = 'live';
    this.listeners = new Set();
    this.settings = {};
  }
  getSettings() { return this.settings; }
  addEventListener(event, fn) {
    if (event === 'ended') this.listeners.add(fn);
  }
  removeEventListener(event, fn) {
    if (event === 'ended') this.listeners.delete(fn);
  }
  end() {
    this.readyState = 'ended';
    for (const fn of this.listeners) fn();
  }
}

class FakeStream {
  constructor() {
    this.video = [new FakeTrack()];
    this.audio = [new FakeTrack()];
  }
  getVideoTracks() { return this.video; }
  getAudioTracks() { return this.audio; }
}

class FakeRecorder {
  constructor(stream, options) {
    this.stream = stream;
    this.options = options;
    this.listeners = {};
    this.state = 'inactive';
  }
  addEventListener(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = new Set();
    this.listeners[event].add(fn);
  }
  start(timeslice) {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.emit('stop');
  }
  removeEventListener(event, fn) {
    if (this.listeners[event]) this.listeners[event].delete(fn);
  }
  emit(event, data) {
    if (this.listeners[event]) {
      for (const fn of this.listeners[event]) fn(data);
    }
  }
}

class FakeTransport {
  constructor() {
    this.log = [];
    this.beginFn = async (d) => ({ ok: true, episodeId: d.episodeId, epochId: d.epochId });
    this.appendFn = async (c, b) => ({ ok: true, episodeId: c.episodeId, epochId: c.epochId, sequence: c.sequence, sha256: c.sha256, byteLength: c.byteLength });
    this.finishFn = async (e) => ({ ok: true, episodeId: e.episodeId, epochId: e.epochId, name: 'out.webm', bytes: e.chunkCount > 0 ? 100 : 0 });
  }
  
  async begin(d) { this.log.push({ type: 'begin', d }); return this.beginFn(d); }
  async append(c, b) { this.log.push({ type: 'append', c }); return this.appendFn(c, b); }
  async finish(e) { this.log.push({ type: 'finish', e }); return this.finishFn(e); }
}

test('4K guest or host originals preserve their actual source dimensions', async () => {
  const transport = new FakeTransport(); const stream = new FakeStream();
  stream.video[0].settings = { width: 3840, height: 2160 };
  const capture = new SourceCapture({ transport, onState: () => {}, makeRecorder: media => new FakeRecorder(media) });
  await capture.start(stream, { episodeId: 'four-k', epochId: 'one', clock: { hostNowMs: 0, localMonoMs: 0, uncertaintyMs: 0 } });
  assert.equal(capture.state.phase, 'recording');
  assert.equal(transport.log[0].d.width, 3840); assert.equal(transport.log[0].d.height, 2160);
  await capture.stop();
});

test('success lifecycle with known fixture bytes', async () => {
  const t = new FakeTransport();
  let stateLog = [];
  let time = 1000;
  
  const cap = new SourceCapture({
    transport: t,
    onState: s => stateLog.push(s),
    makeRecorder: (s) => new FakeRecorder(s),
    now: () => time,
  });

  const stream = new FakeStream();
  await cap.start(stream, {
    episodeId: 'ep1',
    epochId: 'eq1',
    clock: { hostNowMs: 5000, localMonoMs: 1000, uncertaintyMs: 50 }
  });

  assert.equal(cap.state.phase, 'recording');
  assert.equal(t.log.length, 1);
  assert.equal(t.log[0].type, 'begin');
  assert.equal(t.log[0].d.hostStartedMs, 5000);

  await new Promise(r => setTimeout(r, 10));

  time = 1500;
  const fixtureBytes = Buffer.from('known data', 'utf8');
  const expectedHash = '297243d36af2606570ec988e9d0f586f56a1d046129ab4f2b4dc389896e32cba';

  const rec = cap.recorder;
  rec.emit('dataavailable', { data: new global.Blob([fixtureBytes]) });

  await new Promise(r => setTimeout(r, 50));
  
  assert.equal(t.log.length, 2);
  assert.equal(t.log[1].type, 'append');
  assert.equal(t.log[1].c.sha256, expectedHash);
  assert.equal(t.log[1].c.byteLength, 10);
  assert.equal(t.log[1].c.startMonoMs, 1000);
  assert.equal(t.log[1].c.endMonoMs, 1500);

  t.finishFn = async (e) => ({ ok: true, episodeId: e.episodeId, epochId: e.epochId, name: 'out.webm', bytes: cap.state.acknowledgedBytes });

  time = 1800;
  rec.emit('dataavailable', { data: new global.Blob([Buffer.from('final')]) });
  
  const stopP = cap.stop();
  await stopP;

  assert.equal(cap.state.phase, 'complete');
  assert.equal(t.log.length, 4);
  assert.equal(t.log[2].type, 'append');
  assert.equal(t.log[3].type, 'finish');
  assert.equal(t.log[3].e.chunkCount, 2);
  assert.equal(t.log[3].e.endedMonoMs, 1800);
});

test('failure on mismatched begin ACK', async () => {
  const t = new FakeTransport();
  t.beginFn = async (d) => ({ ok: true, episodeId: 'wrong', epochId: d.epochId });
  const cap = new SourceCapture({
    transport: t,
    onState: () => {},
    makeRecorder: (s) => new FakeRecorder(s),
  });
  
  await cap.start(new FakeStream(), {
    episodeId: 'ep1',
    epochId: 'eq1',
    clock: { hostNowMs: 0, localMonoMs: 0, uncertaintyMs: 0 }
  });
  
  await new Promise(r => setTimeout(r, 20));
  assert.equal(cap.state.phase, 'incomplete');
});

test('failure on queue bound exceeded', async () => {
  const t = new FakeTransport();
  t.beginFn = () => new Promise(() => {});
  const cap = new SourceCapture({
    transport: t,
    onState: () => {},
    makeRecorder: (s) => new FakeRecorder(s),
  });

  await cap.start(new FakeStream(), {
    episodeId: 'ep1',
    epochId: 'eq1',
    clock: { hostNowMs: 0, localMonoMs: 0, uncertaintyMs: 0 }
  });

  const rec = cap.recorder;
  rec.emit('dataavailable', { data: { size: 7 * 1024 * 1024 } });
  assert.equal(cap.state.phase, 'recording');
  rec.emit('dataavailable', { data: { size: 7 * 1024 * 1024 } });
  assert.equal(cap.state.phase, 'recording');
  rec.emit('dataavailable', { data: { size: 3 * 1024 * 1024 } });
  assert.equal(cap.state.phase, 'incomplete');
});

test('failure on input track ended', async () => {
  const t = new FakeTransport();
  const cap = new SourceCapture({
    transport: t,
    onState: () => {},
    makeRecorder: (s) => new FakeRecorder(s),
  });
  const stream = new FakeStream();
  await cap.start(stream, { episodeId: 'ep1', epochId: 'eq1', clock: { hostNowMs: 0, localMonoMs: 0, uncertaintyMs: 0 } });
  
  stream.video[0].end();
  assert.equal(cap.state.phase, 'incomplete');
});

test('late completion cannot publish success (drain timeout)', async () => {
  const t = new FakeTransport();
  t.appendFn = () => new Promise(() => {});
  
  const cap = new SourceCapture({
    transport: t,
    onState: () => {},
    makeRecorder: (s) => new FakeRecorder(s),
    drainTimeoutMs: 10,
  });

  await cap.start(new FakeStream(), { episodeId: 'ep1', epochId: 'eq1', clock: { hostNowMs: 0, localMonoMs: 0, uncertaintyMs: 0 } });
  
  const rec = cap.recorder;
  rec.emit('dataavailable', { data: new global.Blob([Buffer.from('data')]) });

  await cap.stop();
  assert.equal(cap.state.phase, 'incomplete');
});


test('delayed-final-data/stop events with earlier append in flight', async () => {
  const t = new FakeTransport();
  t.finishFn = async (e) => ({ ok: true, episodeId: e.episodeId, epochId: e.epochId, bytes: cap.state.acknowledgedBytes });
  let appendResolve = null;
  let appendPromise = new Promise(r => { appendResolve = r; });
  
  const originalAppendFn = t.appendFn;
  let appendCount = 0;
  t.appendFn = async (c, b) => {
    appendCount++;
    if (appendCount === 1) {
      await appendPromise; // Delay first append
    }
    return originalAppendFn(c, b);
  };

  const cap = new SourceCapture({
    transport: t,
    onState: () => {},
    makeRecorder: (s) => new FakeRecorder(s),
    drainTimeoutMs: 2000,
  });

  await cap.start(new FakeStream(), { episodeId: 'ep1', epochId: 'eq1', clock: { hostNowMs: 0, localMonoMs: 0, uncertaintyMs: 0 } });
  
  const rec = cap.recorder;
  rec.emit('dataavailable', { data: new global.Blob([Buffer.from('first')]) });

  const stopP = cap.stop();
  
  // While first is in flight and stop is pending, emit final data and stop event
  setTimeout(() => {
    rec.emit('dataavailable', { data: new global.Blob([Buffer.from('final')]) });
    rec.emit('stop');
  }, 10);
  
  // Resolve first append after the events
  setTimeout(() => {
    appendResolve();
  }, 30);
  
  await stopP;
  assert.equal(cap.state.phase, 'complete');
  assert.equal(t.log.filter(l => l.type === 'append').length, 2);
});

test('empty final blob cases', async () => {
  const t = new FakeTransport();
  t.finishFn = async (e) => ({ ok: true, episodeId: e.episodeId, epochId: e.epochId, bytes: cap.state.acknowledgedBytes });
  const cap = new SourceCapture({
    transport: t,
    onState: () => {},
    makeRecorder: (s) => new FakeRecorder(s),
  });

  await cap.start(new FakeStream(), { episodeId: 'ep1', epochId: 'eq1', clock: { hostNowMs: 0, localMonoMs: 0, uncertaintyMs: 0 } });
  
  const rec = cap.recorder;
  rec.emit('dataavailable', { data: new global.Blob([Buffer.from('data')]) });
  
  const stopP = cap.stop();
  rec.emit('dataavailable', { data: new global.Blob([]) });
  rec.emit('stop');
  
  await stopP;
  assert.equal(cap.state.phase, 'complete');
  // Should only have 1 append since the second was empty
  assert.equal(t.log.filter(l => l.type === 'append').length, 1);
});

test('deferred blob/digest or pending transport completion', async () => {
  const t = new FakeTransport();
  
  // Make append hang forever
  t.appendFn = () => new Promise(() => {});
  
  const cap = new SourceCapture({
    transport: t,
    onState: () => {},
    makeRecorder: (s) => new FakeRecorder(s),
    drainTimeoutMs: 100, // Short timeout
  });

  await cap.start(new FakeStream(), { episodeId: 'ep1', epochId: 'eq1', clock: { hostNowMs: 0, localMonoMs: 0, uncertaintyMs: 0 } });
  
  const rec = cap.recorder;
  rec.emit('dataavailable', { data: new global.Blob([Buffer.from('data')]) });
  
  await cap.stop();
  assert.equal(cap.state.phase, 'incomplete');
  
  // Transport is stuck pending, cap is incomplete. A late ACK should not change it to complete.
  // Wait, FakeTransport is holding the promise, but we can't resolve it here.
});

test('late ACK/finish cannot publish complete', async () => {
  const t = new FakeTransport();
  let finishResolve;
  t.finishFn = (e) => new Promise(r => { finishResolve = r; });
  
  const cap = new SourceCapture({
    transport: t,
    onState: () => {},
    makeRecorder: (s) => new FakeRecorder(s),
    finalizeTimeoutMs: 50,
  });

  await cap.start(new FakeStream(), { episodeId: 'ep1', epochId: 'eq1', clock: { hostNowMs: 0, localMonoMs: 0, uncertaintyMs: 0 } });
  
  const rec = cap.recorder;
  rec.emit('dataavailable', { data: new global.Blob([Buffer.from('data')]) });
  
  const stopP = cap.stop();
  rec.emit('stop'); // trigger recorder stop
  
  await stopP;
  assert.equal(cap.state.phase, 'incomplete');
  
  // Now resolve finish late
  finishResolve({ ok: true, episodeId: 'ep1', epochId: 'eq1', bytes: 4 });
  
  // Yield to event loop
  await new Promise(r => setTimeout(r, 10));
  
  assert.equal(cap.state.phase, 'incomplete');
});

// CodexBWAI: the recorder's last blob starts a new queue after stop() saw an empty queue.
test('an initially empty queue still drains the asynchronously delivered final blob before finish', async () => {
  const transport = new FakeTransport();
  transport.finishFn = async end => {
    assert.equal(end.chunkCount, 1, 'final blob must be acknowledged before finalization');
    return { ok: true, episodeId: end.episodeId, epochId: end.epochId, bytes: 5, name: 'original.webm' };
  };
  let recorder;
  const cap = new SourceCapture({ transport, onState: () => {}, drainTimeoutMs: 1000,
    makeRecorder: stream => {
      recorder = new FakeRecorder(stream);
      recorder.stop = () => { recorder.state = 'inactive'; setTimeout(() => {
        recorder.emit('dataavailable', { data: new Blob(['final']) }); recorder.emit('stop');
      }, 10); };
      return recorder;
    },
  });
  await cap.start(new FakeStream(), { episodeId: 'ep1', epochId: 'eq1', clock: { hostNowMs: 0, localMonoMs: 0, uncertaintyMs: 0 } });
  await cap.stop();
  assert.equal(cap.state.phase, 'complete');
  assert.equal(cap.state.acknowledgedBytes, 5);
  assert.equal(cap.state.pendingBytes, 0);
});

test('durable capture persists bounded pieces without claiming host delivery',async t=>{
 let report, sealed, cancelled=false;
 const pieces=[];
 const cap=new SourceCapture({transport:new FakeTransport(),onState:()=>{},makeRecorder:s=>new FakeRecorder(s),
  durable: progress=>{report=progress;return {open:async()=>{},append:async(c,b)=>pieces.push({c,b}),
   finish:async e=>{sealed=e;report({acknowledgedBytes:131073,message:'Received'});return {ok:true,...e,bytes:131073,name:'saved.webm'};},cancel:()=>{cancelled=true;}};}});
 t.after(()=>cap.fail('test cleanup'));
 await cap.start(new FakeStream(),{episodeId:'ep1',epochId:'eq1',clock:{hostNowMs:0,localMonoMs:0,uncertaintyMs:0}});
 cap.recorder.emit('dataavailable',{data:new Blob([new Uint8Array(131073)])});
 for(let i=0;i<200&&pieces.length!==3;i++)await new Promise(r=>setTimeout(r,1));
 assert.equal(pieces.length,3);assert.ok(pieces.every(p=>p.b.byteLength<=65536));
 assert.deepEqual(pieces.map(p=>p.c.sequence),[0,1,2]);
 assert.equal(pieces[0].c.startMonoMs,pieces[0].c.endMonoMs);
 assert.equal(pieces[1].c.endMonoMs,pieces[2].c.startMonoMs);
 assert.equal(cap.state.acknowledgedBytes,0);assert.equal(cap.state.pendingBytes,131073);
 await cap.stop();assert.equal(sealed.chunkCount,3);assert.equal(cap.state.phase,'complete');assert.equal(cap.state.pendingBytes,0);assert.equal(cancelled,false);
});
test('local persistence failure stops capture without inventing a host receipt',async()=>{
 let cancelled=false;
 const cap=new SourceCapture({transport:new FakeTransport(),onState:()=>{},makeRecorder:s=>new FakeRecorder(s),
  durable:()=>({open:async()=>{},append:async()=>{throw new Error('storage quota');},finish:async()=>{throw new Error('must not finalize');},cancel:()=>{cancelled=true;}})});
 await cap.start(new FakeStream(),{episodeId:'ep1',epochId:'eq1',clock:{hostNowMs:0,localMonoMs:0,uncertaintyMs:0}});
 cap.recorder.emit('dataavailable',{data:new Blob(['stored?'])});
 for(let i=0;i<100&&cap.state.phase!=='incomplete';i++)await new Promise(r=>setTimeout(r,1));
 assert.equal(cap.state.phase,'incomplete');assert.equal(cap.state.acknowledgedBytes,0);assert.equal(cancelled,true);assert.equal(cap.recorder.state,'inactive');
});

test('persisted backlog can exceed the former16MiB RAM limit without ending capture',async t=>{
 let saved=0;
 const cap=new SourceCapture({transport:new FakeTransport(),onState:()=>{},makeRecorder:s=>new FakeRecorder(s),
  durable:()=>({open:async()=>{},append:async(_c,b)=>{saved+=b.byteLength;},finish:async()=>{throw new Error('not delivered');},cancel:()=>{}})});
 t.after(()=>cap.fail('test cleanup'));
 await cap.start(new FakeStream(),{episodeId:'ep1',epochId:'eq1',clock:{hostNowMs:0,localMonoMs:0,uncertaintyMs:0}});
 for(let i=0;i<17;i++) {
  cap.recorder.emit('dataavailable',{data:new Blob([new Uint8Array(1048576)])});
  for(let n=0;n<1000&&saved<(i+1)*1048576;n++)await new Promise(r=>setTimeout(r,1));
  assert.equal(saved,(i+1)*1048576);
 }
 assert.equal(cap.state.phase,'recording');assert.equal(cap.state.acknowledgedBytes,0);
 assert.equal(cap.state.pendingBytes,17*1048576);
});

test('durable finalization stays live across61seconds of missing host receipt',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let acknowledge,finishEntered;
 const entered=new Promise(r=>{finishEntered=r;});
 const cap=new SourceCapture({transport:new FakeTransport(),onState:()=>{},makeRecorder:s=>new FakeRecorder(s),
  durable:progress=>({open:async()=>{},append:async()=>{},finish:end=>new Promise(resolve=>{
    acknowledge=()=>{progress({acknowledgedBytes:3,message:'Received'});resolve({ok:true,...end,bytes:3,name:'saved.webm'});};finishEntered();
  }),cancel:()=>{throw new Error('Must not cancel delivery during61second interruption');}})});
 await cap.start(new FakeStream(),{episodeId:'ep1',epochId:'eq1',clock:{hostNowMs:0,localMonoMs:0,uncertaintyMs:0}});
 cap.recorder.emit('dataavailable',{data:new Blob(['one'])});
 const stopping=cap.stop();await entered;
 t.mock.timers.tick(61000);await Promise.resolve();
 assert.equal(cap.state.phase,'stopping');assert.equal(cap.state.acknowledgedBytes,0);
 acknowledge();await stopping;assert.equal(cap.state.phase,'complete');assert.equal(cap.state.acknowledgedBytes,3);
});

// CodexBWAI — host-only opt-in; legacy guest source requirements remain unchanged.
for (const kind of ['audio', 'video']) test(`partial host ${kind}-only original finalizes and preserves source ownership`, async () => {
  const transport = new FakeTransport(); const stream = new FakeStream();
  stream[kind === 'audio' ? 'video' : 'audio'] = [];
  if (kind === 'video') stream.video[0].settings = {width:1280,height:720};
  const capture = new SourceCapture({transport,onState:()=>{},allowPartialSource:true,makeRecorder:s=>new FakeRecorder(s)});
  await capture.start(stream,{episodeId:'partial',epochId:'one',clock:{hostNowMs:100,localMonoMs:100,uncertaintyMs:0}});
  assert.equal(capture.state.phase,'recording');
  const descriptor=transport.log[0].d; assert.equal(descriptor.width,kind==='video'?1280:0);assert.equal(descriptor.height,kind==='video'?720:0);
  transport.finishFn=async e=>({ok:true,episodeId:e.episodeId,epochId:e.epochId,name:'original.webm',bytes:capture.state.acknowledgedBytes});
  capture.recorder.emit('dataavailable',{data:new Blob(['raw original'])});await capture.stop();
  assert.equal(capture.state.phase,'complete');assert.equal(capture.state.acknowledgedBytes,12);assert.equal(stream[kind][0].readyState,'live');assert.equal(stream[kind][0].listeners.size,0);
});
test('partial-source opt-in rejects empty/duplicate live tracks and guests still require both',async()=>{
  for (const [video,audio,allowed] of [[0,0,true],[2,0,true],[0,2,true],[1,2,true],[0,1,false],[1,0,false]]) {
    const stream=new FakeStream();stream.video=Array.from({length:video},()=>new FakeTrack());stream.audio=Array.from({length:audio},()=>new FakeTrack());
    let created=false;const capture=new SourceCapture({transport:new FakeTransport(),onState:()=>{},allowPartialSource:allowed,makeRecorder:s=>{created=true;return new FakeRecorder(s);}});
    await capture.start(stream,{episodeId:'invalid',epochId:'one',clock:{hostNowMs:0,localMonoMs:0,uncertaintyMs:0}});assert.equal(capture.state.phase,'incomplete');assert.equal(created,false);
  }
});
