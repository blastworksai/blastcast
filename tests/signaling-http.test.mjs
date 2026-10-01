import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { createGuestServer } from '../desktop/guests.cjs';
import readinessHelpers from './helpers/network-readiness.cjs';
const { configureReady } = readinessHelpers;

function fetchLocal(port, path, method = 'POST', headers = {}, body = null, rawBody = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: { ...headers },
    };
    if (body) options.headers['Content-Type'] = 'application/json';
    if (rawBody) options.headers['Content-Type'] = 'application/json';

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, data, json });
      });
    });
    req.setTimeout(2000, () => req.destroy(new Error('HTTP fixture timed out')));
    req.on('error', reject);
    if (rawBody) req.write(rawBody);
    else if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function mockProbe(origin, nonce, proof, signal) {
  return Promise.resolve();
}

test('signaling HTTP boundaries', async (t) => {
  let time = 10000;
  const now = () => time;
  
  const server = createGuestServer({ directory: '.', now, probe: mockProbe });
  t.after(() => server.stop());
  const port = await new Promise(resolve => { const probe = http.createServer(); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
  const configureRes = await configureReady(server, { origin: 'https://test.local', port });
  assert.strictEqual(configureRes.ok, true);

  const inviteRes = server.invite();
  const inviteUrl = new URL(inviteRes.invite.url);
  const inviteToken = inviteUrl.hash.split('=')[1];

  const headers = {
    'Origin': 'https://test.local',
    'Host': 'test.local'
  };

  const redeemKey = 'fixture'.repeat(6) + 'x';
  const redeemReq = await fetchLocal(port, '/api/redeem', 'POST', {
    ...headers, 'Authorization': `Bearer ${inviteToken}`
  }, { redemptionKey: redeemKey });
  
  assert.strictEqual(redeemReq.status, 200);
  const sessionCred = redeemReq.json.sessionCredential;
  const authHeaders = { ...headers, 'Authorization': `Bearer ${sessionCred}` };

  await t.test('unauthorized signals rejected', async () => {
    // Session is only 'redeemed', not admitted
    const r1 = await fetchLocal(port, '/api/call/send', 'POST', authHeaders, { callId: 'fake-id-12345678901234', message: { type: 'hangup' }});
    assert.strictEqual(r1.status, 400);
    assert.strictEqual(r1.json.message, 'Not admitted.');
  });

  await fetchLocal(port, '/api/join', 'POST', authHeaders, { name: 'Alice', consent: true });
  
  // Admit the guest
  const statusRes = server.status();
  const guestId = statusRes.guests[0].session.id;
  server.admit(guestId);

  await t.test('guest send rejects host-only offer', async () => {
    const r = await fetchLocal(port, '/api/call/send', 'POST', authHeaders, { callId: 'fake-id-12345678901234', message: { type: 'description', description: { type: 'offer', sdp: 'fake' }}});
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.message, 'Guest must send answer.');
  });

  await t.test('HTTP body limit for non-call endpoints preserved', async () => {
    const hugeBody = { name: 'A'.repeat(3000), consent: true };
    try {
      await fetchLocal(port, '/api/join', 'POST', authHeaders, hugeBody);
      assert.fail('Should have failed');
    } catch (e) {
      assert.strictEqual(e.code, 'ECONNRESET');
    }
  });

  await t.test('HTTP body limit for call endpoints accommodates SDP', async () => {
    const bigSdp = '\u0001'.repeat(65536); // Worst-case JSON escaping within decoded64KiB cap
    const r = await fetchLocal(port, '/api/call/send', 'POST', authHeaders, { callId: 'fake-id-12345678901234', message: { type: 'description', description: { type: 'answer', sdp: bigSdp }}});
    // Not admitted to this callId yet (since host hasn't offered), but body is parsed
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.message, 'Stale callId.');
  });

  await t.test('JSON UTF8 length limit checked in candidate', async () => {
    const callId = 'test-call-id-123456789';
    server.sendSignal(guestId, callId, { type: 'description', description: { type: 'offer', sdp: 'fake' }});
    
    // 1000 characters of a 3-byte char = 3000 bytes > 2048 bytes
    const hugeUfrag = 'あ'.repeat(1000);
    const r = await fetchLocal(port, '/api/call/send', 'POST', authHeaders, { callId, message: { type: 'candidate', candidate: { candidate: 'x', sdpMid: 'audio', sdpMLineIndex: 0, usernameFragment: hugeUfrag }}});
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.message, 'Invalid signal message.');
  });

  await t.test('extra keys in poll/send rejected', async () => {
    const r = await fetchLocal(port, '/api/call/poll', 'POST', authHeaders, { callId: 'test-call-id-123456789', after: 0, extra: true });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.message, 'Invalid request.');
  });
  
  await t.test('invalid cursor types in poll rejected', async () => {
    for (const after of [NaN, Infinity, 1.5, -1, '0', null]) {
      const r = await fetchLocal(port, '/api/call/poll', 'POST', authHeaders, { callId: 'test-call-id-123456789', after });
      assert.strictEqual(r.status, 400);
    }
  });

  await server.stop();
});
