import { existsSync } from "node:fs";
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
// ClaudeBWAI — MediaPipe Tasks Vision 1.0.1 replaces BodyPix (owner, 7 Oct 2026); assets/bodypix must not return.
const mediaPipeAssets = {
  'assets/mediapipe/vision_bundle.mjs': 'd885630c297c0b20b1fe86096cb06291c4c8080876f27852e724f24ac603713f',
  'assets/mediapipe/wasm/vision_wasm_internal.js': 'e170ee67dd4e16c1a6fcd8840a206687e5a59b22c20e4a902bc445b095454d73',
  'assets/mediapipe/wasm/vision_wasm_internal.wasm': '8da277a733926eacd0474b8704b36742d6ec3231c57a860c5b889dff8f1df886',
  'assets/mediapipe/wasm/vision_wasm_nosimd_internal.js': 'e81d715a3d42cc3373602eb2f7aff795d164934db680e32496b65dab537f9658',
  'assets/mediapipe/wasm/vision_wasm_nosimd_internal.wasm': 'a28483cd42e74e855bf5ebdb6b40d9b66a5b49e35e95020bc97669e6822a3192',
  'assets/mediapipe/selfie_segmenter.tflite': '191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b',
};
for (const [file, expected] of Object.entries(mediaPipeAssets)) {
  assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), expected, file);
}
const notice = await readFile('assets/mediapipe/NOTICE.txt', 'utf8');
assert.match(notice, /tasks-vision 1\.0\.1/); assert.match(notice, /Apache License/);
assert.equal(existsSync('assets/bodypix'), false, 'assets/bodypix must not exist');
console.log(`Dependency gate passed: ${Object.keys(lock.packages).length - 1} pinned compiler/platform entries and ${Object.keys(mediaPipeAssets).length} pinned offline MediaPipe assets, Apache-2.0. Electron is a separately verified official runtime.`);
