// CodexBWAI — temporary discovery ownership, concurrency and cancellation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceAccess } from '../dist/device-access.js';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  const tracks = [], calls = [], messages = [], busy = [];
  const access = new DeviceAccess({ authorize: async () => true, canRequest: () => true, live: () => false,
    acquire: async constraints => { calls.push(constraints); const track = { readyState:'live', stop(){this.readyState='ended';} }; tracks.push(track); return { getTracks: () => [track] }; },
    refresh: async () => { assert.ok(tracks.every(t => t.readyState === 'live')); },
    message: (text,error) => messages.push({text,error}), busy: value => busy.push(value), ...overrides });
  return { access, tracks, calls, messages, busy };
}
test('concurrent dropdown requests use one permission flight and end all temporary tracks after listing', async () => {
  const gate = deferred(); let authorizations = 0;
  const f = fixture({ authorize: () => { authorizations++; return gate.promise; } });
  const first = f.access.prepare(), second = f.access.prepare(); assert.equal(first, second); assert.equal(f.access.busy,true);
  gate.resolve(true); await first;
  assert.equal(authorizations,1); assert.deepEqual(f.calls,[{video:true,audio:false},{video:false,audio:true}]);
  assert.ok(f.tracks.every(t => t.readyState === 'ended')); assert.deepEqual(f.busy,[true,false]);
});
test('denial can retry; missing camera does not suppress microphone discovery', async () => {
  let allow = false, cameraPresent = false, refreshes = 0; const kinds=[], tracks=[];
  const f = fixture({ authorize:async()=>allow, refresh:async()=>{refreshes++;}, acquire:async c=>{
    kinds.push(c.video?'video':'audio'); if(c.video&&!cameraPresent) throw new Error('NotFound');
    const track={ended:false,stop(){this.ended=true;}}; tracks.push(track); return {getTracks:()=>[track]};
  } });
  await f.access.prepare(); assert.deepEqual(kinds,[]); assert.match(f.messages.at(-1).text,/not granted/);
  allow=true; await f.access.prepare(); assert.deepEqual(kinds,['video','audio']); assert.equal(refreshes,1); assert.ok(tracks.every(t=>t.ended));
  cameraPresent=true; await f.access.prepare(); assert.deepEqual(kinds,['video','audio','video']); assert.ok(tracks.every(t=>t.ended));
});
test('cancelled in-flight capture stops late tracks and never refreshes or changes preview', async () => {
  const gate=deferred(); let refreshed=false; const track={ended:false,stop(){this.ended=true;}};
  const f=fixture({acquire:()=>gate.promise,refresh:async()=>{refreshed=true;}});
  const pending=f.access.prepare(); await Promise.resolve(); await Promise.resolve(); f.access.cancel(); gate.resolve({getTracks:()=>[track]}); await pending;
  assert.equal(track.ended,true); assert.equal(refreshed,false); assert.equal(f.access.busy,false);
});
test('live preview and blocked recording do not acquire or stop any tracks; failed enumeration retries', async () => {
  const live=fixture({live:()=>true}); await live.access.prepare(); assert.deepEqual(live.calls,[]);
  const recording=fixture({canRequest:()=>false}); await recording.access.prepare(); assert.deepEqual(recording.calls,[]);
  const f=fixture({refresh:async()=>false}); await f.access.prepare(); await f.access.prepare();
  assert.equal(f.calls.length,4); assert.ok(f.tracks.every(t=>t.readyState==='ended'));
});
