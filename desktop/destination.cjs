// CodexBWAI — only main chooses and retains filesystem paths.
const fs = require('node:fs/promises');
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

function createDestination({ pick, open, probe = probeFolder }) {
  let selected = null;
  let busy = false;
  return {
    selectedFolder: () => selected,
    async choose() {
      if (busy) return { status: 'error', message: 'Finish the current folder selection first.' };
      busy = true;
      try {
        const folder = await pick();
        if (!folder) return { status: 'cancelled' };
        // A newly selected invalid folder must invalidate earlier readiness.
        selected = null;
        const result = await probe(folder);
        if (result.status === 'ready') selected = folder;
        return result;
      } catch { selected = null; return { status: 'error', message: 'The folder picker could not open. Try again.' }; }
      finally { busy = false; }
    },
    async check() {
      if (busy) return { status: 'error', message: 'Finish the current folder selection first.' };
      if (!selected) return { status: 'error', message: 'Choose a recording folder first.' };
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
