// CodexBWAI — installer terms must retain Unicode and paragraph boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { termsRtf } from '../packaging/windows/wizard-plan.mjs';
test('license RTF preserves punctuation and escapes markup without locale-dependent bytes', () => {
  const rtf = termsRtf('BlastCast — terms of use\n“as is”\\{text}\n');
  assert.match(rtf, /\\u8212\?/);
  assert.match(rtf, /\\u8220\?as is\\u8221\?/);
  assert.ok(rtf.includes('\\\\\\{text\\}'));
  assert.equal((rtf.match(/\\par /g) ?? []).length, 2);
  assert.doesNotMatch(rtf, /[^\x00-\x7f]/);
});
