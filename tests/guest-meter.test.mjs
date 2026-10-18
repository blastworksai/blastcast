// CodexBWAI — meter lifecycle contract: synchronous activation, interruption
// visibility and teardown; synthetic values do not establish Safari hardware support.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMeter } from '../dist/guest-meter.js';

function harness() {
  let tick, clock = 0, muted = false, resumed = 0, closed = 0;
  globalThis.requestAnimationFrame = callback => { tick = callback; return 1; };
  globalThis.cancelAnimationFrame = () => { tick = null; };
  const track = { readyState: 'live', muted: false };
  const context = { state: 'suspended', resume() { resumed++; return Promise.resolve(); }, close() { closed++; return Promise.resolve(); },
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createAnalyser: () => ({ fftSize: 256, disconnect() {}, getByteTimeDomainData: values => values.fill(144) }) };
  let level, message;
  const meter = new GuestMeter(v => { level = v; }, m => { message = m; }, () => muted, () => context, () => clock);
  return { meter, context, track, stream: { getAudioTracks: () => [track] }, step() { tick?.(); },
    get state() { return { level, message, resumed, closed, scheduled: Boolean(tick) }; }, mute() { muted = true; } };
}

test('meter unlock occurs before acquisition and retries the same context after interruption', () => {
  const h = harness(); h.meter.unlock();
  assert.equal(h.state.resumed, 1, 'resume must run synchronously in the caller gesture');
  h.meter.attach(h.stream);
  assert.match(h.state.message, /meter is paused.*not verified/);
  h.meter.unlock(); h.context.state = 'running'; h.step();
  assert.ok(h.state.resumed === 2 && h.state.level > 0 && h.state.message.includes('signal detected'));
  h.meter.close();
});

test('track interruption and application mute are distinct; stopping detaches meter', () => {
  const h = harness(); h.meter.unlock(); h.context.state = 'running'; h.meter.attach(h.stream);
  h.track.muted = true; h.step();
  assert.ok(h.state.level === 0 && h.state.message.includes('browser has interrupted'));
  h.mute(); h.step();
  assert.ok(h.state.level === 0 && h.state.message.includes('muted in BlastCast'));
  h.meter.close();
  assert.deepEqual(h.state, { level: 0, message: 'Microphone input is off.', resumed: 1, closed: 1, scheduled: false });
});
