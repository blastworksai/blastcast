// CodexBWAI — encrypted local activation state; only verified metadata leaves this module.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { verifyLicenseKey } = require('./license-key.cjs');

const MAX_FILE = 8192;
function createLicenseStore({ directory, safeStorage, publicKey }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('An absolute application settings directory is required.');
  const root = path.join(directory, 'activation');
  const filename = path.join(root, 'license.json');
  let license = null; let warning;

  function status() {
    return license ? { active: true, license: { ...license } } : { active: false, ...(warning ? { message: warning } : {}) };
  }
  function storageAvailable() {
    try { return safeStorage?.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; }
    catch { return false; }
  }
  async function ensureRoot() {
    const parent = await fs.lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Application settings are unavailable.');
    try { await fs.mkdir(root, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await fs.lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Activation storage is unsafe.');
  }
  async function boundedRead() {
    let info;
    try { info = await fs.lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_FILE) throw new Error('Saved activation is unsafe.');
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const bytes = Buffer.alloc(MAX_FILE + 1); let used = 0;
      while (used < bytes.length) { const read = await handle.read(bytes, used, bytes.length - used, used); if (!read.bytesRead) break; used += read.bytesRead; }
      if (used > MAX_FILE) throw new Error('Saved activation is too large.');
      return bytes.subarray(0, used);
    } finally { await handle.close(); }
  }
  async function save(raw) {
    await ensureRoot();
    const ciphertext = safeStorage.encryptString(raw).toString('base64');
    const bytes = Buffer.from(JSON.stringify({ version: 1, ciphertext }));
    const temporary = path.join(root, `.write-${randomUUID()}.tmp`); let created = false;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600); created = true;
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, filename); created = false;
    } finally { if (created) await fs.unlink(temporary).catch(() => {}); }
  }
  async function load() {
    warning = undefined; license = null;
    try {
      await ensureRoot(); const bytes = await boundedRead(); if (!bytes) return status();
      if (!storageAvailable()) throw new Error('Secure operating-system storage is unavailable. Unlock the system key store, then activate again.');
      const envelope = JSON.parse(bytes.toString('utf8'));
      if (!envelope || envelope.version !== 1 || typeof envelope.ciphertext !== 'string' || Object.keys(envelope).length !== 2) throw new Error('Saved activation is invalid. Enter the key again.');
      const raw = safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64'));
      license = verifyLicenseKey(raw, publicKey);
      if (!license) throw new Error('Saved activation is invalid. Enter the key again.');
    } catch (error) { warning = error instanceof Error ? error.message : 'Saved activation could not be opened.'; }
    return status();
  }
  async function activate(raw) {
    const verified = verifyLicenseKey(raw, publicKey);
    if (!verified) return { active: false, message: 'That activation key is invalid. Check that the complete key was pasted.' };
    if (!storageAvailable()) return { active: false, message: 'Secure operating-system storage is unavailable. Unlock the system key store and try again.' };
    try { await save(raw.trim()); license = verified; warning = undefined; return status(); }
    catch { return { active: false, message: 'BlastCast could not save activation securely. Check application storage access and try again.' }; }
  }
  async function deactivate() {
    try { await fs.unlink(filename); } catch (error) { if (error.code !== 'ENOENT') return { ...status(), message: 'BlastCast could not remove the saved activation.' }; }
    license = null; warning = undefined; return status();
  }
  return { load, activate, deactivate, status, active: () => Boolean(license) };
}
module.exports = { createLicenseStore };
