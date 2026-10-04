// CodexBWAI — app-owned device choices and scene backdrop overrides.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const SCENES = new Set(['1cam', '2cam', '3cam', '4cam', '5cam', '6cam', '7cam', '8cam', 'screensharevert-8', 'screensharehorizont-8']);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_BYTES = 20 * 1024 * 1024;
// ClaudeBWAI — camera background: optional devices.json key plus one PNG/JPEG image file.
const BACKGROUNDS = ['off', 'blur', 'image'];
const MAX_BACKGROUND_BYTES = 15 * 1024 * 1024;
const BACKGROUND_FILES = { png: 'camera-background.png', jpg: 'camera-background.jpg' };
function imageType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > MAX_BACKGROUND_BYTES) throw new Error('Choose a PNG or JPEG image no larger than 15 MB.');
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  throw new Error('Choose a PNG or JPEG image no larger than 15 MB.');
}
const DEFAULT_DEVICES = Object.freeze({ camera: '', microphone: '', height: 1080 });

function devices(value, migrateLegacy = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['camera', 'microphone', 'height', 'background'].includes(key))
    || (Object.hasOwn(value, 'background') && !BACKGROUNDS.includes(value.background))
    || !['camera', 'microphone'].every(key => typeof value[key] === 'string' && value[key].length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value[key]))
    || ![1080, 2160, ...(migrateLegacy ? [720] : [])].includes(value.height)) throw new Error('Invalid device preferences. Choose the devices and resolution again.');
  return { camera: value.camera, microphone: value.microphone, height: value.height === 720 ? 1080 : value.height, ...(Object.hasOwn(value, 'background') ? { background: value.background } : {}) };
}
function png(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < PNG_SIGNATURE.length || bytes.length > MAX_PNG_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Choose a PNG backdrop no larger than 20 MB.');
  }
  return bytes;
}
function sceneName(sceneId) {
  if (!SCENES.has(sceneId)) throw new Error('Unknown scene.');
  return `${sceneId}.png`;
}

function createStudioPreferences({ directory }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('An absolute application settings directory is required.');
  const root = path.join(directory, 'studio-preferences');

  async function ensureDirectory() {
    // The parent supplies Electron userData. Never follow a substituted settings folder.
    const parent = await fs.lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('The application settings directory is not a regular folder.');
    try { await fs.mkdir(root, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await fs.lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The saved settings folder is not a regular folder.');
  }
  async function regular(filename, maxBytes) {
    try {
      const info = await fs.lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) throw new Error('Saved settings contain an unsafe or oversized file.');
      return info;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function read(filename, maxBytes) {
    if (!await regular(filename, maxBytes)) return null;
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw new Error('Saved settings contain an unsafe or oversized file.');
      // Bounded read even if another process grows the file after stat.
      const bytes = Buffer.alloc(maxBytes + 1);
      let used = 0;
      while (used < bytes.length) {
        const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
        if (!bytesRead) break;
        used += bytesRead;
      }
      if (used > maxBytes) throw new Error('Saved settings file is too large.');
      return bytes.subarray(0, used);
    } finally { await handle.close(); }
  }
  async function write(filename, bytes, maxBytes) {
    await ensureDirectory();
    await regular(filename, maxBytes);
    const temporary = path.join(root, `.write-${randomUUID()}.tmp`);
    let created = false;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600); created = true;
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await regular(filename, maxBytes);
      await fs.rename(temporary, filename); created = false;
    } finally { if (created) await fs.unlink(temporary); }
  }
  async function result(action) {
    try { return await action(); } catch (error) {
      const known = error instanceof Error && !error.code;
      return { ok: false, message: known ? error.message : 'BlastCast could not access its saved settings. Check folder access and try again.' };
    }
  }
  let mutations = Promise.resolve();
  function mutate(action) {
    const next = mutations.then(() => result(action));
    mutations = next.then(() => undefined);
    return next;
  }
  async function backdrops() {
    await ensureDirectory();
    const values = {};
    for (const sceneId of SCENES) {
      const bytes = await read(path.join(root, sceneName(sceneId)), MAX_PNG_BYTES);
      if (bytes) values[sceneId] = `data:image/png;base64,${png(bytes).toString('base64')}`;
    }
    return { ok: true, backdrops: values };
  }
  async function backgroundImage() {
    await ensureDirectory();
    for (const [type, name] of Object.entries(BACKGROUND_FILES)) {
      const bytes = await read(path.join(root, name), MAX_BACKGROUND_BYTES);
      if (bytes) return `data:image/${type === 'png' ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`;
    }
    return null;
  }
  return {
    loadBackgroundImage: () => result(async () => ({ ok: true, dataUrl: await backgroundImage() })),
    saveBackgroundImage: bytes => mutate(async () => {
      const type = imageType(bytes);
      await write(path.join(root, BACKGROUND_FILES[type]), Buffer.from(bytes), MAX_BACKGROUND_BYTES);
      // Only one background exists at a time.
      const other = path.join(root, BACKGROUND_FILES[type === 'png' ? 'jpg' : 'png']);
      if (await regular(other, MAX_BACKGROUND_BYTES)) await fs.unlink(other);
      return { ok: true, dataUrl: await backgroundImage() };
    }),
    clearBackgroundImage: () => mutate(async () => {
      await ensureDirectory();
      for (const name of Object.values(BACKGROUND_FILES)) if (await regular(path.join(root, name), MAX_BACKGROUND_BYTES)) await fs.unlink(path.join(root, name));
      return { ok: true };
    }),
    loadDevices: () => result(async () => {
      await ensureDirectory();
      const bytes = await read(path.join(root, 'devices.json'), 4096);
      return { ok: true, preferences: bytes ? devices(JSON.parse(bytes.toString('utf8')), true) : { ...DEFAULT_DEVICES } };
    }),
    saveDevices: value => mutate(async () => {
      const preferences = devices(value);
      await write(path.join(root, 'devices.json'), Buffer.from(JSON.stringify(preferences)), 4096);
      return { ok: true, preferences };
    }),
    getBackdrops: () => result(backdrops),
    saveBackdrop: (sceneId, bytes) => mutate(async () => {
      const filename = sceneName(sceneId);
      const approvedBytes = Buffer.from(png(bytes));
      await write(path.join(root, filename), approvedBytes, MAX_PNG_BYTES);
      return backdrops();
    }),
    resetBackdrop: sceneId => mutate(async () => {
      const filename = path.join(root, sceneName(sceneId));
      await ensureDirectory();
      const bytes = await read(filename, MAX_PNG_BYTES);
      if (bytes) { png(bytes); await fs.unlink(filename); }
      return backdrops();
    }),
  };
}

module.exports = { createStudioPreferences, MAX_PNG_BYTES, MAX_BACKGROUND_BYTES };
