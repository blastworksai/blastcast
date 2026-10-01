// CodexBWAI — display names only; no path or original/synchronization claims cross this view.
export type LibraryEntry = { id: string; name: string; label: string; createdAt: number; durationMs: number };
type Result = { ok: boolean; message?: string };
export interface RecordingLibraryBridge {
  listRecordings(): Promise<Result & { recordings?: LibraryEntry[] }>;
  renameRecording(id: string, label: string): Promise<Result>;
  openLibraryRecording(id: string): Promise<Result>;
}
export function mountRecordingLibrary(container: HTMLElement, bridge: RecordingLibraryBridge) {
  const title = document.createElement('h3'); title.textContent = 'Saved recordings';
  const message = document.createElement('p'); message.setAttribute('role', 'status');
  const list = document.createElement('div'), details = document.createElement('div');
  container.append(title, message, list, details);
  let selected: string | null = null, generation = 0, disposed = false, busy = false;
  let entries: LibraryEntry[] = [];
  function select(entry: LibraryEntry) {
    selected = entry.id; details.replaceChildren();
    const heading = document.createElement('h4'); heading.textContent = entry.label;
    const meta = document.createElement('p'); meta.className = 'bc-meta';
    meta.textContent = `${new Date(entry.createdAt).toLocaleString()} · ${Math.floor(entry.durationMs / 60000)}:${String(Math.floor(entry.durationMs / 1000) % 60).padStart(2,'0')} · ${entry.name}`;
    const input = document.createElement('input'); input.className = 'bc-input'; input.value = entry.label; input.maxLength = 160; input.setAttribute('aria-label','Recording display name');
    const save = document.createElement('button'); save.textContent = 'Save name'; save.className = 'bc-btn bc-btn--secondary';
    const open = document.createElement('button'); open.textContent = 'Open video'; open.className = 'bc-btn bc-btn--secondary';
    const note = document.createElement('p'); note.className = 'bc-meta'; note.textContent = 'Only the display name changes. Recording filenames and recovery data stay unchanged.';
    async function action(fn: () => Promise<Result>) {
      if (busy || disposed) return; busy = true; save.disabled = open.disabled = true;
      try { const result = await fn(); message.textContent = result.ok ? 'Done.' : result.message ?? 'Action could not complete.'; if (result.ok) await refresh(); }
      catch { message.textContent = 'The recording library could not be reached. Your files were kept.'; }
      finally { busy = false; save.disabled = open.disabled = false; }
    }
    save.addEventListener('click', () => void action(() => bridge.renameRecording(entry.id,input.value)));
    open.addEventListener('click', () => void action(() => bridge.openLibraryRecording(entry.id)));
    details.append(heading,meta,input,save,open,note);
  }
  async function refresh() {
    const turn = ++generation;
    try {
      const result = await bridge.listRecordings(); if (disposed || turn !== generation) return;
      if (!result.ok) { message.textContent = result.message ?? 'The recording library could not be loaded.'; return; }
      entries = result.recordings ?? []; container.dataset.count=String(entries.length); message.textContent = ''; list.replaceChildren();
      for (const entry of entries) { const button = document.createElement('button'); button.className = 'bc-btn bc-btn--ghost'; button.textContent = `${entry.label} · ${new Date(entry.createdAt).toLocaleString()}`; button.addEventListener('click', () => { if (!busy) select(entry); }); list.append(button); }
      const current = entries.find(e => e.id === selected) ?? entries[0];
      if (current) select(current); else { details.replaceChildren(); message.textContent = 'Completed recordings will appear here.'; }
    } catch { if (!disposed && turn === generation) message.textContent = 'The recording library could not be loaded. Your files were kept.'; }
  }
  void refresh();
  return { refresh, destroy() { disposed = true; generation++; container.replaceChildren(); } };
}
