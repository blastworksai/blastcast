// CodexBWAI — mixed output and original-source completeness remain independent.
// ClaudeBWAI — quit policy. Retune ONLY here: how long a silent guest still counts as able to deliver.
const STALE_MS = 2 * 60 * 1000;
// A source can still deliver only if its participant is admitted AND has produced a chunk/begin/finish within STALE_MS
// (guests.status().alive is invitation validity, not a live connection, so activity is the reliable signal).
// The host is local: it counts only while its own source is not incomplete and recently active.
const admittedGuest = g => g.alive && !g.revoked && g.phase === 'admitted' && g.session && g.originalsUnsupported !== true;
// ClaudeBWAI — a guest whose page has gone (guests.cjs presence 'disconnected') is left out of a new take's roster.
const liveAdmitted = g => admittedGuest(g) && g.presence !== 'disconnected';
function closePolicy({ busy = false, state, guests = [], staleMs = STALE_MS }) {
  if (busy) return { kind: 'block', reason: 'recording', canClose: false, incomplete: [], recovered: false };
  if (!state || (state.phase === 'closed' && !state.closing) || (state.allSourcesComplete && !state.closing)) {
    return { kind: 'idle', reason: 'none', canClose: true, incomplete: [], recovered: false };
  }
  if (state.closing) return { kind: 'block', reason: 'closing', canClose: false, incomplete: [], recovered: false };
  // ClaudeBWAI — Codex review of 68ea271 (P1): delivery safety follows source activity, never the UI's presence row. An
  // admitted guest can still deliver while an original request is in flight (uploading) or within STALE_MS of their last
  // stored piece, whatever presence says: a backgrounded phone can hold one upload open past the presence timeout.
  const admitted = new Map((guests || []).filter(admittedGuest).map(g => [g.session.id, g]));
  const incomplete = (state.sources || []).filter(s => s.phase !== 'complete').map(s => ({
    id: s.participantId, label: s.label,
    connected: !state.recovered && (s.participantId === 'host' || admitted.has(s.participantId)) &&
      (admitted.get(s.participantId)?.uploading === true || (typeof s.idleMs === 'number' && s.idleMs <= staleMs)),
  }));
  const recovered = Boolean(state.recovered);
  const overdue = state.incompleteOverrideInMs === 0;
  const canClose = recovered || overdue || incomplete.every(s => !s.connected);
  return { kind: 'ask', reason: recovered ? 'recovered' : overdue ? 'overdue' : canClose ? 'nobody-can-deliver' : 'guest-connected', canClose, incomplete, recovered };
}
// Wording einh reviews: one place.
function closeDialog(policy) {
  if (policy.kind === 'block') return { message: policy.reason === 'closing'
    ? 'BlastCast is still closing the original files. Keep it open for a moment.'
    : 'The episode is still recording or saving. Stop the recording and wait for it to save first.', buttons: ['Keep BlastCast open'] };
  const lines = policy.incomplete.map(s => `- ${s.label}: ${s.connected ? 'still connected, upload may continue' : 'not connected'}`).join('\n');
  const head = 'Your episode is saved, but these original recordings are not finished:\n' + lines + '\n\n';
  if (policy.canClose) return { message: 'Some original recordings are not finished.',
    detail: head + 'If you close now, the unfinished originals are kept as partial files and marked incomplete. Nothing is deleted. Your mixed episode is not affected.',
    buttons: ['Keep BlastCast open', 'Close and keep partial originals'] };
  return { message: 'Guests are still sending their original recordings.',
    detail: head + 'Ask each connected guest to keep their page open until it finishes. If they have already left, BlastCast will offer to close within about 2 minutes of their last upload.',
    buttons: ['Keep BlastCast open'] };
}
function createSourceController({ recording, sources, guests, confirmIncomplete = async () => false, now = () => performance.now() }) {
  let beginning = false;
  let ended = null;
  const OVERRIDE_WAIT = 60 * 60 * 1000;
  const failed = message => ({ ok: false, message });
  const sourceBusy = () => { const state = sources.status(); return Boolean(state && (state.closing || (state.phase !== 'closed' && !state.allSourcesComplete))); };
  function baseStatus() {
    const state = sources.status();
    if (!state) return null;
    // A recovered episode cannot be reached by any guest (the admission store is fresh): no wait, only a confirmation.
    if (state.recovered && state.phase !== 'closed' && !state.allSourcesComplete) return { ...state, incompleteOverrideInMs: 0 };
    const elapsed = ended?.id === state.episodeId ? now() - ended.at : null;
    return { ...state, incompleteOverrideInMs: elapsed === null ? null : Math.max(0, OVERRIDE_WAIT + 1 - elapsed) };
  }
  // ClaudeBWAI — the in-studio Finish follows the same rule as the close dialog: the hour is only the last resort
  // when a connected guest is still sending; nobody able to deliver means no wait (behind the confirmation).
  const policyFor = state => closePolicy({ busy: beginning || recording.isBusy(), state, guests: guests.status().guests });
  function sourceStatus() {
    const state = baseStatus();
    if (!state) return null;
    const policy = policyFor(state);
    return { ...state, canFinishIncomplete: policy.kind === 'ask' && policy.canClose, finishReason: policy.reason };
  }
  async function endProduction(method, id) {
    stopSources(id);
    try { return await recording[method](id); }
    finally {
      // The wait begins after production has finished saving/aborting, never at Record or Stop.
      if (!recording.isBusy() && sources.status()?.episodeId === id && ended?.id !== id) ended = { id, at: now() };
    }
  }
  function stopSources(id) {
    const state = sources.status();
    if (state?.episodeId === id && state.phase === 'recording') {
      // stopEpisode changes control state synchronously. A stalled metadata write
      // must not prevent the independent mixed recording from finalizing.
      try { void Promise.resolve(sources.stopEpisode(id)).catch(() => {}); }
      catch { /* Original status stays unresolved, never complete. */ }
    }
  }
  return {
    sourceStatus,
    closeAdvice: () => policyFor(baseStatus()),
    // The quit dialog is the confirmation; policy is re-checked here and nothing is deleted.
    async closeForQuit() {
      const policy = policyFor(baseStatus());
      if (policy.kind === 'idle') return { ok: true };
      if (!policy.canClose) return failed('Originals may still arrive. Keep BlastCast open.');
      return sources.closeEpisode(baseStatus().episodeId);
    },
    busy: () => beginning || recording.isBusy() || sourceBusy(),
    async begin() {
      if (beginning || recording.isBusy()) return failed('A recording is already active.');
      beginning = true;
      try {
        const previous = sources.status();
        if (previous?.closing) return failed('Original files are still closing. Keep the studio open.');
        if (previous && previous.phase !== 'closed') {
          if (!previous.allSourcesComplete) return failed('Finish the previous originals before starting another episode. Missing originals stay incomplete.');
          const closed = await sources.closeEpisode(previous.episodeId);
          if (!closed.ok) return closed;
        }
        const begun = await recording.begin();
        if (!begun.ok) return begun;
        try {
          const roster = [{ id: 'host', label: 'Host' }, ...guests.status().guests
            .filter(liveAdmitted) // a guest whose browser cannot record an original is not in the roster (admittedGuest)
            .map(g => ({ id: g.session.id, label: g.session.name }))];
          const result = await sources.beginEpisode({ id: begun.id, participants: roster });
          if (!result.ok) { await recording.abort(begun.id); if (sources.status()?.episodeId === begun.id) await sources.closeEpisode(begun.id); return result; }
          ended = null;
          return begun;
        } catch {
          await recording.abort(begun.id);
          return failed('Original recording files could not be prepared. Any partial files are retained.');
        }
      } finally { beginning = false; }
    },
    finish: id => endProduction('finish', id),
    abort: id => endProduction('abort', id),
    async closeSources() {
      if (beginning || recording.isBusy()) return failed('Stop the episode recording before finishing originals.');
      const state = baseStatus();
      if (!state || (state.phase === 'closed' && !state.closing)) return { ok: true };
      if (!state.allSourcesComplete && !state.closing && !policyFor(state).canClose) {
        return failed('A connected guest is still sending their original. Keep the studio open until it arrives or they leave.');
      }
      if (!state.allSourcesComplete && !state.closing && !await confirmIncomplete()) return failed('Originals are still pending. Keep the studio and guest pages open.');
      // The confirmation dialog waited on the host: re-check that nobody started delivering again meanwhile.
      if (!state.allSourcesComplete && !state.closing && !policyFor(baseStatus()).canClose) {
        return failed('A connected guest is still sending their original. Keep the studio open until it arrives or they leave.');
      }
      return sources.closeEpisode(state.episodeId);
    },
  };
}
module.exports = { createSourceController, closePolicy, closeDialog, STALE_MS };
