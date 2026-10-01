import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostAudioMixer } from '../dist/audio-mix.js';

// Mock Web Audio API and MediaStream for Node.js testing
class FakeMediaStreamTrack {
  constructor() {
    this.stopped = false;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeMediaStream {
  constructor(tracks = []) {
    this.tracks = tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

class FakeAudioNode {
  constructor() {
    this.connections = [];
  }
  connect(dest) {
    this.connections.push(dest);
  }
  disconnect() {
    this.connections = [];
  }
}

class FakeGainNode extends FakeAudioNode {
  constructor() {
    super();
    this.gain = { value: 1 };
  }
}

class FakeAnalyserNode extends FakeAudioNode {
  constructor() {
    super();
    this.fftSize = 2048;
  }
  getFloatTimeDomainData(array) {
    array.fill(0);
  }
}

class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.destination = new FakeAudioNode();
    
    if (globalThis.forceAudioContextFail) {
      throw new Error("Simulated AudioContext failure");
    }
  }
  createMediaStreamDestination() {
    if (globalThis.forceMediaStreamDestFail) {
      throw new Error("Simulated createMediaStreamDestination failure");
    }
    const dest = new FakeAudioNode();
    dest.stream = new FakeMediaStream([new FakeMediaStreamTrack()]);
    return dest;
  }
  createMediaStreamSource(stream) {
    return new FakeAudioNode();
  }
  createAnalyser() {
    return new FakeAnalyserNode();
  }
  createGain() {
    return new FakeGainNode();
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}

globalThis.AudioContext = FakeAudioContext;
globalThis.MediaStream = FakeMediaStream;

test('HostAudioMixer constructor cleanup on failure', () => {
  globalThis.forceMediaStreamDestFail = true;
  
  let closeCalled = false;
  const originalClose = FakeAudioContext.prototype.close;
  FakeAudioContext.prototype.close = function() {
    closeCalled = true;
    return originalClose.call(this);
  };

  try {
    const hostStream = new FakeMediaStream([new FakeMediaStreamTrack()]);
    assert.throws(() => new HostAudioMixer(hostStream), /Simulated createMediaStreamDestination failure/);
    assert.ok(closeCalled, 'AudioContext should be closed on constructor failure');
  } finally {
    globalThis.forceMediaStreamDestFail = false;
    FakeAudioContext.prototype.close = originalClose;
  }
});

test('HostAudioMixer gains validation', async () => {
  const mixer = new HostAudioMixer(new FakeMediaStream());
  const stream = new FakeMediaStream();
  
  mixer.addGuest('guest1', stream);
  
  // Valid gain
  mixer.setGainDb('guest1', -10);
  assert.equal(mixer.getGainDb('guest1'), -10);
  
  // Invalid gains
  assert.throws(() => mixer.setGainDb('guest1', Infinity), RangeError);
  assert.throws(() => mixer.setGainDb('guest1', -Infinity), RangeError);
  assert.throws(() => mixer.setGainDb('guest1', NaN), RangeError);
  assert.throws(() => mixer.setGainDb('guest1', '10'), RangeError);
  assert.throws(() => mixer.setGainDb('guest1', 10), RangeError); // out of range (>0)
  assert.throws(() => mixer.setGainDb('guest1', -70), RangeError); // out of range (<-60)
  
  // Missing ID
  assert.throws(() => mixer.setGainDb('missing', -10), /Guest missing not found/);
});

test('HostAudioMixer retain gain on remove then add', async () => {
  const mixer = new HostAudioMixer(new FakeMediaStream());
  const stream1 = new FakeMediaStream();
  
  mixer.addGuest('guest1', stream1);
  mixer.setGainDb('guest1', -15);
  
  mixer.removeGuest('guest1');
  
  const stream2 = new FakeMediaStream();
  mixer.addGuest('guest1', stream2);
  
  // Gain should be retained
  assert.equal(mixer.getGainDb('guest1'), -15);
  
  const guest = mixer.guests.get('guest1');
  const expectedGain = Math.pow(10, -15 / 20);
  assert.ok(Math.abs(guest.gainNode.gain.value - expectedGain) < 0.0001);
});

test('HostAudioMixer close is idempotent', async () => {
  const mixer = new HostAudioMixer(new FakeMediaStream());
  
  await mixer.close();
  // Second close should be safe
  await mixer.close();
});

test('HostAudioMixer closed lifecycle guards', async () => {
  const mixer = new HostAudioMixer(new FakeMediaStream());
  await mixer.close();
  
  assert.throws(() => mixer.addGuest('g1', new FakeMediaStream()), /AudioContext is closed/);
  assert.throws(() => mixer.setGainDb('g1', -10), /AudioContext is closed/);
  assert.rejects(async () => await mixer.resume(), /AudioContext is closed/);
  assert.deepEqual(mixer.getLevels(), []);
});

test('HostAudioMixer addGuest replacement requires remove+add', async () => {
  const mixer = new HostAudioMixer(new FakeMediaStream());
  const stream1 = new FakeMediaStream();
  
  mixer.addGuest('guest1', stream1);
  
  // Trying to add the same guest again should throw
  assert.throws(() => mixer.addGuest('guest1', new FakeMediaStream()), /already added/);
  
  // Replacing requires removing first
  mixer.removeGuest('guest1');
  mixer.addGuest('guest1', new FakeMediaStream()); // succeeds
});

// CodexBWAI: browsers close contexts asynchronously; owned tracks must stop
// immediately and a concurrent close must not close the device twice.
test('audio close is idempotent while pending and rejects new work immediately', async t => {
  const originalClose = FakeAudioContext.prototype.close;
  t.after(() => { FakeAudioContext.prototype.close = originalClose; });
  let finish, count = 0;
  FakeAudioContext.prototype.close = function () {
    count++;
    return new Promise(resolve => { finish = () => { this.state = 'closed'; resolve(); }; });
  };
  const input = new FakeMediaStream([new FakeMediaStreamTrack()]);
  const mixer = new HostAudioMixer(input);
  const output = mixer.getMixedStream();
  const first = mixer.close(), second = mixer.close();
  assert.equal(first, second);
  assert.equal(count, 1);
  assert.ok(output.getTracks().every(track => track.stopped));
  assert.ok(input.getTracks().every(track => !track.stopped));
  assert.throws(() => mixer.addGuest('late', input), /closed/);
  assert.throws(() => mixer.getMixedStream(), /closed/);
  await assert.rejects(mixer.resume(), /closed/);
  finish(); await first;
});

test('partial audio graph is disconnected if guest setup fails', async t => {
  const originalGain = FakeAudioContext.prototype.createGain;
  const originalSource = FakeAudioContext.prototype.createMediaStreamSource;
  t.after(() => { FakeAudioContext.prototype.createGain = originalGain; FakeAudioContext.prototype.createMediaStreamSource = originalSource; });
  const mixer = new HostAudioMixer(new FakeMediaStream());
  let source;
  FakeAudioContext.prototype.createMediaStreamSource = () => (source = new FakeAudioNode());
  FakeAudioContext.prototype.createGain = () => { throw new Error('device failure'); };
  assert.throws(() => mixer.addGuest('failed', new FakeMediaStream()), /device failure/);
  assert.deepEqual(source.connections, []);
  assert.equal(mixer.getGuestSource('failed'), undefined);
  await mixer.close();
});

// CodexBWAI — listening and guest mix mute have distinct destinations.
test('monitoring off preserves mixed output while guest mute silences both branches', async () => {
  const mixer = new HostAudioMixer(new FakeMediaStream([]));
  const stream = new FakeMediaStream([new FakeMediaStreamTrack()]);
  mixer.addGuest('guest', stream);
  const guest = mixer.guests.get('guest');
  assert.ok(guest.gainNode.connections.includes(mixer.mixedDestination));
  assert.ok(guest.gainNode.connections.includes(mixer.monitor));
  mixer.setMonitoring(false);
  assert.equal(mixer.monitor.gain.value, 0);
  assert.equal(guest.gainNode.gain.value, 1);
  assert.equal(mixer.getMixedStream().getTracks()[0].stopped, false);
  mixer.setGuestMuted('guest', true);
  mixer.setGainDb('guest', -6);
  assert.equal(guest.gainNode.gain.value, 0);
  mixer.setGuestMuted('guest', false);
  assert.ok(Math.abs(guest.gainNode.gain.value - Math.pow(10,-6/20)) < 0.0001);
  await mixer.close();
  assert.equal(stream.getTracks()[0].stopped, false);
});
