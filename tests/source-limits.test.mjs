// ClaudeBWAI — one home for the shared source limits: values pinned, every former site imports from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as ts from '../dist/source-limits.js';
const require = createRequire(import.meta.url);
const cjs = require('../desktop/source-limits.cjs');
const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('the shared values equal the ones the code shipped with', () => {
  assert.equal(ts.SOURCE_PIECE_BYTES, 65536);
  assert.equal(ts.SOURCE_RETAINED_BYTES, 2147483648);
  assert.equal(ts.SOURCE_MAX_BYTES, 17179869184);
  assert.equal(ts.SOURCE_EPISODE_MAX_BYTES, 137438953472);
  assert.equal(ts.SOURCE_MAX_CHUNKS, 100000);
  assert.equal(ts.UUID.source, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
  assert.deepEqual([...ts.SOURCE_CHUNK_KEYS], ['episodeId','epochId','sequence','byteLength','sha256','startMonoMs','endMonoMs']);
});

test('desktop reads the identical values from the generated JSON', () => {
  assert.equal(cjs.PIECE, ts.SOURCE_PIECE_BYTES); assert.equal(cjs.RETAINED, ts.SOURCE_RETAINED_BYTES);
  assert.equal(cjs.SOURCE, ts.SOURCE_MAX_BYTES); assert.equal(cjs.EPISODE, ts.SOURCE_EPISODE_MAX_BYTES);
  assert.equal(cjs.CHUNKS, ts.SOURCE_MAX_CHUNKS); assert.deepEqual(cjs.CHUNK_KEYS, [...ts.SOURCE_CHUNK_KEYS]);
  assert.equal(cjs.UUID.source, ts.UUID.source);
  assert.ok(cjs.UUID.test('123e4567-e89b-12d3-a456-426614174000')); assert.ok(!cjs.UUID.test('123E4567-e89b-12d3-a456-426614174000'));
});

test('no former site keeps its own copy', () => {
  const sites = ['src/source-outbox.ts','src/source-recovery.ts','desktop/source-import.cjs','desktop/source-recovery.cjs','desktop/sources.cjs','desktop/boundary.cjs'];
  for (const f of sites) {
    const s = read(f);
    assert.doesNotMatch(s, /\b(65536|2147483648|100000)\b/, `${f} has a numeric limit literal`);
    assert.doesNotMatch(s, /64 \* 1024\b(?! \*\*)|2 \* 1024 \*\*? ?\d?|16 \* 1024 \*\* 3|128 \* 1024 \*\* 3/, `${f} has a size expression`);
    assert.ok(!s.includes('[0-9a-f]{8}-'), `${f} defines its own UUID pattern`);
    assert.ok(!s.includes("['episodeId','epochId','sequence'"), `${f} defines its own chunk key list`);
    assert.match(s, /source-limits\.(js|cjs)/, `${f} does not import the shared limits`);
  }
});
