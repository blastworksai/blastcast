// CodexBWAI — saved settings are used only after the host requests a link.
function createGuestWizard({ settings, access, guests, busy = () => false }) {
  let operating = false, revision = 0, activeRevision = -1;
  async function operation(run, allowRecording = false) {
    if (operating || (!allowRecording && busy())) return { ok: false, message: 'Finish the current recording or guest setup before changing guest access.' };
    operating = true;
    try { return await run(); }
    catch { return { ok: false, message: 'Saved guest setup could not be opened. Check Guest settings and try again.' }; }
    finally { operating = false; }
  }
  return {
    load: settings.load,
    invalidate: () => { revision++; activeRevision = -1; },
    save: input => operation(async () => {
      const result = await settings.save(input);
      if (result.ok) revision++;
      return result;
    }),
    clear: () => operation(async () => {
      const stopped = await access.stop();
      if (stopped?.ok === false) return stopped;
      const result = await settings.clear();
      if (result.ok) { revision++; activeRevision = -1; }
      return result;
    }),
    generate: () => operation(async () => {
      const requestedRevision = revision;
      const config = await settings.configuration();
      if (requestedRevision !== revision) return { ok: false, message: 'Guest setup was cancelled.' };
      if (!config) return { ok: false, message: 'Complete Guest settings first.' };
      const current = access.status();
      if (!(current.ok && current.phase === 'ready' && activeRevision === revision)) {
        if (busy()) return { ok: false, message: 'Finish recording and receiving originals before starting a new guest connection.' };
        const result = config.domain === 'no'
          ? (config.freeRouteAcknowledged === true
            ? await access.startFree({ port: config.port, helper: config.helper, privacyAcknowledged: true })
            : { ok: false, message: 'Open Guest settings and confirm the free address privacy notice first.' })
          : await access.configure({ origin: config.origin, port: config.port, routeType: 'tunnel', helper: config.helper });
        if (requestedRevision !== revision) return { ok: false, message: 'Guest setup was cancelled.' };
        if (!result.ok || !['outside-check', 'ready'].includes(result.phase)) return result;
        const enabled = guests.enableSavedInvites();
        if (!enabled.ok) return enabled;
        activeRevision = revision;
      }
      return guests.invite();
    }, true),
  };
}
module.exports = { createGuestWizard };
