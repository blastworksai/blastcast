// ClaudeBWAI — macOS camera/microphone decision logic, pure so it can be tested. macOS remembers a denial and never
// prompts again, so BlastCast must not show its own dialog (then fail silently) once both devices are blocked.
const KINDS = ['camera', 'microphone'];
const STATES = new Set(['not-determined', 'granted', 'denied', 'restricted']);
const blocked = state => state === 'denied' || state === 'restricted';
function normalize(value) { return STATES.has(value) ? value : 'unknown'; }
function statusOf({ platform, getStatus }) {
  if (platform !== 'darwin') return { camera: 'granted', microphone: 'granted' };
  const out = {};
  for (const kind of KINDS) { try { out[kind] = normalize(getStatus(kind)); } catch { out[kind] = 'unknown'; } }
  return out;
}
// Returns true when at least one device may be used. `mediaAllowed` is BlastCast's own earlier consent.
async function decideMediaAccess({ platform, mediaAllowed, getStatus, ask, showDialog }) {
  const status = statusOf({ platform, getStatus });
  if (platform === 'darwin' && KINDS.every(kind => blocked(status[kind]))) return { allowed: false, blocked: true };
  if (!mediaAllowed && !await showDialog()) return { allowed: false, blocked: false };
  if (platform === 'darwin') {
    let any = false;
    for (const kind of KINDS) {
      if (status[kind] === 'granted') any = true;
      else if (!blocked(status[kind]) && await ask(kind)) any = true;
    }
    if (!any) return { allowed: false, blocked: false };
  }
  return { allowed: true, blocked: false };
}
function privacyUrl(kind) {
  if (kind === 'camera') return 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera';
  if (kind === 'microphone') return 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
  if (kind === 'screen') return 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
  return null;
}
// ClaudeBWAI — macOS Screen Recording permission. Without it getDisplayMedia yields a blank or empty capture, silently.
const SCREEN_BLOCKED_MESSAGE = 'macOS is blocking screen sharing. Turn on BlastCast in System Settings → Privacy & Security → Screen Recording, then restart BlastCast.';
// Platform and status reader are injected so this is testable; only darwin ever asks. Returns the notice, or null.
function screenBlockedMessage({ platform, getStatus }) {
  if (platform !== 'darwin') return null;
  let state; try { state = getStatus('screen'); } catch { state = 'unknown'; }
  return state === 'granted' ? null : SCREEN_BLOCKED_MESSAGE;
}
module.exports = { SCREEN_BLOCKED_MESSAGE, screenBlockedMessage, decideMediaAccess, statusOf, privacyUrl, normalize };
