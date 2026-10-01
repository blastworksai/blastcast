import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

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
