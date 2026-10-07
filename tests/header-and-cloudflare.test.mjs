// ClaudeBWAI — MAS CP3 Tasks 3.6b and 3.6c.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/studio.css', import.meta.url), 'utf8').replace(/\s+/g, '');

describe('3.6c Cloudflare one-computer sentence', () => {
  const sentence = /Run the Cloudflare tunnel only on the computer that runs BlastCast\..*Bad gateway, 502/;
  it('is in the Cloudflare steps, before the route figures', () => {
    const m = html.match(/<p id="cloudflare-one-computer-note" class="small field-help">([^<]*)<\/p>/);
    assert.ok(m, 'note present');
    assert.match(m[1], sentence);
    assert.ok(html.indexOf('cloudflare-one-computer-note') < html.indexOf('id="cloudflare-route-form-figure"'));
    assert.ok(html.indexOf('cloudflare-one-computer-note') > html.indexOf('id="helper-reference-wrap"'));
  });
  it('ships in both builds: outside every non-mas block, markers balanced', () => {
    assert.equal(html.split('<!-- non-mas -->').length, html.split('<!-- /non-mas -->').length);
    const stripped = html.replace(/<!-- non-mas -->[\s\S]*?<!-- \/non-mas -->/g, '');
    assert.match(stripped, /cloudflare-one-computer-note/);
  });
});

describe('3.6b header controls', () => {
  // Guards the header style: Settings is an outlined .secondary button (transparent, ink text) and the status is plain text,
  // so neither can fall back to the native light button. Only the mic/camera "off" toggles are filled, by design.
  it('Settings carries the .secondary class and the status is not a button', () => {
    assert.match(html, /<button id="open-settings" class="secondary"/);
    assert.match(html, /<span id="shell-status" class="bc-status"/);
  });
  it('.secondary is transparent with var(--ink) text', () => {
    const m = css.match(/\.primary,\.secondary,\.text-button\{([^}]*)\}/);
    assert.ok(m);
    assert.match(m[1], /background:transparent/);
    assert.match(m[1], /color:var\(--ink\)/);
  });
  it('no rule fills the header controls white', () => {
    assert.doesNotMatch(css, /#open-settings\{[^}]*background/);
    assert.doesNotMatch(css, /#shell-status\{[^}]*background/);
  });
});
