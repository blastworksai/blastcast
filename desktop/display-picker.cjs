// CodexBWAI — each screen share requires a fresh explicit selection in an isolated, scriptless picker.
const { randomUUID } = require('node:crypto');
const STUDIO_URL = 'app://studio/index.html';
const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function pickerHtml(sources, nonce, truncated) {
  const cards = sources.map((source,index) => {
    let thumbnail = ''; try { thumbnail = source.thumbnail.toDataURL(); } catch {}
    if (!/^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(thumbnail) || thumbnail.length > 1024 * 1024) thumbnail = '';
    return `<a href="https://blastcast.invalid/${nonce}/pick/${index}" aria-label="Share ${escape(source.name)}">${thumbnail ? `<img src="${thumbnail}" alt="">` : '<span class="empty">Preview unavailable</span>'}<span>${escape(source.name)}</span></a>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'"><title>Share a screen or window — BlastCast</title><style>body{margin:24px;background:#171717;color:#fff;font:16px system-ui}h1{font-size:23px}p{color:#ccc}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}a{display:flex;flex-direction:column;gap:10px;padding:12px;border:2px solid #555;border-radius:8px;color:white;text-decoration:none;overflow-wrap:anywhere}a:hover,a:focus{border-color:#ffab01;outline:2px solid #ffab01}img,.empty{width:100%;height:140px;object-fit:contain;background:#262626}.empty{display:grid;place-items:center}footer{margin:20px 0}footer a{display:inline-block}small{color:#ddd}</style></head><body><h1>Choose what to share</h1><p>Click a screen or window to start sharing it. Screen audio is not shared.</p><main>${cards || '<p>No screens or windows are available. Check system screen-recording permissions and try again.</p>'}</main>${truncated ? '<p>Only the first 200 sources are shown. Close unused windows if your source is missing.</p>' : ''}<footer><a href="https://blastcast.invalid/${nonce}/cancel">Cancel</a></footer></body></html>`;
}
function installDisplayPicker({ session, getWindow, BrowserWindow, desktopCapturer, icon, timeoutMs = 120000, authorized = () => true }) {
  let active = null;
  const trusted = (request, parent) => {
    try { return Boolean(authorized() && parent && !parent.isDestroyed() && getWindow() === parent && !parent.webContents.isDestroyed() &&
      request.frame === parent.webContents.mainFrame && request.frame.url === STUDIO_URL && request.videoRequested === true && request.audioRequested === false && request.userGesture === true); }
    catch { return false; }
  };
  session.setDisplayMediaRequestHandler((request, callback) => {
    const parent = getWindow();
    if (active || !trusted(request,parent)) { try { callback({}); } catch { /* Electron also rejects the renderer request when no video is granted. */ } return; }
    const nonce = randomUUID(); let child = null, settled = false;
    const timer = setTimeout(() => finish(), Math.max(1000, Math.min(timeoutMs,120000)));
    function finish(source) {
      if (settled) return; settled = true; clearTimeout(timer);
      parent.removeListener('closed', cancel); parent.webContents.removeListener('did-start-navigation', navigated); parent.webContents.removeListener('destroyed', cancel);
      active = null;
      try { callback(source && trusted(request,parent) ? { video: source } : {}); }
      catch { /* Electron 44 throws for a denied video request; getDisplayMedia rejects in the renderer. */ }
      finally { if (child && !child.isDestroyed()) child.destroy(); }
    }
    const cancel = () => finish();
    const navigated = (_event,_url,_inPlace,isMainFrame) => { if (isMainFrame) finish(); };
    active = cancel;
    parent.once('closed',cancel); parent.webContents.on('did-start-navigation',navigated);parent.webContents.once('destroyed',cancel);
    void (async () => {
      try {
        const allSources = await desktopCapturer.getSources({types:['screen','window'],thumbnailSize:{width:320,height:180},fetchWindowIcons:false});
        if (settled) return;
        if (!trusted(request,parent)) { finish(); return; }
        const sources = allSources.slice(0,200);
        child = new BrowserWindow({icon,parent,modal:true,show:false,width:820,height:650,minWidth:480,minHeight:360,title:'Share a screen or window — BlastCast',autoHideMenuBar:true,
          webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,partition:`blastcast-picker-${nonce}`}});
        const pickerSession = child.webContents.session;
        const html = 'data:text/html;charset=utf-8,' + encodeURIComponent(pickerHtml(sources,nonce,allSources.length > sources.length));
        pickerSession.setPermissionRequestHandler((_contents,_permission,cb)=>cb(false));
        pickerSession.setPermissionCheckHandler(()=>false);
        pickerSession.webRequest.onBeforeRequest((details,cb)=>cb({cancel:details.url !== html && !details.url.startsWith('data:image/png;base64,')}));
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
        await child.loadURL(html);
        if (!settled && trusted(request,parent)) child.show(); else finish();
      } catch { finish(); }
    })();
  },{useSystemPicker:false});
  return { dispose() { if (active) active(); session.setDisplayMediaRequestHandler(null); } };
}
module.exports = { installDisplayPicker, pickerHtml };
