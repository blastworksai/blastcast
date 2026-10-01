// CodexBWAI — admission snapshot, mixed-output independence and source authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSourceController } = require('../desktop/source-controller.cjs');
const { registerSourceBridge, STUDIO_URL } = require('../desktop/boundary.cjs');
function fixture() {
  const events = [];
  let snapshot = null, recordingBusy = false, confirm = false, time = 0;
  const recording = {
    isBusy: () => recordingBusy,
    begin: async () => { events.push('mixed-begin'); recordingBusy = true; return { ok: true, id: 'episode' }; },
    finish: async id => { events.push(['mixed-finish', id]); recordingBusy = false; return { ok: true, name: 'mixed.webm' }; },
    abort: async id => { events.push(['mixed-abort', id]); recordingBusy = false; return { ok: false, message: 'Retained partial' }; },
  };
  const sources = {
    status: () => snapshot,
    beginEpisode: async input => { events.push(['source-begin', input]); snapshot = { episodeId: input.id, phase: 'recording', allSourcesComplete: false }; return { ok: true }; },
    stopEpisode: async id => { events.push(['source-stop', id]); snapshot.phase = 'stopped'; return { ok: true }; },
    closeEpisode: async id => { events.push(['source-close', id]); snapshot.phase = 'closed'; return { ok: true }; },
  };
  const guests = { status: () => ({ guests: [
    { alive: true, phase: 'admitted', session: { id: 'guest', name: 'Guest' } },
    { alive: true, phase: 'pending', session: { id: 'pending', name: 'Pending' } },
    { alive: false, phase: 'admitted', session: { id: 'expired', name: 'Expired' } },
  ] }) };
  const controller = createSourceController({ recording, sources, guests, confirmIncomplete: async () => { events.push('confirm'); return confirm; }, now: () => time });
  return { controller, sources, events, advance: ms => { time += ms; }, setConfirm: value => { confirm = value; }, setSnapshot: value => { snapshot = value; } };
}
test('begin snapshots only currently admitted participants and always includes host', async () => {
  const f = fixture();
  assert.equal((await f.controller.begin()).ok, true);
  assert.deepEqual(f.events[1][1].participants, [{ id: 'host', label: 'Host' }, { id: 'guest', label: 'Guest' }]);
  assert.equal((await f.controller.begin()).ok, false);
});
test('source preparation failure aborts mixed startup rather than starting an untracked episode', async () => {
  const f = fixture();
  f.sources.beginEpisode = async () => ({ ok: false, message: 'Disk unavailable' });
  assert.deepEqual(await f.controller.begin(), { ok: false, message: 'Disk unavailable' });
  assert.deepEqual(f.events.at(-1), ['mixed-abort', 'episode']);
  assert.equal(f.controller.busy(), false);
});
test('playable mixed file remains successful while originals are incomplete', async () => {
  const f = fixture();
  await f.controller.begin();
  assert.deepEqual(await f.controller.finish('episode'), { ok: true, name: 'mixed.webm' });
  assert.deepEqual(f.events.slice(-2), [['source-stop', 'episode'], ['mixed-finish', 'episode']]);
  assert.equal(f.controller.busy(), true);
  assert.equal((await f.controller.begin()).ok, false);
});
test('stalled original stop metadata does not hold the playable mixed episode hostage', async () => {
  const f = fixture();await f.controller.begin();
  let release;
  f.sources.stopEpisode = () => new Promise(resolve=>{release=resolve;});
  assert.deepEqual(await f.controller.finish('episode'),{ok:true,name:'mixed.webm'});
  assert.equal(f.controller.busy(),true);
  release({ok:false,message:'Disk unavailable'});
});
test('a closing original store cannot start another mixed recording', async () => {
  const f = fixture();
  f.setSnapshot({episodeId:'old',phase:'closed',closing:true,allSourcesComplete:false});
  assert.equal((await f.controller.begin()).ok,false);
  assert.equal(f.events.length,0);
});
test('incomplete originals require more than an hour after production, then explicit confirmation', async () => {
  const f = fixture();
  await f.controller.begin();
  f.advance(2 * 60 * 60 * 1000); // Long production time does not count as waiting for originals.
  assert.equal((await f.controller.closeSources()).ok, false);
  await f.controller.finish('episode');
  assert.equal((await f.controller.closeSources()).ok, false);
  assert.equal(f.events.some(event => event[0] === 'source-close'), false);
  f.setConfirm(true);
  f.advance(60 * 60 * 1000);
  assert.equal((await f.controller.closeSources()).ok, false);
  assert.equal(f.events.includes('confirm'),false,'no early override even with a willing confirmation');
  await f.controller.finish('episode'); // A repeated finish must not reset the elapsed wait.
  f.advance(1);
  assert.equal(f.controller.sourceStatus().incompleteOverrideInMs,0);
  f.setConfirm(false);
  assert.equal((await f.controller.closeSources()).ok, false);
  f.setConfirm(true);
  assert.equal((await f.controller.closeSources()).ok, true);
  assert.equal(f.controller.busy(), false);
  assert.equal((await f.controller.begin()).ok, true);
});
test('recovered incomplete originals start a fresh conservative override wait on first observation', async () => {
  const f = fixture();
  f.setSnapshot({ episodeId:'recovered', phase:'stopped', recovered:true, allSourcesComplete:false });
  assert.equal(f.controller.sourceStatus().incompleteOverrideInMs,60*60*1000+1);
  f.advance(60*60*1000);
  assert.equal(f.controller.sourceStatus().incompleteOverrideInMs,1);
  f.advance(1); f.setConfirm(true);
  assert.equal(f.controller.sourceStatus().incompleteOverrideInMs,0);
  assert.equal((await f.controller.closeSources()).ok,true);
  assert.deepEqual(f.events.slice(-2),['confirm',['source-close','recovered']]);
});
test('verified originals permit a subsequent recording without an incomplete-source confirmation', async () => {
  const f = fixture();
  f.setSnapshot({ episodeId: 'old', phase: 'stopped', allSourcesComplete: true });
  assert.equal(f.controller.busy(), false);
  assert.equal((await f.controller.begin()).ok, true);
  assert.deepEqual(f.events[0], ['source-close', 'old']);
});
test('concurrent recording starts cannot create two mixed/source pairs', async () => {
  const f = fixture();
  let release;
  f.sources.beginEpisode = () => new Promise(resolve => { release = resolve; });
  const begun = f.controller.begin();
  await Promise.resolve();
  assert.equal((await f.controller.begin()).ok, false);
  release({ ok: true }); await begun;
  assert.equal(f.events.filter(event => event === 'mixed-begin').length, 1);
});
test('source IPC pins host identity and refuses foreign or child frames and oversized bytes', async () => {
  const handlers = new Map(), calls = [];
  const contents = { isDestroyed: () => false, mainFrame: { url: STUDIO_URL } };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const source = Object.fromEntries(['beginSource','appendSource','finishSource'].map(name => [name, (...args) => { calls.push([name,...args]); return { ok: true }; }]));
  registerSourceBridge({ handle: (name, cb) => handlers.set(name, cb) }, () => contents, source);
  const append = handlers.get('blastcast:appendHostSource');
  const bytes = new ArrayBuffer(3);
  append(event, { episodeId: 'fixture' }, bytes);
  assert.equal(calls[0][1], 'host');
  assert.throws(() => append({ ...event, sender: {} }, {}, bytes), /Invalid host source/);
  assert.throws(() => append({ ...event, senderFrame: { url: STUDIO_URL } }, {}, bytes), /Invalid host source/);
  assert.throws(() => append(event, {}, new ArrayBuffer(8 * 1024 * 1024 + 1)), /Invalid host source/);
  assert.throws(() => append(event, {}, bytes, 'guest'), /Invalid host source/);
  assert.equal(calls.length, 1);
});
