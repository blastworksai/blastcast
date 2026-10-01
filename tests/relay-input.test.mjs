import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeExpressTurnAddress } from '../dist/relay-input.js';

test('ExpressTURN dashboard values become strict UDP TURN addresses', () => {
  assert.equal(normalizeExpressTurnAddress('free.expressturn.com:3478'), 'turn:free.expressturn.com:3478?transport=udp');
  assert.equal(normalizeExpressTurnAddress(' turn:eu.expressturn.com:3478 '), 'turn:eu.expressturn.com:3478?transport=udp');
  assert.equal(normalizeExpressTurnAddress('turn:us.expressturn.com:3478?transport=tcp'), 'turn:us.expressturn.com:3478?transport=tcp');
});

test('unknown or unsafe addresses are not rewritten into trusted addresses', () => {
  for (const value of ['relay.example.com:3478', 'evilexpressturn.com:3478', 'turns:free.expressturn.com:443']) {
    assert.equal(normalizeExpressTurnAddress(value), value);
  }
});
