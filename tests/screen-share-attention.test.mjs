import assert from 'node:assert/strict';
import test from 'node:test';
import { GuestScreenAttention } from '../dist/screen-share-attention.js';

test('each newly sharing guest prompts until the host selects a screen', () => {
  const attention = new GuestScreenAttention();
  assert.equal(attention.update([]), false);
  assert.equal(attention.update(['guest-a']), true);
  attention.acknowledge();
  assert.equal(attention.update(['guest-a']), false);
  assert.equal(attention.update(['guest-a', 'guest-b']), true);
  attention.acknowledge();
  assert.equal(attention.update(['guest-a', 'guest-b']), false);
});

test('a stopped share clears only its pending prompt and does not glow afterward', () => {
  const attention = new GuestScreenAttention();
  assert.equal(attention.update(['guest-a']), true);
  assert.equal(attention.update([]), false);
  assert.equal(attention.update([]), false);
  assert.equal(attention.update(['guest-a']), true, 'a later new share is a new request');
});
