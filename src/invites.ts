// CodexBWAI — the privileged host UI only uses explicit desktop methods.
import type { DirectAccessStatus, GuestStatus, HelperInput } from './bridge.js';
import { InviteAutomation } from './invite-automation.js';
import { createAdmissionPanel } from './admission-ui.js';
import { normalizeExpressTurnAddress } from './relay-input.js';
import { inviteCountOptions, clampInviteCount, generateLabel, shortInviteLink } from './invite-list.js';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const panel = el('guest-panel');
const origin = el<HTMLInputElement>('guest-origin');
const port = el<HTMLInputElement>('guest-port');
const routeType = el<HTMLSelectElement>('guest-route-type');
const route = el('guest-route-status');
const note = el('guest-invite-status');
const automation = new InviteAutomation();
let busy = false;
let pendingWant = 1; // ClaudeBWAI — how many invitations the setup in flight was asked for.
let openInvites: { id: string; url: string; expiresAt: number }[] = [];
let inviteSlots: number | undefined;
type SavedSettings = { domain: 'yes' | 'no'; origin: string; port: number; helper: HelperInput; freeRouteAcknowledged?: boolean; credentialSaved: true };
let saved: SavedSettings | null = null;
let settingsProblem = '';
let settingsLoaded = false;
let settingsLoading = false;
let wizardOpen = false;
let wizardStep = 0;
let actionGeneration = 0;
let lastPhase: string | null = null;
let lastGuestStatus: GuestStatus | null = null;
let lastDirectStatus: DirectAccessStatus = { ok: true, phase: 'idle', plan: null, lease: null, message: 'No router change made.' };

const admissionPanel = createAdmissionPanel(el('guest-pending'), {
  onAdmit: id => window.blastcast.guestAdmit(id).catch(() => ({ ok: false, message: 'Could not reach server' })),
  onReject: id => window.blastcast.guestReject(id).catch(() => ({ ok: false, message: 'Could not reach server' })),
  onRemove: id => window.blastcast.guestRemove(id).catch(() => ({ ok: false, message: 'Could not reach server' })),
  onRevoke: token => { automation.cancel(); return window.blastcast.revokeGuestInvite(token).catch(() => ({ ok: false, message: 'Could not reach server' })); }
});

function render(value: GuestStatus): void {
  lastGuestStatus = value;
  if (!value.ok) { note.textContent = value.message; note.classList.add('error'); return; }
  const ready = value.phase === 'ready';
  const check = value.readiness?.check ?? null;
  el<HTMLButtonElement>('create-guest-invite').disabled = busy || settingsLoading || wizardOpen;
  const liveInvite = value.phase === 'ready' && value.invite && value.invite.expiresAt > Date.now() ? value.invite : null;
  renderInvites(value, liveInvite);
  el<HTMLButtonElement>('revoke-guest-invites').disabled = busy || !ready;
  el<HTMLButtonElement>('stop-guests').disabled = value.phase === 'off';
  el<HTMLButtonElement>('copy-guest-readiness').disabled = busy || !check;
  el<HTMLButtonElement>('fail-guest-readiness').disabled = busy || !check;
  el('guest-readiness-actions').hidden = !check;
  if (value.phase === 'outside-check' && check) el<HTMLDetailsElement>('guest-troubleshooting').open = true;
  el<HTMLInputElement>('guest-readiness-link').value = check?.url ?? '';
  if (value.phase === 'off' && lastPhase !== null && lastPhase !== 'off') el<HTMLInputElement>('relay-password').value = '';
  if (value.phase === 'off') route.textContent = 'Guest access is off.';
  else if (value.phase === 'checking') route.textContent = 'Starting the local guest listener…';
  else if (value.phase === 'outside-check') route.textContent = `Listener ready at ${value.origin}. Complete the check from a different network before sharing invitations.`;
  else if (value.phase === 'ready') route.textContent = `Guest address ready at ${value.origin}.`;
  else route.textContent = value.readiness.diagnosis?.message ?? 'The readiness check is blocked.';
  if ('connectionMessage' in value && typeof value.connectionMessage === 'string') route.textContent += ` ${value.connectionMessage}`;
  if (value.helper) route.textContent += ` Helper: ${value.helper.provider}; media policy: ${value.helper.iceTransportPolicy === 'relay' ? 'relay only' : 'direct or relay'}. Relay allowance unknown; media must be checked separately.`;
  if (value.readiness?.hint) route.textContent += ` Local-computer hint: ${value.readiness.hint.message}`;
  if (!busy && lastPhase !== value.phase) {
    if (value.phase === 'ready') note.textContent = 'Guest connection ready.';
    else if (value.phase === 'blocked') note.textContent = value.readiness.diagnosis?.message ?? 'The readiness check is blocked.';
  }
  lastPhase = value.phase;

  const stageLabels: Record<string, string> = { pending: 'Pending', passed: 'Passed', failed: 'Failed', 'not-proven': 'Not proven' };
  const stages = value.readiness?.stages;
  for (const item of document.querySelectorAll<HTMLElement>('[data-readiness]')) {
    const key = item.dataset.readiness as keyof NonNullable<typeof stages>;
    const stage = stages?.[key] ?? 'not-proven';
    item.dataset.state = stage;
    const output = item.querySelector('span');
    if (output) output.textContent = stageLabels[stage] ?? 'Not proven';
  }
  const routeItem = document.querySelector<HTMLElement>('[data-readiness="route"]');
  if (routeItem?.firstChild) routeItem.firstChild.textContent = value.readiness?.routeType === 'tunnel' ? 'Provider route ' : 'Forwarding / firewall ';
  admissionPanel.update(value.guests);
  if (!busy && automation.take(value)) { const want = pendingWant; pendingWant = 1; void action(() => want > 1 ? window.blastcast.createGuestInvites(want) : window.blastcast.createGuestInvite(), want > 1 ? 'Creating your invitations…' : 'Creating your invitation…'); }
}
// ClaudeBWAI — open invitations as "Invite k  link  [Copy]" rows, rebuilt only when they change so a focused Copy keeps focus.
let inviteRowsKey = '';
function renderInvites(value: Extract<GuestStatus, { ok: true }>, liveInvite: { url: string; expiresAt: number } | null): void {
  const now = Date.now();
  openInvites = value.phase !== 'ready' ? [] : (value.invites ?? (liveInvite ? [{ id: 'latest', ...liveInvite }] : [])).filter(i => i.expiresAt > now);
  inviteSlots = value.inviteSlots;
  // Kept for the smoke tests and anything that reads "the newest link": a hidden mirror, never shown.
  el<HTMLInputElement>('guest-invite').value = openInvites.at(-1)?.url ?? '';
  const list = el('guest-invite-list');
  const key = openInvites.map(i => `${i.id}|${i.url}`).join('\n');
  if (key !== inviteRowsKey) {
    inviteRowsKey = key;
    list.replaceChildren(...openInvites.map((invite, index) => {
      const row = document.createElement('li'); row.className = 'preview-controls';
      const name = document.createElement('strong'); name.textContent = `Invite ${index + 1}`;
      const link = document.createElement('span'); link.className = 'small'; link.textContent = shortInviteLink(invite.url); link.title = invite.url;
      const copy = document.createElement('button'); copy.className = 'secondary'; copy.type = 'button'; copy.textContent = 'Copy'; copy.dataset.inviteId = invite.id;
      copy.setAttribute('aria-label', `Copy invite ${index + 1}`);
      copy.addEventListener('click', () => void copyInvite(invite.id));
      row.append(name, link, copy);
      return row;
    }));
  }
  const all = el<HTMLButtonElement>('copy-all-guest-invites');
  all.hidden = openInvites.length < 2; all.disabled = busy || openInvites.length < 2;
  for (const b of list.querySelectorAll<HTMLButtonElement>('button')) b.disabled = busy;
  renderInviteCount();
}
function renderInviteCount(): void {
  const select = el<HTMLSelectElement>('guest-invite-count');
  const options = inviteCountOptions(inviteSlots);
  const chosen = clampInviteCount(Number(select.value), inviteSlots);
  if (select.options.length !== options.length) select.replaceChildren(...options.map(n => new Option(String(n), String(n))));
  select.value = String(chosen);
  select.disabled = busy || settingsLoading || wizardOpen || inviteSlots === 0;
  el<HTMLButtonElement>('create-guest-invite').textContent = generateLabel(chosen);
  if (inviteSlots === 0) el<HTMLButtonElement>('create-guest-invite').disabled = true;
}
async function copyInvite(id: string): Promise<void> {
  try { const value = await window.blastcast.copyGuestInvite(id); note.textContent = value.ok ? 'Link copied. Share it privately with your guest.' : value.message ?? 'Link could not be copied.'; }
  catch { note.textContent = 'Link could not be copied. Select the invitation field and copy it.'; }
}
function renderDirect(value: DirectAccessStatus): void {
  lastDirectStatus = value;
  const guestDirect = lastGuestStatus?.ok && lastGuestStatus.readiness
    ? lastGuestStatus.readiness.routeType === 'direct'
    : routeType.value === 'direct';
  const guestActive = lastGuestStatus?.ok && (lastGuestStatus.phase === 'outside-check' || lastGuestStatus.phase === 'ready');
  const card = el('direct-access-card');
  card.hidden = !guestDirect;
  const planBox = el('direct-access-plan');
  planBox.hidden = !value.plan;
  const status = el('direct-access-status');
  status.classList.toggle('error', !value.ok);
  status.textContent = value.lease
    ? `${value.message} Router address ${value.lease.externalAddress}:${value.lease.externalPort}; expires by ${new Date(value.lease.expiresAt).toLocaleTimeString()}.`
    : value.message;
  if (value.plan) {
    el('direct-access-summary').textContent = `${value.plan.protocol} via gateway ${value.plan.gateway}: public ${value.plan.transport} ${value.plan.publicPort} → this computer ${value.plan.localAddress}:${value.plan.localProxyPort}. Requested lifetime: ${value.plan.requestedLifetimeSeconds / 60} minutes.`;
    el('direct-guest-target').textContent = value.plan.guestTarget;
  } else {
    el('direct-access-summary').textContent = '';
    el('direct-guest-target').textContent = `127.0.0.1:${port.value}`;
  }
  el<HTMLButtonElement>('show-direct-access').disabled = busy || !guestDirect || !guestActive || value.phase === 'active' || value.phase === 'cleanup-pending';
  el<HTMLButtonElement>('approve-direct-access').disabled = busy || value.phase !== 'planned';
}
async function action(run: () => Promise<GuestStatus>, message: string): Promise<void> {
  if (busy) return;
  const generation = ++actionGeneration;
  busy = true; renderHelper(); note.classList.remove('error'); note.textContent = message;
  el<HTMLButtonElement>('check-guest-route').disabled = true;
  el<HTMLButtonElement>('create-guest-invite').disabled = true;
  el<HTMLButtonElement>('copy-all-guest-invites').disabled = true; el<HTMLSelectElement>('guest-invite-count').disabled = true;
  for (const b of el('guest-invite-list').querySelectorAll<HTMLButtonElement>('button')) b.disabled = true;
  el<HTMLButtonElement>('revoke-guest-invites').disabled = true;
  el<HTMLButtonElement>('stop-guests').disabled = false;
  try {
    const value = await run();
    if (generation !== actionGeneration) return;
    const direct = await window.blastcast.directAccessStatus();
    if (generation !== actionGeneration) return;
    if (value.ok) {
      render(value);
      renderDirect(direct);
      note.textContent = value.invite ? `Invitation expires at ${new Date(value.invite.expiresAt).toLocaleTimeString()}. Copy it to share privately.`
        : value.phase === 'ready' ? 'Guest connection ready.'
        : value.phase === 'outside-check' ? 'Copy the private check link and open it on a different network.'
        : value.phase === 'blocked' ? value.readiness.diagnosis?.message ?? 'The readiness check is blocked.'
        : 'Guest access is off; all previous links are closed.';
    } else {
      const current = await window.blastcast.guestStatus();
      if (generation !== actionGeneration) return;
      render(current);
      renderDirect(direct);
      note.textContent = value.message;
      note.classList.add('error');
    }
  } catch { if (generation === actionGeneration) note.textContent = 'Guest controls could not respond. Reopen the studio and retry.'; }
  finally { if (generation === actionGeneration) { busy = false; renderHelper(); if (lastGuestStatus) render(lastGuestStatus); } }
}
async function directAction(run: () => Promise<DirectAccessStatus>, message: string): Promise<void> {
  if (busy) return;
  busy = true;
  el('direct-access-status').classList.remove('error');
  el('direct-access-status').textContent = message;
  el<HTMLButtonElement>('check-guest-route').disabled = true;
  renderDirect(lastDirectStatus);
  try {
    const value = await run();
    busy = false;
    renderDirect(value);
  } catch {
    busy = false;
    renderDirect(lastDirectStatus);
    el('direct-access-status').textContent = 'Temporary router access could not respond. Turn guest access off before retrying.';
    el('direct-access-status').classList.add('error');
  } finally {
    el<HTMLButtonElement>('check-guest-route').disabled = false;
  }
}
el('guest-toolbar').addEventListener('click', () => {
  panel.hidden = false; el('guest-toolbar').setAttribute('aria-expanded', 'true');
  el<HTMLButtonElement>('create-guest-invite').focus();
  const generation = actionGeneration;
  void Promise.all([window.blastcast.guestStatus(), window.blastcast.directAccessStatus()])
    .then(([guest, direct]) => { if (generation === actionGeneration && !busy) { render(guest); renderDirect(direct); } }).catch(() => {});
});
function renderRouteNote(): void {
  const target = document.createElement('strong');
  target.id = 'guest-target';
  target.textContent = `127.0.0.1:${port.value}`;
  const prefix = routeType.value !== 'direct' ? 'Point the HTTPS tunnel/provider at ' : 'Forward that address to ';
  const suffix = routeType.value !== 'direct'
    ? '. HTTPS readiness does not prove the media route; check the call separately.'
    : ' on this computer through a valid local HTTPS proxy, preserving the guest hostname. BlastCast never maps this plain loopback listener directly.';
  el('guest-route-note').replaceChildren(document.createTextNode(prefix), target, document.createTextNode(suffix));
  el('direct-guest-target').textContent = `127.0.0.1:${port.value}`;
}
function renderHelper(): void {
  const domain = el<HTMLSelectElement>('helper-domain').value === 'yes';
  el('guest-wizard').hidden = !wizardOpen;
  el('guest-domain-step').hidden = wizardStep !== 0;
  el('helper-setup').hidden = wizardStep !== 1;
  el('guest-relay-step').hidden = wizardStep !== 2;
  el('guest-wizard-step-label').textContent = `${wizardStep + 1} of 3`;
  el('guest-wizard-back').hidden = wizardStep === 0;
  el('guest-wizard-next').hidden = wizardStep === 2;
  el('save-guest-settings').hidden = wizardStep !== 2;
  el('helper-steps').hidden = false;
  // ClaudeBWAI — the no-domain path shows its own steps and none of the Cloudflare material.
  for (const id of ['cloudflare-ready-figure','cloudflare-route-form-figure','cloudflare-route-ready-figure','helper-domain-note']) el(id).hidden = !domain;
  el('helper-reference-wrap').hidden = !domain;
  el('cloudflare-privacy-note').hidden = !domain;
  // ClaudeBWAI — the free route's amber privacy notice: Save & generate stays off until it is ticked.
  el('free-privacy').hidden = domain || wizardStep !== 2 || el<HTMLSelectElement>('helper-domain').value !== 'no';
  const freeUntick = !domain && !el<HTMLInputElement>('free-privacy-ack').checked;
  el('wizard-guest-origin-label').hidden = !domain;
  el('relay-saved-note').hidden = !saved?.credentialSaved;
  el('helper-provider').textContent = domain ? 'Connect your domain with Cloudflare Tunnel.' : 'BlastCast uses localhost.run Free to generate a temporary HTTPS address. No account or domain purchase is needed.';
  // Adapted from the official Cloudflare remotely-managed tunnel guide, checked 2026-09-29.
  const instructions = !domain ? [
    'Nothing to install or sign up for. When you click Save & generate, BlastCast opens a temporary public address for you through localhost.run, using this computer\'s built-in OpenSSH.',
    'The address is inside the invite link, and under Troubleshooting → Guest address. It works only while BlastCast stays open.',
    'Next: paste your ExpressTURN details. That is the only thing to fill in.',
    'The address changes every session, so generate a new invite each time.',
    'If it fails: make sure the OpenSSH Client is installed (Windows: Settings → System → Optional features → OpenSSH Client) and that your network allows outgoing SSH.',
  ] : [
    'Add your domain to Cloudflare. In Networking → Tunnels, create a named tunnel.',
    'Follow the dashboard instructions to run cloudflared on this computer. Wait for the tunnel to connect.',
    `Open Routes, click Add route, choose Published application, and use http://127.0.0.1:${port.value} as the Service URL. Leave Path empty and keep the additional settings at their defaults.`,
  ];
  el('helper-steps').replaceChildren(...instructions.map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
  el('helper-recovery').textContent = domain ? 'Keep cloudflared running during the session.' : 'The temporary address may change next time. Generate a new invitation when starting another session.';
  el('guest-settings-summary').textContent = settingsProblem ? 'Saved guest settings are unavailable. Edit settings to replace them, or forget them.' : saved ? (saved.domain === 'yes' ? `Saved: ${saved.origin} + ExpressTURN Free.` : 'Saved: temporary guest address + ExpressTURN Free.')
    : settingsLoading ? 'Loading guest settings…' : 'Set up once to generate guest links.';
  el('forget-guest-settings').hidden = (!saved && !settingsProblem) || wizardOpen;
  for (const id of ['create-guest-invite','edit-guest-settings','forget-guest-settings']) el<HTMLButtonElement>(id).disabled = busy || settingsLoading || wizardOpen;
  for (const id of ['guest-wizard-next','guest-wizard-back','guest-wizard-cancel','save-guest-settings','confirm-forget-guest-settings']) el<HTMLButtonElement>(id).disabled = busy;
  el<HTMLButtonElement>('save-guest-settings').disabled = busy || freeUntick;
  el<HTMLInputElement>('free-privacy-ack').disabled = busy;
  el<HTMLSelectElement>('helper-domain').disabled = busy;
  routeType.disabled = port.disabled = origin.disabled = busy;
  el<HTMLButtonElement>('check-guest-route').disabled = busy;
}
function restoreSettings(): void {
  el<HTMLSelectElement>('helper-domain').value = saved?.domain ?? '';
  origin.value = saved?.origin ?? '';
  port.value = String(saved?.port ?? 43821);
  el<HTMLTextAreaElement>('relay-urls').value = saved?.helper.relay.urls.join('\n') ?? '';
  el<HTMLInputElement>('relay-username').value = saved?.helper.relay.username ?? '';
  el<HTMLInputElement>('relay-password').value = '';
  el<HTMLInputElement>('relay-free').checked = Boolean(saved?.helper.freeAccountConfirmed);
  el<HTMLInputElement>('free-privacy-ack').checked = Boolean(saved?.freeRouteAcknowledged);
  el<HTMLInputElement>('relay-only').checked = saved?.helper.relay.iceTransportPolicy === 'relay';
}
function openWizard(): void {
  if (busy || settingsLoading) return;
  automation.cancel(); restoreSettings(); wizardOpen = true; wizardStep = 0;
  el('guest-wizard-status').textContent = settingsProblem; el('guest-forget-confirm').hidden = true;
  renderHelper(); el<HTMLSelectElement>('helper-domain').focus();
}
function cancelWizard(): void {
  if (busy) return;
  restoreSettings(); wizardOpen = false; renderHelper(); el<HTMLButtonElement>('create-guest-invite').focus();
}
async function loadSettings(): Promise<boolean> {
  if (settingsLoading) return false;
  settingsLoading = true; renderHelper();
  try {
    const result = await window.blastcast.loadGuestSettings();
    if (!result.ok) { settingsProblem = result.message; note.textContent = result.message; return false; }
    settingsProblem = ''; saved = result.settings; settingsLoaded = true; return true;
  } catch { settingsProblem = 'Saved guest settings could not be loaded. Enter new credentials to replace them, or forget the saved settings.'; note.textContent = settingsProblem; return false; }
  finally { settingsLoading = false; renderHelper(); }
}
function cancelAutomaticInvite(): void { automation.cancel(); }
port.addEventListener('input', () => { cancelAutomaticInvite(); renderRouteNote(); renderHelper(); });
el('helper-domain').addEventListener('change', () => { cancelAutomaticInvite(); renderHelper(); });
el('free-privacy-ack').addEventListener('change', renderHelper);
routeType.addEventListener('change', () => { cancelAutomaticInvite(); renderRouteNote(); renderDirect(lastDirectStatus); });
origin.addEventListener('input', cancelAutomaticInvite);
function wizardError(message: string): void { el('guest-wizard-status').textContent = message; }
function helperInput(): HelperInput | null {
  const domain = el<HTMLSelectElement>('helper-domain').value;
  if (domain !== 'yes' && domain !== 'no') { wizardError('Choose whether you have a domain first.'); return null; }
  if (domain === 'no' && !el<HTMLInputElement>('free-privacy-ack').checked) { wizardError('Tick the privacy notice to use the free address.'); return null; }
  if (!el<HTMLInputElement>('relay-free').checked) { wizardError('Confirm that this is your Free account.'); return null; }
  const relayUrls = el<HTMLTextAreaElement>('relay-urls');
  const urls = relayUrls.value.split(/\r?\n/).map(normalizeExpressTurnAddress).filter(Boolean);
  relayUrls.value = urls.join('\n');
  const username = el<HTMLInputElement>('relay-username').value;
  const credential = el<HTMLInputElement>('relay-password').value;
  const canKeepPassword = !settingsProblem && saved?.credentialSaved && saved.helper.relay.username === username && JSON.stringify(saved.helper.relay.urls) === JSON.stringify(urls);
  if (!urls.length || !username.trim() || (!credential && !canKeepPassword)) { wizardError('Enter your ExpressTURN addresses, username and allocation password.'); return null; }
  return {provider: domain === 'yes' ? 'cloudflare' : 'localhost-run',freeAccountConfirmed:true,
    relay:{urls,username,credential,iceTransportPolicy:el<HTMLInputElement>('relay-only').checked ? 'relay' : 'all'}};
}
function normalizeRelayField(): void {
  const field = el<HTMLTextAreaElement>('relay-urls');
  const before = field.value;
  field.value = before.split(/\r?\n/).map(normalizeExpressTurnAddress).join('\n');
  if (field.value !== before) wizardError('TURN address format completed automatically.');
}
el('relay-urls').addEventListener('change', normalizeRelayField);
for (const [id, provider] of [['helper-reference', 'cloudflare'], ['expressturn-reference', 'expressturn']] as const) {
  el<HTMLAnchorElement>(id).addEventListener('click', event => {
    event.preventDefault();
    void window.blastcast.openGuestProvider(provider).then(result => {
      if (!result.ok) wizardError(result.message ?? 'The provider website could not open.');
    }).catch(() => wizardError('The provider website could not open.'));
  });
}
function startSetup(run: () => Promise<GuestStatus>, message: string): void {
  if (busy) return;
  const setup = automation.begin(); el<HTMLInputElement>('guest-invite').value = '';
  const want = clampInviteCount(Number(el<HTMLSelectElement>('guest-invite-count').value), inviteSlots); pendingWant = want;
  void action(async () => {
    let result = await run(); automation.accept(setup,result);
    // The saved-settings road makes the first invitation; the rest of the batch follows as one call (the main process refuses an over-limit count whole).
    if (result.ok && want > 1 && result.phase === 'ready' && result.invite) { pendingWant = 1; result = await window.blastcast.createGuestInvites(want - 1); }
    return result;
  },message);
}
function generateSaved(): void { startSetup(() => window.blastcast.generateSavedGuestInvite(), 'Generating your invitation…'); }
el('create-guest-invite').addEventListener('click', async () => {
  if (busy || settingsLoading || wizardOpen) return;
  if (!settingsLoaded && !await loadSettings()) { openWizard(); return; }
  if (!saved) { openWizard(); return; }
  // ClaudeBWAI — guest access already running: the whole batch is one main-process call, created whole or refused whole.
  if (lastPhase === 'ready') {
    const want = clampInviteCount(Number(el<HTMLSelectElement>('guest-invite-count').value), inviteSlots);
    void action(() => want > 1 ? window.blastcast.createGuestInvites(want) : window.blastcast.createGuestInvite(), want > 1 ? 'Creating your invitations…' : 'Creating your invitation…');
    return;
  }
  generateSaved();
});
el('edit-guest-settings').addEventListener('click', async () => { if (!settingsLoaded) await loadSettings(); openWizard(); });
el('guest-wizard-cancel').addEventListener('click', cancelWizard);
el('guest-wizard-back').addEventListener('click', () => { if (!busy && wizardStep > 0) { wizardStep--; wizardError(''); renderHelper(); } });
el('guest-wizard-next').addEventListener('click', () => {
  if (busy) return;
  const answer = el<HTMLSelectElement>('helper-domain').value;
  if (answer !== 'yes' && answer !== 'no') { wizardError('Choose Yes or No to continue.'); return; }
  if (wizardStep === 1 && answer === 'yes') {
    try { const url = new URL(origin.value.trim()); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(); }
    catch { wizardError('Enter your public HTTPS hostname, for example https://guests.yourdomain.com.'); return; }
  }
  wizardStep = Math.min(2,wizardStep+1); wizardError(''); renderHelper();
});
el('save-guest-settings').addEventListener('click', async () => {
  if (busy || !wizardOpen || wizardStep !== 2) return;
  const helper = helperInput(); if (!helper) return;
  const input = {domain:el<HTMLSelectElement>('helper-domain').value as 'yes' | 'no',origin:helper.provider === 'cloudflare' ? origin.value.trim() : '',port:Number(port.value),helper,freeRouteAcknowledged:helper.provider === 'localhost-run' && el<HTMLInputElement>('free-privacy-ack').checked};
  const generation = ++actionGeneration;
  busy = true; renderHelper(); wizardError('Saving guest settings…');
  try {
    const result = await window.blastcast.saveGuestSettings(input);
    if (generation !== actionGeneration) { settingsLoaded = false; return; }
    if (!result.ok) { wizardError(result.message); return; }
    if (!result.settings) { wizardError('Settings were not saved. Please try again.'); return; }
    settingsProblem = ''; saved = result.settings; settingsLoaded = true; el<HTMLInputElement>('relay-password').value = '';
    wizardOpen = false; wizardError(''); busy = false; renderHelper(); generateSaved();
  } catch { if (generation === actionGeneration) wizardError('Settings could not be saved. Your previous settings remain available.'); }
  finally { if (generation === actionGeneration && wizardOpen) { busy = false; renderHelper(); } }
});
el('forget-guest-settings').addEventListener('click', () => { if (!busy) el('guest-forget-confirm').hidden = false; });
el('cancel-forget-guest-settings').addEventListener('click', () => { el('guest-forget-confirm').hidden = true; });
el('confirm-forget-guest-settings').addEventListener('click', async () => {
  if (busy) return;
  busy = true; automation.cancel(); renderHelper();
  try { const result = await window.blastcast.clearGuestSettings();
    if (!result.ok) { note.textContent = result.message; return; }
    settingsProblem = ''; saved = result.settings; settingsLoaded = true; restoreSettings(); el('guest-forget-confirm').hidden = true; note.textContent = 'Saved guest settings forgotten. Provider accounts were not changed.';
  } catch { note.textContent = 'Saved settings could not be forgotten. Try again.'; }
  finally { busy = false; renderHelper(); }
});
el('check-guest-route').addEventListener('click', () => {
  if (busy) return;
  renderRouteNote();
  startSetup(() => window.blastcast.configureGuests({origin:el<HTMLInputElement>('guest-manual-origin').value.trim(),port:Number(port.value),routeType:routeType.value === 'direct' ? 'direct' : 'tunnel'}), 'Checking the manual route…');
});
el('revoke-guest-invites').addEventListener('click', () => { cancelAutomaticInvite(); void action(() => window.blastcast.revokeGuestInvites(), 'Closing invitations…'); });
el('stop-guests').addEventListener('click', () => {
  cancelAutomaticInvite(); actionGeneration++; busy = false;
  void action(() => window.blastcast.stopGuests(), 'Turning guest access off…');
});
el('guest-invite-count').addEventListener('change', renderInviteCount);
el('copy-all-guest-invites').addEventListener('click', async () => {
  try { const value = await window.blastcast.copyAllGuestInvites(); note.textContent = value.ok ? 'Links copied. Share each one privately with its own guest.' : value.message ?? 'Links could not be copied.'; }
  catch { note.textContent = 'Links could not be copied. Copy each one with its own button.'; }
});
el('copy-guest-readiness').addEventListener('click', async () => {
  try { const value = await window.blastcast.copyGuestReadiness(); note.textContent = value.ok ? 'Private check link copied. Open it only on the outside device.' : value.message ?? 'Check link could not be copied.'; }
  catch { note.textContent = 'Check link could not be copied. Select the private link field and copy it.'; }
});
el('fail-guest-readiness').addEventListener('click', () => { cancelAutomaticInvite(); void action(() => window.blastcast.failGuestReadiness(), 'Ending this outside-network check…'); });
el('show-direct-access').addEventListener('click', () => void directAction(() => window.blastcast.prepareGuestDirectAccess(), 'Reading the current default gateway; no router request has been sent…'));
el('approve-direct-access').addEventListener('click', () => void directAction(() => window.blastcast.approveGuestDirectAccess(), 'Requesting the exact temporary router access you approved…'));
setInterval(() => {
  if (!busy) {
    const generation = actionGeneration;
    void Promise.all([window.blastcast.guestStatus(), window.blastcast.directAccessStatus()])
      .then(([guest,direct]) => { if (generation === actionGeneration && !busy) { render(guest); renderDirect(direct); } }).catch(() => {});
  }
}, 2000);

renderHelper();

void loadSettings();
