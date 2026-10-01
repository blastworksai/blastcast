// CodexBWAI — private display metadata; recording files and recovery manifests are never renamed.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MAX_RECORDINGS = 5000, MAX_BYTES = 8 * 1024 * 1024;
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
const validLabel = label => typeof label === 'string' && label.trim().length > 0 && label.length <= 160 && !/[\x00-\x1f\x7f]/.test(label);
function validEntry(e) {
  return e && validId(e.id) && validLabel(e.label) && typeof e.path === 'string' && e.path.length <= 4096 && path.isAbsolute(e.path) && path.extname(e.path).toLowerCase() === '.webm' && !e.path.includes('\0') &&
    typeof e.name === 'string' && e.name.length > 0 && e.name.length <= 255 && e.name === path.basename(e.path) &&
    Number.isSafeInteger(e.createdAt) && e.createdAt >= 0 && Number.isSafeInteger(e.durationMs) && e.durationMs >= 0;
}
async function plainParents(file) {
  let parent = path.dirname(file);
  for (;;) { const stat = await fs.lstat(parent); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe library directory');
    const next = path.dirname(parent); if (next === parent) return; parent = next; }
}
async function regularFile(file) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Not a regular file');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { const actual = await handle.stat(); if (!actual.isFile() || before.dev !== actual.dev || before.ino !== actual.ino) throw new Error('File changed'); return handle; }
  catch (error) { await handle.close(); throw error; }
}
function createRecordingLibrary({ file, open = async () => '' }) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Absolute library path required');
  let queue = Promise.resolve();
  const run = operation => { const task = queue.then(operation); queue = task.catch(() => {}); return task; };
  const bad = message => ({ ok: false, message });
  const publicEntry = ({ id, name, label, createdAt, durationMs }) => ({ id, name, label, createdAt, durationMs });
  async function read() {
    await plainParents(file);
    let handle;
    try { handle = await regularFile(file); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    try {
      if ((await handle.stat()).size > MAX_BYTES) throw new Error('Oversized library');
      const data = JSON.parse(await handle.readFile('utf8'));
      if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > MAX_RECORDINGS || !data.entries.every(validEntry) || new Set(data.entries.map(e => e.id)).size !== data.entries.length) throw new Error('Invalid library');
      return data.entries;
    } finally { await handle.close(); }
  }
  async function mutate(change) {
    await plainParents(file);
    let lock, temporary;
    try {
      lock = await fs.open(file + '.lock', 'wx', 0o600);
      const entries = await read(); const result = await change(entries);
      if (result.ok === false) return result;
      const serialized = JSON.stringify({ version: 1, entries });
      if (Buffer.byteLength(serialized) > MAX_BYTES) return bad('The library metadata is full. Existing records were kept.');
      temporary = file + '.' + randomUUID() + '.tmp';
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
      await plainParents(file);
      // Re-read validates the destination before replacement; symlinks are never followed.
      await read(); await fs.rename(temporary, file); temporary = null;
      return result;
    } finally {
      if (temporary) await fs.unlink(temporary).catch(() => {});
      if (lock) { await lock.close(); await fs.unlink(file + '.lock'); }
    }
  }
  const unavailable = () => bad('The recording library is unavailable or damaged. Existing metadata and recordings were kept. Close other BlastCast windows and check the library before retrying.');
  return {
    list: () => run(async () => { try { return { ok: true, recordings: (await read()).sort((a,b) => b.createdAt-a.createdAt).map(publicEntry) }; } catch { return unavailable(); } }),
    add: entry => run(async () => {
      const e = entry && { id: entry.id, path: entry.path, name: entry.name, label: entry.name, createdAt: entry.createdAt, durationMs: entry.durationMs };
      if (!validEntry(e)) return bad('Invalid recording library entry. The recording was kept.');
      try { return await mutate(async entries => {
        const prior = entries.find(item => item.id === e.id);
        if (prior) return prior.path === e.path ? { ok: true } : bad('Recording identity already exists.');
        if (entries.length >= MAX_RECORDINGS) return bad('The library is full. The recording was saved but could not be listed.');
        const handle = await regularFile(e.path); await handle.close(); entries.push(e); return { ok: true };
      }); } catch { return unavailable(); }
    }),
    rename: (id, label) => run(async () => {
      if (!validId(id) || !validLabel(label)) return bad('Use a recording name of 1–160 characters without control characters.');
      try { return await mutate(entries => { const e = entries.find(item => item.id === id); if (!e) return bad('Recording not found in the library.'); e.label = label.trim(); return { ok: true }; }); } catch { return unavailable(); }
    }),
    open: id => run(async () => {
      if (!validId(id)) return bad('Invalid recording selection.');
      let entry; try { entry = (await read()).find(e => e.id === id); } catch { return unavailable(); }
      if (!entry) return bad('Recording not found in the library.');
      try { const handle = await regularFile(entry.path); await handle.close(); }
      catch { return bad('This recording file is missing or unavailable. Reconnect its drive or locate it in your recording folder.'); }
      try { return await open(entry.path) ? bad('No player could open this recording. The file was kept.') : { ok: true }; }
      catch { return bad('The recording could not be opened. The file was kept.'); }
    }),
  };
}
module.exports = { createRecordingLibrary, MAX_RECORDINGS };
