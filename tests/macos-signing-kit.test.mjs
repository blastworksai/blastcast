// ClaudeBWAI: checks the macOS signing kit (entitlements, script shape, no secrets, pkgbuild/productbuild drift against package.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kit = path.join(root, 'packaging', 'macos');
const scriptPath = path.join(kit, 'sign-notarize.sh');
const script = fs.readFileSync(scriptPath, 'utf8');
const packageSrc = fs.readFileSync(path.join(kit, 'package.mjs'), 'utf8');

test('entitlements.plist has exactly the four device and runtime keys, all true', () => {
  const xml = fs.readFileSync(path.join(kit, 'entitlements.plist'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const pairs = [...xml.matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\/>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(pairs.map((p) => p[0]).sort(), [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.device.audio-input',
    'com.apple.security.device.camera',
  ]);
  assert.ok(pairs.every((p) => p[1] === 'true'));
  assert.equal((xml.match(/<key>/g) || []).length, 4);
});

test('sign-notarize.sh passes bash -n', () => {
  const r = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('sign-notarize.sh carries the required flags and commands', () => {
  for (const needle of ['set -euo pipefail', '--options runtime', '--entitlements', '--timestamp',
    '--keychain-profile blastcast-notary', 'stapler staple', 'spctl -a -vvv -t install']) {
    assert.ok(script.includes(needle), `missing: ${needle}`);
  }
});

test('sign-notarize.sh holds no secret-handling strings', () => {
  for (const bad of ['unlock-keychain', 'set-key-partition-list', '--password']) {
    assert.ok(!script.includes(bad), `forbidden: ${bad}`);
  }
});

// Normalise a JS arg array body and a shell command into comparable token lists.
function jsTokens(call) {
  const m = packageSrc.match(new RegExp(`'/usr/bin/${call}',\\s*\\[([\\s\\S]*?)\\]\\);`));
  assert.ok(m, `${call} call not found in package.mjs`);
  return [...m[1].matchAll(/'([^']*)'|([A-Za-z_$][\w$.]*)/g)].map((t) => (t[1] !== undefined ? t[1] : '$VAR'));
}
function shTokens(call) {
  const joined = script.replace(/\\\n\s*/g, ' ');
  const line = joined.split('\n').find((l) => l.startsWith(`${call} `));
  assert.ok(line, `${call} line not found in script`);
  return [...line.matchAll(/"[^"]*"|\S+/g)].map((t) => (/[$]/.test(t[0]) ? '$VAR' : t[0].replace(/^"|"$/g, ''))).slice(1);
}

test('contract drift: pkgbuild arguments match package.mjs', () => {
  assert.deepEqual(shTokens('pkgbuild'), jsTokens('pkgbuild'));
});

test('contract drift: productbuild arguments match package.mjs except --sign', () => {
  const sh = shTokens('productbuild');
  const i = sh.indexOf('--sign');
  assert.ok(i >= 0, 'productbuild lacks --sign');
  sh.splice(i, 2);
  assert.deepEqual(sh, jsTokens('productbuild'));
});

test('contract drift: component plist matches package.mjs', () => {
  const js = packageSrc.match(/componentPlist = `([\s\S]*?)`;/);
  const sh = script.match(/<<'COMP'\n([\s\S]*?)\nCOMP\n/);
  assert.ok(js && sh);
  assert.equal(sh[1].trim(), js[1].trim());
});
