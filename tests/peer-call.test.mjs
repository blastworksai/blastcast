import test from 'node:test';
import assert from 'node:assert';
import { PeerCall } from '../dist/peer-call.js';

class FakeMediaStream {
  constructor(tracks = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  addTrack(track) {
    this.tracks.push(track);
  }
}

class FakeRTCPeerConnection {
  constructor(configuration) {
    this.configuration = configuration;
    this.connectionState = 'new';
    this.remoteDescription = null;
    this.localDescription = null;
    this.tracks = [];
    this._closed = false;
  }
  addTrack(track, stream) {
    this.tracks.push({ track, stream });
  }
  async createOffer() {
    await new Promise(r => setTimeout(r, 0));
    return { type: 'offer', sdp: 'fake-offer-sdp' };
  }
  async createAnswer() {
    await new Promise(r => setTimeout(r, 0));
    return { type: 'answer', sdp: 'fake-answer-sdp' };
  }
  async setLocalDescription(desc) {
    await new Promise(r => setTimeout(r, 0));
    this.localDescription = desc;
  }
  async setRemoteDescription(desc) {
    await new Promise(r => setTimeout(r, 0));
    this.remoteDescription = desc;
  }
  async addIceCandidate(candidate) {
    await new Promise(r => setTimeout(r, 0));
  }
  close() {
    this._closed = true;
  }
  async getStats() {
    return new Map();
  }
}

global.RTCPeerConnection = FakeRTCPeerConnection;
global.MediaStream = FakeMediaStream;
global.RTCSessionDescription = class { constructor(init) { Object.assign(this, init); } };
global.RTCIceCandidate = class { constructor(init) { Object.assign(this, init); } };

test('PeerCall host starts and sends offer', async () => {
  const stream = new FakeMediaStream(['audio']);
  const sent = [];
  const states = [];
  const call = new PeerCall({
    role: 'host',
    stream,
    send: async (msg) => { sent.push(msg); },
    onRemoteStream: () => {},
    onState: (state) => states.push(state)
  });
  
  await call.start();
  assert.deepStrictEqual(sent, [{ type: 'description', description: { type: 'offer', sdp: 'fake-offer-sdp' } }]);
  call.close();
  assert.strictEqual(states[states.length - 1], 'closed');
});

test('PeerCall guest waits and answers offer', async () => {
  const stream = new FakeMediaStream(['audio']);
  const sent = [];
  const call = new PeerCall({
    role: 'guest',
    stream,
    send: async (msg) => { sent.push(msg); },
    onRemoteStream: () => {},
    onState: () => {}
  });
  
  await call.start();
  assert.strictEqual(sent.length, 0);
  
  await call.receive({ type: 'description', description: { type: 'offer', sdp: 'offer-sdp' } });
  assert.deepStrictEqual(sent, [{ type: 'description', description: { type: 'answer', sdp: 'fake-answer-sdp' } }]);
  call.close();
});

test('PeerCall buffers early ICE candidates', async () => {
  const stream = new FakeMediaStream();
  const call = new PeerCall({
    role: 'host',
    stream,
    send: async () => {},
    onRemoteStream: () => {},
    onState: () => {}
  });
  
  await call.start();
  
  await call.receive({ type: 'candidate', candidate: { candidate: 'ice1' } });
  
  const pc = call.pc;
  let addedCandidates = 0;
  pc.addIceCandidate = async () => { addedCandidates++; };
  
  await call.receive({ type: 'description', description: { type: 'answer', sdp: 'ans' } });
  
  assert.strictEqual(addedCandidates, 1);
  call.close();
});

test('PeerCall close-during-await prevents state resurrection', async () => {
  const stream = new FakeMediaStream();
  let pc;
  global.RTCPeerConnection = class extends FakeRTCPeerConnection {
    constructor() {
      super();
      pc = this;
    }
    async createOffer() {
      await new Promise(r => setTimeout(r, 10)); // slow
      return { type: 'offer', sdp: 'slow-offer' };
    }
  };
  
  const call = new PeerCall({
    role: 'host',
    stream,
    send: async () => {},
    onRemoteStream: () => {},
    onState: () => {}
  });
  
  const startPromise = call.start();
  call.close();
  await startPromise;
  
  assert.strictEqual(pc.localDescription, null);
  global.RTCPeerConnection = FakeRTCPeerConnection;
});

test('PeerCall limits earlyCandidates to 64 and fails explicitly', async () => {
  const stream = new FakeMediaStream();
  let failed = false;
  const call = new PeerCall({
    role: 'guest',
    stream,
    send: async () => {},
    onRemoteStream: () => {},
    onState: (state) => { if (state === 'failed') failed = true; }
  });
  
  await call.start();
  for (let i = 0; i < 70; i++) {
    await call.receive({ type: 'candidate', candidate: { candidate: `ice${i}` } });
  }
  
  assert.ok(failed);
  call.close();
});

test('PeerCall bounds inbound signaling queue to 64', async () => {
  const stream = new FakeMediaStream();
  const states = [];
  const call = new PeerCall({
    role: 'guest',
    stream,
    send: async () => {},
    onRemoteStream: () => {},
    onState: (state) => states.push(state)
  });
  
  await call.start();
  
  const receivePromises = [];
  for (let i = 0; i < 70; i++) {
    receivePromises.push(call.receive({ type: 'candidate', candidate: { candidate: `ice${i}` } }));
  }
  
  await Promise.all(receivePromises);
  assert.ok(states.includes('failed'), 'Should fail due to inbound queue overflow');
  call.close();
});

test('PeerCall creates stable aggregate remote stream', async () => {
  const stream = new FakeMediaStream();
  let receivedStream = null;
  const call = new PeerCall({
    role: 'host',
    stream,
    send: async () => {},
    onRemoteStream: (s) => { receivedStream = s; },
    onState: () => {}
  });
  
  const pc = call.pc;
  pc.ontrack({ track: 'track1' });
  pc.ontrack({ track: 'track2' });
  
  assert.ok(receivedStream);
  assert.deepStrictEqual(receivedStream.getTracks(), ['track1', 'track2']);
  call.close();
});

test('PeerCall validates description types based on role', async () => {
  const stream = new FakeMediaStream();
  const states = [];
  const call = new PeerCall({
    role: 'host',
    stream,
    send: async () => {},
    onRemoteStream: () => {},
    onState: (state) => states.push(state)
  });
  
  await call.start();
  await call.receive({ type: 'description', description: { type: 'offer', sdp: 'fake-sdp' } });
  
  assert.ok(states.includes('failed'));
  call.close();
});

test('PeerCall disconnected state triggers recovery timeout', async () => {
  const stream = new FakeMediaStream();
  const states = [];
  const call = new PeerCall({
    role: 'host',
    stream,
    send: async () => {},
    onRemoteStream: () => {},
    onState: (state) => states.push(state)
  });
  
  await call.start();
  const pc = call.pc;
  
  pc.connectionState = 'connected';
  pc.onconnectionstatechange();
  
  pc.connectionState = 'disconnected';
  pc.onconnectionstatechange();
  
  // ClaudeBWAI — a drop after the call was up is now a 30 s recovery (state 'reconnecting'); timing is covered in peer-reconnect.test.mjs.
  assert.ok(call.deadlineTimer !== null);
  assert.strictEqual(states.at(-1), 'reconnecting');
  
  pc.connectionState = 'connected';
  pc.onconnectionstatechange();
  
  assert.ok(call.deadlineTimer === null);
  assert.ok(call.connectionTimeout === null);
  
  call.close();
});

test('PeerCall single start prevents repeated initialization', async () => {
  const stream = new FakeMediaStream();
  let createOfferCalled = 0;
  
  global.RTCPeerConnection = class extends FakeRTCPeerConnection {
    async createOffer() {
      createOfferCalled++;
      return super.createOffer();
    }
  };

  const call = new PeerCall({
    role: 'host',
    stream,
    send: async () => {},
    onRemoteStream: () => {},
    onState: () => {}
  });
  
  const p1 = call.start();
  const p2 = call.start();
  
  await Promise.all([p1, p2]);
  assert.strictEqual(createOfferCalled, 1);
  call.close();
  
  global.RTCPeerConnection = FakeRTCPeerConnection;
});

// CodexBWAI: a fast connection event must cancel the answer timeout permanently.
test('connection established during setLocalDescription does not acquire a late timeout', async t => {
  const original = global.RTCPeerConnection;
  t.after(() => { global.RTCPeerConnection = original; });
  global.RTCPeerConnection = class extends FakeRTCPeerConnection {
    async setLocalDescription(description) {
      await super.setLocalDescription(description);
      this.connectionState = 'connected'; this.onconnectionstatechange();
    }
  };
  const states = [];
  const call = new PeerCall({ role:'guest', stream:new FakeMediaStream(), send:async()=>{}, onRemoteStream:()=>{}, onState:state=>states.push(state) });
  t.after(() => call.close());
  await call.start();
  await call.receive({ type:'description', description:{type:'offer',sdp:'fixture'} });
  assert.equal(states.at(-1),'connected');
  assert.equal(call.connectionTimeout,null);
});

test('close suppresses queued ICE sends behind a pending offer', async t => {
  let release;
  const sent=[];
  const call=new PeerCall({role:'host',stream:new FakeMediaStream(),send:message=>{sent.push(message);return new Promise(resolve=>{release=resolve;});},onRemoteStream:()=>{},onState:()=>{}});
  t.after(()=>call.close());
  await call.start();
  call.pc.onicecandidate({candidate:{toJSON:()=>({candidate:'fixture'})}});
  call.close();release();
  await call.outboundQueue;
  await call.receive({type:'hangup'});
  assert.equal(sent.length,1);assert.equal(call.outboundCount,0);assert.equal(call.inboundCount,0);
});

function diagnosticCall() {
  const track = { stop() { throw new Error('PeerCall must not stop caller-owned tracks'); } };
  const stream = new FakeMediaStream([track]);
  const call = new PeerCall({ role: 'guest', stream, send: async () => {},
    onRemoteStream: () => {}, onState: () => {}, iceServers: [{ urls: 'turn:example.test:3478' }],
    iceTransportPolicy: 'relay' });
  assert.equal(call.pc.configuration.iceTransportPolicy, 'relay');
  assert.deepEqual(call.pc.configuration.iceServers, [{ urls: 'turn:example.test:3478' }]);
  return call;
}

function stats(...entries) {
  return new Map(entries.map(entry => [entry.id, entry]));
}

test('diagnostics report only the transport-selected relay pair and local inbound bytes', async t => {
  const call = diagnosticCall(); t.after(() => call.close());
  call.pc.getStats = async () => stats(
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'selected' },
    { id: 'selected', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote' },
    { id: 'local', type: 'local-candidate', candidateType: 'host', protocol: 'udp', address: 'private' },
    { id: 'remote', type: 'remote-candidate', candidateType: 'relay', protocol: 'tcp', address: 'private' },
    { id: 'unrelated', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'relay', remoteCandidateId: 'remote' },
    { id: 'relay', type: 'local-candidate', candidateType: 'relay', protocol: 'tcp' },
    { id: 'audio', type: 'inbound-rtp', kind: 'audio', bytesReceived: 7 },
    { id: 'audio2', type: 'inbound-rtp', mediaType: 'audio', bytesReceived: 3 },
    { id: 'video', type: 'inbound-rtp', kind: 'video', bytesReceived: 11 },
    { id: 'remote-audio', type: 'inbound-rtp', kind: 'audio', bytesReceived: 1000, isRemote: true },
    { id: 'bad', type: 'inbound-rtp', kind: 'video', bytesReceived: -1 },
    { id: 'outbound', type: 'outbound-rtp', kind: 'video', bytesSent: 999 }
  );
  assert.deepEqual(await call.diagnostics(), { route: 'relay', protocol: 'udp', audioBytesReceived: 10, videoBytesReceived: 11 });
});

test('selected direct pair outranks unrelated relay candidate', async t => {
  const call = diagnosticCall(); t.after(() => call.close());
  call.pc.getStats = async () => stats(
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'direct' },
    { id: 'direct', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote' },
    { id: 'local', type: 'local-candidate', candidateType: 'host', protocol: 'udp' },
    { id: 'remote', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' },
    { id: 'relay', type: 'local-candidate', candidateType: 'relay', protocol: 'tcp' }
  );
  assert.equal((await call.diagnostics()).route, 'direct');
});

test('fallback requires one nominated succeeded pair', async t => {
  const call = diagnosticCall(); t.after(() => call.close());
  const pair = (id, nominated, state) => ({ id, type: 'candidate-pair', nominated, state,
    localCandidateId: 'local', remoteCandidateId: 'remote' });
  const candidates = [
    { id: 'local', type: 'local-candidate', candidateType: 'relay', protocol: 'tcp' },
    { id: 'remote', type: 'remote-candidate', candidateType: 'host', protocol: 'tcp' }
  ];
  call.pc.getStats = async () => stats(pair('failed', true, 'failed'), ...candidates);
  assert.equal((await call.diagnostics()).route, 'unknown');
  call.pc.getStats = async () => stats(pair('a', true, 'succeeded'), pair('b', true, 'succeeded'), ...candidates);
  assert.equal((await call.diagnostics()).route, 'unknown');
  call.pc.getStats = async () => stats(pair('a', true, 'succeeded'), pair('b', false, 'succeeded'), ...candidates);
  assert.equal((await call.diagnostics()).route, 'relay');
});

test('unavailable or stale stats cannot report a route or received bytes', async t => {
  const call = diagnosticCall(); t.after(() => call.close());
  call.pc.getStats = async () => { throw new Error('unavailable'); };
  const unknown = { route: 'unknown', protocol: null, audioBytesReceived: 0, videoBytesReceived: 0 };
  assert.deepEqual(await call.diagnostics(), unknown);
  let resolveStats;
  call.pc.getStats = () => new Promise(resolve => { resolveStats = resolve; });
  const pending = call.diagnostics();
  call.close();
  resolveStats(stats({ id: 'audio', type: 'inbound-rtp', kind: 'audio', bytesReceived: 400 }));
  assert.deepEqual(await pending, unknown);
  assert.deepEqual(await call.diagnostics(), unknown);
});

test('default ICE policy is all; remote-only RTP and unknown candidates prove nothing', async t => {
  const call = new PeerCall({ role: 'guest', stream: new FakeMediaStream(),
    send: async () => {}, onRemoteStream: () => {}, onState: () => {} });
  t.after(() => call.close());
  assert.equal(call.pc.configuration.iceTransportPolicy, 'all');
  call.pc.getStats = async () => stats(
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' },
    { id: 'pair', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote' },
    { id: 'local', type: 'local-candidate', candidateType: 'unknown', protocol: 'udp' },
    { id: 'remote', type: 'remote-candidate', candidateType: 'host', protocol: 'udp' },
    { id: 'remote-inbound', type: 'remote-inbound-rtp', kind: 'audio', bytesReceived: 123 },
    { id: 'remote-flagged', type: 'inbound-rtp', isRemote: true, kind: 'video', bytesReceived: 456 }
  );
  assert.deepEqual(await call.diagnostics(), {
    route: 'unknown', protocol: 'udp', audioBytesReceived: 0, videoBytesReceived: 0
  });
});

// CodexBWAI — stale transport selection cannot establish a successful relay path.
test('transport-selected failed pair is not relay evidence', async t => {
  const call = diagnosticCall(); t.after(() => call.close());
  call.pc.getStats = async () => stats(
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'failed' },
    { id: 'failed', type: 'candidate-pair', state: 'failed', localCandidateId: 'local', remoteCandidateId: 'remote' },
    { id: 'local', type: 'local-candidate', candidateType: 'relay' },
    { id: 'remote', type: 'remote-candidate', candidateType: 'host' }
  );
  assert.equal((await call.diagnostics()).route, 'unknown');
});
