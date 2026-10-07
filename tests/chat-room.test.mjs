// ClaudeBWAI — einh 4-5 Oct: live chat, never saved
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createChatRoom } = require('../desktop/chat-room.cjs');

function room() {
  const clock = { t: 1000 };
  const r = createChatRoom({ now: () => clock.t });
  return { r, clock };
}
const send = (r, text, from = 'host', name = 'Host') => r.send({ from, name, text });

test('ring caps at 200 and keeps the newest', () => {
  const { r, clock } = room();
  for (let i = 1; i <= 230; i++) { clock.t += 10000; assert.ok(send(r, `m${i}`).ok); }
  const all = r.since(0, 'host');
  assert.equal(all.length, 200);
  assert.equal(all[0].text, 'm31');
  assert.equal(all.at(-1).text, 'm230');
  assert.equal(r.latestId(), 230);
});

test('id continuity across clear()', () => {
  const { r } = room();
  send(r, 'a'); send(r, 'b');
  r.clear();
  assert.equal(r.since(0, 'host').length, 0);
  const res = send(r, 'c');
  assert.equal(res.message.id, 3);
  assert.equal(r.latestId(), 3);
});

test('5 per 5s per sender, rolling, injected clock', () => {
  const { r, clock } = room();
  for (let i = 0; i < 5; i++) assert.ok(send(r, 'x', 'g1', 'G').ok);
  assert.deepEqual(send(r, 'x', 'g1', 'G'), { ok: false, reason: 'rate-limited' });
  clock.t += 4999;
  assert.equal(send(r, 'x', 'g1', 'G').ok, false);
  clock.t += 1;
  assert.equal(send(r, 'x', 'g1', 'G').ok, true);
});

test('one sender flood does not block another', () => {
  const { r } = room();
  for (let i = 0; i < 9; i++) send(r, 'x', 'g1', 'G1');
  assert.equal(send(r, 'hi', 'g2', 'G2').ok, true);
  assert.equal(send(r, 'hi').ok, true);
});

test('length rules count code points', () => {
  const { r, clock } = room();
  const bad = (t) => { clock.t += 10000; assert.deepEqual(send(r, t), { ok: false, reason: 'invalid' }, JSON.stringify(t)); };
  const good = (t) => { clock.t += 10000; assert.equal(send(r, t).ok, true); };
  good('a'.repeat(500));
  good('😀'.repeat(500));
  bad('a'.repeat(501));
  bad('😀'.repeat(501));
  bad(''); bad('   \t '); bad(undefined); bad(42);
});

test('refuses multi-line, controls, bidi, lone surrogates', () => {
  const { r, clock } = room();
  for (const t of ['a\nb', 'a\rb', 'a\u0000b', 'a\u001fb', 'a\u007fb', 'a\u0085b', 'a\u009fb',
    'a‮b', 'a⁦b', 'a⁩b', 'a\ud800b', 'a\udc00', '\ud83d']) {
    clock.t += 10000;
    assert.deepEqual(send(r, t), { ok: false, reason: 'invalid' }, JSON.stringify(t));
  }
  clock.t += 10000;
  assert.equal(send(r, '  trimmed ok  ').message.text, 'trimmed ok');
});

test('no session id leaks and host flag is exact', () => {
  const { r } = room();
  send(r, 'from guest', 'sess-SECRET-1', 'Host');
  send(r, 'from host', 'host', 'Boss');
  send(r, 'mine', 'sess-OWN-2', 'Me');
  for (const out of [r.since(0, 'sess-OWN-2'), r.joinHistory('sess-OWN-2')]) {
    const s = JSON.stringify(out);
    assert.ok(!s.includes('SECRET'));
    assert.ok(!s.includes('sess-'));
    assert.ok(!s.includes('"from"'));
  }
  const m = r.since(0, 'sess-OWN-2');
  assert.equal(m[0].host, false);           // guest named "Host"
  assert.equal(m[0].mine, false);
  assert.equal(m[1].host, true);
  assert.equal(m[2].mine, true);
  assert.deepEqual(Object.keys(m[0]).sort(), ['at', 'host', 'id', 'mine', 'name', 'text']);
});

test('since filters by id; joinHistory is last 50 marked history', () => {
  const { r, clock } = room();
  for (let i = 1; i <= 60; i++) { clock.t += 10000; send(r, `m${i}`); }
  assert.equal(r.since(58, 'host').length, 2);
  assert.equal(r.since(58, 'host')[0].history, undefined);
  const h = r.joinHistory('x');
  assert.equal(h.length, 50);
  assert.equal(h[0].text, 'm11');
  assert.ok(h.every((e) => e.history === true));
});
