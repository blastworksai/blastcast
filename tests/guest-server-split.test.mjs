import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const modules = ['guest-http', 'guest-rate-limit', 'guest-static', 'guest-route', 'guest-readiness', 'guest-status', 'guest-lifecycle', 'guest-api', 'guest-api-source'];
const CEILING = 75; // createGuestServer is a composition root: state, wiring, thin public surface.
const MODULE_FUNCTION_CEILING = 120;

test('each guest-* module loads standalone and exports functions', () => {
  for (const name of modules) {
    const mod = require(`../desktop/${name}.cjs`);
    assert.ok(Object.values(mod).some(v => typeof v === 'function'), `${name} exports a function`);
  }
});

test('the rate limiter is driven by an injected clock', () => {
  const { createRateLimiter, PRE_AUTH_LIMIT } = require('../desktop/guest-rate-limit.cjs');
  let t = 1000;
  const limiter = createRateLimiter({ now: () => t, store: { inviteIsLive: () => false, guestStatus: () => ({ ok: false }) } });
  const req = { method: 'GET', url: '/', headers: {} };
  for (let i = 0; i < PRE_AUTH_LIMIT; i++) assert.equal(limiter.isOver(req), false);
  assert.equal(limiter.isOver(req), true);
  t += 10_000;
  assert.equal(limiter.isOver(req), false);
});

function functionLengths(source) {
  const lines = source.split('\n'); const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:async )?function (\w+)/.exec(lines[i]); if (!m) continue;
    let j = i; while (j < lines.length && lines[j] !== '}') j++;
    out.push([m[1], j - i + 1]);
  }
  return out;
}

test(`createGuestServer stays under ${CEILING} lines and no top-level function in the guest modules exceeds ${MODULE_FUNCTION_CEILING}`, () => {
  const guests = fs.readFileSync(new URL('../desktop/guests.cjs', import.meta.url), 'utf8');
  const create = functionLengths(guests).find(([n]) => n === 'createGuestServer');
  assert.ok(create[1] <= CEILING, `createGuestServer is ${create[1]} lines`);
  for (const name of [...modules, 'guests']) {
    for (const [fn, len] of functionLengths(fs.readFileSync(new URL(`../desktop/${name}.cjs`, import.meta.url), 'utf8')))
      assert.ok(len <= MODULE_FUNCTION_CEILING, `${name}.${fn} is ${len} lines`);
  }
});
