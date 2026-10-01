/** CodexBWAI — presentation-only shell for the supplied studio redesign.
 * Status remains owned by the capture, admission and recording controllers. */
export interface StudioShell {
  updateRecording(phase: string): void;
  confirmStop(): Promise<boolean>;
}
export function initStudioShell(): StudioShell {
  const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const value = document.getElementById(id);
    if (!value) throw new Error(`Missing studio shell element: ${id}`);
    return value as T;
  };
  const dialog = el<HTMLDialogElement>('studio-settings');
  const guestDialog = el<HTMLDialogElement>('guest-connection');
  const guests = el('guest-panel');
  const invite = el<HTMLButtonElement>('guest-toolbar');
  const showSettings = (): void => { if (!dialog.open) dialog.showModal(); };
  el('open-settings').addEventListener('click', showSettings);
  el('close-settings').addEventListener('click', () => dialog.close());
  const closeGuests = (): void => {
    guests.hidden = true;
    invite.setAttribute('aria-expanded', 'false');
  };
  guestDialog.addEventListener('close', closeGuests);
  invite.addEventListener('click', () => { if (!guestDialog.open) guestDialog.showModal(); }, { capture: true });
  el('close-guest-connection').addEventListener('click', () => guestDialog.close());
  const tabs = [el<HTMLButtonElement>('guests-tab'), el<HTMLButtonElement>('recordings-tab')];
  const panes = [el('guests-pane'), el('recordings-pane')];
  const selectTab = (index: number): void => {
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panes[i]!.hidden = i !== index;
    });
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(i));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - i;
      selectTab(next); tabs[next]!.focus();
    });
  });
  const text = (id: string, value: string): void => {
    if (el(id).textContent !== value) el(id).textContent = value;
  };
  let recordingPhase = 'idle';
  let startedAt = 0;
  let elapsedMs = 0;
  const renderClock = (): void => {
    const elapsed = recordingPhase === 'recording' ? performance.now() - startedAt : elapsedMs;
    const seconds = Math.floor(elapsed / 1000);
    text('recording-clock', [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map(value => String(value).padStart(2, '0')).join(':'));
  };
  const clock = window.setInterval(renderClock, 250);
  const stopDialog = el<HTMLDialogElement>('stop-confirmation');
  let resolveStop: ((value: boolean) => void) | null = null;
  const finishStop = (value: boolean): void => {
    const resolve = resolveStop; resolveStop = null;
    if (stopDialog.open) stopDialog.close();
    resolve?.(value);
  };
  el('keep-recording').addEventListener('click', () => finishStop(false));
  el('confirm-stop-recording').addEventListener('click', () => finishStop(true));
  stopDialog.addEventListener('cancel', event => { event.preventDefault(); finishStop(false); });
  // A queued close from an earlier prompt must not dismiss a newly opened one.
  stopDialog.addEventListener('close', () => { if (!stopDialog.open) finishStop(false); });
  const hidden = (id: string, value: boolean): void => {
    if (el(id).hidden !== value) el(id).hidden = value;
  };
  const sync = (): void => {
    const recording = recordingPhase === 'recording';
    hidden('recording-live', !recording);
    text('shell-status', recording ? 'Recording' : recordingPhase === 'finalizing' ? 'Finalizing…' : el('preview-badge').textContent || 'Devices off');
    const count = el('call-guests').querySelectorAll('.call-row').length;
    text('guest-count', String(count));
    hidden('guest-empty', count > 0 || el('guest-pending').querySelectorAll('.bcast-admission-item').length > 0);
    text('recording-count', document.getElementById('recording-library')?.dataset.count ?? '0');
    // Errors in an inactive tab or a closed settings dialog remain visible in the studio.
    const messages = [...document.querySelectorAll<HTMLElement>('.status.error')]
      .filter(node => node.closest('[hidden]') || node.closest('dialog:not([open])'))
      .map(node => node.textContent?.trim()).filter(Boolean);
    text('shell-errors', [...new Set(messages)].join(' · '));
    hidden('shell-errors', messages.length === 0);
  };
  const observer = new MutationObserver(sync);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['class', 'hidden', 'open', 'data-count'] });
  window.addEventListener('pagehide', () => { observer.disconnect(); window.clearInterval(clock); finishStop(false); }, { once: true });
  sync();
  return {
    updateRecording(phase: string): void {
      if (phase === 'recording' && recordingPhase !== 'recording') { startedAt = performance.now(); elapsedMs = 0; }
      if (phase !== 'recording' && recordingPhase === 'recording') elapsedMs = performance.now() - startedAt;
      recordingPhase = phase;
      if (phase !== 'recording') finishStop(false);
      renderClock(); sync();
    },
    confirmStop(): Promise<boolean> {
      if (recordingPhase !== 'recording' || resolveStop) return Promise.resolve(false);
      return new Promise(resolve => { resolveStop = resolve; stopDialog.showModal(); });
    }
  };
}
