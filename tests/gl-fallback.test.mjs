// ClaudeBWAI — einh 4 Oct (CP4c-2): the context-loss policy, driven by a fake canvas and fake timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchGlContext, GL_RESTORE_GRACE_MS } from '../dist/scenes.js';

function rig(recording) {
  const listeners = {}; const timers = []; const log = []; let rebuilds = 0, rebuildThrows = false;
  const target = { addEventListener: (n, f) => { listeners[n] = f; }, removeEventListener: n => { delete listeners[n]; } };
  const hooks = { recording: () => recording.on, event: r => log.push(r), onLostIdle: () => log.push('idle'), onLostTimeout: () => log.push('timeout') };
  const watch = watchGlContext(target, { rebuild: () => { rebuilds++; if (rebuildThrows) throw new Error('x'); } }, hooks,
    { setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; }, clearTimer: t => { t.live = false; } });
  const fire = t => { if (t.live) { t.live = false; t.fn(); } };
  return { listeners, timers, log, watch, fire, rebuilds: () => rebuilds, throwOnRebuild: () => { rebuildThrows = true; } };
}
const lost = () => ({ preventDefault() { lost.prevented = true; } });

test('lost during a recording waits 5 s, then fails the recording', () => {
  const r = rig({ on: true });
  r.listeners.webglcontextlost(lost());
  assert.equal(lost.prevented, true);
  assert.equal(r.timers[0].ms, GL_RESTORE_GRACE_MS); assert.equal(GL_RESTORE_GRACE_MS, 5000);
  assert.deepEqual(r.log, ['context-lost']); assert.equal(r.watch.pending(), true);
  r.fire(r.timers[0]);
  assert.deepEqual(r.log, ['context-lost', 'timeout']);
});
test('restored within the window rebuilds and cancels the failure', () => {
  const r = rig({ on: true });
  r.listeners.webglcontextlost(lost());
  r.listeners.webglcontextrestored();
  assert.equal(r.rebuilds(), 1); assert.equal(r.watch.pending(), false);
  r.fire(r.timers[0]);
  assert.deepEqual(r.log, ['context-lost', 'context-restored']);
});
test('lost between recordings falls back at once, with no timer', () => {
  const r = rig({ on: false });
  r.listeners.webglcontextlost(lost());
  assert.deepEqual(r.log, ['context-lost', 'idle']); assert.equal(r.timers.length, 0);
});
test('recording ended while waiting: the timeout falls back instead of failing', () => {
  const rec = { on: true }; const r = rig(rec);
  r.listeners.webglcontextlost(lost()); rec.on = false; r.fire(r.timers[0]);
  assert.deepEqual(r.log, ['context-lost', 'idle']);
});
test('a rebuild that throws counts as not restored', () => {
  const r = rig({ on: true }); r.throwOnRebuild();
  r.listeners.webglcontextlost(lost()); r.listeners.webglcontextrestored();
  assert.deepEqual(r.log, ['context-lost', 'timeout']);
});
test('dispose removes the listeners and the timer', () => {
  const r = rig({ on: true });
  r.listeners.webglcontextlost(lost()); r.watch.dispose();
  assert.equal(r.timers[0].live, false); assert.deepEqual(Object.keys(r.listeners), []);
});
