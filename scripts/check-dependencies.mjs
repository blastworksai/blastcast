import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
assert.deepEqual(manifest.devDependencies, { typescript: '7.0.2' });
assert.ok(!manifest.dependencies);
for (const [name, entry] of Object.entries(lock.packages)) {
  if (!name) continue;
  assert.ok(name === 'node_modules/typescript' || name.startsWith('node_modules/@typescript/typescript-'), name);
  assert.equal(entry.version, '7.0.2', name);
  assert.equal(entry.license, 'Apache-2.0', name);
  assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//, name);
  assert.match(entry.integrity, /^sha512-/, name);
}
const bodyPixAssets = {
  'assets/bodypix/tf.min.js': '0e7b8a68b1a1cbf8a0f49093fb22199c4a03bd77b010a0657464124e053d78d2',
  'assets/bodypix/body-pix.min.js': 'cbc86043e488d2edbafc2fa5ebeab39dde62b2e2c8caebc5d0366fbefefcd0d9',
  'assets/bodypix/model-stride16.json': '9312e01620959a6a68968748d9016f5aa5bc15a1db045a7f8fb977ef3e557589',
  'assets/bodypix/group1-shard1of1.bin': '76c2be65c09e953a1c6334cd122c3219c60dae9d66d62d575e2599a5b317ebe9',
};
for (const [file, expected] of Object.entries(bodyPixAssets)) {
  assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), expected, file);
}
const notice = await readFile('assets/bodypix/NOTICE.txt', 'utf8');
assert.match(notice, /TensorFlow\.js 1\.7\.4/); assert.match(notice, /BodyPix 2\.0\.5/); assert.match(notice, /Apache License 2\.0/);
console.log(`Dependency gate passed: ${Object.keys(lock.packages).length - 1} pinned compiler/platform entries and ${Object.keys(bodyPixAssets).length} pinned offline BodyPix assets, Apache-2.0. Electron is a separately verified official runtime.`);
