// ClaudeBWAI — einh 5 Oct: Mac App Store flavour; the purchase is the licence.
const path = require('node:path');

const MESSAGE = 'BlastCast from the App Store needs no key.';

// Electron sets process.mas only in Mac App Store builds; anything but boolean true is not MAS.
function isMas(proc = process) { return proc?.mas === true; }

// Same five methods as license-store.cjs, same sync/async split; touches no disk.
function createMasLicenseStore() {
  const status = () => ({ active: true, license: { kind: 'app-store' } });
  return {
    load: async () => status(),
    activate: async () => ({ active: true, message: MESSAGE }),
    deactivate: async () => ({ active: true, message: MESSAGE }),
    status,
    active: () => true,
  };
}

// resourcesPath is .../BlastCast.app/Contents/Resources; the bundled ssh sits in .../Contents/Helpers/ssh.
function helperPath({ resourcesPath } = {}) {
  if (typeof resourcesPath !== 'string' || !path.isAbsolute(resourcesPath)) throw new Error('An absolute resources path is required.');
  return path.join(path.dirname(resourcesPath), 'Helpers', 'ssh');
}
module.exports = { isMas, createMasLicenseStore, helperPath };
