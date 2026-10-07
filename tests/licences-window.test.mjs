import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { installLicencesMenu, buildLicencesHtml } = require('../desktop/licences-window.cjs');

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-'));
  const w = (n, t) => { const p = path.join(dir, n); fs.writeFileSync(p, t); return p; };
  const files = {
    blastcast: w('LICENSE', 'BLASTCAST-TEXT <b>'), electron: w('E', 'ELECTRON-TEXT'),
    chromium: w('C.html', '<html>CHROMIUM-TEXT</html>'),
    openssh: w('ssh', 'OPENSSH-TEXT'), openssl: w('ssl', 'OPENSSL-TEXT'),
  };
  const state = { template: null, windows: [], urls: [] };
  const Menu = { buildFromTemplate: (t) => { state.template = t; return { t }; }, setApplicationMenu: () => {} };
  class BrowserWindow {
    constructor(opts) { this.opts = opts; state.windows.push(this); this.webContents = { setWindowOpenHandler() {}, on() {} }; }
    loadFile(p) { state.loaded = (state.loaded || []).concat(p); }
    loadURL(u) { state.urls.push(decodeURIComponent(u.split(',').slice(1).join(','))); }
    on() {} isDestroyed() { return false; } show() {} removeMenu() {}
  }
  return { files, state, Menu, BrowserWindow, app: { name: 'BlastCast' } };
}
const find = (items, pred) => items.find(pred);

test('darwin: Licences item present under the app menu', () => {
  const r = rig();
  assert.ok(installLicencesMenu({ ...r, platform: 'darwin', helperBundled: true }));
  const appMenu = find(r.state.template, (m) => m.role === 'appMenu');
  assert.ok(find(appMenu.submenu, (i) => i.label === 'Licences…'));
});

test('win32 and linux: no menu change, returns null', () => {
  for (const platform of ['win32', 'linux']) {
    const r = rig();
    assert.equal(installLicencesMenu({ ...r, platform, helperBundled: true }), null);
    assert.equal(r.state.template, null);
  }
});

test('Edit menu keeps copy, paste and selectAll roles', () => {
  const r = rig(); installLicencesMenu({ ...r, platform: 'darwin' });
  const edit = find(r.state.template, (m) => m.role === 'editMenu');
  const roles = edit.submenu.map((i) => i.role);
  for (const x of ['copy', 'paste', 'selectAll']) assert.ok(roles.includes(x), x);
});

test('OpenSSH and OpenSSL texts are shown iff helperBundled', () => {
  for (const helperBundled of [true, false]) {
    const r = rig();
    const { openLicences } = installLicencesMenu({ ...r, platform: 'darwin', helperBundled });
    openLicences();
    const html = r.state.urls[0];
    assert.equal(html.includes('OPENSSH-TEXT'), helperBundled);
    assert.equal(html.includes('OPENSSL-TEXT'), helperBundled);
    assert.ok(html.includes('BLASTCAST-TEXT &lt;b&gt;'));
    assert.ok(html.includes('ELECTRON-TEXT'));
    assert.ok(!html.includes('CHROMIUM-TEXT'));
    assert.ok(html.includes('Electron and Chromium'));
    assert.ok(html.includes("default-src 'none'"));
  }
});

test('window is sandboxed with no node integration', () => {
  const r = rig();
  installLicencesMenu({ ...r, platform: 'darwin' }).openLicences();
  const wp = r.state.windows[0].opts.webPreferences;
  assert.equal(wp.nodeIntegration, false);
  assert.equal(wp.sandbox, true);
  assert.equal(wp.contextIsolation, true);
});

test('missing file shows a plain message and does not throw', () => {
  const html = buildLicencesHtml({ files: { blastcast: '/nonexistent/LICENSE', electron: '/nonexistent/E' }, helperBundled: false });
  assert.ok(html.includes('Licence text missing: LICENSE'));
  assert.ok(html.includes('Licence text missing: E'));
});

test('shipped licence texts exist and are non-empty', () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'assets', 'licences');
  for (const n of ['OpenSSH-LICENCE.txt', 'OpenSSL-LICENSE.txt']) assert.ok(fs.statSync(path.join(dir, n)).size > 1000, n);
});

test('Chromium Licences item present on darwin and opens by loadFile with the same webPreferences', () => {
  const r = rig();
  const inst = installLicencesMenu({ ...r, platform: 'darwin', helperBundled: false });
  const appMenu = find(r.state.template, (m) => m.role === 'appMenu');
  assert.ok(find(appMenu.submenu, (i) => i.label === 'Chromium Licences\u2026'));
  inst.openChromiumLicences();
  assert.deepEqual(r.state.loaded, [r.files.chromium]);
  assert.equal(r.state.urls.length, 0);
  assert.deepEqual(r.state.windows[0].opts.webPreferences, { nodeIntegration: false, contextIsolation: true, sandbox: true });
});

test('Chromium window with a missing file shows the missing message', () => {
  const r = rig();
  const inst = installLicencesMenu({ ...r, files: { ...r.files, chromium: '/nonexistent/LICENSES.chromium.html' }, platform: 'darwin' });
  inst.openChromiumLicences();
  assert.equal(r.state.loaded, undefined);
  assert.ok(r.state.urls[0].includes('Licence text missing: LICENSES.chromium.html'));
});

test('main page data: URL stays under 1.5 MB with the real licence files', () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  const stand = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-')); const e = path.join(stand, 'E');
  fs.writeFileSync(e, 'x'.repeat(1100));
  const html = buildLicencesHtml({
    files: { blastcast: path.join(dir, 'LICENSE'), electron: e,
      openssh: path.join(dir, 'assets/licences/OpenSSH-LICENCE.txt'), openssl: path.join(dir, 'assets/licences/OpenSSL-LICENSE.txt') },
    helperBundled: true,
  });
  const len = ('data:text/html;charset=utf-8,' + encodeURIComponent(html)).length;
  assert.ok(len < 1_500_000, `encoded length ${len}`);
});
