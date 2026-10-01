const STUDIO_URL = 'app://studio/index.html';
const { MAX_CHUNK } = require('./recording.cjs');
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
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  for (const [name, count, validate, method] of [
    ['appendRecording', 3, a => uuid(a[0]) && Number.isSafeInteger(a[1]) && a[1] >= 0 && a[2] instanceof ArrayBuffer && a[2].byteLength > 0 && a[2].byteLength <= MAX_CHUNK, recording.append],
    ['finishRecording', 1, a => uuid(a[0]), recording.finish],
    ['abortRecording', 1, a => uuid(a[0]), recording.abort],
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

  const admissionMethods = [
    ['guestAdmit', guests.admit, idRegex],
    ['guestReject', guests.reject, idRegex],
    ['guestRemove', guests.remove, idRegex],
    ['revokeGuestInvite', guests.revokeInvite, idRegex]
  ];

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
module.exports = { registerSourceBridge, STUDIO_URL, trustedFrame, registerBridge, registerRecordingBridge, registerGuestBridge, localOrigin, mediaPermission, allowedStudioNavigation };
