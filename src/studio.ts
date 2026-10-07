import './desktop-capture-guard.js';
import { ScreenShare, ScreenBlockedError } from './screen-share.js';
import { initStudioShell } from './studio-shell.js';
import { mountRecordingLibrary } from './recording-library.js';
import { SourceSession } from './source-session.js';
import type { SourceStatus } from './source-protocol.js';
import { Recording, RECORDING_MIME_TYPE } from './recording.js';
import { DrawMeter, SessionDiagnosticsLog, recorderInfo, logCompositorEvent, type SceneBackend, type CompositorReason } from './session-diagnostics.js';
import { originalsWaitMessage, recordingRows } from './recording-status.js';
import './invites.js';
import type { FolderResult, LicenseStatus } from './bridge.js';
import { DeviceAccess } from './device-access.js';
import { Preview, deviceNoticeText, reconnectLabel, type DeviceKind, type PreviewState } from './preview.js';
import { denialMessage } from './media-denial.js';
import { CameraBackground, type CameraBackgroundMode } from './camera-background.js';
import { mountSceneControls } from './scene-controls.js';
import { CANVAS_H, CANVAS_W, DEFAULT_SCENES, type DrawableSource, type FrameCompositor, createGlCompositor, watchGlContext } from './scenes.js';
import { HostCalls } from './host-calls.js';
import { GuestScreenAttention } from './screen-share-attention.js';
import { composeProgramOutput } from './program-output.js';
import { createFrameGate, createThrottle } from './peer-call.js';

let backdropOverrides: Record<string,string> = {};
const assetCache = new Map<string, Promise<CanvasImageSource>>();
function resolveAsset(filename: string): Promise<CanvasImageSource> {
  let promise = assetCache.get(filename);
  if (promise) return promise;
  promise = new Promise((resolve, reject) => {
    const img = new Image();
    const fail = () => { clearTimeout(timer); assetCache.delete(filename); reject(new Error('The scene background could not load. Select the scene to retry.')); };
    const timer = setTimeout(fail, 5000);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = fail;
    img.src = backdropOverrides[filename.replace(/\.png$/, '')] ?? filename;
  });
  assetCache.set(filename, promise);
  return promise;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found as T;
}
const studioShell = initStudioShell();
// Absent from the Mac App Store bundle (built with --mas); every use below tolerates that.
const maybe = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const activationLock = maybe('activation-lock');
const studio = element('studio');
const settingsDialog = element<HTMLDialogElement>('studio-settings');
const activationEntry = maybe('activation-entry');
const activationCurrent = maybe('activation-current');
const activationKey = maybe<HTMLTextAreaElement>('activation-key');
const activateLicense = maybe<HTMLButtonElement>('activate-license');
const deactivateLicense = maybe<HTMLButtonElement>('deactivate-license');
const licensedSettings = [...settingsDialog.querySelectorAll<HTMLElement>('.setup-card:not(#activation-card):not(#software-card), .readiness')];
function showLicense(value: LicenseStatus): void {
  const active = value.active;
  studio.inert = !active;
  if (activationLock) activationLock.hidden = active;
  licensedSettings.forEach(section => { section.inert = !active; });
  if (value.active && value.license.kind === 'app-store') {
    // Mac App Store: the store is the licence. No key section, purchase text or GitHub releases link.
    for (const id of ['activation-lock', 'activation-card', 'check-updates', 'update-status']) document.getElementById(id)?.remove();
    return;
  }
  if (activationEntry) activationEntry.hidden = active;
  if (activationCurrent) activationCurrent.hidden = !active;
  if (value.active && value.license.kind !== 'app-store') {
    const holder = maybe('activation-holder'), kind = maybe('activation-kind');
    if (holder) holder.textContent = value.license.holder;
    if (kind) kind.textContent = `${value.license.kind} key`;
  }
  if (!maybe('activation-status')) return;
  status('activation-status', value.message ?? (active ? 'BlastCast is activated on this computer.' : 'Enter an activation key to unlock the studio.'), Boolean(value.message));
  if (!active && !settingsDialog.open) settingsDialog.showModal();
}
async function refreshLicense(): Promise<void> {
  try { showLicense(await window.blastcast.licenseStatus()); }
  catch { showLicense({ active:false, message:'Activation status could not be checked. Restart BlastCast and try again.' }); }
}
maybe('open-activation')?.addEventListener('click', () => { if (!settingsDialog.open) settingsDialog.showModal(); activationKey?.focus(); });
activateLicense?.addEventListener('click', async () => {
  if (activateLicense) activateLicense.disabled = true; status('activation-status', 'Checking activation key…');
  try {
    const result = await window.blastcast.activateLicense(activationKey?.value ?? '');
    if (result.active) { if (activationKey) activationKey.value = ''; status('activation-status', 'Activated. Restarting the studio…'); location.reload(); return; }
    showLicense(result);
  } catch { status('activation-status', 'Activation could not be completed. Try again.', true); }
  finally { if (activateLicense) activateLicense.disabled = false; }
});
deactivateLicense?.addEventListener('click', async () => {
  if (deactivateLicense) deactivateLicense.disabled = true; status('activation-status', 'Deactivating…');
  try {
    const result = await window.blastcast.deactivateLicense();
    if (!result.active) { location.reload(); return; }
    showLicense(result);
  } catch { status('activation-status', 'BlastCast could not be deactivated. Try again.', true); }
  finally { if (deactivateLicense) deactivateLicense.disabled = false; }
});
void refreshLicense();
const libraryContainer = document.createElement('section'); libraryContainer.id = 'recording-library'; element('recordings-pane').append(libraryContainer);
const library = mountRecordingLibrary(libraryContainer, window.blastcast);
const toggleCamera = element<HTMLButtonElement>('toggle-camera');
let cameraEnabled = false, microphoneEnabled = false;
const camera = element<HTMLSelectElement>('camera');
const microphone = element<HTMLSelectElement>('microphone');
const mute = element<HTMLButtonElement>('mute-microphone');
const quality = element<HTMLSelectElement>('quality');
const video = element<HTMLVideoElement>('preview');
const start = element<HTMLButtonElement>('start-preview');
const stop = element<HTMLButtonElement>('stop-preview');
const refresh = element<HTMLButtonElement>('refresh-devices');
const choose = element<HTMLButtonElement>('choose-folder');
const settingsChoose = element<HTMLButtonElement>('settings-choose-folder');
const check = element<HTMLButtonElement>('check-folder');
const open = element<HTMLButtonElement>('open-folder');
const record = element<HTMLButtonElement>('record');
const stopRecording = element<HTMLButtonElement>('stop-recording');
const openRecording = element<HTMLButtonElement>('open-recording');
let hasCompleted = false;
let sceneReady = false;
let sceneError = '';
let sceneSelection = 0;
let sourcesStale = true; // ClaudeBWAI — set when the scene's source list must be rebuilt before the next frame
let preparingRecording = false;
let deviceSwaps = 0; // ClaudeBWAI — one-device switches in progress (applyDevice); Record waits for them
let originalsOpen = false;
let latestSources: SourceStatus | null = null;
let importingRecovery = false;
const recording = new Recording(window.blastcast, state => {
  studioShell.updateRecording(state.phase);
  status('recording-status', state.message, state.phase === 'error');
  element('capture-note').textContent = state.phase === 'recording' ? '● Recording' : state.phase === 'finalizing' ? 'Finalizing…' : 'Not recording';
  if (state.phase === 'complete') {
    hasCompleted = true;
    void library.refresh();
  }
  if (state.phase === 'starting') hasCompleted = false;
  // ClaudeBWAI — the session diagnostics log follows the recording: samples while recording, the end line once the outcome is known.
  if (state.phase === 'recording' && state.episodeId) { sessionLog.start(state.episodeId, canvas.height === 2160 ? 2160 : 1080); if (startupNote) logCompositorEvent(sessionLog, startupNote, activeBackend); }
  else if (state.phase === 'finalizing') sessionLog.pause();
  else if (state.phase === 'complete' || state.phase === 'error') { void sessionLog.stop(state.phase); selectBackend(); }
  showOriginals(latestSources);
});
let folderReady = false;
let folderSelected = false;
let folderBusy = false;
let deviceGeneration = 0;
let deviceAccessBusy = false;
let attached: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let animation = 0;

function status(id: string, message: string, error = false): void {
  const target = element(id);
  target.textContent = message;
  target.classList.toggle('error', error);
}

function readiness(): void {
  const busy = recording.busy || preparingRecording || originals.busy;
  const ready = preview.state.phase === 'live' && folderReady;
  showPreviewStatus(busy);
  element('ready-dot').classList.toggle('ready', ready);
  element('ready-title').textContent = busy ? 'Recording session active.' : ready ? 'Your local checks are complete.' : 'Let’s get your studio ready.';
  element('ready-detail').textContent = busy ? 'Stop recording and wait for it to finish before changing devices or folders.' : ready
    ? `Enabled sources are ready. Your folder is writable. Nothing is being recorded.`
    : 'Enable a camera or microphone and choose a writable folder.';
  // CodexBWAI — explain the same conditions that disable Record; never a stale generic hint.
  const recordReason = recording.state.phase === 'recording' ? 'A recording is already in progress.'
    : recording.state.phase === 'finalizing' ? 'Wait for the current recording to finish saving.'
    : preparingRecording || recording.state.phase === 'starting' ? 'Preparing the recording. Please wait.'
    : deviceSwaps > 0 ? 'Switching devices. Please wait.'
    : originals.busy ? 'Wait for the current participant original to finish recording or saving.'
    : originalsOpen ? 'Finish collecting the previous recording’s originals in the Recordings tab.'
    : folderBusy ? 'Checking the recording folder. Please wait.'
    : !folderReady ? (folderSelected ? 'The recording folder is not writable. Check it in Settings or choose another folder.' : 'Choose a recording folder before recording.')
    : preview.state.phase === 'requesting' || deviceAccessBusy ? 'Finish granting device access before recording.'
    : preview.state.phase !== 'live' ? (preview.state.phase === 'error' || preview.state.phase === 'interrupted'
      ? `Your enabled source is not ready. ${preview.state.message}` : 'Enable a camera or microphone before recording.')
    : sceneError ? `The selected scene is not ready. ${sceneError}`
    : !sceneReady ? 'Wait for the selected scene to finish loading.' : '';
  record.disabled = busy || originalsOpen || preparingRecording || !ready || folderBusy || !sceneReady || Boolean(sceneError) || deviceSwaps > 0;
  const recordTrigger = element('record-trigger');
  const disabledReason = record.disabled ? recordReason : '';
  element('record-disabled-reason').textContent = disabledReason;
  recordTrigger.tabIndex = record.disabled ? 0 : -1;
  if (disabledReason) {
    recordTrigger.title = disabledReason;
    recordTrigger.setAttribute('aria-describedby', 'record-disabled-reason');
  } else {
    recordTrigger.removeAttribute('title');
    recordTrigger.removeAttribute('aria-describedby');
  }
  stopRecording.disabled = recording.state.phase !== 'recording';
  stopRecording.hidden = recording.state.phase !== 'recording';
  record.hidden = recording.state.phase === 'recording';
  recordTrigger.hidden = record.hidden;
  openRecording.disabled = recording.busy || !hasCompleted;
  toggleCamera.disabled = busy || deviceAccessBusy || preview.state.phase === 'requesting';
  mute.disabled = deviceAccessBusy || preview.state.phase === 'requesting' || (busy && !attached?.getAudioTracks().length);
  start.disabled = busy || deviceAccessBusy || preview.state.phase === 'requesting';
  stop.disabled = busy || preview.state.phase === 'idle' || preview.state.phase === 'error';
  camera.disabled = microphone.disabled = quality.disabled = busy || deviceAccessBusy || preview.state.phase === 'requesting';
  for(const selector of [camera,microphone,quality]) selector.title=busy?'Finish recording before replacing devices or capture quality.':'';
  if(busy && attached?.getAudioTracks().length) {mute.title=preview.microphoneMuted?'Unmute microphone':'Mute microphone';mute.setAttribute('aria-label',mute.title);}
  choose.disabled = busy || originalsOpen || folderBusy;
  settingsChoose.disabled = choose.disabled;
  check.disabled = busy || originalsOpen || folderBusy || !folderSelected;
  open.disabled = folderBusy || !folderReady;
  backgroundLock();
}

function clearMeter(): void {
  cancelAnimationFrame(animation);
  if (audioContext) void audioContext.close().catch(() => status('device-status', 'The audio meter could not close cleanly. Restart BlastCast before continuing.', true));
  audioContext = null;
  element<HTMLMeterElement>('mic-level').value = 0;
  element('mic-label').textContent = preview.microphoneMuted ? 'Muted' : 'Mic off';
}

function meter(stream: MediaStream): void {
  try {
    const context = new AudioContext();
    audioContext = context;
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    context.createMediaStreamSource(stream).connect(analyser); // Never monitor into speakers.
    const values = new Uint8Array(analyser.fftSize);
    const tick = () => {
      if (audioContext !== context) return;
      analyser.getByteTimeDomainData(values);
      const rms = Math.sqrt(values.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / values.length);
      element<HTMLMeterElement>('mic-level').value = preview.microphoneMuted ? 0 : Math.min(100, rms * 300);
      element('mic-label').textContent = preview.microphoneMuted ? 'Muted' : context.state === 'running' ? 'Input level' : 'Meter paused';
      animation = requestAnimationFrame(tick);
    };
    void context.resume().catch(() => status('device-status', 'Microphone preview is active, but the level meter could not start.', true));
    tick();
  } catch { status('device-status', 'Microphone preview is active, but the level meter is unavailable.', true); }
}

function renderPreview(state: PreviewState, stream: MediaStream | null): void {
  const micOff = !microphoneEnabled || preview.microphoneMuted;
  mute.setAttribute('aria-pressed', String(micOff));
  mute.setAttribute('aria-label', 'Mute microphone'); // ClaudeBWAI — static names; aria-pressed="true" means muted/off
  toggleCamera.setAttribute('aria-pressed', String(!cameraEnabled));
  toggleCamera.setAttribute('aria-label', 'Turn off camera');
  mute.title = micOff ? 'Microphone is off. Press to turn it on.' : 'Mute microphone';
  toggleCamera.title = cameraEnabled ? 'Turn off camera' : 'Camera is off. Press to turn it on.';
  mute.classList.add('bc-toggle'); toggleCamera.classList.add('bc-toggle');
  mute.innerHTML = '<svg class="bc-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="8" rx="2.5"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2"/></svg>';
  toggleCamera.innerHTML = '<svg class="bc-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="4" width="9" height="8" rx="1.5"/><path d="M10.5 7l4-2.5v7l-4-2.5z"/></svg>';
  // ClaudeBWAI — a camera-only stream has no input level: say Mic off (it said "Input level" with the mic off).
  element('mic-label').textContent = preview.microphoneMuted ? 'Muted' : stream?.getAudioTracks().length ? 'Input level' : 'Mic off';
  const active = state.phase === 'live' || state.phase === 'interrupted';
  start.disabled = state.phase === 'requesting';
  start.firstChild!.textContent = active ? 'Restart preview ' : state.phase === 'error' ? 'Try preview again ' : 'Start preview ';
  stop.disabled = state.phase === 'idle' || state.phase === 'error';
  stop.textContent = state.phase === 'requesting' ? 'Cancel preview' : 'Stop preview';
  camera.disabled = microphone.disabled = quality.disabled = state.phase === 'requesting';
  // ClaudeBWAI — a muted track ('interrupted') no longer ends the recording: the device notice names it and Reconnect restarts it live.
  if (recording.busy && (state.phase === 'error' || state.phase === 'idle')) void recording.fail('A capture device was interrupted. Recording is incomplete; partial files are retained.');
  if (state.phase === 'live') hidePrivacyButton();
  else if (state.denied) void showDenial((text, error) => status('preview-status', text, error));
  showPreviewStatus(recording.busy);
  renderDeviceNotices(state);
  const badge = element('preview-badge');
  badge.textContent = state.phase === 'live' ? '● Preview live' : state.phase === 'requesting' ? 'Awaiting access' : state.phase === 'interrupted' ? 'Device interrupted' : 'Devices off';
  badge.classList.toggle('live', state.phase === 'live');
  if (attached && stream && attached !== stream && (sameTracks(attached, stream, 'video') || sameTracks(attached, stream, 'audio'))) {
    swapDevice(attached, stream);
  } else if (attached !== stream) {
    clearMeter();
    attached = stream; sourcesStale = true;
    calls.setStream(stream ? getCallStream(stream) : null);
    if (!stream && !recording.busy) stopSceneStream();
    background.setSource(stream); // ClaudeBWAI — the processed camera feeds the preview, the scene and the host original
    element('preview-empty').hidden = Boolean(stream);
    video.toggleAttribute('data-live', Boolean(stream));
    showBackendCanvas(); // ClaudeBWAI — einh 4 Oct (CP4c): the preview shows the active backend's canvas, never both
    if (stream) {
      const settings = stream.getVideoTracks()[0]?.getSettings() ?? {};
      element('resolution-label').textContent = `${settings.width ?? '?'} × ${settings.height ?? '?'}`;
      if (stream.getVideoTracks().length) void video.play().catch(() => { if (attached === stream) preview.stop('Preview could not be displayed. Try again.'); });
      if (stream.getAudioTracks().length) meter(stream);
      void refreshDevices();
    } else element('resolution-label').textContent = 'Camera off';
  }
  readiness();
}

// ClaudeBWAI — einh 3 Oct (item 6): toggling or reconnecting ONE device replaces only that track. The other track keeps
// feeding the preview, the scene, the mix and the calls; nothing is renegotiated and no frame is blanked.
const trackIds = (stream: MediaStream, kind: 'audio' | 'video') => (kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks()).map(track => track.id).join(',');
function sameTracks(a: MediaStream, b: MediaStream, kind: 'audio' | 'video'): boolean { return trackIds(a, kind) === trackIds(b, kind); }
function swapDevice(previous: MediaStream, next: MediaStream): void {
  const videoChanged = !sameTracks(previous, next, 'video'), audioChanged = !sameTracks(previous, next, 'audio');
  attached = next; sourcesStale = true;
  if (audioChanged) {
    clearMeter();
    if (next.getAudioTracks().length) meter(next);
    void calls.replaceHostAudio(next).catch(() => status('device-status', 'The microphone could not reach every guest. Ask them to Reconnect.', true));
  }
  if (videoChanged) {
    if (previous.getVideoTracks().length && next.getVideoTracks().length) background.swapCamera(next); else background.setSource(next);
    const settings = next.getVideoTracks()[0]?.getSettings() ?? {};
    element('resolution-label').textContent = next.getVideoTracks().length ? `${settings.width ?? '?'} × ${settings.height ?? '?'}` : 'Camera off';
  } else background.replaceAudio(next);
  void refreshDevices();
}
// The host original records the stream it started with; a device swapped during a take reaches it at the next take,
// and the tracks it replaced stay open until that original has finished (stopping one would end it).
let deferredOriginal: { stream: MediaStream | null } | null = null;
function feedOriginal(stream: MediaStream | null): void {
  if (originals?.busy && stream) { deferredOriginal = { stream }; return; }
  deferredOriginal = null; originals?.update(true, stream);
}
function settleDeviceSwaps(): void {
  if (originals?.busy) return;
  if (deferredOriginal) { const { stream } = deferredOriginal; deferredOriginal = null; originals.update(true, stream); }
  preview.releaseRetained(); // the original that still held replaced tracks has finished
}
function showPreviewStatus(busy: boolean): void {
  const state = preview.state;
  // Named device notices have their own line (with Reconnect); the status line then carries only real errors.
  const message = state.notices?.length ? Object.values(state.errors ?? {}).join(' ')
    : busy && state.phase === 'live' ? 'Camera and microphone feed the recording.' : state.message;
  status('preview-status', message, Boolean(message) && (state.phase === 'error' || state.phase === 'interrupted'));
}
const deviceNotices = element('device-notices');
const reconnecting = new Set<DeviceKind>();
function renderDeviceNotices(state: PreviewState): void {
  const notices = state.notices ?? [];
  const signature = JSON.stringify([notices, [...reconnecting]]);
  if (deviceNotices.dataset['signature'] === signature) return;
  deviceNotices.dataset['signature'] = signature;
  deviceNotices.replaceChildren(...notices.map(notice => {
    const line = document.createElement('p'); line.className = 'device-notice status error'; line.dataset['kind'] = notice.kind;
    const text = document.createElement('span'); text.textContent = deviceNoticeText(notice);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary';
    button.textContent = reconnectLabel(notice.kind); button.disabled = reconnecting.has(notice.kind);
    button.addEventListener('click', () => void reconnectDevice(notice.kind));
    line.append(text, button);
    return line;
  }));
  deviceNotices.hidden = !notices.length;
}
async function reconnectDevice(kind: DeviceKind): Promise<void> {
  if (reconnecting.has(kind)) return;
  reconnecting.add(kind); renderDeviceNotices(preview.state);
  try { await applyDevice(kind, true); }
  finally { reconnecting.delete(kind); renderDeviceNotices(preview.state); }
}

// ClaudeBWAI — a denied macOS permission becomes a visible error plus an Open System Settings button.
const privacyButton = element<HTMLButtonElement>('open-privacy-settings');
let privacyKind: 'camera' | 'microphone' | 'screen' | null = null;
function hidePrivacyButton(): void { privacyKind = null; privacyButton.hidden = true; }
async function showDenial(show: (text: string, error: boolean) => void): Promise<void> {
  let denial = denialMessage({ camera: 'unknown', microphone: 'unknown' });
  try { if (typeof window.blastcast.getMediaAccessStatus === 'function') denial = denialMessage(await window.blastcast.getMediaAccessStatus()); } catch { /* generic text stays */ }
  if (preview.state.phase === 'live') return;
  show(denial.text, true);
  privacyKind = denial.settings; privacyButton.hidden = !denial.settings;
}
privacyButton.addEventListener('click', async () => {
  if (!privacyKind || typeof window.blastcast.openPrivacySettings !== 'function') return;
  try { const result = await window.blastcast.openPrivacySettings(privacyKind); if (!result.ok) status('preview-status', result.message ?? 'System Settings could not open. Open it from the Apple menu.', true); }
  catch { status('preview-status', 'System Settings could not open. Open it from the Apple menu.', true); }
});

// ClaudeBWAI — host camera background (Off / Blur / Image), the guest page's processor reused.
const backgroundSelect = element<HTMLSelectElement>('camera-background');
const backgroundFile = element<HTMLInputElement>('camera-background-file');
const backgroundChange = element<HTMLButtonElement>('camera-background-change');
const background = new CameraBackground(stream => {
  feedOriginal(stream);
  // ClaudeBWAI — the preview element is reloaded only when its camera track changes: a reload blanks the scene's camera.
  const shown = video.srcObject instanceof MediaStream ? video.srcObject.getVideoTracks()[0] ?? null : null;
  if (!stream || stream.getVideoTracks()[0] !== shown || !video.srcObject) {
    video.srcObject = stream;
    if (stream?.getVideoTracks().length) void video.play().catch(() => {});
  }
}, (message, error = false) => {
  status('camera-background-status', message, error);
  element('camera-background-status').classList.toggle('sr-only', !error);
  backgroundSelect.value = background.mode;
  backgroundChange.hidden = background.mode !== 'image';
});
function backgroundLock(): void {
  const locked = recording.busy || preparingRecording || originals.busy;
  const noVideo = !attached?.getVideoTracks().length;
  backgroundSelect.disabled = backgroundFile.disabled = backgroundChange.disabled = locked || noVideo || deviceAccessBusy || preview.state.phase === 'requesting';
  backgroundChange.hidden = background.mode !== 'image';
  backgroundSelect.title = locked ? 'Background can’t change while recording.' : noVideo ? 'Turn on your camera to use a background.' : '';
}
// ClaudeBWAI — the main process stores the chosen image; the data URL becomes a File without fetch (CSP forbids data: fetches).
function dataUrlToFile(dataUrl: string): File {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('The saved background image is not readable. Choose it again.');
  const raw = atob(match[2] ?? ''); const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new File([bytes], 'background', { type: match[1] ?? '' });
}
function syncBackgroundControls(): void { backgroundSelect.value = background.mode; backgroundChange.hidden = background.mode !== 'image'; }
const backgroundFailure = (error: unknown, fallback: string) => status('camera-background-status', error instanceof Error ? error.message : fallback, true);
async function changeBackground(action: () => Promise<void>, fallback: string): Promise<void> {
  const before = background.mode;
  try { await action(); } catch (error) { backgroundFailure(error, fallback); }
  syncBackgroundControls(); backgroundLock();
  if (background.mode !== before) void saveDevices();
}
// Returns true when handled (picked or cancelled); false means fall back to the file input.
async function chooseStoredBackground(): Promise<boolean> {
  if (typeof window.blastcast.chooseBackgroundImage !== 'function') return false;
  let picked: Awaited<ReturnType<Window['blastcast']['chooseBackgroundImage']>>;
  try { picked = await window.blastcast.chooseBackgroundImage(); } catch { return false; }
  if (!picked.ok) return Boolean(picked.cancelled);
  const dataUrl = picked.dataUrl;
  await changeBackground(async () => { await background.setImage(dataUrlToFile(dataUrl)); void saveDevices(); }, 'Background image could not open.');
  return true;
}
async function pickBackgroundImage(): Promise<void> {
  if (!await chooseStoredBackground()) backgroundFile.click();
  else { syncBackgroundControls(); backgroundLock(); }
}
backgroundChange.addEventListener('click', () => void pickBackgroundImage());
backgroundSelect.addEventListener('change', () => {
  const mode = backgroundSelect.value as CameraBackgroundMode;
  if (mode === 'image' && !background.hasImage) { backgroundSelect.value = background.mode; void pickBackgroundImage(); return; }
  void changeBackground(() => background.setMode(mode), 'Background could not change.');
});
backgroundFile.addEventListener('change', () => {
  const file = backgroundFile.files?.[0];
  if (!file) { syncBackgroundControls(); return; }
  void changeBackground(() => background.setImage(file), 'Background image could not open.').finally(() => { backgroundFile.value = ''; });
});
async function restoreBackground(mode: 'off' | 'blur' | 'image'): Promise<void> {
  try {
    if (mode === 'blur') await background.setMode('blur');
    else if (mode === 'image') {
      const stored = typeof window.blastcast.loadBackgroundImage === 'function' ? await window.blastcast.loadBackgroundImage() : null;
      if (!stored?.ok || !stored.dataUrl) { status('camera-background-status', 'Your saved background image is missing. Choose it again.', true); void saveDevices(); }
      else await background.setImage(dataUrlToFile(stored.dataUrl));
    }
  } catch (error) { backgroundFailure(error, 'Your saved background could not be restored. Choose it again.'); }
  syncBackgroundControls(); backgroundLock();
}
const preview = new Preview(value => navigator.mediaDevices.getUserMedia(value), renderPreview, { deviceNotices: true });
const calls = new HostCalls(window.blastcast, element('call-guests'), element('call-audio-status'), element<HTMLButtonElement>('enable-call-audio'));
// ClaudeBWAI — local session diagnostics beside the recording (scene draw cost, guest video stats); no visible UI.
const drawMeter = new DrawMeter();
const sessionLog = new SessionDiagnosticsLog(window.blastcast, drawMeter, () => calls.diagnosticsSources(), recorderInfo(RECORDING_MIME_TYPE));
calls.onCallEvent = (slot, state, reason) => sessionLog.event(slot, state, reason);
const shareVideo = document.createElement('video'); shareVideo.muted=true; shareVideo.playsInline=true;
const shareSelect = element<HTMLSelectElement>('screen-source');
const guestScreenAttention = new GuestScreenAttention();
function showGuestScreenAttention(active: boolean): void {
  shareSelect.classList.toggle('screen-share-attention', active);
  shareSelect.setAttribute('aria-describedby', active ? 'screen-share-prompt' : 'screen-status');
  element('screen-share-prompt').hidden = !active;
}
shareSelect.addEventListener('change', () => { sourcesStale = true; guestScreenAttention.acknowledge(); showGuestScreenAttention(false); });
// ClaudeBWAI — the picker comes first (main arms one grant on a pick); a cancel rejects quietly, as the picker cancel did.
const share = new ScreenShare(async () => {
  hidePrivacyButton();
  const chosen = await window.blastcast.chooseScreen();
  // ClaudeBWAI — 3.6a: still blocked after macOS had its chance to ask: our message, plus the existing button pointed at Screen Recording.
  if (chosen?.blocked === true && typeof chosen.message === 'string') { privacyKind = 'screen'; privacyButton.hidden = false; throw new ScreenBlockedError(chosen.message); }
  if (!chosen?.ok) throw new DOMException('Screen sharing was cancelled.', 'NotAllowedError');
  return navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:15,max:30}},audio:false});
}, (stream,message) => {
  shareVideo.srcObject = stream;
  if(stream) { void shareVideo.play().catch(()=>status('screen-status','Screen preview could not start.',true)); shareSelect.value='host'; }
  else shareVideo.pause();
  void calls.setScreen(stream).catch(()=>status('screen-status','The screen could not reach every guest. Stop sharing and try again.',true));
  element('share-screen').textContent = stream ? 'Stop sharing' : 'Share screen';
  status('screen-status',message);
});
element('share-screen').addEventListener('click',()=>{if(share.stream||share.busy)share.stop();else void share.start();});
function screenSource(): DrawableSource[] {
  const guestScreens = calls.screenSources();
  showGuestScreenAttention(guestScreenAttention.update(guestScreens.map(source => source.id)));
  const choices = [{id:'none',name:'No screen'},...(share.stream?[{id:'host',name:'Your screen'}]:[]),...guestScreens];
  const signature = choices.map(v=>v.id+':'+v.name).join('|');
  if(shareSelect.dataset.choices!==signature) {
    const selected=shareSelect.value; shareSelect.replaceChildren(...choices.map(v=>new Option(v.name,v.id)));
    shareSelect.value=choices.some(v=>v.id===selected)?selected:'none'; shareSelect.dataset.choices=signature;
    if(share.stream && selected==='') shareSelect.value='host';
  }
  const selected=shareSelect.value==='host'?shareVideo:guestScreens.find(v=>v.id===shareSelect.value)?.video;
  if(!selected) return [];
  return [{kind:'screenshare',index:0,state:selected.videoWidth>0?'live':'empty',drawable:selected,naturalWidth:selected.videoWidth,naturalHeight:selected.videoHeight}];
}


function showOriginals(value: SourceStatus | null): void {
  latestSources = value;
  originalsOpen = Boolean(value && (value.closing || (value.phase !== 'closed' && !value.allSourcesComplete)));
  const rows = element('recording-rows');
  // ClaudeBWAI — SourceSession polls every 500 ms; rebuild the table only when its data changed.
  const items = recordingRows(recording.state, value);
  const rowsSignature = JSON.stringify(items);
  const rebuild = rows.dataset['signature'] !== rowsSignature;
  if (rebuild) { rows.replaceChildren(); rows.dataset['signature'] = rowsSignature; }
  for (const item of rebuild ? items : []) {
    const row = document.createElement('tr'); row.dataset.recordingId = item.id;
    row.dataset.delivery = item.delivery; row.dataset.sync = item.synchronization.state;
    const name = document.createElement('th'); name.scope = 'row'; name.textContent = item.label;
    if (item.kind !== 'Mixed episode') {
      const kind = document.createElement('small'); kind.textContent = item.kind; name.append(kind);
    }
    const delivery = document.createElement('td');
    const label = document.createElement('strong'); label.textContent = item.deliveryLabel; delivery.append(label);
    const detail = document.createElement('small'); detail.textContent = item.detail; delivery.append(detail);
    const sync = document.createElement('td'); sync.textContent = item.synchronization.label;
    const limit = document.createElement('small'); limit.textContent = `Limit ${item.synchronization.limitMs} ms`; sync.append(limit);
    row.append(name, delivery, sync); rows.append(row);
  }
  const shown = value?.recovered || value?.episodeId === recording.state.episodeId ? value : null;
  const waitMessage = originalsWaitMessage(value);
  status('originals-status', !shown ? 'Separate originals start with Record.' : shown.allSourcesComplete
    ? 'Originals for participants present at the start are verified. Guests admitted later are not included.'
    : shown.phase === 'closed' ? 'This original backup set is incomplete. All saved media has been kept.'
    : waitMessage, shown?.phase === 'closed' && !shown.allSourcesComplete);
  element<HTMLButtonElement>('finish-originals').disabled = !originalsOpen || recording.busy || preparingRecording || (!value?.closing && !value?.canFinishIncomplete);
  element<HTMLButtonElement>('import-guest-recovery').disabled = importingRecovery || recording.busy || preparingRecording ||
    !value || value.phase !== 'stopped' || Boolean(value.closing) || value.allSourcesComplete;
  readiness();
}
const originals = new SourceSession(async () => {
  const current = await window.blastcast.sourceStatus();
  showOriginals(current);
  return { ok: true, episode: current ? { episodeId: current.episodeId, phase: current.phase,
    participantId: 'host', hostNowMs: current.hostNowMs, eligible: true } : null,
    source: current?.sources.find(source => source.participantId === 'host') ?? null };
}, {
  begin: descriptor => window.blastcast.beginHostSource(descriptor),
  append: (chunk, bytes) => window.blastcast.appendHostSource(chunk, bytes),
  finish: end => window.blastcast.finishHostSource(end),
}, state => { status('host-source-status', state.message, state.phase === 'incomplete'); settleDeviceSwaps(); readiness(); },
  message => status('host-source-status', message), false, {allowPartialSource:true});
element('finish-originals').addEventListener('click', async () => {
  try {
    const result = await window.blastcast.closeSourceEpisode();
    if (!result.ok) status('originals-status', result.message ?? 'Originals remain pending.', true);
    else await originals.poll();
  } catch { status('originals-status', 'Originals could not be finished. Keep the recording folder connected.', true); }
});
element('import-guest-recovery').addEventListener('click', async () => {
  if (importingRecovery) return;
  importingRecovery = true; showOriginals(latestSources);
  let outcome: { message: string; error: boolean } | null = null;
  try {
    const result = await window.blastcast.importGuestRecovery();
    if (!result.ok) {
      if (!result.cancelled) outcome = { message:result.message,error:true };
      return;
    }
    await originals.poll();
    outcome = { message:result.unchanged ? 'This guest recovery was already imported and verified.'
      : result.complete ? 'Guest recovery imported and verified. The selected recovery file was kept.'
        : 'Guest recovery imported. Saved bytes were kept, but this original is still incomplete.', error:!result.complete };
  } catch { outcome = { message:'Guest recovery could not be imported. Existing files were kept.',error:true }; }
  finally { importingRecovery = false; showOriginals(latestSources); if (outcome) status('originals-status',outcome.message,outcome.error); }
});
originals.update(true, null);


async function refreshDevices(): Promise<boolean> {
  const generation = ++deviceGeneration;
  refresh.disabled = true;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (generation !== deviceGeneration) return false;
    for (const [select, kind, name] of [[camera, 'videoinput', 'camera'], [microphone, 'audioinput', 'microphone']] as const) {
      const selected = select.value;
      select.replaceChildren(new Option(`System default ${name}`, ''));
      devices.filter(device => device.kind === kind && device.deviceId).forEach((device, index) => {
        select.add(new Option(device.label || `${name === 'camera' ? 'Camera' : 'Microphone'} ${index + 1}`, device.deviceId));
      });
      if ([...select.options].some(option => option.value === selected)) select.value = selected;
      else if (selected) preview.stop('A selected device is no longer available. Choose a device and restart preview.');
    }
    status('device-status', devices.some(device => device.label)
      ? 'Device changes apply immediately. Devices stay off until enabled.'
      : 'Open a camera or microphone list to allow access and see device names.');
    return true;
  } catch { status('device-status', 'Devices could not be listed. Check system permissions and refresh.', true); return false; }
  finally { if (generation === deviceGeneration) refresh.disabled = false; }
}

const deviceAccess = new DeviceAccess({
  authorize: () => window.blastcast.authorizePreview(),
  acquire: constraints => navigator.mediaDevices.getUserMedia(constraints), refresh: refreshDevices,
  canRequest: () => !recording.busy && !preparingRecording && !originals.busy && preview.state.phase !== 'requesting',
  live: () => preview.state.phase === 'live',
  busy: value => { deviceAccessBusy = value; readiness(); },
  message: (message, error) => status('device-status', message, error),
  denied: () => void showDenial((text, error) => status('device-status', text, error)),
});
deviceAccess.bind(camera, 'video'); deviceAccess.bind(microphone, 'audio');
start.addEventListener('click', () => { if (!recording.busy && !deviceAccess.busy && !preparingRecording && !originals.busy) void preview.start({ camera: camera.value, microphone: microphone.value,
  height: quality.value === '2160' ? 2160 : 1080 }, () => window.blastcast.authorizePreview()); });
async function applyDevices(): Promise<void> {
  if (recording.busy || originals.busy || preparingRecording || deviceAccess.busy) return;
  await preview.start({ camera: camera.value, microphone: microphone.value, height: quality.value === '2160' ? 2160 : 1080, cameraEnabled, microphoneEnabled }, () => window.blastcast.authorizePreview());
  if (preview.state.errors?.camera) cameraEnabled = false;
  if (preview.state.errors?.microphone) microphoneEnabled = false;
  if (!attached) { cameraEnabled = false; microphoneEnabled = false; }
  renderPreview(preview.state, attached);
}
// ClaudeBWAI — one device at a time: the toggle, the device list and Reconnect touch only their own track.
// ClaudeBWAI — Codex review of 68ea271 (P2): while a device is being switched, Record waits (readiness), and whether the
// replaced track is kept for a running original is decided at the swap itself, not when the acquisition started.
async function applyDevice(kind: DeviceKind, reconnect = false): Promise<void> {
  if (deviceAccess.busy || preview.state.phase === 'requesting') return;
  if (!reconnect && (recording.busy || originals.busy || preparingRecording)) return;
  if (!attached) { await applyDevices(); return; }
  deviceSwaps++; readiness();
  try {
    await preview.setDevice(kind, { camera: camera.value, microphone: microphone.value, height: quality.value === '2160' ? 2160 : 1080, cameraEnabled, microphoneEnabled },
      () => window.blastcast.authorizePreview(), { retain: () => recording.busy || preparingRecording || originals.busy, reconnect });
  } finally { deviceSwaps--; }
  if (!reconnect && preview.state.errors?.[kind]) { if (kind === 'camera') cameraEnabled = false; else microphoneEnabled = false; }
  if (!attached) { cameraEnabled = false; microphoneEnabled = false; }
  settleDeviceSwaps();
  renderPreview(preview.state, attached);
}
toggleCamera.addEventListener('click', () => { cameraEnabled = !cameraEnabled; void applyDevice('camera'); });
mute.addEventListener('click', () => {
  if (recording.busy || originals.busy) { preview.setMicrophoneMuted(!preview.microphoneMuted); return; }
  microphoneEnabled = !microphoneEnabled; preview.setMicrophoneMuted(false); void applyDevice('microphone');
});
element('hear-guests').addEventListener('click', () => {
  const button = element('hear-guests'); const enabled = button.getAttribute('aria-checked') !== 'true';
  button.setAttribute('aria-checked', String(enabled)); calls.setMonitoring(enabled);
});
stop.addEventListener('click', () => { if (!recording.busy) preview.stop(); });
refresh.addEventListener('click', () => void refreshDevices());
camera.addEventListener('change', () => { void saveDevices(); if (cameraEnabled) void applyDevice('camera'); });
microphone.addEventListener('change', () => { void saveDevices(); if (microphoneEnabled) void applyDevice('microphone'); });
quality.addEventListener('change', () => { setOutputQuality(quality.value === '2160' ? 2160 : 1080); void saveDevices(); if (cameraEnabled) void applyDevice('camera'); });
navigator.mediaDevices.addEventListener('devicechange', () => void refreshDevices());

function showFolder(result: FolderResult): void {
  if (result.status === 'cancelled') {
    status('folder-status', folderReady ? 'Selection cancelled. Your previous folder is still selected.' : 'Selection cancelled. Choose a folder when you are ready.');
    return;
  }
  folderReady = result.status === 'ready';
  folderSelected = result.status === 'ready';
  choose.textContent=folderSelected?'Change':'Choose folder';
  settingsChoose.textContent=folderSelected?'Change folder':'Choose folder';
  element('folder-label').textContent = result.status === 'ready' ? result.label : 'No writable folder selected';
  status('folder-status', result.status === 'ready'
    ? `Write check passed. This checks access now, not space for a full episode.${result.notice ? ` ${result.notice}` : ''}` : result.message, result.status === 'error');
}
async function folderAction(action: () => Promise<FolderResult>): Promise<void> {
  if (folderBusy) return;
  folderBusy = true;
  readiness();
  try { showFolder(await action()); }
  catch { showFolder({ status: 'error', message: 'The desktop connection failed. Restart BlastCast and try again.' }); }
  finally { folderBusy = false; readiness(); }
}
choose.addEventListener('click', () => void folderAction(() => window.blastcast.chooseFolder()));
settingsChoose.addEventListener('click', () => void folderAction(() => window.blastcast.chooseFolder()));
check.addEventListener('click', () => void folderAction(() => window.blastcast.checkFolder()));
open.addEventListener('click', async () => {
  try {
    const result = await window.blastcast.openFolder();
    if (!result.ok) status('folder-status', result.message ?? 'The folder could not be opened.', true);
  } catch { status('folder-status', 'The folder could not be opened. Restart BlastCast and try again.', true); }
});
const canvas = element<HTMLCanvasElement>('composed');
const ctx = canvas.getContext('2d', { alpha: false })!;
// ClaudeBWAI — einh 4 Oct (CP4c-2): a canvas keeps the context type it first asked for, so WebGL2 draws on a second canvas.
// The program stream (preview, recording, guests) always comes from the canvas of the chosen backend, and the backend
// is never switched while a recording runs: MediaRecorder holds the track, and replaceProgramVideo only reaches calls.
const glCanvas = document.createElement('canvas');
glCanvas.width = canvas.width; glCanvas.height = canvas.height;
glCanvas.className = canvas.className; glCanvas.setAttribute('aria-label', 'Composed scene preview'); glCanvas.style.display = 'none';
canvas.after(glCanvas);
let glCompositor: FrameCompositor | null = null;
let glWatch: { dispose(): void } | null = null;
let glDisabled = false; // WebGL2 missing, lost, or it failed a recording: Canvas 2D for the rest of the session
let activeBackend: SceneBackend = 'canvas2d';
let startupNote: CompositorReason | null = null; // why this recording starts on Canvas 2D, written to its diagnostics log
const activeCanvas = (): HTMLCanvasElement => activeBackend === 'webgl2' ? glCanvas : canvas;
const controlsContainer = element('scene-controls-container');
let sceneStream: MediaStream | null = null;
let renderAnimationId = 0;
let renderGeneration = 0;

const controls = mountSceneControls({
  container: controlsContainer,
  resolveAsset,
  customBackdrop: id => Boolean(backdropOverrides[id]),
  onSceneSelected: scene => { sourcesStale = true; element('preview-heading').textContent=scene.label; sceneSelection++; sceneReady = false; sceneError = ''; status('scene-status', 'Loading selected scene…'); readiness(); },
});

function stopSceneStream() {
  if (sceneStream) {
    for (const track of sceneStream.getTracks()) track.stop();
    sceneStream = null;
  }
}

function showBackendCanvas(): void {
  canvas.style.display = activeBackend === 'webgl2' ? 'none' : 'block'; glCanvas.style.display = activeBackend === 'webgl2' ? 'block' : 'none';
}
function restartSceneStream(): void {
  stopSceneStream();
  if (attached) {
    sceneStream = activeCanvas().captureStream(30);
    void calls.replaceProgramVideo(sceneStream.getVideoTracks()[0] ?? null).catch(() => status('device-status', 'The new quality could not reach every guest. Ask them to Reconnect.', true));
  }
}
function releaseGl(): void {
  glWatch?.dispose(); glWatch = null;
  try { glCompositor?.dispose(); } catch { /* the context is already gone */ }
  glCompositor = null;
}
function switchBackend(next: SceneBackend, reason: CompositorReason | null): void {
  if (next === activeBackend || recording.busy) return;
  activeBackend = next; drawMeter.backend = next;
  showBackendCanvas();
  restartSceneStream();
  if (reason) logCompositorEvent(sessionLog, reason, next);
}
function fallBackToCanvas2d(): void { glDisabled = true; startupNote = 'fallback-canvas2d'; releaseGl(); switchBackend('canvas2d', 'fallback-canvas2d'); }
// Chosen at start, on a quality change, before a recording and after one; a no-op while a recording runs.
function selectBackend(): void {
  if (recording.busy) return;
  if (!glDisabled && !glCompositor) {
    glCompositor = createGlCompositor(glCanvas);
    if (glCompositor) {
      glWatch = watchGlContext(glCanvas, glCompositor, {
        recording: () => recording.busy,
        event: reason => logCompositorEvent(sessionLog, reason, 'webgl2'),
        onLostIdle: fallBackToCanvas2d,
        onLostTimeout: () => {
          if (!recording.busy) { fallBackToCanvas2d(); return; }
          glDisabled = true; startupNote = 'fallback-canvas2d'; // the next recording starts on Canvas 2D (selectBackend runs when this one ends)
          logCompositorEvent(sessionLog, 'recording-failed', 'webgl2');
          void recording.fail('The graphics card dropped the GPU compositor and it did not come back. Recording is incomplete; partial files are retained. The next recording uses the standard compositor.');
        },
      });
    } else { glDisabled = true; startupNote = 'webgl2-unavailable'; }
  }
  if (glCompositor?.lost()) glDisabled = true;
  if (glDisabled) { const had = Boolean(glCompositor); releaseGl(); if (had) startupNote = 'fallback-canvas2d'; }
  if (glCompositor) { startupNote = null; switchBackend('webgl2', null); }
  else switchBackend('canvas2d', 'fallback-canvas2d');
}

function setOutputQuality(height: 1080 | 2160): void {
  const width = height === 2160 ? 3840 : 1920;
  if (canvas.width !== width || canvas.height !== height) {
    stopSceneStream();
    canvas.width = width;
    canvas.height = height;
    glCanvas.width = width; glCanvas.height = height; glCompositor?.resize(width, height);
    // ClaudeBWAI — Codex review of 68ea271 (P2): the guests' program video was the scene track just stopped; hand every call
    // the new one (replaceTrack on the video sender, no renegotiation). A one-device change no longer rebuilds the calls.
    if (attached) {
      sceneStream = activeCanvas().captureStream(30);
      void calls.replaceProgramVideo(sceneStream.getVideoTracks()[0] ?? null).catch(() => status('device-status', 'The new quality could not reach every guest. Ask them to Reconnect.', true));
    }
  }
  selectBackend();
  element('output-label').textContent = `Recording output ${width}×${height}`;
}

// ClaudeBWAI — the canvas is captured at 30 fps, so drawing faster than 30 fps only burns the CPU.
const RENDER_FPS = 30, SOURCE_REFRESH_MS = 250, STATUS_REFRESH_MS = 500;
const renderGate = createFrameGate(RENDER_FPS);
let frameValid = false;
let statusSelection = -1;
let sourceSignature = '';
const drawableIds = new WeakMap<object, number>();
let nextDrawableId = 0;
const drawableId = (drawable: object): number => {
  let id = drawableIds.get(drawable);
  if (id === undefined) { id = ++nextDrawableId; drawableIds.set(drawable, id); }
  return id;
};
function scheduleRender(): void {
  renderAnimationId = requestAnimationFrame(now => {
    if (!renderGate(now)) { scheduleRender(); return; }
    void renderLoop();
  });
}
// Source assembly touches the DOM (screen picker, attention banner, scene thumbnails), so it runs at ~4 Hz
// and hands the scene controls a new list only when something they draw or show actually changed.
const refreshSources = createThrottle(() => {
  let own: DrawableSource[] = [];
  frameValid = false;
  if (attached && attached.active) {
    const track = attached.getVideoTracks()[0];
    const settings = track?.getSettings();
    const live = track?.readyState === 'live' && track?.enabled && !track.muted && video.videoWidth > 0 && video.videoHeight > 0;
    frameValid = Boolean(live || attached.getAudioTracks().some(track => track.readyState === 'live'));
    own = [{
      kind: 'camera',
      index: 0,
      state: live ? 'live' : 'muted',
      drawable: video,
      naturalWidth: video.videoWidth || settings?.width || 0,
      naturalHeight: video.videoHeight || settings?.height || 0
    }];
  }
  const all = [...own, ...calls.sources(), ...screenSource()];
  const signature = all.map(source => `${source.kind}:${source.index}:${source.state}:${source.naturalWidth}x${source.naturalHeight}:${drawableId(source.drawable as object)}`).join('|');
  if (signature !== sourceSignature) { sourceSignature = signature; controls.updateSources(all); }
}, SOURCE_REFRESH_MS);
const refreshSceneStatus = createThrottle(() => {
  status('scene-status', 'Scene changes appear in the recording. Select a shared screen for a screen-share scene.');
  readiness();
}, STATUS_REFRESH_MS);

async function renderLoop() {
  const gen = ++renderGeneration;
  const selection = sceneSelection;
  if (sceneError) { scheduleRender(); return; }

  refreshSources(sourcesStale); sourcesStale = false;
  const hasValidFrame = frameValid;

  if (activeBackend === 'webgl2' && glCompositor?.lost()) { scheduleRender(); return; } // the watch decides: restore, fall back, or fail
  try {
    const drawStart = performance.now();
    if (activeBackend === 'webgl2' && glCompositor) {
      try { await controls.composeToCanvas(glCompositor); } finally { drawMeter.add(performance.now() - drawStart); }
    } else {
      ctx.save();
      ctx.setTransform(canvas.width / CANVAS_W, 0, 0, canvas.height / CANVAS_H, 0, 0);
      try { await controls.composeToCanvas(ctx); }
      finally { ctx.restore(); drawMeter.add(performance.now() - drawStart); }
    }
    if (gen === renderGeneration && selection === sceneSelection) {
      const changed = sceneReady !== hasValidFrame || statusSelection !== selection;
      sceneReady = hasValidFrame; statusSelection = selection;
      refreshSceneStatus(changed);
    }
  } catch (err) {
    if (gen === renderGeneration && selection === sceneSelection) {
      sceneReady = false;
      sceneError = 'The scene could not be drawn. Select a scene to retry.';
      status('scene-status', sceneError, true);
      readiness();
      if (recording.busy) void recording.fail('A scene asset failed to load. Recording is incomplete; partial files are retained.');
    }
  }

  if (gen === renderGeneration) scheduleRender();
}

selectBackend();
void renderLoop();

function getRecordingStream(): MediaStream {
  return getSceneOutputStream(calls.mixedStream());
}

function getCallStream(deviceStream: MediaStream): MediaStream {
  return getSceneOutputStream(deviceStream);
}

function getSceneOutputStream(audioStream: MediaStream): MediaStream {
  if (!sceneStream) {
    sceneStream = activeCanvas().captureStream(30);
  }
  return composeProgramOutput(sceneStream, audioStream);
}

record.addEventListener('click', async () => {
  if (!attached || !folderReady || !sceneReady || preparingRecording || recording.busy || originalsOpen || originals.busy || deviceSwaps > 0) return;
  const stream = attached;
  preparingRecording = true; readiness();
  try {
    selectBackend();
    await calls.resumeAudio();
    if (attached === stream && folderReady && sceneReady) await recording.start(getRecordingStream());
    void originals.poll();
  } catch { status('recording-status', 'Recording did not start. Enable call audio and check preview before retrying.', true); }
  finally { preparingRecording = false; readiness(); }
});
stopRecording.addEventListener('click', async () => { if (await studioShell.confirmStop()) await recording.stop(); });
openRecording.addEventListener('click', async () => {
  try { const result = await window.blastcast.openRecording(); if (!result.ok) status('recording-status', result.message, true); }
  catch { status('recording-status', 'The player could not open. Your saved file remains in the recording folder.', true); }
});
window.addEventListener('beforeunload', event => {
  if (recording.busy || preparingRecording || originalsOpen || originals.busy) { event.preventDefault(); event.returnValue = ''; return; }
  deviceAccess.cancel();
  share.stop();
  library.destroy();
  preview.stop();
  calls.close();
  originals.close();
  renderGeneration++;
  cancelAnimationFrame(renderAnimationId);
  controls.destroy();
  stopSceneStream();
});
showOriginals(latestSources);
void refreshDevices();

async function saveDevices(): Promise<void> {
  const result = await window.blastcast.saveDevicePreferences({camera:camera.value,microphone:microphone.value,height:quality.value === '2160' ? 2160 : 1080,background:background.mode});
  if (!result.ok) status('device-status', result.message ?? 'Device selections could not be saved.', true);
}
void window.blastcast.loadDevicePreferences().then(async result => {
  if (!result.ok || !result.preferences) return;
  const prefs = result.preferences;
  await refreshDevices();
  for (const [select, id] of [[camera,prefs.camera],[microphone,prefs.microphone]] as const) {
    if (id && ![...select.options].some(option => option.value === id)) select.add(new Option('Saved device (allow access to check)', id));
    select.value = id;
  }
  quality.value = String(prefs.height);
  setOutputQuality(prefs.height);
  await restoreBackground(prefs.background ?? 'off');
}).catch(() => status('device-status', 'Saved devices could not be loaded. Choose your devices again.', true));

// CodexBWAI — every layout owns its upload; selection never depends on the active scene.
const backdropRows = new Map<string, { upload: HTMLButtonElement; reset: HTMLButtonElement; state: HTMLElement }>();
let backdropBusy = false;
function updateBackdropRows(): void {
  for (const [id, row] of backdropRows) {
    row.state.textContent = backdropOverrides[id] ? 'Custom backdrop saved' : 'Using shipped backdrop';
    row.state.classList.remove('error');
    row.upload.disabled = backdropBusy;
    row.reset.disabled = backdropBusy || !backdropOverrides[id];
  }
}
async function loadBackdrops(result: Awaited<ReturnType<Window['blastcast']['getSceneBackdrops']>>): Promise<void> {
  if (!result.ok) { status('backdrop-status', result.message ?? 'Backdrops could not load.', true); return; }
  backdropOverrides = result.backdrops ?? {};
  assetCache.clear(); controls.selectScene(controls.currentScene.id);
  updateBackdropRows();
  status('backdrop-status', 'Each layout keeps its own backdrop. Your active layout stays selected.');
}
for (const scene of DEFAULT_SCENES) {
  const row = document.createElement('div'); row.className = 'backdrop-layout'; row.dataset.sceneId = scene.id;
  const detail = document.createElement('div');
  const label = document.createElement('strong'); label.textContent = scene.hasScreenshare
    ? scene.id === 'screensharevert-8' ? 'Screen share — vertical camera bar' : 'Screen share — horizontal camera bar'
    : `${scene.cameraCount} camera${scene.cameraCount === 1 ? '' : 's'}`;
  label.id = `backdrop-label-${scene.id}`;
  const state = document.createElement('p'); state.className = 'small status'; state.setAttribute('role', 'status');
  detail.append(label, state);
  const actions = document.createElement('div'); actions.className = 'backdrop-layout-actions';
  const upload = document.createElement('button'); upload.type = 'button'; upload.className = 'secondary'; upload.textContent = 'Choose PNG…';
  upload.setAttribute('aria-label', `Upload backdrop for ${label.textContent}`);
  const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'text-button'; reset.textContent = 'Use shipped backdrop';
  reset.setAttribute('aria-label', `Use shipped backdrop for ${label.textContent}`);
  actions.append(upload, reset); row.append(detail, actions); element('backdrop-layouts').append(row);
  backdropRows.set(scene.id, { upload, reset, state });
  async function changeBackdrop(resetToDefault: boolean): Promise<void> {
    if (backdropBusy) return;
    backdropBusy = true; updateBackdropRows();
    try {
      const result = resetToDefault ? await window.blastcast.resetSceneBackdrop(scene.id) : await window.blastcast.chooseSceneBackdrop(scene.id);
      if ('cancelled' in result && result.cancelled) return;
      await loadBackdrops(result);
      if (!result.ok) { state.textContent = result.message ?? 'This backdrop could not be saved.'; state.classList.add('error'); }
    } catch {
      state.textContent = 'This backdrop could not be saved. Try choosing the PNG again.'; state.classList.add('error');
    } finally {
      backdropBusy = false;
      for (const [id, buttons] of backdropRows) { buttons.upload.disabled = false; buttons.reset.disabled = !backdropOverrides[id]; }
    }
  }
  upload.addEventListener('click', () => { void changeBackdrop(false); });
  reset.addEventListener('click', () => { void changeBackdrop(true); });
}
backdropBusy = true; updateBackdropRows();
void window.blastcast.getSceneBackdrops().then(loadBackdrops)
  .catch(() => status('backdrop-status', 'Saved backdrops could not be loaded. Try again after reopening BlastCast.', true))
  .finally(() => { backdropBusy = false; updateBackdropRows(); });

void window.blastcast.appInfo().then(info=>{element('app-version').textContent=info.version;});
maybe('check-updates')?.addEventListener('click',async()=>{const result=await window.blastcast.openUpdates();status('update-status',result.ok?'The public BlastCast repository opened in your browser.':result.message??'The release page could not open.',!result.ok);});
