// BWTV — guest server route, auth, consent and bounds tests.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createGuestServer: createRawGuestServer, parseRoute: parseRawRoute } = require('../desktop/guests.cjs');
const { INVITE_TTL_MS: INVITE_MS, MAX_GUESTS: MAX_INVITES } = require('../desktop/admission.cjs');
const { randomBytes } = require('node:crypto');
const { createTLSFixture } = require('./helpers/tls-fixture.cjs');
const { confirmGuestReadiness } = require('./helpers/network-readiness.cjs');

// ── helpers ──────────────────────────────────────────────────────────────

function request(port, method, path, { token, origin, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (origin) headers.origin = origin;
    if (host) headers.host = host;
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ agent: false, hostname: '127.0.0.1', port, method, path, headers }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function freePort() {
  return new Promise(resolve => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}

// A resolved probe so configure succeeds without a real HTTPS proxy.
const resolvedProbe = async () => {};

// Existing boundary tests still need a ready route. This wrapper reaches that
// state only through the production HTTP confirmation endpoint.
function createGuestServer(options) {
  const guests = createRawGuestServer(options);
  const configureOutside = guests.configure;
  guests.configureOutside = input => configureOutside({ routeType: 'direct', ...input });
  guests.configure = async input => {
    const configured = await guests.configureOutside(input);
    if (!configured.ok || configured.phase !== 'outside-check') return configured;
    const confirmed = await confirmGuestReadiness(guests);
    return confirmed.status === 200 ? guests.status() : { ok: false, message: 'Test readiness confirmation failed.' };
  };
  return guests;
}
function parseRoute(input) {
  return parseRawRoute(input && typeof input === 'object' ? { routeType: 'direct', ...input } : input);
}

// ── parseRoute ───────────────────────────────────────────────────────────

describe('parseRoute', () => {
  test('accepts valid HTTPS origin and port', () => {
    const r = parseRoute({ origin: 'https://guests.example.com', port: 8443, routeType: 'direct' });
    assert.equal(r.origin, 'https://guests.example.com');
    assert.equal(r.host, 'guests.example.com');
    assert.equal(r.port, 8443);
    assert.equal(r.routeType, 'direct');
  });
  test('accepts only the two explicit route types', () => {
    assert.equal(parseRoute({ origin: 'https://guests.example.com', port: 8443, routeType: 'tunnel' }).routeType, 'tunnel');
    assert.throws(() => parseRoute({ origin: 'https://guests.example.com', port: 8443, routeType: 'turn' }), /route type/i);
    assert.throws(() => parseRawRoute({ origin: 'https://guests.example.com', port: 8443 }), /HTTPS address/i);
  });
  test('rejects HTTP scheme', () => {
    assert.throws(() => parseRoute({ origin: 'http://example.com', port: 8443 }), /HTTPS/);
  });
  test('rejects origin with path', () => {
    assert.throws(() => parseRoute({ origin: 'https://example.com/path', port: 8443 }), /path/);
  });
  test('rejects origin with password', () => {
    assert.throws(() => parseRoute({ origin: 'https://user:pass@example.com', port: 8443 }), /password/);
  });
  test('rejects origin with query', () => {
    assert.throws(() => parseRoute({ origin: 'https://example.com?q=1', port: 8443 }), /query/);
  });
  test('rejects origin with fragment', () => {
    assert.throws(() => parseRoute({ origin: 'https://example.com#f', port: 8443 }), /fragment/);
  });
  test('rejects port below 1024', () => {
    assert.throws(() => parseRoute({ origin: 'https://example.com', port: 80 }), /1024/);
  });
  test('rejects port above 65535', () => {
    assert.throws(() => parseRoute({ origin: 'https://example.com', port: 70000 }), /65535/);
  });
  test('rejects non-integer port', () => {
    assert.throws(() => parseRoute({ origin: 'https://example.com', port: 8443.5 }));
  });
  test('rejects extra keys', () => {
    assert.throws(() => parseRoute({ origin: 'https://example.com', port: 8443, extra: 1 }));
  });
  test('rejects missing origin', () => {
    assert.throws(() => parseRoute({ port: 8443 }));
  });
  test('rejects null input', () => {
    assert.throws(() => parseRoute(null));
  });
});

// ── server lifecycle ─────────────────────────────────────────────────────

describe('guest server lifecycle', () => {
  test('configure starts server, stop shuts it down', async (t) => {
    const port = await freePort();
    const guests = createGuestServer({ directory: '/dev/null', probe: resolvedProbe }); t.after(() => guests.stop());
    const result = await guests.configure({ origin: 'https://test.example.com', port });
    assert.equal(result.ok, true);
    assert.equal(result.phase, 'ready');
    await guests.stop();
    assert.equal(guests.status().phase, 'off');
  });

  test('reconfigure replaces previous server', async (t) => {
    const port1 = await freePort();
    const port2 = await freePort();
    const guests = createGuestServer({ directory: '/dev/null', probe: resolvedProbe }); t.after(() => guests.stop());
    await guests.configure({ origin: 'https://a.example.com', port: port1 });
    const result = await guests.configure({ origin: 'https://b.example.com', port: port2 });
    assert.equal(result.ok, true);
    assert.equal(result.origin, 'https://b.example.com');
    await guests.stop();
  });

  test('concurrent configure is rejected without replacing the active check', async (t) => {
    const port = await freePort();
    const guests = createRawGuestServer({ directory: '/dev/null', probe: resolvedProbe }); t.after(() => guests.stop());
    const first = guests.configure({ origin: 'https://a.example.com', port, routeType: 'direct' });
    const second = guests.configure({ origin: 'https://b.example.com', port: port + 1, routeType: 'direct' });
    
    const res1 = await first;
    const res2 = await second;
    
    assert.equal(res1.ok, true);
    assert.equal(res1.phase, 'outside-check');
    assert.equal(res2.ok, false);
    assert.match(res2.message, /in progress/);
    assert.equal(guests.status().origin, 'https://a.example.com');

    await guests.stop();
  });

  test('failed host probe leaves outside confirmation available and becomes a hint', async (t) => {
    const port = await freePort();
    const guests = createRawGuestServer({ directory: '/dev/null', probe: async () => { const error = new Error('unreachable'); error.code = 'ECONNREFUSED'; throw error; } }); t.after(() => guests.stop());
    const result = await guests.configure({ origin: 'https://bad.example.com', port, routeType: 'direct' });
    assert.equal(result.phase, 'outside-check');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(guests.status().readiness.hint.code, 'HOST_ROUTE_UNREACHABLE');
    assert.equal((await confirmGuestReadiness(guests)).status, 200);
    assert.equal(guests.status().phase, 'ready');
  });

  test('stop during an outside check revokes it', async (t) => {
    const port = await freePort();
    const guests = createRawGuestServer({ directory: '/dev/null', probe: () => new Promise(() => {}) }); t.after(() => guests.stop());
    const configured = await guests.configure({ origin: 'https://a.example.com', port, routeType: 'direct' });
    assert.equal(configured.phase, 'outside-check');
    await guests.stop();
    assert.equal(guests.status().phase, 'off');
    assert.equal(guests.status().readiness, null);
  });
});

describe('outside-network readiness', () => {
  test('requires exact browser evidence, then permits bounded idempotency', async t => {
    const port = await freePort();
    const guests = createRawGuestServer({ directory: '/dev/null', probe: resolvedProbe }); t.after(() => guests.stop());
    const configured = await guests.configure({ origin: 'https://test.example.com', port, routeType: 'direct' });
    assert.equal(configured.phase, 'outside-check');
    assert.deepEqual(configured.readiness.stages, { listener: 'passed', address: 'pending', https: 'pending', route: 'pending', outside: 'pending' });
    const checkUrl = configured.readiness.check.url;
    assert.equal((await confirmGuestReadiness(guests, { token: 'x'.repeat(43) })).status, 410);
    assert.equal((await confirmGuestReadiness(guests, { body: { outsideNetwork: true, secureWithoutBypass: false } })).status, 400);
    assert.equal(guests.status().phase, 'outside-check');
    assert.equal((await confirmGuestReadiness(guests)).status, 200);
    assert.equal(guests.status().phase, 'ready');
    assert.deepEqual(guests.status().readiness.stages, { listener: 'passed', address: 'passed', https: 'passed', route: 'passed', outside: 'passed' });
    assert.equal(guests.status().readiness.check, null);
    assert.equal((await confirmGuestReadiness(guests, { checkUrl })).status, 200);
  });

  test('invalid configuration leaves the current generation intact', async t => {
    const port = await freePort();
    const guests = createRawGuestServer({ directory: '/dev/null', probe: resolvedProbe }); t.after(() => guests.stop());
    const configured = await guests.configure({ origin: 'https://test.example.com', port, routeType: 'direct' });
    assert.equal((await confirmGuestReadiness(guests)).status, 200);
    const invitation = guests.invite().invite.url;
    const rejected = await guests.configure({ origin: 'http://bad.example.com', port, routeType: 'direct' });
    assert.equal(rejected.ok, false);
    assert.equal(guests.status().phase, 'ready');
    assert.equal(guests.status().invite.url, invitation);
    assert.equal(configured.readiness.check.url.startsWith('https://test.example.com/readiness#check='), true);
  });

  test('host-probe evidence maps to the closed nonblocking hint codes', async t => {
    for (const [errorCode, expected, message] of [
      ['ENOTFOUND', 'HOST_DNS_LOOKUP_FAILED', /resolve/],
      ['CERT_HAS_EXPIRED', 'HOST_TLS_VALIDATION_FAILED', /Do not bypass/],
      ['HOST_ROUTE_MISMATCH', 'HOST_ROUTE_MISMATCH', /exact route check/],
      ['ECONNRESET', 'HOST_ROUTE_UNREACHABLE', /Hairpin NAT/],
    ]) {
      const port = await freePort();
      const probe = async () => { const error = new Error(errorCode); error.code = errorCode; throw error; };
      const guests = createRawGuestServer({ directory: '/dev/null', probe });
      t.after(() => guests.stop());
      await guests.configure({ origin: 'https://test.example.com', port, routeType: 'direct' });
      await new Promise(resolve => setImmediate(resolve));
      const status = guests.status();
      assert.equal(status.phase, 'outside-check');
      assert.equal(status.readiness.hint.code, expected);
      assert.match(status.readiness.hint.message, message);
      await guests.stop();
    }
  });

  test('direct and tunnel failures are explicit and never retry', async t => {
    const port1 = await freePort(), port2 = await freePort();
    const guests = createRawGuestServer({ directory: '/dev/null', probe: resolvedProbe }); t.after(() => guests.stop());
    await guests.configure({ origin: 'https://direct.example.com', port: port1, routeType: 'direct' });
    assert.equal(guests.failReadiness().readiness.diagnosis.code, 'DIRECT_OUTSIDE_UNREACHABLE');
    assert.deepEqual(guests.status().readiness.stages, { listener: 'passed', address: 'not-proven', https: 'not-proven', route: 'not-proven', outside: 'failed' });
    assert.equal(guests.status().readiness.check, null);
    await guests.configure({ origin: 'https://tunnel.example.com', port: port2, routeType: 'tunnel' });
    const failed = guests.failReadiness();
    assert.equal(failed.readiness.diagnosis.code, 'PROVIDER_OUTSIDE_UNREACHABLE');
    assert.match(failed.readiness.diagnosis.message, /does not provide TURN/);
  });

  test('monotonic expiry ignores wall-clock rollback and closes the token', async t => {
    let wall = 10_000, mono = 50;
    const port = await freePort();
    const guests = createRawGuestServer({ directory: '/dev/null', probe: resolvedProbe, now: () => wall, monotonicNow: () => mono }); t.after(() => guests.stop());
    const configured = await guests.configure({ origin: 'https://test.example.com', port, routeType: 'direct' });
    assert.equal(configured.readiness.check.expiresAt, 610_000);
    wall = -1_000_000;
    mono = 600_049;
    assert.equal(guests.status().phase, 'outside-check');
    mono = 600_050;
    const expired = guests.status();
    assert.equal(expired.phase, 'blocked');
    assert.equal(expired.readiness.diagnosis.code, 'OUTSIDE_CHECK_EXPIRED');
    assert.equal(expired.readiness.check, null);
  });

  test('confirmation expiring while its body is in flight cannot make the route ready', async t => {
    let mono = 0;
    const port = await freePort(), origin = 'https://test.example.com';
    const guests = createRawGuestServer({ directory: '/dev/null', probe: resolvedProbe, monotonicNow: () => mono }); t.after(() => guests.stop());
    const configured = await guests.configure({ origin, port, routeType: 'direct' });
    const check = new URL(configured.readiness.check.url);
    const token = check.hash.slice('#check='.length);
    const payload = JSON.stringify({ outsideNetwork: true, secureWithoutBypass: true });
    let finish;
    const response = new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/api/readiness/confirm', headers: {
        host: check.host, origin, authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
      } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.write(payload.slice(0, 10));
      finish = () => req.end(payload.slice(10));
    });
    await new Promise(resolve => setImmediate(resolve));
    mono = 600_000;
    finish();
    assert.equal(await response, 410);
    assert.equal(guests.status().phase, 'blocked');
  });

  test('occupied local port has its own blocked state', async t => {
    const port = await freePort();
    const occupied = http.createServer();
    await new Promise(resolve => occupied.listen(port, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => occupied.close(resolve)));
    const guests = createRawGuestServer({ directory: '/dev/null', probe: resolvedProbe }); t.after(() => guests.stop());
    const result = await guests.configure({ origin: 'https://test.example.com', port, routeType: 'direct' });
    assert.equal(result.phase, 'blocked');
    assert.equal(result.readiness.diagnosis.code, 'LOCAL_PORT_BUSY');
    assert.deepEqual(result.readiness.stages, { listener: 'failed', address: 'not-proven', https: 'not-proven', route: 'not-proven', outside: 'failed' });
  });
});

// ── invitation management ────────────────────────────────────────────────

describe('invitation management', () => {
  test('invite requires verified route', (t) => {
    const guests = createGuestServer({ directory: '/dev/null', probe: resolvedProbe }); t.after(() => guests.stop());
    const result = guests.invite();
    assert.equal(result.ok, false);
    assert.match(result.message, /check/i);
  });

  test('invite creates URL with token in fragment', async (t) => {
    const port = await freePort();
    const guests = createGuestServer({ directory: '/dev/null', probe: resolvedProbe }); t.after(() => guests.stop());
    await guests.configure({ origin: 'https://test.example.com', port });
    const result = guests.invite();
    assert.equal(result.ok, true);
    assert.ok(result.invite);
    assert.match(result.invite.url, /^https:\/\/test\.example\.com\/#invite=[A-Za-z0-9_-]{43}$/);
    assert.ok(result.invite.expiresAt > Date.now());
    await guests.stop();
  });

  test('invite respects MAX_INVITES limit', async (t) => {
    const port = await freePort();
    const guests = createGuestServer({ directory: '/dev/null', probe: resolvedProbe }); t.after(() => guests.stop());
    await guests.configure({ origin: 'https://test.example.com', port });
    for (let i = 0; i < MAX_INVITES; i++) assert.equal(guests.invite().ok, true);
    const overflow = guests.invite();
    assert.equal(overflow.ok, false);
    assert.match(overflow.message, /7 invitations/);
    await guests.stop();
  });

  test('revoke clears all invitations', async (t) => {
    const port = await freePort();
    const guests = createGuestServer({ directory: '/dev/null', probe: resolvedProbe }); t.after(() => guests.stop());
    await guests.configure({ origin: 'https://test.example.com', port });
    guests.invite();
    const result = guests.revoke();
    assert.equal(result.ok, true);
    assert.equal(result.invite, null);
    assert.ok(result.guests.every(g => !g.alive));
    await guests.stop();
  });

  test('stop invalidates all invitations', async (t) => {
    const port = await freePort();
    const guests = createGuestServer({ directory: '/dev/null', probe: resolvedProbe }); t.after(() => guests.stop());
    await guests.configure({ origin: 'https://test.example.com', port });
    guests.invite();
    await guests.stop();
    assert.equal(guests.status().invite, null);
    assert.equal(guests.status().phase, 'off');
  });

  test('expired invitations are pruned', async (t) => {
    let clock = 1000;
    const port = await freePort();
    const guests = createGuestServer({ directory: '/dev/null', probe: resolvedProbe, now: () => clock }); t.after(() => guests.stop());
    await guests.configure({ origin: 'https://test.example.com', port });
    guests.invite();
    assert.ok(guests.status().invite);
    clock += INVITE_MS + 1;
    assert.equal(guests.status().invite, null);
    await guests.stop();
  });
});

// ── HTTP boundary tests ──────────────────────────────────────────────────

describe('guest HTTP boundary', () => {
  let guests, port, token;
  const origin = 'https://test.example.com';

  async function setup(t) {
    port = await freePort();
    guests = createGuestServer({ directory: '/dev/null', probe: resolvedProbe }); t.after(() => guests.stop());
    await guests.configure({ origin, port });
    const inv = guests.invite();
    const invToken = inv.invite.url.split('#invite=')[1];
    const redeemRes = await request(port, 'POST', '/api/redeem', { host: 'test.example.com', origin, token: invToken, body: { redemptionKey: randomBytes(32).toString('base64url') } });
    assert.equal(redeemRes.status, 200);
    token = redeemRes.body.sessionCredential;
  }

  test('wrong Host header returns 403', async (t) => {
    await setup(t);
    const res = await request(port, 'GET', '/', { host: 'evil.example.com' });
    assert.equal(res.status, 403);
    await guests.stop();
  });

  test('static assets served with security headers', async (t) => {
    port = await freePort();
    guests = createGuestServer({ directory: fileURLToPath(new URL('../dist', import.meta.url)), probe: resolvedProbe }); t.after(() => guests.stop());
    await guests.configure({ origin, port });
    const res = await request(port, 'GET', '/', { host: 'test.example.com' });
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-security-policy']);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cache-control'], 'no-store');
    for (const [asset, mime] of [['/camera-background.js', 'text/javascript'], ['/mediapipe/vision_bundle.mjs', 'text/javascript'],
      ['/mediapipe/wasm/vision_wasm_internal.js', 'text/javascript'], ['/mediapipe/wasm/vision_wasm_nosimd_internal.js', 'text/javascript'],
      ['/mediapipe/wasm/vision_wasm_internal.wasm', 'application/wasm'], ['/mediapipe/wasm/vision_wasm_nosimd_internal.wasm', 'application/wasm'],
      ['/mediapipe/selfie_segmenter.tflite', 'application/octet-stream'], ['/mediapipe/NOTICE.txt', 'text/plain; charset=utf-8']]) {
      const assetResponse = await request(port, 'GET', asset, { host: 'test.example.com' });
      assert.equal(assetResponse.status, 200, asset); assert.equal(assetResponse.headers['content-type'], mime, asset);
    }
    // ClaudeBWAI — a query string on a mediapipe asset is refused like any other static asset (no special-cased queries remain).
    for (const query of ['?tfjs-format=file', '?redirect=https://example.com']) {
      for (const asset of ['/mediapipe/selfie_segmenter.tflite', '/mediapipe/wasm/vision_wasm_internal.wasm']) {
        assert.equal((await request(port, 'GET', asset + query, { host: 'test.example.com' })).status, 404, asset + query);
      }
    }
    // The wasm loaders and the page need 'wasm-unsafe-eval'; connect-src stays 'self'.
    assert.match(res.headers['content-security-policy'], /script-src 'self' 'wasm-unsafe-eval';/);
    await guests.stop();
  });

  test('readiness page is available before proof with media denied by its own policy', async t => {
    port = await freePort();
    guests = createRawGuestServer({ directory: fileURLToPath(new URL('../dist', import.meta.url)), probe: async () => { throw new Error('hairpin unavailable'); } }); t.after(() => guests.stop());
    await guests.configure({ origin, port, routeType: 'direct' });
    const res = await request(port, 'GET', '/readiness', { host: 'test.example.com' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-security-policy'], /connect-src 'self'/);
    assert.doesNotMatch(res.headers['content-security-policy'], /media-src/);
    assert.equal(res.headers['permissions-policy'], 'camera=(), microphone=(), display-capture=()');
    assert.match(res.body, /different network/);
    assert.doesNotMatch(res.body, /#check=/);
  });

  test('unknown paths return 404', async (t) => {
    await setup(t);
    const res = await request(port, 'GET', '/admin', { host: 'test.example.com' });
    assert.equal(res.status, 404);
    await guests.stop();
  });

  test('POST to unknown API path returns 404', async (t) => {
    await setup(t);
    const res = await request(port, 'POST', '/api/admin', { host: 'test.example.com', origin, token, body: {} });
    assert.equal(res.status, 404);
    await guests.stop();
  });

  test('wrong origin returns 403', async (t) => {
    await setup(t);
    const res = await request(port, 'POST', '/api/status', { host: 'test.example.com', origin: 'https://evil.example.com', token, body: {} });
    assert.equal(res.status, 403);
    await guests.stop();
  });

  test('invalid token returns 410', async (t) => {
    await setup(t);
    const res = await request(port, 'POST', '/api/status', { host: 'test.example.com', origin, token: 'badtoken', body: {} });
    assert.equal(res.status, 410);
    await guests.stop();
  });

  test('no Authorization header returns 410', async (t) => {
    await setup(t);
    const res = await request(port, 'POST', '/api/status', { host: 'test.example.com', origin, body: {} });
    assert.equal(res.status, 410);
    await guests.stop();
  });

  test('status returns current phase', async (t) => {
    await setup(t);
    const res = await request(port, 'POST', '/api/status', { host: 'test.example.com', origin, token, body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.phase, 'redeemed');
    await guests.stop();
  });

  test('preview endpoint is a no-op status check', async (t) => {
    await setup(t);
    const res = await request(port, 'POST', '/api/preview', { host: 'test.example.com', origin, token, body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.phase, 'redeemed');
    await guests.stop();
  });
});

// ── join consent flow ────────────────────────────────────────────────────

describe('join consent and validation', () => {
  let guests, port, token;
  const origin = 'https://test.example.com';

  async function setup(t) {
    port = await freePort();
    guests = createGuestServer({ directory: '/dev/null', probe: resolvedProbe }); t.after(() => guests.stop());
    await guests.configure({ origin, port });
    const invToken = guests.invite().invite.url.split('#invite=')[1];
    const redeemRes = await request(port, 'POST', '/api/redeem', { host: 'test.example.com', origin, token: invToken, body: { redemptionKey: randomBytes(32).toString('base64url') } });
    assert.equal(redeemRes.status, 200);
    token = redeemRes.body.sessionCredential;
  }

  test('join requires consent=true', async (t) => {
    await setup(t);
    const res = await request(port, 'POST', '/api/join', { host: 'test.example.com', origin, token,
      body: { consent: false, name: 'Alice', consentVersion: 'consent-v1' } });
    assert.equal(res.status, 400);
    await guests.stop();
  });

  test('join requires non-empty trimmed name', async (t) => {
    await setup(t);
    const res = await request(port, 'POST', '/api/join', { host: 'test.example.com', origin, token,
      body: { consent: true, name: '   ', consentVersion: 'consent-v1' } });
    assert.equal(res.status, 400);
    await guests.stop();
  });

  test('join rejects control characters in name', async (t) => {
    await setup(t);
    const res = await request(port, 'POST', '/api/join', { host: 'test.example.com', origin, token,
      body: { consent: true, name: 'A\x00B', consentVersion: 'consent-v1' } });
    assert.equal(res.status, 400);
    await guests.stop();
  });

  test('join rejects name over 80 chars', async (t) => {
    await setup(t);
    const res = await request(port, 'POST', '/api/join', { host: 'test.example.com', origin, token,
      body: { consent: true, name: 'A'.repeat(81), consentVersion: 'consent-v1' } });
    assert.equal(res.status, 400);
    await guests.stop();
  });

  test('join requires bounded consentVersion', async (t) => {
    await setup(t);
    const res = await request(port, 'POST', '/api/join', { host: 'test.example.com', origin, token,
      body: { consent: true, name: 'Alice', consentVersion: 'invalid consent version' } });
    assert.equal(res.status, 400);
    await guests.stop();
  });

  test('join rejects extra body fields', async (t) => {
    await setup(t);
    const res = await request(port, 'POST', '/api/join', { host: 'test.example.com', origin, token,
      body: { consent: true, name: 'Alice', consentVersion: 'consent-v1', extra: 1 } });
    assert.equal(res.status, 400);
    await guests.stop();
  });

  test('valid join creates pending request', async (t) => {
    await setup(t);
    const consentVersion = 'consent-v1';
    const res = await request(port, 'POST', '/api/join', { host: 'test.example.com', origin, token,
      body: { consent: true, name: 'Alice', consentVersion } });
    assert.equal(res.status, 200);
    assert.equal(res.body.phase, 'pending');
    const status = guests.status();
    assert.equal(status.guests.length, 1);
    assert.equal(status.guests[0].session.name, 'Alice');
    await guests.stop();
  });

  test('idempotent join with same consentVersion and name succeeds', async (t) => {
    await setup(t);
    const consentVersion = 'consent-v1';
    const body = { consent: true, name: 'Alice', consentVersion };
    await request(port, 'POST', '/api/join', { host: 'test.example.com', origin, token, body });
    const res = await request(port, 'POST', '/api/join', { host: 'test.example.com', origin, token, body });
    assert.equal(res.status, 200);
    assert.equal(res.body.phase, 'pending');
    await guests.stop();
  });

  test('conflicting join with different consentVersion returns 409', async (t) => {
    await setup(t);
    await request(port, 'POST', '/api/join', { host: 'test.example.com', origin, token,
      body: { consent: true, name: 'Alice', consentVersion: 'consent-v1' } });
    const res = await request(port, 'POST', '/api/join', { host: 'test.example.com', origin, token,
      body: { consent: true, name: 'Alice', consentVersion: 'consent-v2' } });
    assert.equal(res.status, 409);
    await guests.stop();
  });

  test('conflicting join with different name returns 409', async (t) => {
    await setup(t);
    const consentVersion = 'consent-v1';
    await request(port, 'POST', '/api/join', { host: 'test.example.com', origin, token,
      body: { consent: true, name: 'Alice', consentVersion } });
    const res = await request(port, 'POST', '/api/join', { host: 'test.example.com', origin, token,
      body: { consent: true, name: 'Bob', consentVersion } });
    assert.equal(res.status, 409);
    await guests.stop();
  });
});

// ── leave ────────────────────────────────────────────────────────────────

describe('guest leave', () => {
  test('leave removes invitation and releases guest', async (t) => {
    const port = await freePort();
    const origin = 'https://test.example.com';
    const guests = createGuestServer({ directory: '/dev/null', probe: resolvedProbe }); t.after(() => guests.stop());
    await guests.configure({ origin, port });
    const invToken = guests.invite().invite.url.split('#invite=')[1];
    const redeemRes = await request(port, 'POST', '/api/redeem', { host: 'test.example.com', origin, token: invToken, body: { redemptionKey: randomBytes(32).toString('base64url') } });
    assert.equal(redeemRes.status, 200);
    const token = redeemRes.body.sessionCredential;
    const res = await request(port, 'POST', '/api/leave', { host: 'test.example.com', origin, token, body: {} });
    assert.equal(res.status, 200);
    // Token is now invalid.
    const check = await request(port, 'POST', '/api/status', { host: 'test.example.com', origin, token, body: {} });
    assert.equal(check.status, 410);
    await guests.stop();
  });
});

// ── rate limiting ────────────────────────────────────────────────────────

describe('rate limiting', () => {
  test('more than 1000 requests in 10s window returns 429', async (t) => {
    let clock = 1000;
    const port = await freePort();
    const guests = createGuestServer({ directory: '/dev/null', probe: resolvedProbe, now: () => clock }); t.after(() => guests.stop());
    await guests.configure({ origin: 'https://test.example.com', port });
    // Fire 1001 requests in the same window.
    const results = [];
    for (let i = 0; i < 1001; i++) {
      results.push(await request(port, 'GET', '/', { host: 'test.example.com' }));
    }
    assert.ok(results.some(r => r.status === 429));
    // After window resets, requests succeed again.
    clock += 10_001;
    const after = await request(port, 'GET', '/', { host: 'test.example.com' });
    assert.notEqual(after.status, 429);
    await guests.stop();
  });
});

// ── body size limit ──────────────────────────────────────────────────────

describe('body size limit', () => {
  test('oversized JSON body is rejected (400 or connection reset)', async (t) => {
    const port = await freePort();
    const origin = 'https://test.example.com';
    const guests = createGuestServer({ directory: '/dev/null', probe: resolvedProbe }); t.after(() => guests.stop());
    await guests.configure({ origin, port });
    const token = guests.invite().invite.url.split('#invite=')[1];
    const oversized = { consent: true, name: 'A'.repeat(3000), consentVersion: 'consent-v1' };
    try {
      const res = await request(port, 'POST', '/api/join', { host: 'test.example.com', origin, token, body: oversized });
      // If we get a response, it must be an error status.
      assert.ok(res.status >= 400, `Expected error status, got ${res.status}`);
    } catch {
      // Connection reset is also correct — server destroyed the oversized request.
    }
    await guests.stop();
  });

  test('non-JSON content-type returns 400', async (t) => {
    const port = await freePort();
    const origin = 'https://test.example.com';
    const guests = createGuestServer({ directory: '/dev/null', probe: resolvedProbe }); t.after(() => guests.stop());
    await guests.configure({ origin, port });
    const token = guests.invite().invite.url.split('#invite=')[1];
    // Send with wrong content-type.
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ agent: false, hostname: '127.0.0.1', port, method: 'POST', path: '/api/join',
        headers: { authorization: `Bearer ${token}`, origin, host: 'test.example.com', 'content-type': 'text/plain', 'content-length': 2 } }, res => {
        let data = ''; res.setEncoding('utf8');
        res.on('data', c => { data += c; });
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
      });
      req.on('error', reject);
      req.write('{}'); req.end();
    });
    assert.equal(res.status, 400);
    await guests.stop();
  });
});

// ── TLS route verification ───────────────────────────────────────────────

describe('TLS route verification', () => {
  test('shipping verifier rejects the test certificate even with a test CA environment variable', async (t) => {
    const { verifyRoute } = require('../desktop/guests.cjs');
    const tls = createTLSFixture('localhost');
    const oldCA = process.env.BLASTCAST_TEST_CA;
    process.env.BLASTCAST_TEST_CA = `${tls.dir}/ca.crt`;
    const proxy = tls.createServer((req, res) => res.end('proof'));
    t.after(() => { proxy.closeAllConnections(); proxy.close(); });
    try {
      const port = await new Promise(resolve => proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port)));
      await assert.rejects(verifyRoute(`https://localhost:${port}`, 'nonce', 'proof', new AbortController().signal), /certificate|issuer/i);
    } finally {
      proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
      if (oldCA === undefined) delete process.env.BLASTCAST_TEST_CA; else process.env.BLASTCAST_TEST_CA = oldCA;
      tls.cleanup();
    }
  });

  test('verifyRoute succeeds through a real TLS proxy with valid CA', async (t) => {
    const { createRouteVerifier } = require('../desktop/guests.cjs');
    const tls = createTLSFixture('localhost');
    const verifyRoute = createRouteVerifier({ ca: tls.ca });
    try {
      const nonce = 'test-nonce-' + Date.now();
      const proof = 'test-proof-' + Date.now();
      const proxy = tls.createServer((req, res) => {
        if (req.url === `/route-check/${nonce}`) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(proof); }
        else { res.writeHead(404); res.end(); }
      });
      t.after(() => { proxy.closeAllConnections(); proxy.close(); });
      const proxyPort = await new Promise(resolve => { proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port)); });
      try {
        const ac = new AbortController();
        await verifyRoute(`https://localhost:${proxyPort}`, nonce, proof, ac.signal);
      } finally { proxy.close(); }
    } finally {
      tls.cleanup();
    }
  });

  test('verifyRoute rejects wrong challenge body', async (t) => {
    const { createRouteVerifier } = require('../desktop/guests.cjs');
    const tls = createTLSFixture('localhost');
    const verifyRoute = createRouteVerifier({ ca: tls.ca });
    try {
      const nonce = 'test-nonce-' + Date.now();
      const proof = 'test-proof-' + Date.now();
      const proxy = tls.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('wrong-proof'); });
      t.after(() => { proxy.closeAllConnections(); proxy.close(); });
      const proxyPort = await new Promise(resolve => { proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port)); });
      try {
        const ac = new AbortController();
        await assert.rejects(() => verifyRoute(`https://localhost:${proxyPort}`, nonce, proof, ac.signal), /points somewhere else/);
      } finally { proxy.close(); }
    } finally {
      tls.cleanup();
    }
  });

  test('verifyRoute reflects origin rejection', async (t) => {
    const { createRouteVerifier } = require('../desktop/guests.cjs');
    const tls = createTLSFixture('localhost');
    const verifyRoute = createRouteVerifier({ ca: tls.ca });
    try {
      const nonce = 'test-nonce-' + Date.now();
      const proof = 'test-proof-' + Date.now();
      // Server that naively reflects the URL nonce
      const proxy = tls.createServer((req, res) => {
        const urlNonce = req.url.split('/route-check/')[1];
        res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(urlNonce || '');
      });
      t.after(() => { proxy.closeAllConnections(); proxy.close(); });
      const proxyPort = await new Promise(resolve => { proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port)); });
      try {
        const ac = new AbortController();
        await assert.rejects(() => verifyRoute(`https://localhost:${proxyPort}`, nonce, proof, ac.signal), /points somewhere else/);
      } finally { proxy.close(); }
    } finally {
      tls.cleanup();
    }
  });
});

// ── server before verification ───────────────────────────────────────────

describe('server before verification', () => {
  test('requests during checking return 503', async (t) => {
    const port = await freePort();
    let resolveProbe;
    const guests = createGuestServer({ directory: '/dev/null', probe: () => new Promise(r => { resolveProbe = r; }) }); t.after(() => guests.stop());
    const configuring = guests.configure({ origin: 'https://test.example.com', port });
    await new Promise(r => setTimeout(r, 100));
    const res = await request(port, 'GET', '/', { host: 'test.example.com' });
    assert.equal(res.status, 503);
    resolveProbe();
    await configuring;
    await guests.stop();
  });
});

// ── non-POST, non-GET methods ────────────────────────────────────────────

describe('unsupported methods', () => {
  test('PUT/DELETE/PATCH return 404', async (t) => {
    const port = await freePort();
    const origin = 'https://test.example.com';
    const guests = createGuestServer({ directory: '/dev/null', probe: resolvedProbe }); t.after(() => guests.stop());
    await guests.configure({ origin, port });
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const res = await request(port, method, '/api/status', { host: 'test.example.com', origin, token: 'x', body: {} });
      assert.equal(res.status, 404, `${method} should 404`);
    }
    await guests.stop();
  });
});

// CodexBWAI — integration regressions for the admission doorway.
test('redemption is browser-bound; host admission and removal control session access', async t => {
  const port = await freePort(), origin = 'https://test.example.com', host = 'test.example.com';
  const guests = createGuestServer({ directory: '/dev/null', probe: resolvedProbe });
  t.after(() => guests.stop()); await guests.configure({ origin, port });
  const token = guests.invite().invite.url.split('#invite=')[1];
  const key = randomBytes(32).toString('base64url');
  const post = (endpoint, credential, body = {}) => request(port, 'POST', `/api/${endpoint}`, { host, origin, token: credential, body });
  assert.equal((await post('redeem', token, { redemptionKey: key, extra: 1 })).status, 400);
  const redeemed = await post('redeem', token, { redemptionKey: key });
  assert.equal(redeemed.status, 200); assert.ok(redeemed.body.expiresAt > Date.now());
  const session = redeemed.body.sessionCredential;
  assert.equal((await post('status', token)).status, 410, 'invite is not a session');
  assert.equal((await post('join', session, { name: 'Alice', consent: true, consentVersion: '1' })).status, 200);
  const id = guests.status().guests[0].session.id;
  assert.equal(guests.admit(id).ok, true);
  assert.equal((await post('status', session)).body.phase, 'admitted');
  assert.equal((await post('redeem', token, { redemptionKey: randomBytes(32).toString('base64url') })).status, 410);
  // Same browser, same key: re-admission rejoin (new credential, old one dead, same host row).
  const rejoined = await post('redeem', token, { redemptionKey: key });
  assert.equal(rejoined.status, 200);
  assert.notEqual(rejoined.body.sessionCredential, session);
  assert.equal((await post('status', session)).status, 410, 'old tab credential is refused');
  assert.equal(guests.status().guests.length, 1); assert.equal(guests.status().guests[0].session.id, id);
  const session2 = rejoined.body.sessionCredential;
  assert.equal((await post('join', session2, { name: 'Alice', consent: true, consentVersion: '1' })).status, 200);
  assert.equal(guests.admit(id).ok, true);
  for (const endpoint of ['status', 'preview', 'leave']) assert.equal((await post(endpoint, session2, { extra: true })).status, 400);
  assert.equal((await post('status', session2)).body.phase, 'admitted', 'invalid leave must not mutate');
  assert.equal(guests.remove(id).ok, true);
  assert.equal((await post('status', session2)).status, 410);
  assert.equal((await post('redeem', token, { redemptionKey: key })).status, 410, 'removed guest cannot rejoin');
  assert.equal(guests.status().invite, null);
});

test('stale host probe completion cannot change a newer listener', async t => {
  let release, entered;
  const started = new Promise(r => { entered = r; });
  let count = 0;
  const guests = createRawGuestServer({ directory: '/dev/null', probe: () => ++count === 1 ? new Promise(r => { release = r; entered(); }) : Promise.resolve() });
  t.after(() => guests.stop());
  const oldPort = await freePort(), newPort = await freePort();
  assert.equal((await guests.configure({ origin: 'https://old.example.com', port: oldPort, routeType: 'direct' })).phase, 'outside-check');
  await started;
  assert.equal((await guests.configure({ origin: 'https://new.example.com', port: newPort, routeType: 'direct' })).phase, 'outside-check');
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(guests.status().origin, 'https://new.example.com');
  assert.equal(guests.status().readiness.hint, null);
  assert.equal((await confirmGuestReadiness(guests)).status, 200);
  assert.equal((await request(newPort, 'GET', '/unknown', { host: 'new.example.com' })).status, 404);
});
