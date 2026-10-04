// ClaudeBWAI — einh 3 Oct, "Disconnected, can rejoin": presence is separate from admission. A guest whose page goes
// quiet shows as disconnected within ~15 s, leaves the live list and the scene, keeps Remove, and counts as unable to
// deliver for the close policy; the same browser rejoining goes back through the waiting list.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { liveGuest } from '../dist/host-calls.js';
import { admissionRowLabel } from '../dist/admission-ui.js';
const require = createRequire(import.meta.url);
const { createGuestServer, createPresenceTracker, PRESENCE_TIMEOUT_MS } = require('../desktop/guests.cjs');
const { closePolicy, createSourceController } = require('../desktop/source-controller.cjs');
const { configureReady } = require('./helpers/network-readiness.cjs');

function post(port, path, token, body = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', agent: false,
      headers: { Host: 'presence.test', Origin: 'https://presence.test', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, response => {
      let data = ''; response.on('data', c => { data += c; });
      response.on('end', () => { let json = null; try { json = JSON.parse(data); } catch {} resolve({ status: response.statusCode, json }); });
    });
    request.on('error', reject); request.end(payload);
  });
}
const freePort = () => new Promise(resolve => { const probe = http.createServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });

test('presence tracker: connected within the timeout, disconnected after it, connected again on the next request', () => {
  let t = 0;
  const presence = createPresenceTracker({ now: () => t });
  assert.equal(presence.state('a'), 'disconnected', 'never seen');
  presence.touch('a'); assert.equal(presence.state('a'), 'connected');
  t += PRESENCE_TIMEOUT_MS; assert.equal(presence.state('a'), 'connected');
  t += 1; assert.equal(presence.state('a'), 'disconnected');
  presence.touch('a'); assert.equal(presence.state('a'), 'connected');
  presence.clear(); assert.equal(presence.state('a'), 'disconnected');
  assert.ok(PRESENCE_TIMEOUT_MS <= 15_000, 'about 15 s at most');
});

test('a guest whose page goes quiet is shown disconnected (still admitted), and the same browser rejoins through the waiting list', async t => {
  let time = 1_000_000;
  const server = createGuestServer({ directory: '.', now: () => time, probe: async () => {} });
  t.after(() => server.stop());
  const port = await freePort();
  assert.equal((await configureReady(server, { origin: 'https://presence.test', port })).ok, true);
  const invite = new URL(server.invite().invite.url).hash.split('=')[1];
  const key = 'k'.repeat(43);
  const redeemed = await post(port, '/api/redeem', invite, { redemptionKey: key });
  assert.equal(redeemed.status, 200);
  const credential = redeemed.json.sessionCredential;
  assert.equal((await post(port, '/api/join', credential, { name: 'Phone', consent: true })).status, 200);
  const sessionId = server.status().guests[0].session.id;
  assert.equal(server.admit(sessionId).ok, true);
  let row = server.status().guests[0];
  assert.deepEqual([row.phase, row.presence], ['admitted', 'connected']);
  assert.equal(liveGuest(row), true);

  time += 2000; await post(port, '/api/status', credential); // the page's 2 s status poll keeps it present
  time += PRESENCE_TIMEOUT_MS - 1000;
  assert.equal(server.status().guests[0].presence, 'connected');

  time += 2000; // tab closed: no request for longer than the timeout
  row = server.status().guests[0];
  assert.deepEqual([row.phase, row.presence], ['admitted', 'disconnected'], 'admission and presence stay separate');
  assert.equal(liveGuest(row), false, 'leaves the live list and the scene');
  assert.equal(admissionRowLabel(row), 'Disconnected — can rejoin from the same browser');
  assert.equal(admissionRowLabel({ phase: 'admitted', presence: 'connected' }), 'admitted');

  // Same browser, reload: the same redemption key redeems again and lands in the waiting list for re-admit.
  const rejoin = await post(port, '/api/redeem', invite, { redemptionKey: key });
  assert.equal(rejoin.status, 200);
  assert.equal((await post(port, '/api/join', rejoin.json.sessionCredential, { name: 'Phone', consent: true })).status, 200);
  row = server.status().guests[0];
  assert.equal(row.phase, 'pending');
  assert.equal(server.admit(sessionId).ok, true);
  row = server.status().guests[0];
  assert.deepEqual([row.phase, row.presence, row.session.id], ['admitted', 'connected', sessionId], 'one row, back live');

  // Another browser with the same link is still refused.
  assert.equal((await post(port, '/api/redeem', invite, { redemptionKey: 'x'.repeat(43) })).status, 410);

  // Remove still works on a disconnected guest.
  time += PRESENCE_TIMEOUT_MS + 1;
  assert.equal(server.status().guests[0].presence, 'disconnected');
  assert.equal(server.remove(sessionId).ok, true);
  assert.equal(server.status().guests[0].phase, 'removed');
});

test('closePolicy follows source activity, not presence: an in-flight upload or recent piece keeps a guest able to deliver (Codex P1)', async () => {
  const G = 'B'.repeat(22);
  const state = (idleMs) => ({ episodeId: 'e', phase: 'stopped', allSourcesComplete: false, incompleteOverrideInMs: 3e6,
    sources: [{ participantId: 'host', label: 'Host', phase: 'complete', idleMs: 0 }, { participantId: G, label: 'Phone', phase: 'recording', idleMs }] });
  const guest = (presence, uploading = false) => [{ alive: true, revoked: false, phase: 'admitted', presence, uploading, session: { id: G, name: 'Phone' } }];
  // A backgrounded phone: presence expired (no request started for > 12 s), one upload still open.
  let p = closePolicy({ state: state(20_000), guests: guest('disconnected', true) });
  assert.deepEqual([p.canClose, p.incomplete[0].connected], [false, true], 'an open upload keeps the guest able to deliver');
  p = closePolicy({ state: state(200_000), guests: guest('disconnected', true) });
  assert.equal(p.canClose, false, 'even past STALE_MS, an in-flight upload blocks closing');
  p = closePolicy({ state: state(20_000), guests: guest('disconnected') });
  assert.equal(p.canClose, false, 'a piece stored 20 s ago still counts, whatever presence says');
  p = closePolicy({ state: state(121_000), guests: guest('disconnected') });
  assert.deepEqual([p.canClose, p.reason, p.incomplete[0].connected], [true, 'nobody-can-deliver', false], 'quiet for > 2 min and nothing in flight');
  p = closePolicy({ state: state(1000), guests: [] });
  assert.equal(p.canClose, true, 'a guest no longer admitted cannot deliver');
});

test('an upload still open when the presence timeout passes keeps the guest present and uploading; completion refreshes presence', async t => {
  let time = 5_000_000;
  let release;
  const sources = {
    status: () => null, recoveryKey: () => null,
    appendSource: () => new Promise(resolve => { release = () => resolve({ ok: true }); }),
  };
  const server = createGuestServer({ directory: '.', now: () => time, probe: async () => {}, sources });
  t.after(() => server.stop());
  const port = await freePort();
  assert.equal((await configureReady(server, { origin: 'https://presence.test', port })).ok, true);
  const invite = new URL(server.invite().invite.url).hash.split('=')[1];
  const credential = (await post(port, '/api/redeem', invite, { redemptionKey: 'q'.repeat(43) })).json.sessionCredential;
  await post(port, '/api/join', credential, { name: 'Phone', consent: true });
  const sessionId = server.status().guests[0].session.id;
  server.admit(sessionId);
  // Start a chunk upload that the host holds open (a slow phone upload).
  const body = Buffer.alloc(16, 1);
  const pending = new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: '/api/source/chunk', method: 'POST', agent: false,
      headers: { Host: 'presence.test', Origin: 'https://presence.test', Authorization: `Bearer ${credential}`, 'Content-Type': 'application/octet-stream',
        'Content-Length': body.length, 'X-Blastcast-Source': JSON.stringify({ episodeId: 'x' }) } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject); request.end(body);
  });
  for (let i = 0; i < 100 && !release; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(release, 'the upload reached the host');
  time += PRESENCE_TIMEOUT_MS + 8000; // 20 s with the upload open and no other request
  let row = server.status().guests[0];
  assert.deepEqual([row.uploading, row.presence], [true, 'connected']);
  release();
  assert.equal(await pending, 200);
  row = server.status().guests[0];
  assert.deepEqual([row.uploading, row.presence], [false, 'connected'], 'completion counts as the page being there');
  time += PRESENCE_TIMEOUT_MS + 1;
  assert.equal(server.status().guests[0].presence, 'disconnected');
});

test('the recording roster leaves out a disconnected guest', async () => {
  const G = 'B'.repeat(22);
  const guest = presence => [{ alive: true, revoked: false, phase: 'admitted', presence, session: { id: G, name: 'Phone' } }];
  const begun = [];
  const controller = createSourceController({
    recording: { isBusy: () => false, begin: async () => ({ ok: true, id: 'ep' }), abort: async () => ({}) },
    sources: { status: () => null, beginEpisode: async input => { begun.push(input.participants); return { ok: true }; } },
    guests: { status: () => ({ guests: [...guest('disconnected'), { alive: true, revoked: false, phase: 'admitted', presence: 'connected', session: { id: 'C'.repeat(22), name: 'Here' } }] }) },
  });
  assert.equal((await controller.begin()).ok, true);
  assert.deepEqual(begun[0], [{ id: 'host', label: 'Host' }, { id: 'C'.repeat(22), label: 'Here' }]);
});

test('a lost-media session reads Disconnected even while its page still polls; a new connect clears it', async () => {
  const { setGuestMediaLost } = await import('../dist/admission-ui.js');
  const row = { phase: 'admitted', presence: 'connected', session: { id: 'lost-1' } };
  assert.equal(admissionRowLabel(row), 'admitted');
  setGuestMediaLost('lost-1', true);
  assert.equal(admissionRowLabel(row), 'Disconnected — can rejoin from the same browser');
  setGuestMediaLost('lost-1', false);
  assert.equal(admissionRowLabel(row), 'admitted');
});
