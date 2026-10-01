// CodexBWAI — mixed output and original-source completeness remain independent.
function createSourceController({ recording, sources, guests, confirmIncomplete = async () => false, now = () => performance.now() }) {
  let beginning = false;
  let ended = null;
  const OVERRIDE_WAIT = 60 * 60 * 1000;
  const failed = message => ({ ok: false, message });
  const sourceBusy = () => { const state = sources.status(); return Boolean(state && (state.closing || (state.phase !== 'closed' && !state.allSourcesComplete))); };
  function sourceStatus() {
    const state = sources.status();
    if (!state) return null;
    if (state.recovered && state.phase !== 'closed' && !state.allSourcesComplete && ended?.id !== state.episodeId) {
      ended = { id:state.episodeId, at:now() };
    }
    const elapsed = ended?.id === state.episodeId ? now() - ended.at : null;
    return { ...state, incompleteOverrideInMs: elapsed === null ? null : Math.max(0, OVERRIDE_WAIT + 1 - elapsed) };
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
            .filter(g => g.alive && !g.revoked && g.phase === 'admitted' && g.session)
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
      const state = sourceStatus();
      if (!state || (state.phase === 'closed' && !state.closing)) return { ok: true };
      if (!state.allSourcesComplete && !state.closing && state.incompleteOverrideInMs !== 0) {
        return failed('Keep the studio open until all originals arrive. An override becomes available only after more than an hour has passed since production finished.');
      }
      if (!state.allSourcesComplete && !state.closing && !await confirmIncomplete()) return failed('Originals are still pending. Keep the studio and guest pages open.');
      return sources.closeEpisode(state.episodeId);
    },
  };
}
module.exports = { createSourceController };
