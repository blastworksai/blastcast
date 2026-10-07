// ClaudeBWAI: checks the Mac App Store signing kit (three entitlement sets, sign-mas.sh shape).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kit = path.join(root, 'packaging', 'macos');
const scriptPath = path.join(kit, 'sign-mas.sh');
const script = fs.readFileSync(scriptPath, 'utf8');

// Reads a plist dict of <key>…</key> followed by <true/>, <false/> or <string>…</string> or <array>…</array>.
function readPlist(name) {
  const xml = fs.readFileSync(path.join(kit, name), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  assert.match(xml, /<plist version="1\.0">\s*<dict>[\s\S]*<\/dict>\s*<\/plist>/, `${name} is not a plist dict`);
  const body = xml.slice(xml.indexOf('<dict>') + 6, xml.lastIndexOf('</dict>'));
  const re = /<key>([^<]+)<\/key>\s*(<true\/>|<false\/>|<string>[^<]*<\/string>|<array>[\s\S]*?<\/array>)/g;
  const out = {};
  let consumed = body;
  for (const m of body.matchAll(re)) {
    out[m[1]] = m[2];
    consumed = consumed.replace(m[0], '');
  }
  assert.equal(consumed.trim(), '', `${name} has content the reader did not understand`);
  assert.equal((body.match(/<key>/g) || []).length, Object.keys(out).length, `${name} key count mismatch (duplicate?)`);
  return out;
}

const S = 'com.apple.security.';
const PARENT = [
  `${S}app-sandbox`, `${S}application-groups`, `${S}device.camera`, `${S}device.audio-input`,
  `${S}network.client`, `${S}network.server`, `${S}files.user-selected.read-write`,
  `${S}files.bookmarks.app-scope`, 'com.apple.application-identifier', 'com.apple.developer.team-identifier',
].sort();

test('entitlements-mas.plist has exactly the proven parent key set', () => {
  const p = readPlist('entitlements-mas.plist');
  assert.deepEqual(Object.keys(p).sort(), PARENT);
  assert.ok(!Object.keys(p).some((k) => k.includes('.cs.')), 'no cs.* keys');
  assert.equal(p['com.apple.application-identifier'], '<string>RN28A922NH.com.blastworks.blastcast</string>');
  assert.equal(p['com.apple.developer.team-identifier'], '<string>RN28A922NH</string>');
  assert.match(p[`${S}application-groups`], /<string>RN28A922NH\.com\.blastworks\.blastcast<\/string>/);
  for (const k of PARENT.filter((k) => k.startsWith(S) && k !== `${S}application-groups`)) {
    assert.equal(p[k], '<true/>', k);
  }
});

test('entitlements-mas-child.plist is app-sandbox + inherit only', () => {
  const p = readPlist('entitlements-mas-child.plist');
  assert.deepEqual(Object.keys(p).sort(), [`${S}app-sandbox`, `${S}inherit`]);
  assert.ok(Object.values(p).every((v) => v === '<true/>'));
});

test('entitlements-mas-loginhelper.plist is app-sandbox only', () => {
  const p = readPlist('entitlements-mas-loginhelper.plist');
  assert.deepEqual(Object.keys(p), [`${S}app-sandbox`]);
  assert.equal(p[`${S}app-sandbox`], '<true/>');
});

test('sign-mas.sh passes bash -n', () => {
  const r = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('sign-mas.sh passes shellcheck when installed', (t) => {
  const r = spawnSync('shellcheck', [scriptPath], { encoding: 'utf8' });
  if (r.error) return t.skip('shellcheck not on PATH');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('sign-mas.sh tests nested apps on the path relative to the outer app', () => {
  assert.ok(script.includes('rel="${f#"$APP"/}"'), 'rel is not computed against $APP');
  assert.ok(script.includes('case "$rel" in *.app/*) continue ;; esac'), 'relative nested-app test missing');
  assert.ok(!/case "\$f" in \*\.app\//.test(script), 'absolute-path nested-app test present');
});

test('sign-mas.sh follows the spike flags (no hardened runtime) and the preflight contract', () => {
  const code = script.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.ok(!code.includes('--options runtime'), 'spike did not use --options runtime');
  for (const needle of ['set -euo pipefail', 'security find-identity -v', 'SSH_CONNECTION', 'ditto "$INPUT_APP" "$APP"',
    'out-dir exists and is not empty', 'embedded.provisionprofile', 'Apple Distribution: Kristof Kennes',
    '3rd Party Mac Developer Installer: Kristof Kennes', 'productbuild --component "$APP" /Applications --sign',
    'codesign --verify --deep --strict', 'codesign -d --entitlements :-', 'pkgutil --check-signature',
    'BlastCast_MAS.provisionprofile']) {
    assert.ok(script.includes(needle), `missing: ${needle}`);
  }
  for (const bad of ['unlock-keychain', 'set-key-partition-list', '--password', 'notarytool']) {
    assert.ok(!script.includes(bad), `forbidden: ${bad}`);
  }
});

test('sign-mas.sh signs in order: leaves, frameworks, helpers, login helper, ssh, main app', () => {
  const marks = ['Signing loose Mach-O', 'Signing framework bundles', 'Signing helper apps', 'Signing login helper',
    'Signing the bundled ssh helper', 'Signing the main app'].map((m) => script.indexOf(m));
  assert.ok(marks.every((i) => i >= 0));
  assert.deepEqual([...marks].sort((a, b) => a - b), marks);
});

test('sign-mas.sh strips extended attributes before signing and refuses quarantined files (App Store Connect 91109)', () => {
  const strip = script.indexOf('xattr -cr "$APP"');
  const firstSign = script.indexOf('step "Signing loose Mach-O');
  const guard = script.indexOf('quarantined="$(xattr -lr "$APP"');
  assert.ok(!/xattr[^\n]*\|\s*grep -q/.test(script), 'no grep -q after xattr in a pipe (pipefail SIGPIPE)');
  const pkg = script.indexOf('productbuild --component');
  assert.ok(strip > script.indexOf('embedded.provisionprofile') && strip < firstSign, 'xattr -cr runs after the profile copy and before any signing');
  assert.ok(guard > firstSign && guard < pkg, 'quarantine check runs before productbuild');
});

test('sign-mas.sh refuses files that non-root users cannot read, before productbuild (App Store Connect 90255)', () => {
  const guard = script.indexOf('unreadable="$(find "$APP"');
  assert.ok(guard > 0, 'readability check present');
  assert.ok(guard > script.indexOf('quarantined="$(xattr -lr "$APP"') && guard < script.indexOf('productbuild --component'), 'runs after the quarantine check and before productbuild');
  assert.match(script, /! -perm -o\+r/);
});
