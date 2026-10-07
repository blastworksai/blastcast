// ClaudeBWAI — einh 4-5 Oct: live chat over the guest HTTP API, plus the packager require-graph guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createGuestServer } = require('../desktop/guests.cjs');
const { configureReady } = require('./helpers/network-readiness.cjs');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HOST = 'test.example.com', ORIGIN = 'https://test.example.com';

function freePort() { return new Promise(resolve => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
function send(port, urlPath, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body ?? {}));
    const h = { host: HOST, origin: ORIGIN, 'content-type': 'application/json', 'content-length': payload.length };
    if (token) h.authorization = `Bearer ${token}`;
    const req = http.request({ agent: false, hostname: '127.0.0.1', port, method: 'POST', path: urlPath, headers: h }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on('error', reject); req.end(payload);
  });
}
// names[i] joins as names[i]; admitted[i] decides whether the host admits that guest.
async function room(t, names, admitted = names.map(() => true)) {
  const port = await freePort();
  let clock = Date.now();
  const guests = createGuestServer({ directory: '/dev/null', probe: () => Promise.resolve(), now: () => clock });
  t.after(() => guests.stop());
  await configureReady(guests, { origin: ORIGIN, port });
  const sessions = [];
  for (const name of names) {
    const token = guests.invite().invite.url.split('#invite=')[1];
    const r = await send(port, '/api/redeem', { token, body: { redemptionKey: crypto.randomBytes(32).toString('base64url') } });
    await send(port, '/api/join', { token: r.body.sessionCredential, body: { name, consent: true, consentVersion: '1' } });
    sessions.push(r.body.sessionCredential);
  }
  guests.status().guests.forEach((g, i) => { if (admitted[i]) guests.admit(g.session.id); });
  return { port, guests, sessions, advance: ms => { clock += ms; } };
}
const say = (port, token, text) => send(port, '/api/chat/send', { token, body: { text } });
const poll = (port, token, since) => send(port, '/api/chat/poll', { token, body: { since } });

test('a waiting-room guest is refused on both routes', async t => {
  const { port, sessions } = await room(t, ['Waiting'], [false]);
  assert.ok([400, 410].includes((await say(port, sessions[0], 'hi')).status));
  assert.ok([400, 410].includes((await poll(port, sessions[0], 0)).status));
  assert.notEqual((await say(port, sessions[0], 'hi')).status, 200);
});

test('a removed guest gets 410 on both routes', async t => {
  const { port, guests, sessions } = await room(t, ['Ann', 'Bo']);
  const id = guests.status().guests[0].session.id;
  guests.remove(id);
  assert.equal((await say(port, sessions[0], 'hi')).status, 410);
  assert.equal((await poll(port, sessions[0], 0)).status, 410);
});

test('the sender name is the stored admitted name; a body with a name key is refused', async t => {
  const { port, sessions } = await room(t, ['Ann']);
  assert.equal((await send(port, '/api/chat/send', { token: sessions[0], body: { text: 'x', name: 'Host' } })).status, 400);
  assert.equal((await send(port, '/api/chat/send', { token: sessions[0], body: { text: 'x', from: 'host' } })).status, 400);
  assert.equal((await send(port, '/api/chat/poll', { token: sessions[0], body: { since: 0, extra: 1 } })).status, 400);
  const r = await say(port, sessions[0], 'hello');
  assert.equal(r.status, 200);
  assert.equal(r.body.message.name, 'Ann');
  assert.equal(r.body.message.host, false);
});

test('a guest named Host is host:false while host messages are host:true', async t => {
  const { port, guests, sessions } = await room(t, ['Host']);
  assert.equal((await say(port, sessions[0], 'i am a guest')).body.message.host, false);
  assert.equal(guests.chatSend('real host').message.host, true);
  const p = await poll(port, sessions[0], 0);
  assert.deepEqual(p.body.messages.map(m => [m.name, m.host]), [['Host', false], ['Host', true]]);
  assert.deepEqual(guests.chatSince(0).messages.map(m => m.host), [false, true]);
});

test('oversize, multi-line and control text are refused with 400', async t => {
  const { port, sessions } = await room(t, ['Ann']);
  for (const text of ['x'.repeat(501), 'a\nb', 'a\u0007b', 'a‮b', 'a\u0085b', '   ', 5, null]) {
    assert.equal((await send(port, '/api/chat/send', { token: sessions[0], body: { text } })).status, 400, JSON.stringify(text));
  }
  assert.equal((await say(port, sessions[0], 'é'.repeat(500))).status, 200);
});

test("one guest's flood does not block another", async t => {
  const { port, sessions } = await room(t, ['Ann', 'Bo']);
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await say(port, sessions[0], `f${i}`)).status);
  assert.ok(codes.includes(429));
  assert.equal((await say(port, sessions[1], 'still here')).status, 200);
});

test('poll results never carry a session id; since=0 is history, later polls are live', async t => {
  const { port, guests, sessions } = await room(t, ['Ann', 'Bo']);
  const ids = guests.status().guests.map(g => g.session.id);
  await say(port, sessions[0], 'one');
  const joined = await poll(port, sessions[1], 0);
  assert.equal(joined.body.messages.length, 1);
  assert.equal(joined.body.messages[0].history, true);
  assert.equal(joined.body.messages[0].mine, false);
  const next = await say(port, sessions[0], 'two');
  const live = await poll(port, sessions[1], joined.body.latestId);
  assert.deepEqual(live.body.messages.map(m => m.text), ['two']);
  assert.equal(live.body.messages[0].history, undefined);
  const raw = JSON.stringify([joined.body, live.body, next.body]);
  for (const id of ids) assert.ok(!raw.includes(id));
  assert.equal((await poll(port, sessions[0], 0)).body.messages.find(m => m.text === 'one').mine, true);
});

test('the first message after joining an EMPTY room is live, not history', async t => {
  const { port, sessions } = await room(t, ['Ann', 'Bo']);
  const first = await poll(port, sessions[1], 0);
  assert.deepEqual(first.body.messages, []);
  assert.ok(first.body.latestId >= 1, 'the cursor a guest gets back after its first poll is never 0');
  const sent = await say(port, sessions[0], 'hello');
  const again = await poll(port, sessions[1], first.body.latestId);
  assert.deepEqual(again.body.messages.map(m => m.text), ['hello']);
  assert.equal(again.body.messages[0].history, undefined);
  assert.equal(again.body.messages[0].id, sent.body.message.id, 'send and poll agree on the id, so the client de-duplicates');
  assert.equal((await poll(port, sessions[0], sent.body.message.id)).body.messages.length, 0, 'the sender\'s own cursor passes its message');
  assert.equal((await poll(port, sessions[1], again.body.latestId)).body.messages.length, 0);
});

test('poll since must be a safe integer >= 0', async t => {
  const { port, sessions } = await room(t, ['Ann']);
  for (const since of [-1, 1.5, '0', null, 2 ** 60]) assert.equal((await poll(port, sessions[0], since)).status, 400, String(since));
});

test('revoke empties the room', async t => {
  const { port, guests, sessions } = await room(t, ['Ann']);
  await say(port, sessions[0], 'gone soon');
  guests.chatSend('host too');
  guests.revoke();
  assert.deepEqual(guests.chatSince(0).messages, []);
});

test('the room empties when no admitted guest remains', async t => {
  const { port, guests, sessions } = await room(t, ['Ann']);
  await say(port, sessions[0], 'bye');
  assert.equal((await send(port, '/api/leave', { token: sessions[0] })).status, 200);
  assert.deepEqual(guests.chatSince(0).messages, []);
});

// Every desktop/*.cjs reachable from main.cjs must ship: a missing one is a packaged app that crashes at launch.
function reachable() {
  const seen = new Set(); const todo = ['main.cjs'];
  while (todo.length) {
    const f = todo.pop(); if (seen.has(f)) continue; seen.add(f);
    const src = fs.readFileSync(path.join(ROOT, 'desktop', f), 'utf8');
    for (const m of src.matchAll(/require\(\s*['"]\.\/([\w.-]+\.cjs)['"]\s*\)/g)) todo.push(m[1]);
  }
  return [...seen].filter(f => fs.existsSync(path.join(ROOT, 'desktop', f)));
}
test('every desktop module reached from main.cjs is in all three packager lists', () => {
  const sources = ['packaging/linux/package.mjs', 'packaging/windows/layout.mjs', 'packaging/macos/package.mjs'].map(p => [p, fs.readFileSync(path.join(ROOT, p), 'utf8')]);
  const modules = reachable();
  assert.ok(modules.includes('chat-room.cjs') && modules.length > 20, `walk found ${modules.length}`);
  for (const [p, src] of sources) {
    for (const f of modules) {
      const base = f.replace(/\.cjs$/, '');
      assert.ok(src.includes(`desktop/${f}`) || new RegExp(`['"]${base}['"]`).test(src), `${p} is missing desktop/${f}`);
    }
  }
});
