// CodexBWAI — only main chooses and retains filesystem paths.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function folderError(error) {
  switch (error?.code) {
    case 'EACCES': case 'EPERM': case 'EROFS': return 'This folder is not writable. Choose a folder you can save to.';
    case 'ENOSPC': case 'EDQUOT': return 'This drive has no space available. Free some space or choose another drive.';
    case 'ENOENT': case 'ENOTDIR': return 'This folder is unavailable. Reconnect the drive or choose another folder.';
    case 'EOPNOTSUPP': case 'ENOTSUP': case 'ENOSYS': return 'This folder cannot safely finish recordings. Choose another drive.';
    default: return 'This folder could not be checked. Reconnect the drive or choose another folder.';
  }
}

async function probeFolder(folder, io = fs) {
  let handle;
  let created = false;
  let linked = false;
  let failure;
  const probe = path.join(folder, `.blastcast-write-check-${randomUUID()}`);
  const publication = probe + '.link';
  try {
    if (!(await io.stat(folder)).isDirectory()) return { status: 'error', message: folderError({ code: 'ENOTDIR' }) };
    handle = await io.open(probe, 'wx', 0o600);
    created = true;
    await handle.writeFile('BlastCast destination check\n');
    await handle.sync();
    await io.link(probe, publication);
    linked = true;
  } catch (error) { failure = error; }
  finally {
    if (handle) {
      try { await handle.close(); } catch (error) { failure ??= error; }
    }
    let cleanupFailed = false;
    for (const owned of [linked ? publication : null, created ? probe : null]) {
      if (owned) { try { await io.unlink(owned); } catch { cleanupFailed = true; } }
    }
    if (cleanupFailed) return { status: 'error', message: 'A temporary folder-check file could not be removed. Check this folder before trying again.' };
  }
  return failure ? { status: 'error', message: folderError(failure) } : { status: 'ready', label: folder };
}

// ClaudeBWAI — Task 3.3: the recording folder survives relaunch in every build; only the Mac App Store build also keeps security-scoped bookmarks.
const MAX_FILE = 65536;
const MAX_BOOKMARKS = 32;
const NO_FOLDER = 'Choose a recording folder first.';

function validFolder(value) { return typeof value === 'string' && value.length > 0 && value.length < 4096 && path.isAbsolute(value) && !value.includes('\0'); }
function validBookmark(value) { return typeof value === 'string' && value.length > 0 && value.length < 16384 && /^[A-Za-z0-9+/=]+$/.test(value); }

function createFolderStore(file) {
  async function ensureDirectory() {
    const parent = await fs.lstat(path.dirname(file));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Application settings are unavailable.');
  }
  async function read() {
    let info;
    try { info = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_FILE) throw new Error('Saved folder is unsafe.');
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try { return JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
  }
  async function write(state) {
    await ensureDirectory();
    try { if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Saved folder is unsafe.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}-${randomUUID()}.tmp`);
    let created = false;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600); created = true;
      try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, file); created = false;
    } finally { if (created) await fs.unlink(temporary).catch(() => {}); }
  }
  return { read, write };
}

function parseState(raw) {
  if (!raw || raw.version !== 1) throw new Error('Saved folder is invalid.');
  const folder = raw.folder === null ? null : raw.folder;
  if (folder !== null && !validFolder(folder)) throw new Error('Saved folder is invalid.');
  const bookmarks = [];
  if (raw.bookmarks !== undefined) {
    if (!Array.isArray(raw.bookmarks) || raw.bookmarks.length > MAX_BOOKMARKS) throw new Error('Saved folder is invalid.');
    for (const item of raw.bookmarks) {
      if (!item || !validFolder(item.folder) || !validBookmark(item.bookmark)) throw new Error('Saved folder is invalid.');
      if (!bookmarks.some(entry => entry.folder === item.folder)) bookmarks.push({ folder: item.folder, bookmark: item.bookmark });
    }
  }
  return { folder, bookmarks };
}

// pick(options) returns a folder path, or null when cancelled. When `bookmarks` is injected, pick receives
// { securityScopedBookmarks: true } and returns { folder, dialogResult } so create(dialogResult) can mint the bookmark.
function createDestination({ pick, open, probe = probeFolder, file, bookmarks }) {
  if (file !== undefined && !validFolder(file)) throw new Error('An absolute recording-folder settings path is required.');
  const store = file ? createFolderStore(file) : null;
  let selected = null;
  let saved = []; // one bookmark per folder, kept so earlier recordings stay playable
  let stops = [];
  let busy = false;

  function stopAll() {
    const running = stops; stops = [];
    for (const stop of running) { try { stop?.(); } catch { /* releasing access must never throw out of the app */ } }
  }
  // Returns the folders whose access could not be started.
  function startAll() {
    const failed = new Set();
    for (const item of saved) {
      try {
        const stop = bookmarks.start(item.bookmark);
        if (!stop) failed.add(item.folder); else stops.push(typeof stop === 'function' ? stop : () => {});
      } catch { failed.add(item.folder); }
    }
    return failed;
  }
  async function persist(folder) {
    if (!store) return;
    try { await store.write({ version: 1, folder, ...(bookmarks ? { bookmarks: saved } : {}) }); } catch { /* the folder still works for this session */ }
  }
  const unavailable = () => ({ status: 'error', message: folderError({ code: 'ENOENT' }) });

  return {
    selectedFolder: () => selected,
    // Call once at launch, before the recording or source stores recover. Never throws.
    async load() {
      selected = null; saved = []; stopAll();
      if (!store) return { status: 'none' };
      let state;
      try {
        const raw = await store.read();
        if (!raw) return { status: 'none' };
        state = parseState(raw);
      } catch { return unavailable(); }
      let failed = new Set();
      if (bookmarks) { saved = state.bookmarks; failed = startAll(); } // start before any probe
      if (!state.folder) return { status: 'none' };
      if (bookmarks && (failed.has(state.folder) || !saved.some(item => item.folder === state.folder))) return unavailable();
      try {
        const result = await probe(state.folder);
        if (result.status === 'ready') selected = state.folder;
        return result;
      } catch { return unavailable(); }
    },
    dispose() { stopAll(); },
    async choose() {
      if (busy) return { status: 'error', message: 'Finish the current folder selection first.' };
      busy = true;
      try {
        const picked = bookmarks ? await pick({ securityScopedBookmarks: true }) : await pick();
        const folder = bookmarks ? picked?.folder : picked;
        if (!folder) return { status: 'cancelled' };
        // A newly selected invalid folder must invalidate earlier readiness.
        selected = null;
        let bookmark = null;
        if (bookmarks) {
          try { bookmark = bookmarks.create(picked.dialogResult); } catch { bookmark = null; }
          if (!validBookmark(bookmark)) { await persist(null); return unavailable(); }
        }
        const result = await probe(folder);
        if (result.status === 'ready') {
          selected = folder;
          if (bookmarks) {
            stopAll();
            saved = [...saved.filter(item => item.folder !== folder), { folder, bookmark }].slice(-MAX_BOOKMARKS);
            startAll();
          }
          await persist(folder);
        } else await persist(null);
        return result;
      } catch { selected = null; return { status: 'error', message: 'The folder picker could not open. Try again.' }; }
      finally { busy = false; }
    },
    async check() {
      if (busy) return { status: 'error', message: 'Finish the current folder selection first.' };
      if (!selected) return { status: 'error', message: NO_FOLDER };
      busy = true;
      try {
        const result = await probe(selected);
        if (result.status !== 'ready') selected = null;
        return result;
      } catch { selected = null; return { status: 'error', message: 'This folder could not be checked. Choose it again.' }; }
      finally { busy = false; }
    },
    async open() {
      if (busy || !selected) return { ok: false, message: 'Choose and check a recording folder first.' };
      try {
        const error = await open(selected);
        return error ? { ok: false, message: 'The folder could not be opened. Check that the drive is connected.' } : { ok: true };
      } catch { return { ok: false, message: 'The folder could not be opened. Try again.' }; }
    },
  };
}
module.exports = { createDestination, probeFolder, folderError };
