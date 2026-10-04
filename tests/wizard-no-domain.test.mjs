// ClaudeBWAI — regression for e50d78d: the guest wizard's no-domain path hides every Cloudflare figure and shows its own five steps.
// invites.ts runs against the live DOM at load, so this asserts on compiled dist/invites.js text; the live-DOM invariant sweep is in tests/helper-smoke.cjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const js = readFileSync(new URL('../dist/invites.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const noDomainSteps = [
  'Nothing to install or sign up for.',
  'The address is inside the invite link, and under Troubleshooting',
  'Next: paste your ExpressTURN details.',
  'The address changes every session, so generate a new invite each time.',
  'If it fails: make sure the OpenSSH Client is installed',
];
const cloudflareSteps = [
  'Add your domain to Cloudflare.',
  'Follow the dashboard instructions to run cloudflared on this computer.',
  'Open Routes, click Add route, choose Published application',
];
const hiddenIds = ['cloudflare-ready-figure', 'cloudflare-route-form-figure', 'cloudflare-route-ready-figure', 'helper-domain-note'];

describe('guest wizard no-domain path (dist/invites.js)', () => {
  it('lists the five no-domain steps in order', () => {
    let at = -1;
    for (const text of noDomainSteps) {
      const next = js.indexOf(text, at + 1);
      assert.ok(next > at, `step missing or out of order: ${text}`);
      at = next;
    }
  });
  it('picks the no-domain list when there is no domain and keeps the three Cloudflare steps for yes', () => {
    const noStart = js.indexOf(noDomainSteps[0]);
    const yesStart = js.indexOf(cloudflareSteps[0]);
    assert.ok(yesStart > js.indexOf(noDomainSteps[4]), 'Cloudflare steps follow the no-domain steps in the ternary');
    let at = yesStart - 1;
    for (const text of cloudflareSteps) { const next = js.indexOf(text, at + 1); assert.ok(next > at, `Cloudflare step missing: ${text}`); at = next; }
    assert.match(js.slice(0, noStart).slice(-200), /!domain\s*\?\s*\[\s*'$/, 'no-domain array is chosen by !domain');
  });
  it('hides the four Cloudflare ids with !domain and no longer hides the steps list', () => {
    const loop = js.match(/for \(const id of \[([^\]]+)\]\)\s*el\(id\)\.hidden = !domain/);
    assert.ok(loop, 'hide loop present');
    for (const id of hiddenIds) assert.ok(loop[1].includes(`'${id}'`) || loop[1].includes(`"${id}"`), `hide loop covers ${id}`);
    assert.doesNotMatch(js, /el\('helper-steps'\)\.hidden = !domain/);
  });
  it('index.html carries all four elements the loop hides', () => {
    for (const id of hiddenIds) assert.match(html, new RegExp(`id="${id}"`), `${id} exists`);
  });
});
