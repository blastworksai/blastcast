import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('Settings exposes activation and public repository wording without private-invite copy', async () => {
  const html=await fs.readFile('src/index.html','utf8'), studio=await fs.readFile('src/studio.ts','utf8'), preload=await fs.readFile('desktop/preload.cjs','utf8');
  for(const id of ['activation-card','activation-key','activate-license','deactivate-license','activation-lock']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/public GitHub repository/); assert.doesNotMatch(html,/invited account|private GitHub/i);
  assert.match(studio,/window\.blastcast\.activateLicense/); assert.match(studio,/studio\.inert = !active/); assert.match(studio,/location\.reload\(\)/);
  for(const method of ['licenseStatus','activateLicense','deactivateLicense']) assert.match(preload,new RegExp(`${method}:`));
});

test('private signing material and issued activation keys are excluded from tracked source', async () => {
  const files=(await fs.readFile('.gitignore','utf8'));
  assert.match(files,/\*\.pem/); assert.match(files,/\*\.key/);
  const publicKey=await fs.readFile('assets/licensing/public-key.txt','utf8'); assert.match(publicKey,/BEGIN PUBLIC KEY/); assert.doesNotMatch(publicKey,/PRIVATE/);
});

const PURCHASE = 'BlastCast requires a key purchased from Blastworks.ai';
const RELEASES = 'github.com/blastworksai/blastcast/releases';

test('app-store licence: studio.ts removes the key section, purchase sentence and releases link at render', async () => {
  const studio = await fs.readFile('src/studio.ts', 'utf8'), bridge = await fs.readFile('src/bridge.ts', 'utf8');
  assert.match(bridge, /\{kind:'app-store'\}/);
  assert.match(studio, /license\.kind === 'app-store'/);
  for (const id of ['activation-lock', 'activation-card', 'check-updates', 'update-status']) assert.ok(studio.includes(`'${id}'`), id);
  assert.match(studio, /document\.getElementById\(id\)\?\.remove\(\)/);
});

test('build: --mas strips non-mas blocks, the default build keeps them', async () => {
  const run = promisify(execFile), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-build-'));
  try {
    await run('node', ['scripts/build.mjs', '--mas', '--out', path.join(tmp, 'mas')]);
    await run('node', ['scripts/build.mjs', '--out', path.join(tmp, 'std')]);
    const mas = await fs.readFile(path.join(tmp, 'mas', 'index.html'), 'utf8'), std = await fs.readFile(path.join(tmp, 'std', 'index.html'), 'utf8');
    for (const needle of [PURCHASE, RELEASES, 'View source and releases', 'activation-key', 'non-mas']) assert.ok(!mas.includes(needle), `MAS leaks ${needle}`);
    assert.ok(std.includes(PURCHASE) && std.includes('activation-key') && std.includes('View source and releases') && !std.includes('non-mas'));
    const src = await fs.readFile('src/index.html', 'utf8');
    assert.equal(std, src.replaceAll('<!-- non-mas -->', '').replaceAll('<!-- /non-mas -->', ''));
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('build: unbalanced non-mas markers are refused loudly', async () => {
  const run = promisify(execFile), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-bad-')), script = path.resolve('scripts/build.mjs');
  try {
    await fs.mkdir(path.join(tmp, 'src'));
    for (const bad of ['<p>a</p><!-- non-mas --><p>b</p>', '<p>a</p><!-- /non-mas -->', '<!-- non-mas --><!-- non-mas --><!-- /non-mas --><!-- /non-mas -->']) {
      await fs.writeFile(path.join(tmp, 'src', 'index.html'), bad);
      await assert.rejects(run('node', [script, '--mas', '--out', path.join(tmp, 'o')], { cwd: tmp }), /unbalanced|nested/);
    }
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});
