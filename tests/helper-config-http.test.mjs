// CodexBWAI — local-only proof of the helper credential HTTP and studio IPC boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import readiness from './helpers/network-readiness.cjs';

const require = createRequire(import.meta.url);
const { createGuestServer } = require('../desktop/guests.cjs');
const { registerGuestBridge, STUDIO_URL } = require('../desktop/boundary.cjs');
const { INVITE_TTL_MS } = require('../desktop/admission.cjs');
const { confirmGuestReadiness } = readiness;
const origin = 'https://helper.example.test';
const host = 'helper.example.test';
const secret = 'allocation-secret-only-in-call-config';
const relayUrl = 'turn:us.expressturn.com:3478?transport=udp';
const helper = {
  provider: 'cloudflare', freeAccountConfirmed: true,
  relay: { urls: [relayUrl], username: 'allocation-user', credential: secret, iceTransportPolicy: 'relay' },
};

async function freePort() {
  return new Promise(resolve => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function request(port, path, { token, requestHost = host, requestOrigin = origin, body = {}, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const payload = method === 'POST' ? JSON.stringify(body) : '';
    const headers = { host: requestHost, origin: requestOrigin };
    if (token) headers.authorization = `Bearer ${token}`;
    if (method === 'POST') { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); }
    const req = http.request({ agent: false, hostname: '127.0.0.1', port, path, method, headers }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, text: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('local request timed out')));
    req.end(payload);
  });
}

async function configureReady(guests, port, selectedHelper = helper) {
  const config = { origin, port, routeType: selectedHelper ? 'tunnel' : 'direct', ...(selectedHelper ? { helper: selectedHelper } : {}) };
  const initial = await guests.configure(config);
  assert.equal(initial.phase, 'outside-check');
  assert.equal((await confirmGuestReadiness(guests)).status, 200);
  return guests.status();
}

async function openSession(guests, port, name = 'Alice') {
  const invite = guests.invite().invite.url;
  const inviteToken = new URL(invite).hash.slice('#invite='.length);
  const redeemed = await request(port, '/api/redeem', { token: inviteToken, body: { redemptionKey: 'r'.repeat(43) } });
  assert.equal(redeemed.status, 200);
  const token = redeemed.body.sessionCredential;
  assert.equal((await request(port, '/api/join', { token, body: { name, consent: true } })).status, 200);
  const sessionId = guests.status().guests.find(g => g.session?.name === name).session.id;
  return { token, sessionId };
}

test('call configuration is admitted-only, scoped to the route, and absent from public metadata', async t => {
  let nowMs = 10_000;
  const guests = createGuestServer({ directory: '.', now: () => nowMs, probe: async () => {} });
  t.after(() => guests.stop());
  const port = await freePort();
  const first = await guests.configure({ origin, port, routeType: 'tunnel', helper });
  assert.equal(first.phase, 'outside-check');
  assert.equal(JSON.stringify(first).includes(secret), false);
  assert.equal((await request(port, '/api/call/config', { token: 'x'.repeat(43) })).status, 503);
  const check = await confirmGuestReadiness(guests);
  assert.equal(check.status, 200);
  assert.equal(JSON.stringify(check.body).includes(secret), false);
  assert.deepEqual(guests.status().helper, { provider: 'cloudflare', iceTransportPolicy: 'relay', quota: 'unknown' });
  assert.equal(JSON.stringify(guests.status()).includes(secret), false);

  const pending = await openSession(guests, port);
  assert.equal((await request(port, '/api/call/config', { token: pending.token })).status, 400);
  assert.equal(guests.callConfiguration(pending.sessionId).ok, false);
  assert.equal((await request(port, '/api/call/config')).status, 410);
  assert.equal((await request(port, '/api/call/config', { token: pending.token, requestHost: 'wrong.example.test' })).status, 403);
  assert.equal((await request(port, '/api/call/config', { token: pending.token, requestOrigin: 'https://wrong.example.test' })).status, 403);

  assert.equal(guests.admit(pending.sessionId).ok, true);
  const config = await request(port, '/api/call/config', { token: pending.token });
  assert.equal(config.status, 200);
  assert.equal(config.headers['cache-control'], 'no-store');
  assert.deepEqual(config.body, { ok: true, iceServers: [{ urls: [relayUrl], username: 'allocation-user', credential: secret }], iceTransportPolicy: 'relay' });
  assert.equal((await request(port, '/api/call/config', { token: pending.token, body: { extra: true } })).status, 400);
  const hostConfig = guests.callConfiguration(pending.sessionId);
  hostConfig.iceServers[0].urls[0] = 'changed';
  assert.equal(guests.callConfiguration(pending.sessionId).iceServers[0].urls[0], relayUrl);
  assert.equal((await request(port, '/api/status', { token: pending.token })).text.includes(secret), false);
  assert.equal(JSON.stringify(guests.status()).includes(secret), false);

  assert.equal(guests.remove(pending.sessionId).ok, true);
  assert.equal(guests.callConfiguration(pending.sessionId).ok, false);
  assert.equal((await request(port, '/api/call/config', { token: pending.token })).status, 410);

  // ClaudeBWAI — einh 2 Oct ("Guests that connect via a link expire the token"): once admitted, the link's
  // 30-minute doorway timer no longer ends the guest's call; revoking still does.
  const admitted = await openSession(guests, port, 'Bob');
  assert.equal(guests.admit(admitted.sessionId).ok, true);
  nowMs += INVITE_TTL_MS + 1;
  assert.equal(guests.callConfiguration(admitted.sessionId).iceServers[0].urls[0], relayUrl);
  assert.equal((await request(port, '/api/call/config', { token: admitted.token })).status, 200);
  guests.revoke();
  assert.equal(guests.callConfiguration(admitted.sessionId).ok, false);
  assert.equal((await request(port, '/api/call/config', { token: admitted.token })).status, 410);
});

test('invalid helper keeps the active route; reconfigure and stop revoke old allocation access', async t => {
  const guests = createGuestServer({ directory: '.', probe: async () => {} });
  t.after(() => guests.stop());
  const firstPort = await freePort();
  await configureReady(guests, firstPort);
  const admitted = await openSession(guests, firstPort);
  guests.admit(admitted.sessionId);
  const before = guests.status();
  const invalid = await guests.configure({ origin, port: firstPort, routeType: 'tunnel', helper: { ...helper, relay: { ...helper.relay, credential: '' } } });
  assert.equal(invalid.ok, false);
  assert.equal(guests.status().phase, before.phase);
  assert.equal(guests.status().port, before.port);
  assert.equal((await request(firstPort, '/api/call/config', { token: admitted.token })).body.iceServers[0].credential, secret);

  const secondPort = await freePort();
  await configureReady(guests, secondPort, null);
  assert.equal(guests.status().helper, null);
  assert.equal(guests.callConfiguration(admitted.sessionId).ok, false);
  assert.equal((await request(secondPort, '/api/call/config', { token: admitted.token })).status, 410);
  const direct = await openSession(guests, secondPort, 'Direct');
  guests.admit(direct.sessionId);
  assert.deepEqual((await request(secondPort, '/api/call/config', { token: direct.token })).body,
    { ok: true, iceServers: [], iceTransportPolicy: 'all' });
  await guests.stop();
  assert.equal(guests.callConfiguration(direct.sessionId).ok, false);
  assert.equal(guests.status().helper, null);
});

test('studio IPC call configuration accepts one stable ID only from the trusted main frame', () => {
  const handlers = new Map();
  const calls = [];
  const frame = { url: STUDIO_URL };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const guests = Object.fromEntries(['configure', 'admit', 'reject', 'remove', 'revokeInvite', 'sendSignal', 'pollSignals']
    .map(name => [name, () => ({ ok: true })]));
  guests.callConfiguration = id => { calls.push(id); return { ok: true, iceServers: [] }; };
  registerGuestBridge({ handle: (name, fn) => handlers.set(name, fn) }, () => contents, guests);
  const handler = handlers.get('blastcast:getGuestCallConfiguration');
  const event = { sender: contents, senderFrame: frame };
  const id = 'a'.repeat(22);
  assert.deepEqual(handler(event, id), { ok: true, iceServers: [] });
  for (const args of [[], [id, id], [null], ['a'.repeat(21)], ['a'.repeat(23)], ['a/'.repeat(11)]])
    assert.throws(() => handler(event, ...args));
  assert.throws(() => handler({ ...event, sender: {} }, id));
  assert.throws(() => handler({ ...event, senderFrame: { url: STUDIO_URL } }, id));
  frame.url = 'https://remote.example.test';
  assert.throws(() => handler(event, id));
  assert.deepEqual(calls, [id]);
});
