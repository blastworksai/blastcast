// CodexBWAI — owns guest listener, provider process and direct lease as one lifetime.
const { parseRoute } = require('./guests.cjs');
function createGuestAccess({ guests, directAccess, tunnel, onConfigured = () => {} }) {
  let changing = false, epoch = 0, connectionMessage = '';
  const status = () => ({ ...guests.status(), ...(connectionMessage ? { connectionMessage } : {}) });
  async function cleanup() {
    guests.revoke();
    // Stop forwarding before releasing the port: never forward a replacement process.
    const helper = await tunnel.stop();
    if (helper?.ok === false) return helper;
    await guests.stop();
    return directAccess.stop();
  }
  async function stop() { ++epoch; return cleanup(); }
  async function configure(input, generated = false) {
    let config;
    if (generated && input && typeof input === 'object' && input.privacyAcknowledged !== true) return { ok: false, message: 'Confirm the free address privacy notice in guest settings before using the free address.' };
    try {
      if (generated) {
        if (!input || typeof input !== 'object' || Object.keys(input).sort().join() !== 'helper,port,privacyAcknowledged' || input.helper?.provider !== 'localhost-run') throw Error('Invalid free address setup.');
        config = { origin: 'https://pending.invalid', port: input.port, routeType: 'tunnel', helper: input.helper };
      } else config = input;
      parseRoute(config);
    } catch { return { ok: false, message: 'Check the guest address, local port and free media-relay settings.' }; }
    if (generated && input.privacyAcknowledged !== true) return { ok: false, message: 'Confirm the free address privacy notice in guest settings before using the free address.' };
    if (changing) return { ok: false, message: 'Guest setup is already running. Wait or cancel it.' };
    changing = true; const current = ++epoch; connectionMessage = '';
    try {
      const closed = await cleanup();
      if (closed?.ok === false) return closed;
      if (current !== epoch) return { ok: false, message: 'Guest setup was cancelled.' };
      const result = await guests.configure(config, generated ? async port => {
        const opened = await tunnel.start(port, { privacyAcknowledged: true });
        if (current !== epoch) throw Error('Guest setup was cancelled.');
        if (!opened.ok) { connectionMessage = opened.message; throw Error('Free address unavailable.'); }
        return opened.origin;
      } : undefined);
      if (current !== epoch) return { ok: false, message: 'Guest setup was cancelled.' };
      if (!result.ok || result.phase === 'blocked') await tunnel.stop();
      if (!result.ok && connectionMessage) return { ok: false, message: connectionMessage };
      if (result.ok) onConfigured();
      return result;
    } catch {
      if (current === epoch) await cleanup();
      return { ok: false, message: connectionMessage || 'Guest setup could not finish. Try again.' };
    } finally { changing = false; }
  }
  async function lost(message) {
    ++epoch; connectionMessage = message || 'The temporary guest address disconnected. Previous links are closed. Generate a new address when ready.';
    await cleanup();
  }
  return { status, stop, configure: input => configure(input), startFree: input => configure(input, true), lost };
}
module.exports = { createGuestAccess };
