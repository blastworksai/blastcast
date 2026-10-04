// ClaudeBWAI — the relay step tells the host, visibly, that admitted guests keep the relay details.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const NOTICE = 'Admitted guests receive these relay details for the call and could keep using your ExpressTURN allowance afterwards. Change the password in ExpressTURN if that matters to you.';
const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const step = html.slice(html.indexOf('<section id="guest-relay-step"'), html.indexOf('</section>', html.indexOf('<section id="guest-relay-step"')));
test('the verbatim notice is in the relay step, outside any <details>', () => {
  assert.ok(step.includes(NOTICE));
  const before = step.slice(0, step.indexOf(NOTICE));
  assert.equal((before.match(/<details/g) ?? []).length, (before.match(/<\/details>/g) ?? []).length, 'every <details> opened before the notice is closed');
  assert.match(before, /<p id="relay-guest-notice" class="small notice">$/);
});
test('the collapsed section no longer contradicts it', () => {
  const details = step.slice(step.indexOf('<details>'));
  assert.doesNotMatch(details, /Rotate them in ExpressTURN after a session/);
  assert.doesNotMatch(details, /guests can retain them until then/);
});
