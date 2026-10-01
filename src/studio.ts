import { ScreenShare } from './screen-share.js';
import { initStudioShell } from './studio-shell.js';
import { mountRecordingLibrary } from './recording-library.js';
import { SourceSession } from './source-session.js';
import type { SourceStatus } from './source-protocol.js';
import { Recording } from './recording.js';
import { recordingRows } from './recording-status.js';
import './invites.js';
import type { FolderResult, LicenseStatus } from './bridge.js';
import { DeviceAccess } from './device-access.js';
import { Preview, type PreviewState } from './preview.js';
import { mountSceneControls } from './scene-controls.js';
import { CANVAS_H, CANVAS_W, DEFAULT_SCENES, type DrawableSource } from './scenes.js';
import { HostCalls } from './host-calls.js';
import { GuestScreenAttention } from './screen-share-attention.js';
import { composeProgramOutput } from './program-output.js';

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
const activationLock = element('activation-lock');
const studio = element('studio');
const settingsDialog = element<HTMLDialogElement>('studio-settings');
const activationEntry = element('activation-entry');
const activationCurrent = element('activation-current');
const activationKey = element<HTMLTextAreaElement>('activation-key');
const activateLicense = element<HTMLButtonElement>('activate-license');
const deactivateLicense = element<HTMLButtonElement>('deactivate-license');
const licensedSettings = [...settingsDialog.querySelectorAll<HTMLElement>('.setup-card:not(#activation-card):not(#software-card), .readiness')];
function showLicense(value: LicenseStatus): void {
  const active = value.active;
  studio.inert = !active; activationLock.hidden = active;
  licensedSettings.forEach(section => { section.inert = !active; });
  activationEntry.hidden = active; activationCurrent.hidden = !active;
  if (active) {
    element('activation-holder').textContent = value.license.holder;
    element('activation-kind').textContent = `${value.license.kind} key`;
  }
  status('activation-status', value.message ?? (active ? 'BlastCast is activated on this computer.' : 'Enter an activation key to unlock the studio.'), Boolean(value.message));
  if (!active && !settingsDialog.open) settingsDialog.showModal();
}
async function refreshLicense(): Promise<void> {
  try { showLicense(await window.blastcast.licenseStatus()); }
  catch { showLicense({ active:false, message:'Activation status could not be checked. Restart BlastCast and try again.' }); }
}
element('open-activation').addEventListener('click', () => { if (!settingsDialog.open) settingsDialog.showModal(); activationKey.focus(); });
activateLicense.addEventListener('click', async () => {
  activateLicense.disabled = true; status('activation-status', 'Checking activation key…');
  try {
    const result = await window.blastcast.activateLicense(activationKey.value);
    if (result.active) { activationKey.value = ''; status('activation-status', 'Activated. Restarting the studio…'); location.reload(); return; }
    showLicense(result);
  } catch { status('activation-status', 'Activation could not be completed. Try again.', true); }
  finally { activateLicense.disabled = false; }
});
deactivateLicense.addEventListener('click', async () => {
  deactivateLicense.disabled = true; status('activation-status', 'Deactivating…');
  try {
    const result = await window.blastcast.deactivateLicense();
    if (!result.active) { location.reload(); return; }
    showLicense(result);
  } catch { status('activation-status', 'BlastCast could not be deactivated. Try again.', true); }
  finally { deactivateLicense.disabled = false; }
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
let preparingRecording = false;
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
  status('preview-status', busy && preview.state.phase === 'live'
    ? 'Camera and microphone feed the recording.' : preview.state.message,
    preview.state.phase === 'error' || preview.state.phase === 'interrupted');
  element('ready-dot').classList.toggle('ready', ready);
  element('ready-title').textContent = busy ? 'Recording session active.' : ready ? 'Your local checks are complete.' : 'Let’s get your studio ready.';
  element('ready-detail').textContent = busy ? 'Stop recording and wait for it to finish before changing devices or folders.' : ready
    ? `Enabled sources are ready. Your folder is writable. Nothing is being recorded.`
    : 'Enable a camera or microphone and choose a writable folder.';
  // CodexBWAI — explain the same conditions that disable Record; never a stale generic hint.
  const recordReason = recording.state.phase === 'recording' ? 'A recording is already in progress.'
    : recording.state.phase === 'finalizing' ? 'Wait for the current recording to finish saving.'
    : preparingRecording || recording.state.phase === 'starting' ? 'Preparing the recording. Please wait.'
    : originals.busy ? 'Wait for the current participant original to finish recording or saving.'
    : originalsOpen ? 'Finish collecting the previous recording’s originals in the Recordings tab.'
    : folderBusy ? 'Checking the recording folder. Please wait.'
    : !folderReady ? (folderSelected ? 'The recording folder is not writable. Check it in Settings or choose another folder.' : 'Choose a recording folder before recording.')
    : preview.state.phase === 'requesting' || deviceAccessBusy ? 'Finish granting device access before recording.'
    : preview.state.phase !== 'live' ? (preview.state.phase === 'error' || preview.state.phase === 'interrupted'
      ? `Your enabled source is not ready. ${preview.state.message}` : 'Enable a camera or microphone before recording.')
    : sceneError ? `The selected scene is not ready. ${sceneError}`
    : !sceneReady ? 'Wait for the selected scene to finish loading.' : '';
  record.disabled = busy || originalsOpen || preparingRecording || !ready || folderBusy || !sceneReady || Boolean(sceneError);
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
  mute.setAttribute('aria-label', micOff ? 'Enable microphone' : 'Disable microphone');
  toggleCamera.setAttribute('aria-pressed', String(!cameraEnabled));
  toggleCamera.setAttribute('aria-label', cameraEnabled ? 'Disable camera' : 'Enable camera');
  mute.title = micOff ? 'Enable microphone' : 'Disable microphone';
  toggleCamera.title = cameraEnabled ? 'Disable camera' : 'Enable camera';
  mute.classList.add('bc-toggle'); toggleCamera.classList.add('bc-toggle');
  mute.innerHTML = '<svg class="bc-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="8" rx="2.5"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2"/></svg>';
  toggleCamera.innerHTML = '<svg class="bc-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="4" width="9" height="8" rx="1.5"/><path d="M10.5 7l4-2.5v7l-4-2.5z"/></svg>';
  element('mic-label').textContent = preview.microphoneMuted ? 'Muted' : stream ? 'Input level' : 'Mic off';
  const active = state.phase === 'live' || state.phase === 'interrupted';
  start.disabled = state.phase === 'requesting';
  start.firstChild!.textContent = active ? 'Restart preview ' : state.phase === 'error' ? 'Try preview again ' : 'Start preview ';
  stop.disabled = state.phase === 'idle' || state.phase === 'error';
  stop.textContent = state.phase === 'requesting' ? 'Cancel preview' : 'Stop preview';
  camera.disabled = microphone.disabled = quality.disabled = state.phase === 'requesting';
  if (recording.busy && (state.phase === 'error' || state.phase === 'interrupted' || state.phase === 'idle')) void recording.fail('A capture device was interrupted. Recording is incomplete; partial files are retained.');
  status('preview-status', recording.busy && state.phase === 'live' ? 'Camera and microphone feed the recording.' : state.message, state.phase === 'error' || state.phase === 'interrupted');
  const badge = element('preview-badge');
  badge.textContent = state.phase === 'live' ? '● Preview live' : state.phase === 'requesting' ? 'Awaiting access' : state.phase === 'interrupted' ? 'Device interrupted' : 'Devices off';
  badge.classList.toggle('live', state.phase === 'live');
  if (attached !== stream) {
    clearMeter();
    attached = stream;
    calls.setStream(stream ? getCallStream(stream) : null);
    if (!stream && !recording.busy) stopSceneStream();
    originals.update(true, stream);
    video.srcObject = stream;
    element('preview-empty').hidden = Boolean(stream);
    video.toggleAttribute('data-live', Boolean(stream));
    const composedCanvas = element<HTMLCanvasElement>('composed');
    composedCanvas.style.display = 'block';
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

const preview = new Preview(value => navigator.mediaDevices.getUserMedia(value), renderPreview);
const calls = new HostCalls(window.blastcast, element('call-guests'), element('call-audio-status'), element<HTMLButtonElement>('enable-call-audio'));
const shareVideo = document.createElement('video'); shareVideo.muted=true; shareVideo.playsInline=true;
const shareSelect = element<HTMLSelectElement>('screen-source');
const guestScreenAttention = new GuestScreenAttention();
function showGuestScreenAttention(active: boolean): void {
  shareSelect.classList.toggle('screen-share-attention', active);
  shareSelect.setAttribute('aria-describedby', active ? 'screen-share-prompt' : 'screen-status');
  element('screen-share-prompt').hidden = !active;
}
shareSelect.addEventListener('change', () => { guestScreenAttention.acknowledge(); showGuestScreenAttention(false); });
const share = new ScreenShare(() => navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:15,max:30}},audio:false}), (stream,message) => {
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
  const rows = element('recording-rows'); rows.replaceChildren();
  for (const item of recordingRows(recording.state, value)) {
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
  const remaining = value?.incompleteOverrideInMs;
  const waitMessage = value?.recovered && !value.allSourcesComplete
    ? remaining === 0 ? 'Recovered originals are incomplete. You can now explicitly finish this retained backup set.'
      : `Recovered originals from an interrupted studio. Verified files are kept; incomplete tails need guest reimport or the timed override${remaining == null ? '.' : ` in ${Math.ceil(remaining / 60000)} min.`}`
    : value?.phase === 'stopped' && !value.allSourcesComplete
    ? remaining === 0 ? 'More than an hour has passed since production finished. You can now explicitly finish with missing originals.'
      : remaining == null ? 'Keep the studio open until all originals arrive.'
        : `Keep the studio open until all originals arrive. An override becomes available in ${Math.ceil(remaining / 60000)} min.`
    : 'Original backup set pending. Keep the studio and guest pages open.';
  status('originals-status', !shown ? 'Separate originals start with Record.' : shown.allSourcesComplete
    ? 'Originals for participants present at the start are verified. Guests admitted later are not included.'
    : shown.phase === 'closed' ? 'This original backup set is incomplete. All saved media has been kept.'
    : waitMessage, shown?.phase === 'closed' && !shown.allSourcesComplete);
  element<HTMLButtonElement>('finish-originals').disabled = !originalsOpen || recording.busy || preparingRecording || (!value?.closing && remaining !== 0);
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
}, state => { status('host-source-status', state.message, state.phase === 'incomplete'); readiness(); },
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
toggleCamera.addEventListener('click', () => { cameraEnabled = !cameraEnabled; void applyDevices(); });
mute.addEventListener('click', () => {
  if (recording.busy || originals.busy) { preview.setMicrophoneMuted(!preview.microphoneMuted); return; }
  microphoneEnabled = !microphoneEnabled; preview.setMicrophoneMuted(false); void applyDevices();
});
element('hear-guests').addEventListener('click', () => {
  const button = element('hear-guests'); const enabled = button.getAttribute('aria-checked') !== 'true';
  button.setAttribute('aria-checked', String(enabled)); calls.setMonitoring(enabled);
});
stop.addEventListener('click', () => { if (!recording.busy) preview.stop(); });
refresh.addEventListener('click', () => void refreshDevices());
for (const select of [camera, microphone]) select.addEventListener('change', () => { void saveDevices(); if (cameraEnabled || microphoneEnabled) void applyDevices(); });
quality.addEventListener('change', () => { setOutputQuality(quality.value === '2160' ? 2160 : 1080); void saveDevices(); if (cameraEnabled || microphoneEnabled) void applyDevices(); });
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
    ? 'Write check passed. This checks access now, not space for a full episode.' : result.message, result.status === 'error');
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
const controlsContainer = element('scene-controls-container');
let sceneStream: MediaStream | null = null;
let renderAnimationId = 0;
let renderGeneration = 0;

const controls = mountSceneControls({
  container: controlsContainer,
  resolveAsset,
  customBackdrop: id => Boolean(backdropOverrides[id]),
  onSceneSelected: scene => { element('preview-heading').textContent=scene.label; sceneSelection++; sceneReady = false; sceneError = ''; status('scene-status', 'Loading selected scene…'); readiness(); },
});

function stopSceneStream() {
  if (sceneStream) {
    for (const track of sceneStream.getTracks()) track.stop();
    sceneStream = null;
  }
}

function setOutputQuality(height: 1080 | 2160): void {
  const width = height === 2160 ? 3840 : 1920;
  if (canvas.width !== width || canvas.height !== height) {
    stopSceneStream();
    canvas.width = width;
    canvas.height = height;
  }
  element('output-label').textContent = `Recording output ${width}×${height}`;
}

async function renderLoop() {
  const gen = ++renderGeneration;
  const selection = sceneSelection;
  let hasValidFrame = false;
  if (sceneError) { renderAnimationId = requestAnimationFrame(() => void renderLoop()); return; }

  if (attached && attached.active) {
    const track = attached.getVideoTracks()[0];
    const settings = track?.getSettings();
    const live = track?.readyState === 'live' && track?.enabled && !track.muted && video.videoWidth > 0 && video.videoHeight > 0;

    hasValidFrame = Boolean(live || attached.getAudioTracks().some(track => track.readyState === 'live'));
    const sources: DrawableSource[] = [{
      kind: 'camera',
      index: 0,
      state: live ? 'live' : 'muted',
      drawable: video,
      naturalWidth: video.videoWidth || settings?.width || 0,
      naturalHeight: video.videoHeight || settings?.height || 0
    }];
    controls.updateSources([...sources, ...calls.sources(), ...screenSource()]);
  } else {
    controls.updateSources([...calls.sources(), ...screenSource()]);
  }

  try {
    ctx.save();
    ctx.setTransform(canvas.width / CANVAS_W, 0, 0, canvas.height / CANVAS_H, 0, 0);
    try { await controls.composeToCanvas(ctx); }
    finally { ctx.restore(); }
    if (gen === renderGeneration && selection === sceneSelection) {
      sceneReady = hasValidFrame;
      status('scene-status', 'Scene changes appear in the recording. Select a shared screen for a screen-share scene.');
      readiness();
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

  if (gen === renderGeneration) {
    renderAnimationId = requestAnimationFrame(() => void renderLoop());
  }
}

void renderLoop();

function getRecordingStream(): MediaStream {
  return getSceneOutputStream(calls.mixedStream());
}

function getCallStream(deviceStream: MediaStream): MediaStream {
  return getSceneOutputStream(deviceStream);
}

function getSceneOutputStream(audioStream: MediaStream): MediaStream {
  if (!sceneStream) {
    sceneStream = canvas.captureStream(30);
  }
  return composeProgramOutput(sceneStream, audioStream);
}

record.addEventListener('click', async () => {
  if (!attached || !folderReady || !sceneReady || preparingRecording || recording.busy || originalsOpen || originals.busy) return;
  const stream = attached;
  preparingRecording = true; readiness();
  try {
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
  const result = await window.blastcast.saveDevicePreferences({camera:camera.value,microphone:microphone.value,height:quality.value === '2160' ? 2160 : 1080});
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
element('check-updates').addEventListener('click',async()=>{const result=await window.blastcast.openUpdates();status('update-status',result.ok?'The public BlastCast repository opened in your browser.':result.message??'The release page could not open.',!result.ok);});
