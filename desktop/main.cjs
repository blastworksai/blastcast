// Authored by CodexBWAI. Local capture plus an explicitly enabled loopback guest server.
const { app, BrowserWindow, desktopCapturer, nativeImage, clipboard, dialog, ipcMain, protocol, session, shell, safeStorage, systemPreferences } = require('electron');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { createSourceStore } = require('./sources.cjs');
const { createSourceController } = require('./source-controller.cjs');
const { createRecordingLibrary } = require('./recording-library.cjs');
const { installDisplayPicker } = require('./display-picker.cjs');
const { createStudioPreferences } = require('./studio-preferences.cjs');
const { createRecordingStore } = require('./recording.cjs');
const { createDestination } = require('./destination.cjs');
const { trustedFrame, registerBridge, registerRecordingBridge, registerGuestBridge, registerSourceBridge, STUDIO_URL, mediaPermission, allowedStudioNavigation } = require('./boundary.cjs');
const { createGuestServer } = require('./guests.cjs');
const { createFreeTunnel } = require('./free-tunnel.cjs');
const { createGuestAccess } = require('./guest-access.cjs');
const { createGuestSettings } = require('./guest-settings.cjs');
const { createGuestWizard } = require('./guest-wizard.cjs');
const { createDirectAccess } = require('./direct-access.cjs');
const { createLicenseStore } = require('./license-store.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: {
  standard: true, secure: true, supportFetchAPI: true,
} }]);
app.enableSandbox();
// CodexBWAI: give Windows taskbar grouping its own identity, not Electron's.
const windowsAppId = 'BlastworksAI.BlastCast';
if (process.platform === 'win32') app.setAppUserModelId(windowsAppId);
let window;
let mediaAllowed = false;
let permissionPending = false;
let licenseStore;
const assets = new Map([
  ['/Blastworks-Cast-256.png', 'image/png'],
  ['/1cam.png', 'image/png'], ['/2cam.png', 'image/png'], ['/3cam.png', 'image/png'], ['/4cam.png', 'image/png'],
  ['/5cam.png', 'image/png'], ['/6cam.png', 'image/png'], ['/7cam.png', 'image/png'], ['/8cam.png', 'image/png'],
  ['/screensharevert-8.png', 'image/png'], ['/screensharehorizont-8.png', 'image/png'],
  ['/tokens.css', 'text/css'], ['/blastcast.css', 'text/css'], ['/studio-shell.js', 'text/javascript'], ['/recording-library.js', 'text/javascript'], ['/invite-automation.js', 'text/javascript'], ['/logo-icon.svg', 'image/svg+xml'],
  ['/relay-input.js', 'text/javascript'], ['/screen-share-attention.js', 'text/javascript'], ['/program-output.js', 'text/javascript'],
  ...['cloudflare-tunnel-ready', 'cloudflare-route-form', 'cloudflare-route-ready', 'expressturn-fields'].map(name => [`/instructions/${name}.png`, 'image/png']),
  ...['Regular', 'SemiBold', 'ExtraBold'].map(weight => [`/fonts/BlastworksSans-${weight}.woff2`, 'font/woff2']),
  ['/index.html', 'text/html'], ['/studio.css', 'text/css'],
  ['/studio.js', 'text/javascript'], ['/invites.js', 'text/javascript'], ['/recording.js', 'text/javascript'], ['/preview.js', 'text/javascript'],
  ['/recording-status.js', 'text/javascript'], ['/synchronization.js', 'text/javascript'],
  ['/screen-share.js', 'text/javascript'], ['/device-access.js', 'text/javascript'], ['/scenes.js', 'text/javascript'], ['/scene-controls.js', 'text/javascript'],
  ['/admission.css', 'text/css'], ['/admission-ui.js', 'text/javascript'],
    ['/source-protocol.js', 'text/javascript'], ['/source-capture.js', 'text/javascript'], ['/source-session.js', 'text/javascript'], ['/source-outbox.js', 'text/javascript'], ['/source-recovery.js', 'text/javascript'],
  ['/host-calls.js', 'text/javascript'], ['/peer-call.js', 'text/javascript'], ['/audio-mix.js', 'text/javascript'],
]);
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

async function authorizePreview() {
  if (!licenseStore?.active()) return false;
  if (permissionPending) return false;
  permissionPending = true;
  try {
    if (!mediaAllowed) {
      const answer = await dialog.showMessageBox(window, {
        type: 'question', title: 'Camera and microphone access',
        message: 'Allow BlastCast to access your camera and microphone?',
        detail: 'Opening a device list briefly checks available devices. Enabling a camera or microphone keeps that source on until you disable it. Admitting a guest connects your enabled sources to them. Recording starts only when you press Record and is saved on this computer.',
        buttons: ['Allow access', 'Cancel'], defaultId: 1, cancelId: 1,
      });
      if (answer.response !== 0) return false;
    }
    if (process.platform === 'darwin') {
      let anyAllowed = false;
      for (const kind of ['camera', 'microphone']) {
        if (await systemPreferences.askForMediaAccess(kind)) anyAllowed = true;
      }
      if (!anyAllowed) { mediaAllowed = false; return false; }
    }
    mediaAllowed = true;
    return true;
  } finally { permissionPending = false; }
}

app.whenReady().then(async () => {
  const publicKey = await fs.readFile(path.join(__dirname, '../assets/licensing/public-key.txt'), 'utf8');
  licenseStore = createLicenseStore({ directory: app.getPath('userData'), safeStorage, publicKey });
  await licenseStore.load();
  const activated = () => licenseStore.active();
  const local = session.fromPartition('blastcast-local');
  local.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('app://studio/') });
  });
  await local.protocol.handle('app', async request => {
    const url = new URL(request.url);
    const mime = assets.get(url.pathname);
    if (url.host !== 'studio' || request.method !== 'GET' || !mime || url.search) return new Response('Not found', { status: 404 });
    try {
      return new Response(await fs.readFile(path.join(__dirname, '../dist', url.pathname.slice(1))), {
        headers: { 'Content-Type': mime, 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' },
      });
    } catch { return new Response('Application files unavailable. Rebuild BlastCast.', { status: 500 }); }
  });
  const validMedia = (contents, permission, details) => mediaPermission(contents, window?.webContents, permission, details, mediaAllowed && activated());
  local.setPermissionRequestHandler((contents, permission, callback, details) => callback(
    (activated() && permission === 'display-capture' && contents === window?.webContents && contents.getURL() === STUDIO_URL && details.isMainFrame !== false) ||
    (validMedia(contents, permission, details) && details.mediaTypes?.every(type => type === 'audio' || type === 'video') === true),
  ));
  local.setPermissionCheckHandler((contents, permission, origin, details) =>
    (activated() && permission === 'display-capture' && contents === window?.webContents && contents.getURL() === STUDIO_URL && details.isMainFrame !== false && origin === 'app://studio') || validMedia(contents, permission, { ...details, requestingOrigin: origin }));
  installDisplayPicker({session:local,getWindow:()=>window,BrowserWindow,desktopCapturer,icon:path.join(__dirname,'../assets/brand/Blastworks-Cast-256.png'),authorized:activated});
  let guests;
  const directAccess = createDirectAccess({
    journalPath: path.join(app.getPath('userData'), 'direct-access-lease.json'),
    beforeLeaseCleanup: async () => { await guests?.stop(); },
  });
  await directAccess.recover();
  const destination = createDestination({
    pick: async () => {
      const result = await dialog.showOpenDialog(window, {
        title: 'Choose a recording folder', properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? null : result.filePaths[0];
    },
    open: folder => shell.openPath(folder),
  });
  const library = createRecordingLibrary({file:path.join(app.getPath('userData'), 'recording-library.json'),open:file=>shell.openPath(file)});
  const preferences = createStudioPreferences({directory:app.getPath('userData')});
  const recording = createRecordingStore({ folder: destination.selectedFolder, open: file => shell.openPath(file), onFinalized:entry=>library.add(entry) });
  for (const [name, method, count] of [['renameRecording',library.rename,2], ['openLibraryRecording',library.open,1], ['saveDevicePreferences',preferences.saveDevices,1], ['chooseSceneBackdrop', async id => {
      if(!['1cam','2cam','3cam','4cam','5cam','6cam','7cam','8cam','screensharevert-8','screensharehorizont-8'].includes(id)) return {ok:false,message:'Unknown scene.'};
      const chosen=await dialog.showOpenDialog(window,{title:'Choose a 1920 × 1080 PNG backdrop',properties:['openFile'],filters:[{name:'PNG backdrop',extensions:['png']}]});
      if(chosen.canceled||chosen.filePaths.length!==1)return {ok:false,cancelled:true,message:'Backdrop selection cancelled.'};
      try {
        const handle=await fs.open(chosen.filePaths[0],'r'); let bytes;
        try {if(!(await handle.stat()).isFile()||(await handle.stat()).size>20*1024*1024)return {ok:false,message:'Choose a PNG smaller than 20 MB.'}; bytes=await handle.readFile();} finally {await handle.close();}
        if(bytes.length<24||bytes.readUInt32BE(16)!==1920||bytes.readUInt32BE(20)!==1080)return {ok:false,message:'Backdrops must be 1920 × 1080 pixels.'};
        const image=nativeImage.createFromBuffer(bytes); const size=image.getSize();
        if(image.isEmpty()||size.width!==1920||size.height!==1080)return {ok:false,message:'This PNG could not be decoded as a 1920 × 1080 backdrop.'};
        return preferences.saveBackdrop(id,bytes);
      }catch{return {ok:false,message:'The backdrop could not be read. Choose a valid PNG.'};}
    },1], ['resetSceneBackdrop',preferences.resetBackdrop,1]]) {
    ipcMain.handle(`blastcast:${name}`, (event,...args)=>{
      if(!trustedFrame(event,window?.webContents)||args.length!==count) throw new Error('Unauthorized studio request');
      if(!activated()) throw new Error('BlastCast activation is required.');
      return method(...args);
    });
  }
  let sourceStore = createSourceStore({ folder: destination.selectedFolder });
  // Keep bridge/HTTP references stable when an interrupted renderer gets a fresh store.
  const sources = Object.fromEntries(['beginEpisode', 'beginSource', 'appendSource', 'finishSource', 'stopEpisode', 'closeEpisode', 'status', 'recoveryKey', 'importRecovery', 'recover', 'interrupt', 'shutdown']
    .map(name => [name, (...args) => sourceStore[name](...args)]));
  guests = createGuestServer({ directory: path.join(__dirname, '../dist'), sources });
  let guestGeneration = 0;
  let guestAccess;
  const tunnel = createFreeTunnel({ directory: path.join(app.getPath('userData'), 'free-tunnel'),
    onLost: message => { void guestAccess.lost(message).catch(() => {}); } });
  guestAccess = createGuestAccess({guests,directAccess,tunnel,onConfigured:()=>{guestGeneration++;}});
  let guestWizard;
  const stopGuestAccess = () => { guestWizard?.invalidate(); return guestAccess.stop(); };
  const configureGuestAccess = input => coordinator.busy()
    ? {ok:false,message:'Finish recording and receiving originals before changing guest access.'}
    : (guestWizard?.invalidate(), guestAccess.configure(input));
  const prepareGuestDirectAccess = async () => {
    const current = guests.status();
    if (!current.ok || !current.readiness || current.readiness.routeType !== 'direct' ||
        (current.phase !== 'outside-check' && current.phase !== 'ready') || !current.port) {
      return { ok: false, phase: 'blocked', plan: null, lease: null,
        message: 'Start a current direct readiness check before showing temporary router access.' };
    }
    return directAccess.prepare({ generation: guestGeneration, origin: current.origin, guestTarget: `127.0.0.1:${current.port}` });
  };
  const approveGuestDirectAccess = async () => {
    const current = guests.status();
    const access = directAccess.status();
    if (!current.ok || !current.readiness || current.readiness.routeType !== 'direct' ||
        (current.phase !== 'outside-check' && current.phase !== 'ready') || access.plan?.generation !== guestGeneration) {
      await directAccess.stop();
      return { ok: false, phase: 'blocked', plan: null, lease: null,
        message: 'The direct route changed. Show the current temporary access again before approving it.' };
    }
    return directAccess.approve();
  };
  const coordinator = createSourceController({ recording, sources, guests, confirmIncomplete: async () => {
    const answer = await dialog.showMessageBox(window, { type: 'warning', title: 'Finish with missing originals?',
      message: 'Some participant originals are not complete.',
      detail: 'Finishing stops original delivery for this episode. All saved media and partial files are kept. Your complete episode stays playable; its original backup set will remain incomplete.',
      buttons: ['Keep receiving originals', 'Finish with missing originals'], defaultId: 0, cancelId: 0 });
    return answer.response === 1;
  } });
  guestWizard = createGuestWizard({ settings: createGuestSettings({directory:app.getPath('userData'),safeStorage}), access:guestAccess, guests, busy:coordinator.busy });
  registerBridge(ipcMain, () => window?.webContents, { loadGuestSettings:guestWizard.load });
  registerBridge(ipcMain, () => window?.webContents, {clearGuestSettings:guestWizard.clear,generateSavedGuestInvite:guestWizard.generate}, activated);
  ipcMain.handle('blastcast:saveGuestSettings', (event,...args) => {
    if (!trustedFrame(event,window?.webContents) || args.length !== 1) throw new Error('Unauthorized guest settings');
    if (!activated()) throw new Error('BlastCast activation is required.');
    return guestWizard.save(args[0]);
  });
  registerRecordingBridge(ipcMain, () => window?.webContents, { ...recording, finish: coordinator.finish, abort: coordinator.abort }, activated);
  registerSourceBridge(ipcMain, () => window?.webContents, sources, activated);
  registerGuestBridge(ipcMain, () => window?.webContents, { ...guests, configure: configureGuestAccess }, activated);
  ipcMain.handle('blastcast:startFreeGuestAccess', (event,...args) => {
    if (!trustedFrame(event,window?.webContents) || args.length !== 1) throw new Error('Unauthorized guest setup');
    if (!activated()) throw new Error('BlastCast activation is required.');
    if (coordinator.busy()) return {ok:false,message:'Finish recording and receiving originals before changing guest access.'};
    guestWizard.invalidate();
    return guestAccess.startFree(args[0]);
  });
  let folderOperation = false;
  const availableFolder = method => async () => {
    if (folderOperation || coordinator.busy()) return { status:'error', message:'Finish recording and original delivery before changing or checking the destination.' };
    folderOperation = true;
    try { return await method(); }
    finally { folderOperation = false; }
  };
  const recoverFolder = method => async () => {
    const result = await method();
    if (result.status !== 'ready') return result;
    const recovered = await sourceStore.recover();
    return recovered.ok ? result : { status:'error', message:recovered.message };
  };
  const importGuestRecovery = async () => {
    if (folderOperation) return { ok:false,message:'Another recording-folder action is still open.' };
    folderOperation = true;
    try {
      const state = sourceStore.status();
      if (!state || state.phase !== 'stopped' || state.closing || state.allSourcesComplete) {
        return { ok:false,message:'Stop the episode with a missing guest original before importing recovery.' };
      }
      const result = await dialog.showOpenDialog(window, { title:'Import guest recovery',properties:['openFile'],
        filters:[{ name:'BlastCast guest recovery',extensions:['bcr'] }] });
      if (result.canceled || result.filePaths.length !== 1) return { ok:false,cancelled:true,message:'No recovery file selected.' };
      return sourceStore.importRecovery(result.filePaths[0]);
    } finally { folderOperation = false; }
  };
  registerBridge(ipcMain, () => window?.webContents, {
    appInfo:()=>({version:app.getVersion(),updates:'https://github.com/blastworksai/blastcast/releases'}),
    openUpdates:async()=>{try{await shell.openExternal('https://github.com/blastworksai/blastcast/releases');return {ok:true};}catch{return {ok:false,message:'GitHub releases could not open. Visit github.com/blastworksai/blastcast/releases in your browser.'};}},
    listRecordings:library.list, getSceneBackdrops:preferences.getBackdrops, loadDevicePreferences:preferences.loadDevices,
    sourceStatus: coordinator.sourceStatus,
    guestStatus: async () => {
      const current = guestAccess.status();
      if (current.ok && current.phase === 'blocked' && ['planned', 'active'].includes(directAccess.status().phase)) await directAccess.stop();
      if (current.ok && current.phase === 'blocked') await tunnel.stop();
      return current;
    },
    directAccessStatus: directAccess.status,
  });
  registerBridge(ipcMain, () => window?.webContents, {
    authorizePreview, chooseFolder: availableFolder(recoverFolder(destination.choose)), checkFolder: availableFolder(recoverFolder(destination.check)), openFolder: destination.open,
    beginRecording: coordinator.begin, openRecording: recording.openLatest,
    closeSourceEpisode: coordinator.closeSources, importGuestRecovery,
    createGuestInvite: guests.invite, revokeGuestInvites: guests.revoke,
    failGuestReadiness: async () => {
      const result = guests.failReadiness();
      if (result.ok && result.phase === 'blocked') await directAccess.stop();
      return result;
    },
    prepareGuestDirectAccess,
    approveGuestDirectAccess,
    stopGuests: async () => { const result=await stopGuestAccess(); return result?.ok === false ? result : guestAccess.status(); },
    copyGuestReadiness: () => {
      const current = guests.status();
      const check = current.readiness?.check;
      if (!check) return { ok: false, message: 'Start a current outside-network check first.' };
      clipboard.writeText(check.url); return { ok: true };
    },
    copyGuestInvite: () => {
      const current = guests.status();
      if (!current.invite) return { ok: false, message: 'Create a current invitation first.' };
      clipboard.writeText(current.invite.url); return { ok: true };
    },
  }, activated);
  registerBridge(ipcMain, () => window?.webContents, { licenseStatus: licenseStore.status });
  ipcMain.handle('blastcast:activateLicense', (event,...args) => {
    if (!trustedFrame(event,window?.webContents) || args.length !== 1 || typeof args[0] !== 'string') throw new Error('Unauthorized activation request');
    return licenseStore.activate(args[0]);
  });
  registerBridge(ipcMain, () => window?.webContents, { deactivateLicense: async () => {
    if (coordinator.busy()) return { ...licenseStore.status(), message:'Finish recording and receiving originals before deactivating BlastCast.' };
    await stopGuestAccess(); mediaAllowed = false; return licenseStore.deactivate();
  } });
  ipcMain.handle('blastcast:openGuestProvider', async (event,...args) => {
    const destinations = {cloudflare:'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/',expressturn:'https://www.expressturn.com/'};
    if (!trustedFrame(event,window?.webContents) || args.length !== 1 || !Object.hasOwn(destinations,args[0])) throw new Error('Unauthorized provider guide');
    if (!activated()) throw new Error('BlastCast activation is required.');
    try { await shell.openExternal(destinations[args[0]]); return {ok:true}; }
    catch { return {ok:false,message:'The provider website could not open in your browser.'}; }
  });
  function createWindow() {
    mediaAllowed = false;
    const windowsIcon = path.join(__dirname, '../assets/brand/BlastCast.ico');
    const windowIcon = process.platform === 'win32' && existsSync(windowsIcon)
      ? windowsIcon : path.join(__dirname, '../assets/brand/Blastworks-Cast-256.png');
    window = new BrowserWindow({
      title: 'BlastCast', width: 1240, height: 860, minWidth: 780, minHeight: 650,
      icon: windowIcon,
      backgroundColor: '#232323', autoHideMenuBar: true,
      webPreferences: { session: local, preload: path.join(__dirname, 'preload.cjs'),
        backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
        webviewTag: false, spellcheck: false },
    });
    if (process.platform === 'win32') {
      window.setAppDetails({ appId: windowsAppId,
        appIconPath: existsSync(windowsIcon) ? windowsIcon : process.execPath,
        appIconIndex: 0, relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: 'BlastCast' });
    }
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event,url) => { if (!allowedStudioNavigation(url)) event.preventDefault(); });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.on('close', event => {
      if (coordinator.busy()) {
        event.preventDefault();
        void dialog.showMessageBox(window, { type: 'info', message: 'Stop recording, then keep the studio open until all originals are verified. An override becomes available only after more than an hour has passed since production finished.', buttons: ['Keep recording window open'] });
      }
    });
    const created = window;
    let recovering = false;
    created.webContents.on('render-process-gone', () => {
      if (recovering) return;
      recovering = true; mediaAllowed = false;
      void (async () => {
        await stopGuestAccess();
        await recording.shutdown();
        const interrupted = await sourceStore.interrupt();
        if (!interrupted.ok) throw new Error(interrupted.message);
        sourceStore = createSourceStore({ folder: destination.selectedFolder });
        const recovered = destination.selectedFolder() ? await sourceStore.recover() : { ok:true, recovered:false };
        if (created.isDestroyed()) return;
        const answer = await dialog.showMessageBox(created, {
          type: 'warning', title: 'Studio interrupted',
          message: 'BlastCast’s studio stopped unexpectedly.',
          detail: recovered.ok
            ? 'BlastCast checked the selected recording folder and kept every verified original byte it found. Incomplete tails remain unchanged. Reopening the studio leaves your camera and microphone off until you start preview again.'
            : `${recovered.message} Reopening the studio keeps recording blocked until you select another valid folder.`,
          buttons: ['Reopen studio', 'Keep window open'], defaultId: 0, cancelId: 1,
        });
        if (answer.response === 0 && !created.isDestroyed()) await created.loadURL(STUDIO_URL);
      })().catch(error => {
        dialog.showErrorBox('Studio could not reopen', `Your recording files remain in the selected folder. Close and reopen BlastCast. ${error.message}`);
      }).finally(() => { recovering = false; });
    });
    window.on('closed', () => { window = null; mediaAllowed = false; void stopGuestAccess(); void sourceStore.shutdown(); });
    window.loadURL(STUDIO_URL).catch(error => {
      dialog.showErrorBox('BlastCast could not start', error.message);
      app.quit();
    });
  }
  createWindow();
  let quitCleanupStarted = false;
  let quitCleanupFinished = false;
  app.on('before-quit', event => {
    if (quitCleanupFinished) return;
    event.preventDefault();
    if (quitCleanupStarted) return;
    quitCleanupStarted = true;
    void stopGuestAccess().catch(() => {}).finally(() => {
      quitCleanupFinished = true;
      app.quit();
    });
  });
  app.on('activate', () => { if (!window) { sourceStore = createSourceStore({ folder: destination.selectedFolder }); createWindow(); } });
}).catch(error => { dialog.showErrorBox('BlastCast could not start', error.message); app.quit(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
