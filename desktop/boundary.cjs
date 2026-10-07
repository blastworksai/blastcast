const STUDIO_URL = 'app://studio/index.html';
const { MAX_CHUNK } = require('./recording.cjs');
const { UUID } = require('./source-limits.cjs');
const { validDiagnostics } = require('./session-diagnostics.cjs');
function trustedFrame(event, contents) {
  return Boolean(contents && !contents.isDestroyed() && event.sender === contents &&
    event.senderFrame === contents.mainFrame && event.senderFrame?.url === STUDIO_URL);
}
function allowedStudioNavigation(url) { return url === STUDIO_URL; }
function registerBridge(ipc, contents, methods, authorized = () => true) {
  for (const [name, method] of Object.entries(methods)) {
    ipc.handle(`blastcast:${name}`, (event, ...args) => {
      if (!trustedFrame(event, contents()) || args.length) throw new Error('Unauthorized desktop request');
      if (!authorized()) throw new Error('BlastCast activation is required.');
      return method();
    });
  }
}
// CodexBWAI — recording accepts only bounded payloads from the studio's main frame.
function registerRecordingBridge(ipc, contents, recording, authorized = () => true) {
  const uuid = value => typeof value === 'string' && UUID.test(value);
  for (const [name, count, validate, method] of [
    ['appendRecording', 3, a => uuid(a[0]) && Number.isSafeInteger(a[1]) && a[1] >= 0 && a[2] instanceof ArrayBuffer && a[2].byteLength > 0 && a[2].byteLength <= MAX_CHUNK, recording.append],
    ['finishRecording', 1, a => uuid(a[0]), recording.finish],
    ['abortRecording', 1, a => uuid(a[0]), recording.abort],
    // ClaudeBWAI — session diagnostics: the recording id plus one schema-checked, size-capped payload; main picks the file.
    ['recordSessionDiagnostics', 2, a => uuid(a[0]) && validDiagnostics(a[1]), recording.diagnostics],
  ]) ipc.handle(`blastcast:${name}`, (event, ...args) => {
    if (!trustedFrame(event, contents()) || args.length !== count || !validate(args)) throw new Error('Invalid recording request');
    if (!authorized()) throw new Error('BlastCast activation is required.');
    return method(...args);
  });
}
function localOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'app:' && url.hostname === 'studio' && !url.port && !url.username && !url.password;
  } catch { return false; }
}
function mediaPermission(contents, expected, permission, details, allowed) {
  return Boolean(allowed && contents && contents === expected &&
    permission === 'media' && contents.getURL() === STUDIO_URL &&
    localOrigin(details.requestingUrl ?? details.requestingOrigin) && details.isMainFrame !== false);
}
// ClaudeBWAI — host display-capture consent. Electron 44 sends getDisplayMedia's permission request as
// 'media' with EMPTY mediaTypes, byte-identical to getUserMedia({video:{mandatory:{chromeMediaSource:'desktop'}}}),
// which captures the screen with no picker. The permission handlers cannot tell the two apart (probed, Electron 44.4.5:
// same details keys, check handler results are ignored once granted, only the display-media handler differs and it
// fires after the grant). So the picker comes FIRST: the studio's chooseScreen bridge call needs real mouse/keyboard/
// touch input to the studio within INTENT_MS (webContents 'input-event'; script-made click() emits none), consumes it,
// and opens the isolated picker (display-picker.cjs). A pick arms ONE grant for ARM_MS. An empty-mediaTypes request is
// granted only while a pick is armed, unexpired and unspent; the display-media handler then serves exactly that source.
// Measured 3 Oct 2026: Electron calls the display-media handler re-entrantly INSIDE the permission callback(true)
// (100 of 100 getDisplayMedia calls, idle and under a busy main loop) and never after a refusal. So decide() checks the
// moment callback(true) returns: a grant still unserved was spent outside getDisplayMedia (a desktop getUserMedia, e.g.
// through a fresh iframe's unpatched prototype), and main crashes the studio renderer at once, which ends that stream;
// the existing render-process-gone recovery reopens the studio. Once granted, only serve() ends the watch: a navigation
// (even one main then blocks), a new chooseScreen or a new pick while a grant is outstanding crashes at once, and a
// WATCHDOG_MS timer stays as the backstop. disarm() only drops an armed pick that was never granted.
// Camera/mic requests (non-empty mediaTypes) keep the earlier consent flag.
const INPUT_TYPES = new Set(['mouseDown', 'mouseUp', 'rawKeyDown', 'keyDown', 'keyUp', 'touchStart', 'touchEnd', 'gestureTap']);
function createDisplayPermission({ getContents, authorized = () => true, deviceAllowed = () => false, now = Date.now, intentMs = 2000, grantMs = 5000, armMs = 5000,
  watchdogMs = 1500, setTimer = setTimeout, clearTimer = clearTimeout, onUnconsumed = () => {}, log = message => console.error(message), enforceOnReturn = true }) {
  const lastInput = new WeakMap();
  let grantUntil = -Infinity, armed = null, outstanding = null;
  const studio = (contents, details) => Boolean(contents && contents === getContents() && contents.getURL() === STUDIO_URL && details && details.isMainFrame !== false);
  const isDisplay = (permission, details) => permission === 'display-capture' ||
    (permission === 'media' && Array.isArray(details?.mediaTypes) && details.mediaTypes.length === 0);
  // The one way an outstanding grant ends without serve(): the studio renderer is crashed.
  const breach = reason => {
    if (!outstanding) return false;
    const { contents, timer } = outstanding; outstanding = null; armed = null; grantUntil = -Infinity; clearTimer(timer);
    log(`BlastCast: a desktop capture grant was spent outside getDisplayMedia (${reason}); restarting the studio.`);
    onUnconsumed(contents);
    return true;
  };
  const disarm = () => { armed = null; };
  function request(contents, permission, details = {}) {
    if (isDisplay(permission, details)) {
      if (!authorized() || !studio(contents, details) || !localOrigin(details.requestingUrl ?? details.securityOrigin)) return false;
      if (outstanding || !armed || now() > armed.until) return false;
      const grant = { source: armed.source, contents, timer: null }; armed = null; outstanding = grant;
      grantUntil = now() + grantMs;
      grant.timer = setTimer(() => { if (outstanding === grant) breach('backstop'); }, watchdogMs);
      return true;
    }
    return Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every(type => type === 'audio' || type === 'video') &&
      mediaPermission(contents, getContents(), permission, details, deviceAllowed());
  }
  return {
    watch(contents) {
      contents.on('input-event', (_event, input) => { if (INPUT_TYPES.has(input?.type)) lastInput.set(contents, now()); });
      // An outstanding grant survives no navigation, blocked or not; an armed pick belongs to the document that asked for it.
      const navigating = (inPlace, isMainFrame) => {
        if (!isMainFrame || contents !== getContents()) return;
        if (outstanding?.contents === contents) breach('navigation'); else if (!inPlace) disarm();
      };
      contents.on('will-navigate', () => navigating(false, true));
      contents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => navigating(inPlace, isMainFrame));
    },
    // ClaudeBWAI — chooseScreen spends one genuine input to the studio, at most INTENT_MS old.
    takeInput(contents) {
      if (!contents || contents !== getContents() || contents.getURL() !== STUDIO_URL) return false;
      const at = lastInput.get(contents);
      if (at === undefined || now() - at > intentMs || now() < at) return false;
      lastInput.delete(contents);
      return true;
    },
    arm(source) { if (breach('new pick')) return; armed = source ? { source, until: now() + armMs } : null; },
    disarm,
    breach,
    get outstanding() { return Boolean(outstanding); },
    // The display-media handler's half: the granted source, once. The only call that ends an outstanding grant cleanly.
    serve() {
      if (!outstanding) return null;
      const { source, timer } = outstanding; outstanding = null; clearTimer(timer);
      return source;
    },
    request,
    // ClaudeBWAI — the permission handler: grant, then check the instant callback(true) returns (see the comment above).
    decide(contents, permission, callback, details = {}) {
      const granted = request(contents, permission, details);
      const grant = granted && outstanding;
      try { callback(granted); }
      finally { if (enforceOnReturn && grant && outstanding === grant) breach('not served'); }
    },
    check(contents, permission, origin, details = {}) {
      if (permission !== 'media' && permission !== 'display-capture') return false;
      if (mediaPermission(contents, getContents(), permission, { ...details, requestingOrigin: origin }, deviceAllowed())) return true;
      return authorized() && now() < grantUntil && studio(contents, details) && localOrigin(details.requestingUrl ?? origin);
    },
  };
}
// ClaudeBWAI — the studio's chooseScreen bridge method: genuine input first, one picker at a time, and a pick arms one
// grant. A chooseScreen while a grant is outstanding crashes the studio at once rather than waiting for the backstop:
// that grant was spent outside getDisplayMedia and its stream may be live.
function createChooseScreen({ permission, picker, getContents }) {
  return async () => {
    if (permission.breach('new chooseScreen')) return { ok: false };
    if (!permission.takeInput(getContents()) || picker.active) return { ok: false };
    permission.disarm();
    const source = await picker.choose();
    // ClaudeBWAI — 3.6a: macOS Screen Recording is judged INSIDE the picker, after desktopCapturer.getSources has let macOS prompt
    // (display-picker.cjs); a blocked result carries our message and never arms a grant. No pre-picker short-circuit.
    if (source?.blocked === true && typeof source.message === 'string') return { ok: false, blocked: true, message: source.message };
    if (!source) return { ok: false, cancelled: true };
    permission.arm(source);
    return { ok: true };
  };
}
function registerGuestBridge(ipc, contents, guests, authorized = () => true) {
  ipc.handle('blastcast:configureGuests', (event, ...args) => {
    if (!trustedFrame(event, contents()) || args.length !== 1) throw new Error('Unauthorized guest configuration');
    if (!authorized()) throw new Error('BlastCast activation is required.');
    return guests.configure(args[0]);
  });
  
  const idRegex = /^[A-Za-z0-9_-]{22}$/;
  ipc.handle('blastcast:getGuestCallConfiguration', (event, ...args) => {
    if (!trustedFrame(event, contents()) || args.length !== 1 || typeof args[0] !== 'string' || !idRegex.test(args[0])) throw new Error('Unauthorized call configuration');
    if (!authorized()) throw new Error('BlastCast activation is required.');
    return guests.callConfiguration(args[0]);
  });

  // ClaudeBWAI — einh 4-5 Oct: host chat. The sender is always the host; the renderer supplies only the text / the last id seen.
  ipc.handle('blastcast:chatSend', (event, ...args) => {
    if (!trustedFrame(event, contents()) || args.length !== 1 || typeof args[0] !== 'string') throw new Error('Unauthorized chatSend');
    if (!authorized()) throw new Error('BlastCast activation is required.');
    return guests.chatSend(args[0]);
  });
  ipc.handle('blastcast:chatSince', (event, ...args) => {
    if (!trustedFrame(event, contents()) || args.length !== 1 || !Number.isSafeInteger(args[0]) || args[0] < 0) throw new Error('Unauthorized chatSince');
    if (!authorized()) throw new Error('BlastCast activation is required.');
    return guests.chatSince(args[0]);
  });

  ipc.handle('blastcast:chatAttention', (event, ...args) => {
    if (!trustedFrame(event, contents()) || args.length !== 1 || !Number.isSafeInteger(args[0]) || args[0] < 0) throw new Error('Unauthorized chatAttention');
    if (!authorized()) throw new Error('BlastCast activation is required.');
    return guests.chatAttention(args[0]);
  });

  const admissionMethods = [
    ['guestAdmit', guests.admit, idRegex],
    ['guestReject', guests.reject, idRegex],
    ['guestRemove', guests.remove, idRegex],
    ['revokeGuestInvite', guests.revokeInvite, idRegex],
    // ClaudeBWAI — copy one open invitation's link by its id; the link itself never crosses the bridge as an argument.
    ['copyGuestInvite', guests.copyInvite, idRegex]
  ];

  // ClaudeBWAI — einh 4 Oct: create N separate one-person invitations in one call; the store re-validates 1..remaining.
  ipc.handle('blastcast:createGuestInvites', (event, ...args) => {
    if (!trustedFrame(event, contents()) || args.length !== 1 || !Number.isInteger(args[0]) || args[0] < 1 || args[0] > 7) throw new Error('Unauthorized createGuestInvites');
    if (!authorized()) throw new Error('BlastCast activation is required.');
    return guests.invite(args[0]);
  });

  for (const [name, method, regex] of admissionMethods) {
    ipc.handle(`blastcast:${name}`, (event, ...args) => {
      if (!trustedFrame(event, contents()) || args.length !== 1 || typeof args[0] !== 'string' || !regex.test(args[0])) {
        throw new Error(`Unauthorized ${name}`);
      }
      if (!authorized()) throw new Error('BlastCast activation is required.');
      return method(args[0]);
    });
  }

  ipc.handle('blastcast:sendGuestSignal', (event, sessionId, callId, message) => {
    if (!trustedFrame(event, contents()) || typeof sessionId !== 'string' || !idRegex.test(sessionId) || typeof callId !== 'string' || !idRegex.test(callId) || !message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error('Unauthorized guest signal');
    }
    if (!authorized()) throw new Error('BlastCast activation is required.');
    return guests.sendSignal(sessionId, callId, message);
  });

  ipc.handle('blastcast:pollGuestSignals', (event, sessionId, callId, after) => {
    if (!trustedFrame(event, contents()) || typeof sessionId !== 'string' || !idRegex.test(sessionId) || typeof callId !== 'string' || !idRegex.test(callId) || typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) {
      throw new Error('Unauthorized guest signal poll');
    }
    if (!authorized()) throw new Error('BlastCast activation is required.');
    return guests.pollSignals(sessionId, callId, after);
  });
}
// Only the local main frame can send host originals; the caller cannot select a guest identity.
function registerSourceBridge(ipc, contents, sources, authorized = () => true) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  for (const [name, count, validate, method] of [
    ['beginHostSource', 1, a => object(a[0]), sources.beginSource],
    ['appendHostSource', 2, a => object(a[0]) && a[1] instanceof ArrayBuffer && a[1].byteLength > 0 && a[1].byteLength <= MAX_CHUNK, sources.appendSource],
    ['finishHostSource', 1, a => object(a[0]), sources.finishSource],
  ]) ipc.handle(`blastcast:${name}`, (event, ...args) => {
    if (!trustedFrame(event, contents()) || args.length !== count || !validate(args)) throw new Error('Invalid host source request');
    if (!authorized()) throw new Error('BlastCast activation is required.');
    // The store owns strict metadata schemas and all filesystem paths.
    return method('host', ...args);
  });
}
module.exports = { registerSourceBridge, STUDIO_URL, trustedFrame, registerBridge, registerRecordingBridge, registerGuestBridge, localOrigin, mediaPermission, createDisplayPermission, createChooseScreen, allowedStudioNavigation };
