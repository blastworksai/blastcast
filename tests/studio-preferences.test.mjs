// CodexBWAI — settings persistence without access to shipped scene files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const { createStudioPreferences, MAX_PNG_BYTES } = createRequire(import.meta.url)('../desktop/studio-preferences.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-preferences-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, store: createStudioPreferences({ directory }), root: path.join(directory, 'studio-preferences') };
}
test('device choices persist but enablement never does', async t => {
  const { store, directory } = await fixture(t);
  assert.deepEqual(await store.loadDevices(), { ok: true, preferences: { camera: '', microphone: '', height: 1080 } });
  const preferences = { camera: 'cam-abc', microphone: 'mic-def', height: 2160 };
  assert.deepEqual(await store.saveDevices(preferences), { ok: true, preferences });
  assert.deepEqual(await createStudioPreferences({ directory }).loadDevices(), { ok: true, preferences });
  assert.equal((await store.saveDevices({ ...preferences, cameraEnabled: true })).ok, false);
  assert.deepEqual((await store.loadDevices()).preferences, preferences);
});
test('legacy 720p host preference migrates to the 1080p minimum', async t => {
  const { store, root } = await fixture(t);
  await store.loadDevices();
  await fs.writeFile(path.join(root, 'devices.json'), JSON.stringify({ camera: 'old-cam', microphone: 'old-mic', height: 720 }));
  assert.deepEqual(await store.loadDevices(), { ok: true, preferences: { camera: 'old-cam', microphone: 'old-mic', height: 1080 } });
});
test('invalid device fields leave valid preferences intact', async t => {
  const { store } = await fixture(t); const preferences = { camera: '', microphone: '', height: 1080 };
  await store.saveDevices(preferences);
  for (const value of [null, {}, { ...preferences, camera: 'x'.repeat(513) }, { ...preferences, microphone: '\0' }, { ...preferences, height: 720 }]) assert.equal((await store.saveDevices(value)).ok, false);
  assert.deepEqual((await store.loadDevices()).preferences, preferences);
});
test('per-scene backdrops survive restart and reset only the chosen override', async t => {
  const { store, directory, root } = await fixture(t);
  assert.deepEqual(await store.getBackdrops(), { ok: true, backdrops: {} });
  await store.saveBackdrop('1cam', PNG); await store.saveBackdrop('screensharevert-8', PNG);
  const restored = await createStudioPreferences({ directory }).getBackdrops();
  assert.equal(restored.backdrops['1cam'], `data:image/png;base64,${PNG.toString('base64')}`);
  const result = await store.resetBackdrop('1cam');
  assert.deepEqual(Object.keys(result.backdrops), ['screensharevert-8']);
  assert.deepEqual(await fs.readdir(root), ['screensharevert-8.png']);
});
test('invalid scene paths, bytes and oversize content cannot be saved', async t => {
  const { store } = await fixture(t);
  assert.equal((await store.saveBackdrop('../outside', PNG)).ok, false);
  assert.equal((await store.resetBackdrop('../outside')).ok, false);
  assert.equal((await store.saveBackdrop('1cam', Buffer.from('no png'))).ok, false);
  assert.equal((await store.saveBackdrop('1cam', Buffer.alloc(MAX_PNG_BYTES + 1))).ok, false);
  assert.deepEqual(await store.getBackdrops(), { ok: true, backdrops: {} });
});
test('symlink files are refused for reads, writes and explicit reset', async t => {
  const { store, directory, root } = await fixture(t); await store.getBackdrops();
  const outside = path.join(directory, 'outside.png'); await fs.writeFile(outside, PNG);
  await fs.symlink(outside, path.join(root, '1cam.png'));
  for (const result of [await store.getBackdrops(), await store.saveBackdrop('1cam', PNG), await store.resetBackdrop('1cam')]) assert.equal(result.ok, false);
  assert.deepEqual(await fs.readFile(outside), PNG);
  await fs.symlink(outside, path.join(root, 'devices.json'));
  assert.equal((await store.loadDevices()).ok, false);
  assert.equal((await store.saveDevices({ camera: '', microphone: '', height: 1080 })).ok, false);
});
test('symlink settings directory is refused', async t => {
  const { store, directory, root } = await fixture(t); const outside = path.join(directory, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, root);
  assert.equal((await store.getBackdrops()).ok, false);
  assert.equal((await store.saveDevices({ camera: '', microphone: '', height: 1080 })).ok, false);
  assert.deepEqual(await fs.readdir(outside), []);
});
test('malformed and oversized saved files report failure without deleting data', async t => {
  const { store, root } = await fixture(t); await store.loadDevices();
  const filename = path.join(root, 'devices.json');
  await fs.writeFile(filename, '{broken'); assert.equal((await store.loadDevices()).ok, false);
  await fs.writeFile(filename, Buffer.alloc(4097)); assert.equal((await store.loadDevices()).ok, false);
  assert.equal((await fs.stat(filename)).size, 4097);
});

test('rapid changes save in request order and leave no staging files', async t => {
  const { store, root } = await fixture(t);
  const writes = Array.from({ length: 10 }, (_, index) => store.saveDevices({ camera: `camera-${index}`, microphone: '', height: 1080 }));
  assert.ok((await Promise.all(writes)).every(result => result.ok));
  assert.equal((await store.loadDevices()).preferences.camera, 'camera-9');
  assert.deepEqual(await fs.readdir(root), ['devices.json']);
});
test('saving and resetting overrides cannot change supplied default assets', async t => {
  const { store } = await fixture(t);
  const original = new URL('../assets/scenes/defaults/1cam.png', import.meta.url);
  const before = await fs.readFile(original);
  await store.saveBackdrop('1cam', PNG); await store.resetBackdrop('1cam');
  assert.deepEqual(await fs.readFile(original), before);
});
