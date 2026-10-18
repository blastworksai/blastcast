// ClaudeBWAI — einh 5 Oct: Mac App Store flavour; the purchase is the licence.
const path = require('node:path');

const MESSAGE = 'BlastCast from the App Store needs no key.';

// Electron sets process.mas only in Mac App Store builds; anything but boolean true is not MAS.
function isMas(proc = process) { return proc?.mas === true; }

// Same five methods as license-store.cjs, same sync/async split; touches no disk.
function createStoreLicenseStore(message) {
  const status = () => ({ active: true, license: { kind: 'app-store' } });
  return {
    load: async () => status(),
    activate: async () => ({ active: true, message }),
    deactivate: async () => ({ active: true, message }),
    status,
    active: () => true,
  };
}

// CodexBWAI — Electron sets this read-only flag for MSIX/AppX execution.
// Source: https://www.electronjs.org/docs/latest/api/process#processwindowsstore-readonly
function isWindowsStore(proc = process) { return proc?.windowsStore === true; }
function createMasLicenseStore() { return createStoreLicenseStore(MESSAGE); }
function createWindowsStoreLicenseStore() { return createStoreLicenseStore('BlastCast from the Microsoft Store needs no key.'); }

// resourcesPath is .../BlastCast.app/Contents/Resources; the bundled ssh sits in .../Contents/Helpers/ssh.
function helperPath({ resourcesPath } = {}) {
  if (typeof resourcesPath !== 'string' || !path.isAbsolute(resourcesPath)) throw new Error('An absolute resources path is required.');
  return path.join(path.dirname(resourcesPath), 'Helpers', 'ssh');
}
module.exports = { isMas, createMasLicenseStore, isWindowsStore, createWindowsStoreLicenseStore, helperPath };
