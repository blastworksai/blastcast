// CodexBWAI — main-process storage owns paths, recording identity and durability.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { finalizeWebm, writeAll } = require('./webm.cjs');
const MAX_CHUNK = 8 * 1024 * 1024;
const MAX_BYTES = 16 * 1024 * 1024 * 1024;
function failure(error) {
  if (['ENOSPC', 'EDQUOT'].includes(error?.code)) return 'The drive has no space left. Recording is incomplete; partial files are retained.';
  if (['ENOENT', 'ENOTDIR', 'EIO', 'ENODEV'].includes(error?.code)) return 'The recording destination is unavailable. Recording is incomplete; reconnect the drive.';
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return 'The recording destination is no longer writable. Recording is incomplete.';
  return 'Recording could not be finalized. Partial files are retained; this is not a completed episode.';
}
function createRecordingStore({ folder, io = fs, finalize = finalizeWebm, open = async () => '', onFinalized = async () => ({ok:true}) }) {
  let active = null; let opening = false; let latest = null;
  const bad = message => ({ ok: false, message });
  async function close(state) { if (state.handle) { const h = state.handle; state.handle = null; await h.close(); } }
  async function fail(state, error) {
    state.phase = 'failed'; state.message = state.published
      ? `A finalized file (${state.name}) was written, but cleanup failed. Check your recording folder; extra files are retained.` : failure(error);
    try { await close(state); } catch { state.message += ' The file could not close cleanly.'; }
    return bad(state.message);
  }
  return {
    isBusy: () => opening || Boolean(active && ['recording', 'finalizing'].includes(active.phase)),
    // ClaudeBWAI — the latest recording's identity and target, for the diagnostics log beside it (never a renderer path).
    current: () => active ? { id: active.id, target: active.target, phase: active.phase } : null,
    async begin() {
      if (opening || (active && ['recording', 'finalizing'].includes(active.phase))) return bad('A recording is already active.');
      opening = true;
      try {
        const selected = folder(); if (!selected) return bad('Choose and check a recording folder first.');
        const id = randomUUID();
        const name = `BlastCast-${new Date().toISOString().replace(/[:.]/g, '-')}-${id.slice(0, 8)}.webm`;
        const target = path.join(selected, name);
        const state = { id, name, target, partial: target + '.partial', staging: target + '.finalizing', phase: 'recording', sequence: 0, bytes: 0, writing: false, pending: null };
        state.handle = await io.open(state.partial, 'wx', 0o600);
        active = state; return { ok: true, id, name };
      } catch (error) { return bad(failure(error)); }
      finally { opening = false; }
    },
    async append(id, sequence, value) {
      const state = active;
      if (!state || state.id !== id || state.phase !== 'recording') return bad('This recording is no longer active.');
      if (state.writing || sequence !== state.sequence || !Number.isSafeInteger(sequence) || !(value instanceof ArrayBuffer) || value.byteLength === 0 || value.byteLength > MAX_CHUNK) return bad('Invalid or overlapping recording chunk. Stop recording and retry.');
      if (state.bytes + value.byteLength > MAX_BYTES) return fail(state, new Error('Recording size limit'));
      state.writing = true;
      state.pending = (async () => {
        try {
          await writeAll(state.handle, Buffer.from(value)); await state.handle.sync();
          state.sequence++; state.bytes += value.byteLength;
          return { ok: true, bytes: state.bytes };
        } catch (error) { return fail(state, error); }
        finally { state.writing = false; }
      })();
      return state.pending;
    },
    async finish(id) {
      const state = active;
      if (!state || state.id !== id || state.phase !== 'recording') return bad('No active recording can be finalized.');
      state.phase = 'finalizing';
      if (state.pending) await state.pending;
      if (state.phase === 'failed') return bad(state.message);
      try {
        if (!state.bytes) throw new Error('No media captured');
        await state.handle.sync(); await close(state);
        const details = await finalize(state.partial, state.staging, io);
        // Hard-link publication refuses replacement of any existing output; unlike rename.
        await io.link(state.staging, state.target);
        state.published = true;
        await io.unlink(state.staging);
        // Keep source until the finalized output and cleanup both succeed.
        await io.unlink(state.partial);
        state.phase = 'complete'; latest = { target: state.target, name: state.name };
        const library = await Promise.resolve().then(() => onFinalized({ id:state.id, path:state.target, name:state.name, createdAt:Date.now(), durationMs:Math.round((details?.durationSeconds ?? 0) * 1000) })).catch(() => ({ok:false,message:'Recording saved, but library metadata could not be updated.'}));
        return { ok: true, name: state.name, bytes: state.bytes, ...details, ...(library.ok ? {} : {warning:library.message}) };
      } catch (error) { return fail(state, error); }
    },
    async abort(id, message = 'Recording interrupted. Partial files are retained.') {
      const state = active;
      if (!state || state.id !== id) return bad('No matching recording.');
      if (state.phase === 'finalizing') return bad('Finalization is still running.');
      if (state.phase === 'complete') return bad('Recording is already complete.');
      state.phase = 'failed';
      if (state.pending) await state.pending;
      try { await close(state); } catch { message += ' File close failed.'; }
      return bad(message);
    },
    async openLatest() {
      if (!latest) return bad('No completed episode is available.');
      try { const error = await open(latest.target); return error ? bad('No player could open this WebM. Open it in a WebM-compatible player.') : { ok: true }; }
      catch { return bad('The completed recording could not be opened.'); }
    },
    async shutdown() {
      const state = active; if (!state || state.phase === 'complete') return;
      if (state.phase === 'finalizing') return; // Window close is vetoed during finalization.
      state.phase = 'failed'; if (state.pending) await state.pending;
      try { await close(state); } catch { /* shutdown cannot claim success */ }
    },
  };
}
module.exports = { createRecordingStore, MAX_CHUNK, MAX_BYTES };
