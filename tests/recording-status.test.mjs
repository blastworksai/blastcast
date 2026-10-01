// CodexBWAI — status must not turn delivery evidence into timing evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordingRows } from '../dist/recording-status.js';
const mixed = (phase = 'complete', episodeId = 'current') => ({ phase, episodeId, message:'Mixed status', pendingBytes:0, peakBytes:0 });
const source = (participantId, phase = 'complete', failed = false) => ({ participantId, label:participantId, phase, failed, bytes:1024, epochs:[] });
const status = (sources, phase = 'stopped', episodeId = 'current') => ({ episodeId, phase, hostNowMs:0, sources, allSourcesComplete:sources.every(s=>s.phase==='complete') });
test('saved mixed and verified originals have independent unmeasured synchronization', () => {
  const rows = recordingRows(mixed(), status([source('host'),source('guest')]));
  assert.deepEqual(rows.map(r=>r.delivery), ['saved','verified','verified']);
  assert.deepEqual(rows.map(r=>r.id), ['mixed','original:host','original:guest']);
  for (const row of rows) assert.deepEqual(row.synchronization, {state:'not_measured',label:'Not measured',limitMs:40});
});
test('missing, interrupted and failed originals do not change a saved mixed episode', () => {
  const rows = recordingRows(mixed(), status([source('missing','pending'),source('interrupted','incomplete'),source('disk','incomplete',true)]));
  assert.deepEqual(rows.map(r=>r.delivery), ['saved','incomplete','incomplete','failed']);
  assert.equal(rows[1].deliveryLabel,'Incomplete');
  assert.equal(rows[3].deliveryLabel,'Failed');
});
test('source phase and production phase distinguish awaiting, recording, transferring and finalizing', () => {
  for (const [phase, production, expected] of [
    ['pending','recording','not_started'], ['recording','recording','recording'],
    ['recording','stopped','transferring'], ['finalizing','stopped','finalizing'],
    ['pending','closed','incomplete'], ['complete','closed','verified'],
  ]) assert.equal(recordingRows(mixed(),status([source('host',phase)],production))[1].delivery,expected);
});
test('every mixed lifecycle phase has an explicit delivery label with unmeasured timing', () => {
  for (const [phase,expected] of Object.entries({idle:'not_started',starting:'not_started',recording:'recording',finalizing:'finalizing',complete:'saved',error:'failed'})) {
    const [row] = recordingRows(mixed(phase),null);
    assert.equal(row.delivery,expected); assert.ok(row.deliveryLabel.length);
    assert.equal(row.synchronization.state,'not_measured');
  }
});
test('new and failed starts cannot reuse a previous episode, including delayed status replies', () => {
  const old = status([source('previous')],'stopped','old');
  for (const state of [mixed('starting',null),mixed('error',null),mixed('recording'),mixed('error')]) {
    assert.equal(recordingRows(state,old).length,1);
  }
  assert.equal(recordingRows(mixed('error'),status([source('current')])).length,2);
});
test('restart recovery shows verified and incomplete originals without borrowing a mixed episode identity', () => {
  const recovered = { ...status([source('host'),source('guest','incomplete')],'stopped','recovered'), recovered:true };
  const rows = recordingRows(mixed('idle',null),recovered);
  assert.deepEqual(rows.map(row=>row.delivery),['not_started','verified','incomplete']);
  assert.match(rows[2].detail,/restart/i);
});
test('projection preserves labels as data and never mutates or retains source objects', () => {
  const input = status([source('<img src=x onerror=alert(1)>')]);
  const before = structuredClone(input);
  const rows = recordingRows(mixed(),input);
  assert.equal(rows[1].label,input.sources[0].label);
  rows[1].label='changed'; rows[1].synchronization.limitMs=999;
  assert.deepEqual(input,before);
  assert.equal(recordingRows(mixed(),input)[1].synchronization.limitMs,40);
});
