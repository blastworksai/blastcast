// ClaudeBWAI — rate limit per credential (einh, 4 Oct 2026). Behind the tunnel every peer is 127.0.0.1, so the limit
// follows the credential: unauthenticated floods can never lock an admitted guest out, and one guest cannot starve another.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createGuestServer } = require('../desktop/guests.cjs');
const { configureReady } = require('./helpers/network-readiness.cjs');

const HOST = 'test.example.com', ORIGIN = 'https://test.example.com';
const meta = { episodeId:'ep1', epochId:'e1', sequence:0, byteLength:1, sha256:'h', startMonoMs:0, endMonoMs:1 };
const ack = m => ({ ok:true, episodeId:m.episodeId, epochId:m.epochId, sequence:m.sequence, sha256:m.sha256, byteLength:m.byteLength });
const sources = { status:()=>({episodeId:'ep1',phase:'recording',hostNowMs:0,sources:[]}), recoveryKey:()=>null, appendSource:async(_p,m)=>ack(m) };

function freePort() { return new Promise(resolve => { const s = http.createServer().listen(0,'127.0.0.1',() => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
function send(port, method, urlPath, { host = HOST, origin = ORIGIN, token, body, raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw ?? (body === undefined ? null : Buffer.from(JSON.stringify(body)));
    const h = { host, ...headers };
    if (origin) h.origin = origin;
    if (token) h.authorization = `Bearer ${token}`;
    if (payload) { h['content-type'] = raw ? 'application/octet-stream' : 'application/json'; h['content-length'] = payload.length; }
    const req = http.request({ agent:false, hostname:'127.0.0.1', port, method, path:urlPath, headers:h }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status:res.statusCode, body:JSON.parse(data) }); } catch { resolve({ status:res.statusCode, body:data }); } });
    });
    req.on('error', reject); req.end(payload ?? undefined);
  });
}
async function room(t, guestCount = 2) {
  const port = await freePort();
  let clock = Date.now();
  const guests = createGuestServer({ directory:'/dev/null', probe:()=>Promise.resolve(), sources, now:() => clock });
  t.after(() => guests.stop());
  await configureReady(guests, { origin:ORIGIN, port });
  const sessions = [];
  for (let i = 0; i < guestCount; i++) {
    const token = guests.invite().invite.url.split('#invite=')[1];
    const r = await send(port, 'POST', '/api/redeem', { token, body:{ redemptionKey:crypto.randomBytes(32).toString('base64url') } });
    const session = r.body.sessionCredential;
    await send(port, 'POST', '/api/join', { token:session, body:{ name:`G${i}`, consent:true, consentVersion:'1' } });
    sessions.push(session);
  }
  for (const g of guests.status().guests) guests.admit(g.session.id);
  return { port, guests, sessions, advance: ms => { clock += ms; } };
}
const chunkReq = (port, token) => send(port, 'POST', '/api/source/chunk', { token, raw:Buffer.from('a'), headers:{ 'x-blastcast-source':JSON.stringify(meta) } });

test('flooding the unauthenticated path to 429 does not block an admitted guest', async t => {
  const { port, sessions } = await room(t, 1);
  let limited = false;
  for (let i = 0; i < 1500 && !limited; i++) limited = (await send(port, 'GET', '/', {})).status === 429;
  assert.ok(limited, 'the unauthenticated flood must hit the pre-auth limit');
  assert.equal((await send(port, 'POST', '/api/status', { token:sessions[0], body:{} })).status, 200);
  assert.notEqual((await chunkReq(port, sessions[0])).status, 429);
  // A garbage bearer is unauthenticated too, and is still limited.
  assert.equal((await send(port, 'POST', '/api/status', { token:'x'.repeat(43), body:{} })).status, 429);
});

test('one guest exceeding its own bucket gets 429 while another guest is unaffected', async t => {
  const { port, sessions } = await room(t, 2);
  let limited = false;
  for (let i = 0; i < 400 && !limited; i++) limited = (await send(port, 'POST', '/api/status', { token:sessions[0], body:{} })).status === 429;
  assert.ok(limited, 'the noisy guest must be limited');
  assert.equal((await send(port, 'POST', '/api/status', { token:sessions[1], body:{} })).status, 200);
  assert.notEqual((await chunkReq(port, sessions[1])).status, 429);
});

test('a wrong Host header is refused without consuming any bucket', async t => {
  const { port, sessions } = await room(t, 1);
  for (let i = 0; i < 1500; i++) assert.equal((await send(port, 'POST', '/api/status', { host:'evil.example.com', token:sessions[0], body:{} })).status, 403);
  for (let i = 0; i < 1500; i++) assert.equal((await send(port, 'GET', '/', { host:'evil.example.com' })).status, 403);
  assert.equal((await send(port, 'POST', '/api/status', { token:sessions[0], body:{} })).status, 200);
  assert.ok(![403, 429].includes((await send(port, 'GET', '/', {})).status));
});

test('buckets reset after the window', async t => {
  const { port, sessions, advance } = await room(t, 1);
  let limited = false;
  for (let i = 0; i < 400 && !limited; i++) limited = (await send(port, 'POST', '/api/status', { token:sessions[0], body:{} })).status === 429;
  assert.ok(limited);
  advance(10_001);
  assert.equal((await send(port, 'POST', '/api/status', { token:sessions[0], body:{} })).status, 200);
});
