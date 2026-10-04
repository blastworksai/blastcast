// ClaudeBWAI — every module the studio page loads must be in the app:// asset map, or the studio never starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const served = new Set([...readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8').matchAll(/\['(\/[^']+)',\s*'[a-z]+\/[a-z.+-]+'\]/g)].map(m => m[1]));

function pageModules(page) {
  const html = readFileSync(path.join(root, 'dist', page), 'utf8');
  const queue = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(m => m[1]);
  const seen = new Set();
  while (queue.length) {
    const file = queue.shift().replace(/^\.?\//, '');
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.endsWith('.js') || file.includes('/')) continue;
    const source = readFileSync(path.join(root, 'dist', file), 'utf8');
    for (const m of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]\.\/([^'"]+)['"]/g)) queue.push(m[1]);
  }
  return [...seen];
}

test('every script the studio page loads, and every module they import, is served by app://studio', () => {
  const modules = pageModules('index.html');
  assert.ok(modules.includes('studio.js') && modules.length > 10, `walked too little of the module graph: ${modules.join(', ')}`);
  for (const file of modules) {
    assert.ok(existsSync(path.join(root, 'dist', file)), `dist/${file} is imported but was not built`);
    assert.ok(served.has(`/${file}`), `/${file} is loaded by the studio but missing from the asset map in desktop/main.cjs`);
  }
});

// The guest page is served by the guest HTTPS server from its own explicit map (desktop/guests.cjs).
const guestServed = new Set([...readFileSync(path.join(root, 'desktop/guest-static.cjs'), 'utf8').matchAll(/\['(\/[^']+)',\s*\['[^']+',\s*'[a-z]+\/[a-z.+-]+(?:;[^']*)?'\]\]/g)].map(m => m[1]));

test('every script the guest page loads, and every module they import, is served by the guest server', () => {
  const modules = pageModules('guest.html');
  assert.ok(modules.includes('guest.js') && modules.length > 8, `walked too little of the guest module graph: ${modules.join(', ')}`);
  for (const file of modules) {
    assert.ok(existsSync(path.join(root, 'dist', file)), `dist/${file} is imported but was not built`);
    assert.ok(guestServed.has(`/${file}`), `/${file} is loaded by the guest page but missing from the asset map in desktop/guests.cjs`);
  }
});
