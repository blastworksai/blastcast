// CodexBWAI — encrypted, app-owned guest wizard settings. Never return saved credentials to UI.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseRoute } = require('./guests.cjs');
const MAX_BYTES = 65536;
class SettingsError extends Error {}
const invalid = () => { throw new SettingsError('Guest settings are invalid. Check the domain, HTTPS address, port and relay details.'); };
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) invalid();
  const copy = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    copy[key] = descriptor.value;
  }
  return copy;
}
function snapshot(input, allowBlank = false) {
  try {
    const value = exact(input, ['domain', 'origin', 'port', 'helper']);
    const helper = exact(value.helper, ['provider', 'freeAccountConfirmed', 'relay']);
    const relay = exact(helper.relay, ['urls', 'username', 'credential', 'iceTransportPolicy']);
    if (!['yes', 'no'].includes(value.domain) || typeof value.origin !== 'string' || value.origin.length > 300 || /[\x00-\x1f\x7f]/.test(value.origin)) invalid();
    if (helper.provider !== (value.domain === 'yes' ? 'cloudflare' : 'localhost-run')) invalid();
    const blank = allowBlank && relay.credential === '';
    // parseRoute/parseHelper validate exact nested schemas, including array own data properties.
    const route = parseRoute({ origin: value.domain === 'no' ? 'https://pending.invalid' : value.origin,
      port: value.port, routeType: 'tunnel', helper: { ...helper, relay: { ...relay, credential: blank ? 'pending-saved-credential' : relay.credential } } });
    const server = route.helper.iceServers[0];
    return { domain: value.domain, origin: value.domain === 'no' ? '' : route.origin, port: route.port,
      helper: { provider: helper.provider, freeAccountConfirmed: true,
        relay: { urls: [...server.urls], username: server.username, credential: blank ? '' : server.credential, iceTransportPolicy: route.helper.iceTransportPolicy } } };
  } catch { invalid(); }
}
function redact(settings) {
  if (!settings) return null;
  return { ...settings, credentialSaved: true, helper: { ...settings.helper,
    relay: { ...settings.helper.relay, urls: [...settings.helper.relay.urls], credential: '' } } };
}
function createGuestSettings({ directory, safeStorage }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new SettingsError('An absolute application settings directory is required.');
  const root = path.join(directory, 'guest-settings');
  const filename = path.join(root, 'settings.json');
  let mutations = Promise.resolve();
  function encryptionReady() {
    try {
      if (!safeStorage?.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error();
    } catch { throw new SettingsError('Secure operating-system storage is unavailable. Relay credentials were not saved; unlock or configure your system key store and retry.'); }
  }
  async function ensureDirectory() {
    const parent = await fs.lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error();
    try { await fs.mkdir(root, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await fs.lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
    await fs.chmod(root, 0o700);
  }
  async function regular() {
    try {
      const info = await fs.lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES) throw new Error();
      return info;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function read() {
    encryptionReady(); await ensureDirectory();
    if (!await regular()) return null;
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let bytes;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES) throw new Error();
      const buffer = Buffer.alloc(MAX_BYTES + 1); let used = 0;
      while (used < buffer.length) {
        const result = await handle.read(buffer, used, buffer.length - used, used);
        if (!result.bytesRead) break; used += result.bytesRead;
      }
      if (used > MAX_BYTES) throw new Error(); bytes = buffer.subarray(0, used);
    } finally { await handle.close(); }
    const envelope = exact(JSON.parse(bytes.toString('utf8')), ['version', 'ciphertext']);
    if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.ciphertext) || !envelope.ciphertext) throw new Error();
    const plaintext = safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64'));
    if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > MAX_BYTES) throw new Error();
    return snapshot(JSON.parse(plaintext));
  }
  async function write(settings) {
    encryptionReady(); await ensureDirectory(); await regular();
    const encrypted = safeStorage.encryptString(JSON.stringify(settings));
    if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_BYTES / 2) throw new Error();
    const bytes = Buffer.from(JSON.stringify({ version: 1, ciphertext: encrypted.toString('base64') }));
    if (bytes.length > MAX_BYTES) throw new Error();
    const temporary = path.join(root, `.write-${randomUUID()}.tmp`); let created = false;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600); created = true;
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await regular(); await fs.rename(temporary, filename); created = false;
    } finally { if (created) await fs.unlink(temporary); }
  }
  const message = error => error instanceof SettingsError ? error.message : 'BlastCast could not read or save its encrypted guest settings. Check system key-store and application storage access, or clear saved settings and configure them again.';
  async function result(action) { try { return { ok: true, settings: redact(await action()) }; } catch (error) { return { ok: false, message: message(error) }; } }
  function mutate(action) { const next = mutations.then(() => result(action)); mutations = next.then(() => undefined); return next; }
  return {
    load: () => mutations.then(() => result(read)),
    save(input) {
      let value;
      try { value = snapshot(input, true); } catch (error) { return Promise.resolve({ ok: false, message: message(error) }); }
      return mutate(async () => {
        if (value.helper.relay.credential === '') {
          const previous = await read(); const relay = value.helper.relay; const saved = previous?.helper.relay;
          if (!saved || relay.username !== saved.username || JSON.stringify(relay.urls) !== JSON.stringify(saved.urls)) throw new SettingsError('Enter the relay password for these relay addresses and username.');
          value.helper.relay.credential = saved.credential;
        }
        value = snapshot(value); await write(value); return value;
      });
    },
    clear: () => mutate(async () => { await ensureDirectory(); if (await regular()) await fs.unlink(filename); return null; }),
    async configuration() {
      await mutations;
      try { return await read(); } catch (error) { throw new SettingsError(message(error)); }
    },
  };
}
module.exports = { createGuestSettings };
