// ClaudeBWAI — MediaPipe replaces BodyPix (7 Oct 2026): the vendored bundle's one outside URL is usage logging; BlastCast blocks it with CSP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

test('vision_bundle.mjs names exactly one outside host, the usage-logging endpoint', async () => {
  const text = await readFile('assets/mediapipe/vision_bundle.mjs', 'utf8');
  const hosts = new Set([...text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map(m => m[1]));
  assert.deepEqual([...hosts], ['odml.pa.googleapis.com']);
});

test('both CSPs keep connect-src self only and script-src self plus wasm-unsafe-eval', async () => {
  const main = await readFile('desktop/main.cjs', 'utf8');
  const http = await readFile('desktop/guest-http.cjs', 'utf8');
  const csps = [main.match(/const csp = "([^"]+)"/)[1], http.match(/headers = \{\s*'Content-Security-Policy': "([^"]+)"/)[1]];
  for (const csp of csps) {
    const directives = Object.fromEntries(csp.split(';').map(d => d.trim().split(/\s+(.*)/s)));
    assert.equal(directives['connect-src'], "'self'", csp);
    assert.equal(directives['script-src'], "'self' 'wasm-unsafe-eval'", csp);
  }
});

test('BodyPix is gone', () => { assert.equal(existsSync('assets/bodypix'), false); });
