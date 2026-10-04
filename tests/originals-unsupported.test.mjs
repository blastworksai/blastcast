// ClaudeBWAI — a guest whose browser cannot record WebM (iOS < 18.4) still joins; the host never waits for their original.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { originalsSupported, ORIGINALS_UNSUPPORTED_GUEST_NOTICE, ORIGINALS_UNSUPPORTED_HOST_LABEL, SOURCE_MIME } from '../dist/source-protocol.js';
import { admissionRowLabel } from '../dist/admission-ui.js';
const require = createRequire(import.meta.url);
const { createGuestServer } = require('../desktop/guests.cjs');
const { createSourceController, closePolicy } = require('../desktop/source-controller.cjs');
const { configureReady } = require('./helpers/network-readiness.cjs');

test('support is detected up front from MediaRecorder.isTypeSupported(SOURCE_MIME)', () => {
  const seen = [];
  assert.equal(originalsSupported({ isTypeSupported: m => { seen.push(m); return false; } }), false);
  assert.deepEqual(seen, [SOURCE_MIME]);
  assert.equal(originalsSupported({ isTypeSupported: () => true }), true);
  assert.equal(originalsSupported(undefined), false);
  assert.equal(originalsSupported({}), false);
  assert.equal(originalsSupported({ isTypeSupported: () => { throw new Error('x'); } }), false);
});
test('the guest notice and host label are verbatim', () => {
  assert.equal(ORIGINALS_UNSUPPORTED_GUEST_NOTICE, "Your browser can't record a local copy, so the host records you from the call. You can still join.");
  assert.equal(ORIGINALS_UNSUPPORTED_HOST_LABEL, "No local copy (browser can't record)");
});
test('the guest page starts no capture and still joins when unsupported', () => {
  const guest = readFileSync(new URL('../src/guest.ts', import.meta.url), 'utf8');
  assert.match(guest, /originals\.update\(originalsOk && admitted && valid && !terminal, outgoing\)/);
  assert.match(guest, /originals\.update\(originalsOk && valid && admitted && !terminal, stream\)/);
  assert.match(guest, /originalsUnsupported: true/);
  assert.doesNotMatch(guest, /originals\.update\((?!originalsOk)/);
  assert.match(guest, /if \(!originalsOk\) status\('guest-original-status', ORIGINALS_UNSUPPORTED_GUEST_NOTICE\)/);
});
test('the host row names a guest without a local copy', () => {
  assert.equal(admissionRowLabel({ phase: 'admitted', presence: 'connected', originalsUnsupported: true }), `admitted — ${ORIGINALS_UNSUPPORTED_HOST_LABEL}`);
  assert.equal(admissionRowLabel({ phase: 'admitted', presence: 'connected' }), 'admitted');
});
test('the roster leaves an unsupported guest out and closePolicy never waits for them', async () => {
  let snapshot = null; const events = [];
  const recording = { isBusy: () => false, begin: async () => ({ ok: true, id: 'episode' }) };
  const sources = { status: () => snapshot, beginEpisode: async input => { events.push(input); snapshot = { episodeId: input.id, phase: 'recording', allSourcesComplete: false }; return { ok: true }; } };
  const guests = { status: () => ({ guests: [
    { alive: true, phase: 'admitted', session: { id: 'ok', name: 'Fine' } },
    { alive: true, phase: 'admitted', originalsUnsupported: true, session: { id: 'old', name: 'Old iPhone' } },
  ] }) };
  await createSourceController({ recording, sources, guests }).begin();
  assert.deepEqual(events[0].participants, [{ id: 'host', label: 'Host' }, { id: 'ok', label: 'Fine' }]);
  const state = { phase: 'stopped', allSourcesComplete: false, sources: [{ participantId: 'old', label: 'Old iPhone', phase: 'pending', idleMs: 0 }] };
  const admitted = [{ alive: true, phase: 'admitted', originalsUnsupported: true, session: { id: 'old' } }];
  const policy = closePolicy({ state, guests: admitted });
  assert.equal(policy.canClose, true);
  assert.equal(policy.incomplete[0].connected, false);
  assert.equal(closePolicy({ state, guests: [{ ...admitted[0], originalsUnsupported: undefined }] }).canClose, false);
});
function freePort() { return new Promise(resolve => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
function post(port, path, { token, host, origin, body }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ agent: false, hostname: '127.0.0.1', port, method: 'POST', path, headers: { authorization: `Bearer ${token}`, origin, host,
      'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', c => { data += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on('error', reject); req.end(payload);
  });
}
test('the host validates the guest report as a strict boolean and lists it', async t => {
  const port = await freePort(); const host = 'test.example.com', origin = 'https://test.example.com';
  const sources = { status: () => null };
  const guests = createGuestServer({ directory: '/dev/null', probe: () => Promise.resolve(), sources });
  t.after(() => guests.stop());
  await configureReady(guests, { origin, port });
  const token = guests.invite().invite.url.split('#invite=')[1];
  const redeemed = await post(port, '/api/redeem', { host, origin, token, body: { redemptionKey: randomBytes(32).toString('base64url') } });
  const session = redeemed.body.sessionCredential;
  await post(port, '/api/join', { host, origin, token: session, body: { name: 'Old', consent: true, consentVersion: '1' } });
  guests.admit(guests.status().guests[0].session.id);
  const send = body => post(port, '/api/source/status', { host, origin, token: session, body });
  for (const bad of [{ originalsUnsupported: 'true' }, { originalsUnsupported: 1 }, { originalsUnsupported: true, extra: 1 }, { other: true }]) assert.equal((await send(bad)).status, 400);
  assert.equal(guests.status().guests[0].originalsUnsupported, undefined);
  assert.equal((await send({ originalsUnsupported: true })).status, 200);
  assert.equal(guests.status().guests[0].originalsUnsupported, true);
  assert.equal((await send({ originalsUnsupported: false })).status, 200);
  assert.equal(guests.status().guests[0].originalsUnsupported, undefined);
});
