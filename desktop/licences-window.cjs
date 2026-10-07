'use strict';
// BlastCast > Licences... (macOS only). Shows licence texts verbatim, read-only, offline.
// The OpenSSH and OpenSSL texts appear only when the bundled ssh helper is present.
const fs = require('node:fs');
const path = require('node:path');

const CSP = "default-src 'none'; style-src 'unsafe-inline'";
const LICENCE_DIR = path.join(__dirname, '..', 'assets', 'licences');

function defaultFiles() {
  return {
    blastcast: path.join(__dirname, '..', 'LICENSE'),
    electron: null,
    chromium: null,
    openssh: path.join(LICENCE_DIR, 'OpenSSH-LICENCE.txt'),
    openssl: path.join(LICENCE_DIR, 'OpenSSL-LICENSE.txt'),
  };
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Ordered sections: [title, key]. The OpenSSH/OpenSSL ones are gated on helperBundled.
function sectionList(helperBundled) {
  const list = [
    ['BlastCast', 'blastcast'],
    ['Electron and Chromium', 'electron'],
  ];
  if (helperBundled) list.push(['OpenSSH', 'openssh'], ['OpenSSL', 'openssl']);
  return list;
}

function readText(filePath, name) {
  try {
    if (!filePath) throw new Error('no path');
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return `Licence text missing: ${name}`;
  }
}

function buildLicencesHtml({ files = {}, helperBundled = false } = {}) {
  const f = { ...defaultFiles(), ...files };
  const body = sectionList(helperBundled).map(([title, key]) => {
    const name = f[key] ? path.basename(String(f[key])) : key;
    const note = key === 'electron'
      ? '<p>The Chromium licences open in their own window: BlastCast, then Chromium Licences…</p>' : '';
    return `<section><h2>${escapeHtml(title)}</h2>${note}<pre>${escapeHtml(readText(f[key], name))}</pre></section>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${CSP}">`
    + `<title>Licences</title>`
    + `<style>body{font:13px system-ui,sans-serif;margin:16px;color:#111;background:#fff}`
    + `@media(prefers-color-scheme:dark){body{color:#eee;background:#1e1e1e}}`
    + `pre{white-space:pre-wrap;word-wrap:break-word;font:12px ui-monospace,monospace}</style></head>`
    + `<body>${body}</body></html>`;
}

function buildMenuTemplate({ app, openLicences, openChromiumLicences }) {
  const name = app && app.name ? app.name : 'BlastCast';
  return [
    {
      role: 'appMenu',
      label: name,
      submenu: [
        { role: 'about' },
        { label: 'Licences…', click: () => openLicences() },
        { label: 'Chromium Licences…', click: () => openChromiumLicences() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      role: 'editMenu',
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      role: 'viewMenu',
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      role: 'windowMenu',
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    },
  ];
}

function lockDown(win) {
  if (win.removeMenu) win.removeMenu();
  if (win.webContents) {
    if (win.webContents.setWindowOpenHandler) win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    if (win.webContents.on) win.webContents.on('will-navigate', (event) => event.preventDefault());
  }
}

const WEB_PREFERENCES = { nodeIntegration: false, contextIsolation: true, sandbox: true };

function dataUrl(html) { return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`; }

function installLicencesMenu({ Menu, BrowserWindow, app, files = {}, platform = process.platform, helperBundled = false }) {
  if (platform !== 'darwin') return null;
  const f = { ...defaultFiles(), ...files };
  let win = null; let chromiumWin = null;
  const openLicences = () => {
    if (win && !(win.isDestroyed && win.isDestroyed())) { win.show(); if (win.focus) win.focus(); return win; }
    win = new BrowserWindow({ width: 760, height: 680, title: 'Licences', show: true, fullscreenable: false, webPreferences: { ...WEB_PREFERENCES } });
    if (win.on) win.on('closed', () => { win = null; });
    lockDown(win);
    win.loadURL(dataUrl(buildLicencesHtml({ files, helperBundled })));
    return win;
  };
  const openChromiumLicences = () => {
    if (chromiumWin && !(chromiumWin.isDestroyed && chromiumWin.isDestroyed())) { chromiumWin.show(); if (chromiumWin.focus) chromiumWin.focus(); return chromiumWin; }
    chromiumWin = new BrowserWindow({ width: 900, height: 700, title: 'Chromium Licences', show: true, fullscreenable: false, webPreferences: { ...WEB_PREFERENCES } });
    if (chromiumWin.on) chromiumWin.on('closed', () => { chromiumWin = null; });
    lockDown(chromiumWin);
    // The file is ~20 MB: far above the URL cap, so it is loaded by path, never inlined.
    if (f.chromium && fs.existsSync(f.chromium)) chromiumWin.loadFile(f.chromium);
    else {
      const name = f.chromium ? path.basename(String(f.chromium)) : 'LICENSES.chromium.html';
      chromiumWin.loadURL(dataUrl(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>Chromium Licences</title></head><body><pre>${escapeHtml(`Licence text missing: ${name}`)}</pre></body></html>`));
    }
    return chromiumWin;
  };
  const template = buildMenuTemplate({ app, openLicences, openChromiumLicences });
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return { menu, openLicences, openChromiumLicences };
}

module.exports = { installLicencesMenu, buildMenuTemplate, buildLicencesHtml };
