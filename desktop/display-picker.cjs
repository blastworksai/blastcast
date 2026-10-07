// CodexBWAI — each screen share requires a fresh explicit selection in an isolated, scriptless picker.
const { randomUUID } = require('node:crypto');
const { SCREEN_BLOCKED_MESSAGE } = require('./media-access.cjs');
const STUDIO_URL = 'app://studio/index.html';
const PICKER_HOST = 'blastcast.invalid';
const PICKER_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'";
const pickerUrl = nonce => `https://${PICKER_HOST}/${nonce}/index.html`;
const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function pickerHtml(sources, nonce, truncated) {
  const cards = sources.map((source,index) => {
    let thumbnail = ''; try { thumbnail = source.thumbnail.toDataURL(); } catch {}
    if (!/^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(thumbnail) || thumbnail.length > 1024 * 1024) thumbnail = '';
    return `<a href="https://blastcast.invalid/${nonce}/pick/${index}" aria-label="Share ${escape(source.name)}">${thumbnail ? `<img src="${thumbnail}" alt="">` : '<span class="empty">Preview unavailable</span>'}<span>${escape(source.name)}</span></a>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PICKER_CSP}"><title>Share a screen or window — BlastCast</title><style>body{margin:24px;background:#171717;color:#fff;font:16px system-ui}h1{font-size:23px}p{color:#ccc}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}a{display:flex;flex-direction:column;gap:10px;padding:12px;border:2px solid #555;border-radius:8px;color:white;text-decoration:none;overflow-wrap:anywhere}a:hover,a:focus{border-color:#ffab01;outline:2px solid #ffab01}img,.empty{width:100%;height:140px;object-fit:contain;background:#262626}.empty{display:grid;place-items:center}footer{margin:20px 0}footer a{display:inline-block}small{color:#ddd}</style></head><body><h1>Choose what to share</h1><p>Click a screen or window to start sharing it. Screen audio is not shared.</p><main>${cards || '<p>No screens or windows are available. Check system screen-recording permissions and try again.</p>'}</main>${truncated ? '<p>Only the first 200 sources are shown. Close unused windows if your source is missing.</p>' : ''}<footer><a href="https://blastcast.invalid/${nonce}/cancel">Cancel</a></footer></body></html>`;
}
// ClaudeBWAI — resolves {blocked:true,message} (never a source) when macOS Screen Recording stays blocked after the prompt path.
// ClaudeBWAI — the picker opens from the studio's chooseScreen bridge call (boundary.cjs createDisplayPermission), BEFORE
// getDisplayMedia; resolves the chosen source, or null on cancel, timeout, parent close/navigation or failure.
function openPicker({ parent, stillTrusted, BrowserWindow, desktopCapturer, icon, timeoutMs, bindCancel = () => {}, screenBlocked = null, platform = process.platform }) {
  return new Promise(resolve => {
    const nonce = randomUUID(); let child = null, settled = false;
    const timer = setTimeout(() => finish(), Math.max(1000, Math.min(timeoutMs,120000)));
    function finish(source) {
      if (settled) return; settled = true; clearTimeout(timer);
      parent.removeListener('closed', cancel); parent.webContents.removeListener('did-start-navigation', navigated); parent.webContents.removeListener('destroyed', cancel);
      try { resolve(source && stillTrusted() ? source : null); }
      finally { if (child && !child.isDestroyed()) child.destroy(); }
    }
    const cancel = () => finish();
    const navigated = (_event,_url,_inPlace,isMainFrame) => { if (isMainFrame) finish(); };
    bindCancel(cancel);
    parent.once('closed',cancel); parent.webContents.on('did-start-navigation',navigated);parent.webContents.once('destroyed',cancel);
    void (async () => {
      try {
        // ClaudeBWAI — 3.6a: getSources ALWAYS runs first, even with Screen Recording not granted: it is the call that makes macOS
        // register BlastCast, list it in System Settings and show its own prompt (a status preflight alone shows nothing).
        let allSources;
        try { allSources = await desktopCapturer.getSources({types:['screen','window'],thumbnailSize:{width:320,height:180},fetchWindowIcons:false}); }
        catch (error) { if (!screenBlocked) throw error; allSources = []; }
        if (settled) return;
        if (!stillTrusted()) { finish(); return; }
        // Only after that does BlastCast decide: still not granted (or macOS handed back nothing) -> our message, never silence.
        const blockedMessage = screenBlocked ? (screenBlocked() || (platform === 'darwin' && allSources.length === 0 ? SCREEN_BLOCKED_MESSAGE : null)) : null;
        if (blockedMessage) { finish({ blocked: true, message: blockedMessage }); return; }
        const sources = allSources.slice(0,200);
        child = new BrowserWindow({icon,parent,modal:true,show:false,width:820,height:650,minWidth:480,minHeight:360,title:'Share a screen or window — BlastCast',autoHideMenuBar:true,
          webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,partition:`blastcast-picker-${nonce}`}});
        const pickerSession = child.webContents.session;
        // ClaudeBWAI — served through the picker session's own protocol handler: a data: URL carrying every thumbnail hit Chromium's 2 MiB URL limit at ~22 sources.
        const url = pickerUrl(nonce), html = pickerHtml(sources,nonce,allSources.length > sources.length);
        await pickerSession.protocol.handle('https', request => request.url === url && request.method === 'GET'
          ? new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':PICKER_CSP,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})
          : new Response('Not found',{status:404}));
        pickerSession.setPermissionRequestHandler((_contents,_permission,cb)=>cb(false));
        pickerSession.setPermissionCheckHandler(()=>false);
        pickerSession.webRequest.onBeforeRequest((details,cb)=>cb({cancel:details.url !== url && !details.url.startsWith('data:image/png;base64,')}));
        child.webContents.setWindowOpenHandler(()=>({action:'deny'}));
        child.webContents.on('will-navigate',(event,url)=>{
          event.preventDefault();
          if (url === `https://blastcast.invalid/${nonce}/cancel`) { finish(); return; }
          const prefix = `https://blastcast.invalid/${nonce}/pick/`;
          if (!url.startsWith(prefix)) return;
          const index = url.slice(prefix.length);
          if (!/^(0|[1-9][0-9]{0,2})$/.test(index)) return;
          const source = sources[Number(index)]; if (source) finish(source);
        });
        child.on('closed',cancel);child.webContents.on('render-process-gone',cancel);
        await child.loadURL(url);
        if (!settled && stillTrusted()) child.show(); else finish();
      } catch (error) { console.error('BlastCast display picker failed:', error?.message ?? error); finish(); }
    })();
  });
}
// ClaudeBWAI — choose() runs the picker for chooseScreen; the display-media handler only serves what the pick armed
// (serve(), boundary.cjs), so getDisplayMedia never opens a second picker and gets nothing without a pick.
function installDisplayPicker({ session, getWindow, BrowserWindow, desktopCapturer, icon, timeoutMs = 120000, authorized = () => true, serve = () => null, screenBlocked = null, platform = process.platform }) {
  let active = null;
  const studioWindow = parent => Boolean(authorized() && parent && !parent.isDestroyed() && getWindow() === parent && !parent.webContents.isDestroyed() &&
    parent.webContents.mainFrame?.url === STUDIO_URL);
  // ClaudeBWAI — no userGesture requirement here (deviation from the earlier handler): the studio's transient activation
  // lapses after 5 s while the host is still in the picker window (measured: userGesture false, getDisplayMedia still
  // runs), and the gesture is now spent by chooseScreen's genuine-input check instead.
  const trusted = (request, parent) => {
    try { return Boolean(studioWindow(parent) && request.frame === parent.webContents.mainFrame && request.frame.url === STUDIO_URL && request.videoRequested === true && request.audioRequested === false); }
    catch { return false; }
  };
  session.setDisplayMediaRequestHandler((request, callback) => {
    // Reaching this handler proves the grant went to getDisplayMedia, not the legacy path, so it is always consumed;
    // an untrusted request is refused without its refusal counting as a breach (Codex round 4).
    const granted = serve(), source = granted && trusted(request, getWindow()) ? granted : null;
    try { callback(source ? { video: source } : {}); } catch { /* Electron 44 throws for a denied video request; getDisplayMedia rejects in the renderer. */ }
  },{useSystemPicker:false});
  return {
    async choose() {
      const parent = getWindow();
      if (active || !studioWindow(parent)) return null;
      let cancel = () => {};
      const pending = openPicker({ parent, stillTrusted: () => studioWindow(parent), BrowserWindow, desktopCapturer, icon, timeoutMs, screenBlocked, platform, bindCancel: c => { cancel = c; } });
      active = { cancel };
      try { return await pending; } finally { active = null; }
    },
    get active() { return Boolean(active); },
    dispose() { active?.cancel(); session.setDisplayMediaRequestHandler(null); },
  };
}
module.exports = { installDisplayPicker, openPicker, pickerHtml, pickerUrl };
