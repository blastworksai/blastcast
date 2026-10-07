// ClaudeBWAI — einh 5 Oct: Task 3.4. Loads the real desktop/main.cjs under a stubbed electron and stops it at createFreeTunnel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const desktop = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop');
const STOP = new Error('stop at tunnel');
const RESOURCES = '/Applications/BlastCast.app/Contents/Resources';

async function boot({ mas }) {
  const loaded = [];
  const tunnelOptions = [];
  const errors = [];
  const handlers = new Map();
  const noop = () => {};
  const fakeSession = { webRequest: { onBeforeRequest: noop }, protocol: { handle: async () => {} }, setPermissionRequestHandler: noop, setPermissionCheckHandler: noop };
  const electron = {
    app: { enableSandbox: noop, on: noop, quit: noop, whenReady: () => Promise.resolve(), getPath: () => '/nonexistent-blastcast-test', getVersion: () => '0.0.0', startAccessingSecurityScopedResource: noop, setAppUserModelId: noop },
    BrowserWindow: function () {}, Menu: {}, desktopCapturer: {}, nativeImage: {}, clipboard: {}, shell: {}, safeStorage: {}, systemPreferences: {},
    dialog: { showErrorBox: (title, text) => errors.push(`${title}: ${text}`) },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    protocol: { registerSchemesAsPrivileged: noop },
    session: { fromPartition: () => fakeSession },
  };
  const trapped = new Set(['license-store.cjs', 'license-key.cjs', 'releases-link.cjs']);
  const stubs = {
    'free-tunnel.cjs': { createFreeTunnel: options => { tunnelOptions.push(options); throw STOP; } },
    'display-picker.cjs': { installDisplayPicker: () => ({}) },
  };
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    const base = path.basename(request);
    if (parent?.filename?.startsWith(desktop)) {
      if (trapped.has(base)) { loaded.push(base); const e = new Error(`Cannot find module '${request}'`); e.code = 'MODULE_NOT_FOUND'; if (mas) throw e; }
      if (stubs[base]) return stubs[base];
    }
    return realLoad.call(this, request, parent, isMain);
  };
  const main = path.join(desktop, 'main.cjs');
  const savedMas = Object.getOwnPropertyDescriptor(process, 'mas');
  const savedResources = process.resourcesPath;
  // main.cjs and every module it requires must load fresh for each flavour.
  for (const key of Object.keys(require.cache)) if (key.startsWith(desktop)) delete require.cache[key];
  if (mas) process.mas = true; else delete process.mas;
  process.resourcesPath = RESOURCES;
  try {
    require(main);
    // The whenReady chain settles within a few ticks; wait for the tunnel stub or an error report.
    for (let i = 0; i < 200 && !tunnelOptions.length && !errors.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  } finally {
    Module._load = realLoad;
    if (savedMas) Object.defineProperty(process, 'mas', savedMas); else delete process.mas;
    process.resourcesPath = savedResources;
    for (const key of Object.keys(require.cache)) if (key.startsWith(desktop)) delete require.cache[key];
  }
  return { loaded, tunnelOptions, errors, handlers };
}

test('MAS: main.cjs never loads license-store, license-key or releases-link and the tunnel uses the bundled helper', async () => {
  const { loaded, tunnelOptions, errors } = await boot({ mas: true });
  assert.deepEqual(loaded, []);
  assert.ok(!errors.some(e => /Cannot find module|MODULE_NOT_FOUND/.test(e)), errors.join('\n'));
  assert.equal(tunnelOptions.length, 1, errors.join('\n'));
  assert.equal(tunnelOptions[0].executable, '/Applications/BlastCast.app/Contents/Helpers/ssh');
  assert.ok(path.isAbsolute(tunnelOptions[0].executable) && tunnelOptions[0].executable.endsWith('Contents/Helpers/ssh'));
});

// Source-level check: the boot stops at the tunnel (before the IPC block), so this is a static assertion, not a run.
test('IPC for licence activation stays registered unconditionally and openUpdates refuses under MAS and main.cjs holds no releases URL', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(path.join(desktop, 'main.cjs'), 'utf8');
  assert.match(source, /^  ipcMain\.handle\('blastcast:activateLicense'/m);
  assert.match(source, /deactivateLicense: async \(\) =>/);
  assert.match(source, /openUpdates:async\(\)=>releases\?releases\.openReleases\(shell\):\{ok:false/);
  assert.doesNotMatch(source, /github\.com\/blastworksai\/blastcast\/releases/);
});

test('non-MAS: license-store is loaded and the tunnel gets no executable override', async () => {
  const { loaded, tunnelOptions } = await boot({ mas: false });
  assert.ok(loaded.includes('license-store.cjs'));
  assert.ok(loaded.includes('releases-link.cjs'));
  assert.equal(tunnelOptions.length, 1);
  assert.equal('executable' in tunnelOptions[0], false);
});
