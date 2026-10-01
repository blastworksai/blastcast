// CodexBWAI — browser-only guest page; admitted calls use authenticated signaling.
import { DeviceAccess } from './device-access.js';
import { Preview } from './preview.js';
import { SourceTransportError } from './source-outbox.js';
import { SourceSession } from './source-session.js';
import { recoveryFilename, type SourceRecoveryWriter } from './source-recovery.js';
import type { SourceChunk, SourceChunkAck, SourceControl, SourceBeginAck, SourceFinishAck } from './source-protocol.js';
import { ScreenShare, showScreen } from './screen-share.js';
import { GuestCall } from './guest-call.js';
import { CameraBackground, type CameraBackgroundMode } from './camera-background.js';
const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const video = el<HTMLVideoElement>('guest-preview');
const camera = el<HTMLSelectElement>('guest-camera');
const microphone = el<HTMLSelectElement>('guest-microphone');
const backgroundSelect = el<HTMLSelectElement>('guest-background');
const backgroundFile = el<HTMLInputElement>('guest-background-file');
const consent = el<HTMLInputElement>('guest-consent');
const name = el<HTMLInputElement>('guest-name');
const join = el<HTMLButtonElement>('guest-join');
const token = /^#invite=([A-Za-z0-9_-]{43})$/.exec(location.hash)?.[1] ?? '';
history.replaceState(null, '', location.pathname); // Bearer credential never enters an HTTP URL or storage.
let valid = false, pending = false, joining = false, terminal = false, admitted = false, checking = false;
let sessionCredential = '';
let attached: MediaStream | null = null;
let outgoing: MediaStream | null = null;
let context: AudioContext | null = null;
let animation = 0, deviceGeneration = 0;
let deviceAccessBusy = false;
let originals: SourceSession;
let share: ScreenShare | undefined;
const requestId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : '';
const redemptionKey = (() => {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
})();

function status(id: string, message: string, error = false): void { el(id).textContent = message; el(id).classList.toggle('error', error); }
function buttons(): void {
  const inCall = admitted && valid && !terminal;
  document.body.classList.toggle('in-call', inCall);
  el('guest-host-panel').hidden = !inCall;
  if ((!inCall || !attached) && (share?.stream || share?.busy)) share.stop();
  el<HTMLButtonElement>('guest-share-screen').disabled = !inCall || !attached || Boolean(share?.busy || share?.stream);
  el<HTMLButtonElement>('guest-stop-screen').disabled = !share?.stream && !share?.busy;
  el('guest-mode').textContent = inCall ? 'Guest call' : 'Guest preview';
  el('preview-heading').textContent = inCall ? 'Your camera' : 'Check your camera & microphone';
  el('setup-heading').textContent = inCall ? 'Your devices' : 'Before you join';
  el('guest-leave').textContent = inCall ? 'Leave call' : 'Leave invitation';
  camera.disabled = microphone.disabled = !valid || deviceAccessBusy || preview.state.phase === 'requesting' || Boolean(originals?.busy);
  backgroundSelect.disabled = backgroundFile.disabled = !valid || deviceAccessBusy || preview.state.phase === 'requesting' || Boolean(originals?.busy);
  const deviceToggle = el<HTMLButtonElement>('guest-stop');
  deviceToggle.textContent = attached || preview.state.phase === 'requesting' ? 'Turn devices off' : 'Turn devices on';
  deviceToggle.disabled = !attached && preview.state.phase !== 'requesting' && !inCall;
  join.disabled = !valid || pending || joining || admitted || deviceAccessBusy || preview.state.phase === 'requesting' || Boolean(originals?.busy) || !consent.checked || !name.value.trim();
  consent.disabled = name.disabled = pending || joining || admitted;
  el<HTMLButtonElement>('guest-leave').disabled = !valid;
  el<HTMLButtonElement>('guest-save-recovery').disabled = !originals?.canSaveRecovery;
}
function stopMeter(): void {
  cancelAnimationFrame(animation); const old = context; context = null;
  if (old) void old.close().catch(() => {});
  el<HTMLMeterElement>('guest-level').value = 0;
}
function meter(stream: MediaStream): void {
  try {
    const current = new AudioContext(); context = current;
    const analyser = current.createAnalyser(); analyser.fftSize = 256;
    current.createMediaStreamSource(stream).connect(analyser);
    const values = new Uint8Array(analyser.fftSize);
    const tick = () => {
      if (context !== current) return;
      analyser.getByteTimeDomainData(values);
      const rms = Math.sqrt(values.reduce((sum, v) => sum + ((v - 128) / 128) ** 2, 0) / values.length);
      el<HTMLMeterElement>('guest-level').value = preview.microphoneMuted ? 0 : Math.min(100, rms * 300);
      animation = requestAnimationFrame(tick);
    };
    void current.resume().catch(() => status('guest-device-status', 'Your microphone is active, but the meter could not start.'));
    tick();
  } catch { status('guest-device-status', 'The input meter is unavailable in this browser.'); }
}
function publishOutgoing(stream: MediaStream | null): void {
  outgoing = stream; video.srcObject = stream; el('guest-preview-empty').hidden = Boolean(stream);
  call.update(valid && admitted && !terminal, stream);
  originals.update(valid && admitted && !terminal, stream);
  if (stream) void video.play().catch(() => { if (outgoing === stream) preview.stop('Preview could not display. Ask to join again.'); });
}
const background = new CameraBackground(publishOutgoing, (message, error = false) => {
  status('guest-background-status', message, error);
  backgroundSelect.value = background.mode;
});
const preview = new Preview(c => navigator.mediaDevices.getUserMedia(c), (state, stream) => {
  let message = state.message;
  if (admitted && state.phase === 'live') message = 'Devices live. Your camera and microphone are shared while the call is connected; the host may record.';
  if (message.includes('access was denied')) message = 'Camera or microphone access was denied. Allow this site in your browser’s address-bar permissions and system privacy settings, then ask to join again.';
  status('guest-preview-status', message, state.phase === 'error' || state.phase === 'interrupted');
  const mute = el<HTMLButtonElement>('guest-mute');
  mute.textContent = preview.microphoneMuted ? 'Unmute microphone' : 'Mute microphone';
  mute.setAttribute('aria-pressed', String(preview.microphoneMuted));
  if (stream !== attached) {
    stopMeter(); attached = stream; background.setSource(stream);
    if (stream) {
      meter(stream); void devices();
    }
  }
  buttons();
});
const call = new GuestCall(api, el<HTMLVideoElement>('guest-host'), el('guest-call-status'), el<HTMLButtonElement>('guest-play-audio'), stream => {
  el('guest-screen-panel').hidden = !stream;
  showScreen(el<HTMLVideoElement>('guest-screen'), stream);
});
share = new ScreenShare(() => navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }), (stream, message) => {
  status('guest-screen-status', message);
  void call.setScreen(stream).catch(() => {
    if (stream) share?.stop();
    status('guest-screen-status', 'The screen could not be sent. Stop and retry sharing.', true);
  });
  // The picker callback runs before its busy flag settles; refresh on the next task.
  setTimeout(buttons, 0);
});
el('guest-share-screen').addEventListener('click', () => {
  if (valid && admitted && !terminal && attached) void share?.start().finally(buttons);
});
el('guest-stop-screen').addEventListener('click', () => { share?.stop(); buttons(); });
backgroundSelect.addEventListener('change', () => {
  const mode = backgroundSelect.value as CameraBackgroundMode;
  if (mode === 'image' && !background.hasImage) { backgroundFile.click(); backgroundSelect.value = background.mode; return; }
  void background.setMode(mode).catch(error => status('guest-background-status', error instanceof Error ? error.message : 'Background could not change.', true)).finally(buttons);
});
backgroundFile.addEventListener('change', () => {
  const file = backgroundFile.files?.[0];
  if (!file) { backgroundSelect.value = background.mode; return; }
  void background.setImage(file).catch(error => status('guest-background-status', error instanceof Error ? error.message : 'Background image could not load.', true)).finally(() => {
    backgroundSelect.value = background.mode; backgroundFile.value = ''; buttons();
  });
});
originals = new SourceSession(() => api<SourceControl>('source/status'), {
  begin: descriptor => api<SourceBeginAck>('source/begin', descriptor),
  append: uploadOriginal,
  finish: end => api<SourceFinishAck>('source/finish', end, 120000),
}, state => { status('guest-original-status', state.message, state.phase === 'incomplete'); buttons(); },
  message => { status('guest-original-status', message); buttons(); }, true);

async function uploadOriginal(chunk: SourceChunk, bytes: ArrayBuffer): Promise<SourceChunkAck> {
  const response = await hostFetch('/api/source/chunk', { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
    headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${sessionCredential}`, 'X-Blastcast-Source': JSON.stringify(chunk) },
    body: bytes, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new SourceTransportError('The host could not confirm this original chunk.', transientStatus(response.status));
  return await hostJson<SourceChunkAck>(response);
}


function transientStatus(status: number): boolean { return [408,409,429,502,503,504].includes(status); }
async function hostFetch(url: string, options: RequestInit): Promise<Response> {
  try { return await fetch(url, { ...options, priority: url.startsWith('/api/source/') && !url.endsWith('/status') ? 'low' : 'high' }); }
  catch (error) {
    if (error instanceof TypeError || (error instanceof DOMException && ['TimeoutError','AbortError','NetworkError'].includes(error.name))) {
      throw new SourceTransportError('Host connection unavailable.', true);
    }
    throw error;
  }
}
async function hostJson<T>(response: Response): Promise<T> {
  try { return await response.json() as T; }
  catch (error) {
    if (error instanceof TypeError || (error instanceof DOMException && ['TimeoutError','AbortError','NetworkError'].includes(error.name))) {
      throw new SourceTransportError('Host response interrupted.', true);
    }
    throw error;
  }
}
async function devices(): Promise<boolean> {
  const generation = ++deviceGeneration;
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    if (generation !== deviceGeneration) return false;
    for (const [select, kind, label] of [[camera, 'videoinput', 'camera'], [microphone, 'audioinput', 'microphone']] as const) {
      const selected = select.value;
      select.replaceChildren(new Option(`System default ${label}`, ''));
      list.filter(d => d.kind === kind && d.deviceId).forEach((d, i) => select.add(new Option(d.label || `${label} ${i + 1}`, d.deviceId)));
      if ([...select.options].some(o => o.value === selected)) select.value = selected;
      else if (selected) preview.stop('A selected device is unavailable. Select a device and ask to join again.');
    }
    status('guest-device-status', 'Changing a device turns the current devices off. Ask to join again to apply your choice.');
    return true;
  } catch { status('guest-device-status', 'Could not list devices. Check browser permissions and refresh devices.', true); return false; }
}
type Reply = { ok: true; phase: string; expiresAt: number; sessionCredential?: string };
async function api<T = Reply>(endpoint: string, body: object = {}, timeoutMs = 5000): Promise<T> {
  const auth = endpoint === 'redeem' ? token : sessionCredential;
  const response = await hostFetch(`/api/${endpoint}`, { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    if (response.status === 429) {
      throw new SourceTransportError('429', true); // special handling for rate limit
    }
    const error = await response.json().catch(() => ({})) as { message?: string };
    if (response.status === 410) {
      terminal = true; valid = false; preview.stop();
      const reason = error.message ?? 'This invitation is closed.';
      status('invitation-status', `${reason} Your devices are off. Ask the host for a new link.`, true);
    }
    throw new SourceTransportError(error.message ?? 'The host could not accept the request.', transientStatus(response.status));
  }
  return await hostJson<T>(response);
}
async function check(): Promise<void> {
  if (terminal || checking) return;
  checking = true;
  try {
    if (!sessionCredential) {
      const result = await api('redeem', { redemptionKey });
      if (terminal) return;
      sessionCredential = result.sessionCredential!;
    }
    const result = await api('status');
    if (terminal) return;
    valid = true; 
    pending = result.phase === 'pending';
    admitted = result.phase === 'admitted';
    call.update(admitted, outgoing);
    originals.update(admitted && valid && !terminal, outgoing);
    
    let info = 'Invitation ready. Preview stays on this device.';
    if (result.phase === 'pending') info = 'Your request is waiting with the host. You are not admitted or being recorded.';
    else if (result.phase === 'admitted') info = 'You are admitted. With preview on, your camera and microphone connect to the host.';
    else if (result.phase === 'left' || result.phase === 'removed' || result.phase === 'rejected') {
      terminal = true; valid = false; preview.stop();
      info = 'This session is no longer active.';
      status('invitation-status', info, true);
      buttons();
      return;
    }
    status('invitation-status', info);
    if (pending) {
      status('guest-join-status', 'Recording consent sent. Waiting for host admission.');
    } else if (admitted) {
      status('guest-join-status', '');
      if (preview.state.phase === 'live') status('guest-preview-status', 'Devices live. Your camera and microphone are shared while the call is connected; the host may record.');
    }
  } catch (error) {
    if (admitted && !terminal && error instanceof SourceTransportError && error.retryable) {
      status('invitation-status', 'Host connection interrupted. Your devices stay on for your original recording. Keep this page open; the live call may need Reconnect.', true);
      return;
    }
    valid = false; preview.stop();
    if (error instanceof Error && error.message === '429') {
      if (!terminal) status('invitation-status', 'Host is busy. Too many requests. Checking again shortly. Ask to join when the connection recovers.', true);
    } else {
      if (!terminal) status('invitation-status', 'Cannot reach the host. Devices are off; checking again shortly. Ask to join when the connection recovers.', true);
    }
  }
  finally { checking = false; buttons(); }
}
const deviceAccess = new DeviceAccess({ authorize: async () => valid && !terminal,
  acquire: constraints => navigator.mediaDevices.getUserMedia(constraints), refresh: devices,
  canRequest: () => valid && !terminal && !originals.busy && preview.state.phase !== 'requesting',
  live: () => preview.state.phase === 'live',
  busy: value => { deviceAccessBusy = value; buttons(); },
  message: (message, error) => status('guest-device-status', message, error),
});
deviceAccess.bind(camera, 'video'); deviceAccess.bind(microphone, 'audio');
el('guest-stop').addEventListener('click', () => {
  if (attached || preview.state.phase === 'requesting') preview.stop();
  else if (valid && admitted && !terminal) void preview.start({ camera: camera.value, microphone: microphone.value,
    height: 'auto' }, async () => valid);
});
el('guest-mute').addEventListener('click', () => preview.setMicrophoneMuted(!preview.microphoneMuted));
el('guest-refresh').addEventListener('click', () => void devices());
el('guest-save-recovery').addEventListener('click', async () => {
  const picker = (window as unknown as { showSaveFilePicker?: (options: object) => Promise<{ createWritable(): Promise<SourceRecoveryWriter> }> }).showSaveFilePicker;
  if (!picker || !navigator.locks) {
    status('guest-original-status', 'This browser cannot safely stream a recovery file. Keep this page open in a current desktop Chrome or Edge browser.', true);
    return;
  }
  try {
    const episodeId = originals.state?.episodeId ?? '';
    const handle = await picker.call(window,{ suggestedName:recoveryFilename(episodeId),types:[{
      description:'BlastCast guest recovery',accept:{ 'application/octet-stream':['.bcr'] } }] });
    const writer = await handle.createWritable();
    const saved = await originals.saveRecovery(writer);
    status('guest-original-status', `Recovery file saved with ${saved.chunks} retained piece${saved.chunks===1?'':'s'}. Keep the file until the host confirms import.`);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    status('guest-original-status', 'The recovery file was not completed. Retained data stays in this page; choose Save recovery file again before closing it.', true);
  } finally { buttons(); }
});
for (const select of [camera, microphone]) select.addEventListener('change', () => preview.stop('Settings changed. Ask to join to check your selection.'));
consent.addEventListener('change', buttons); name.addEventListener('input', buttons);
join.addEventListener('click', async () => {
  if (join.disabled) return;
  joining = true; buttons();
  try {
    if (preview.state.phase !== 'live') {
      await preview.start({ camera: camera.value, microphone: microphone.value, height: 'auto' }, async () => valid);
      if (String(preview.state.phase) !== 'live') {
        status('guest-join-status', 'Camera and microphone must be available before asking to join.', true);
        return;
      }
    }
    await api('join', { name: name.value.trim(), consent: consent.checked, consentVersion: '1' });
    if (!terminal) { pending = true; status('guest-join-status', 'Recording consent sent. Waiting for host admission; you are not being recorded.'); }
  } catch (error) { 
    if (error instanceof Error && error.message === '429') status('guest-join-status', 'Host is busy. Try again shortly.', true);
    else status('guest-join-status', error instanceof Error ? error.message : 'Request failed. Try again.', true); 
  }
  finally { joining = false; buttons(); }
});
el('guest-leave').addEventListener('click', () => {
  terminal = true; valid = false; deviceAccess.cancel(); preview.stop(); buttons();
  status('invitation-status', 'You left this invitation. Your devices are off.');
  void api('leave').catch(() => status('guest-join-status', 'Devices are off. The host could not confirm withdrawal; ask them to close your invitation.', true));
});
window.addEventListener('beforeunload', event => { if (originals.busy || originals.canSaveRecovery) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { share?.stop(); deviceAccess.cancel(); terminal = true; valid = false; preview.stop(); background.close(); call.close(); originals.close(); });
if (!isSecureContext || location.protocol !== 'https:') {
  terminal = true; status('invitation-status', 'A secure HTTPS invitation is required. Ask the host for their secure link; do not bypass certificate warnings.', true);
} else if (!navigator.mediaDevices?.getUserMedia || !requestId) {
  terminal = true; status('invitation-status', 'This browser cannot preview devices. Open the invitation in a current desktop Chrome or Edge browser and allow camera and microphone access.', true);
} else if (!token) {
  terminal = true; status('invitation-status', 'The invitation is missing. Open the full private link from the host again.', true);
} else {
  void check(); setInterval(() => { if (!joining) void check(); }, 2000);
  navigator.mediaDevices.addEventListener('devicechange', () => void devices());
}
