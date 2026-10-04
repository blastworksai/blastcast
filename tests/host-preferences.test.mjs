// ClaudeBWAI — host camera background preference and image storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const { createStudioPreferences, MAX_BACKGROUND_BYTES } = createRequire(import.meta.url)('../desktop/studio-preferences.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF'), Buffer.alloc(20), Buffer.from([0xff, 0xd9])]);
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-host-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, store: createStudioPreferences({ directory }), root: path.join(directory, 'studio-preferences') };
}
const base = { camera: 'c', microphone: 'm', height: 1080 };
test('cold start and legacy files load with no background', async t => {
  const { store, root } = await fixture(t);
  const cold = await store.loadDevices();
  assert.equal(cold.ok, true); assert.equal('background' in cold.preferences, false);
  await fs.writeFile(path.join(root, 'devices.json'), JSON.stringify(base));
  assert.deepEqual(await store.loadDevices(), { ok: true, preferences: base });
});
test('background round-trips and rejects other values', async t => {
  const { store, directory } = await fixture(t);
  for (const background of ['off', 'blur', 'image']) {
    assert.equal((await store.saveDevices({ ...base, background })).ok, true);
    assert.equal((await createStudioPreferences({ directory }).loadDevices()).preferences.background, background);
  }
  for (const background of ['sparkle', 1, null, undefined]) assert.equal((await store.saveDevices({ ...base, background })).ok, false);
  assert.equal((await store.loadDevices()).preferences.background, 'image');
});
test('image store, load and clear round-trip for PNG and JPEG', async t => {
  const { store, root } = await fixture(t);
  assert.deepEqual(await store.loadBackgroundImage(), { ok: true, dataUrl: null });
  const p = await store.saveBackgroundImage(PNG);
  assert.equal(p.dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.deepEqual(await store.loadBackgroundImage(), p);
  const j = await store.saveBackgroundImage(JPG);
  assert.equal(j.dataUrl, `data:image/jpeg;base64,${JPG.toString('base64')}`);
  assert.deepEqual((await fs.readdir(root)).filter(n => n.startsWith('camera-background')), ['camera-background.jpg']);
  assert.equal(((await fs.stat(root)).mode & 0o777), 0o700);
  assert.deepEqual(await store.clearBackgroundImage(), { ok: true });
  assert.deepEqual(await store.loadBackgroundImage(), { ok: true, dataUrl: null });
  assert.deepEqual(await store.clearBackgroundImage(), { ok: true });
});
test('stored type follows the bytes, not a name', async t => {
  const { store, root } = await fixture(t);
  await store.saveBackgroundImage(PNG); // a PNG that was named photo.jpg is still a PNG
  assert.deepEqual((await fs.readdir(root)).filter(n => n.startsWith('camera-background')), ['camera-background.png']);
});
test('oversize and non-image bytes are refused and leave the stored image alone', async t => {
  const { store } = await fixture(t);
  await store.saveBackgroundImage(PNG);
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_BACKGROUND_BYTES)]);
  for (const bytes of [big, Buffer.from('GIF89a......................'), Buffer.from('hello'), 'text', null]) {
    assert.equal((await store.saveBackgroundImage(bytes)).ok, false);
  }
  assert.equal((await store.loadBackgroundImage()).dataUrl.startsWith('data:image/png'), true);
});
