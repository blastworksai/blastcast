// BWTV source-store prototype; durability/lifetime implementation rewritten by CodexBWAI.
// The main process owns paths. Journal records, not a RAM hash cache, prove chunk receipt.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { finalizeWebm, writeAll } = require('./webm.cjs');
const { recoverLatestSourceEpisode } = require('./source-recovery.cjs');
const { stageRecoveryImport } = require('./source-import.cjs');
const LIMITS = require('./source-limits.cjs');
const MAX_CHUNK = 8 * 1024 * 1024, MAX_PARTICIPANT = LIMITS.SOURCE, MAX_EPISODE = LIMITS.EPISODE;
const JOURNAL_SIZE = 512, MAX_CHUNKS = LIMITS.CHUNKS;
// CodexBWAI — expected interruption/missing media is not an observed disk failure.
const INCOMPLETE = Symbol('incomplete source');
const DESCRIPTOR = ['episodeId','epochId','mimeType','startedMonoMs','hostStartedMs','clockUncertaintyMs','width','height'];
const CHUNK = LIMITS.CHUNK_KEYS;
const END = ['episodeId','epochId','chunkCount','endedMonoMs'];
const bad = message => ({ ok: false, message });
const uuid = v => typeof v === 'string' && LIMITS.UUID.test(v);
const participant = v => v === 'host' || (typeof v === 'string' && /^[A-Za-z0-9_-]{22}$/.test(v));
const time = v => Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
function shape(v, keys) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype &&
    Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
}
const equal = (a, b, keys) => keys.every(k => a[k] === b[k]);
function createSourceStore({ folder, io: supplied = fs, finalize = finalizeWebm }) {
  const io = { ...fs, ...supplied };
  let episode = null, opening = false, recovering = false, importing = false, shuttingDown = false, recoveryError = null;
  const operations = new Set();
  function track(action) {
    const pending = Promise.resolve().then(action).finally(() => operations.delete(pending));
    operations.add(pending); return pending;
  }
  const current = ep => episode === ep && !ep.closing && !shuttingDown;
  function summarize(ep, persisted = false) {
    const sources = [...ep.participants.values()].map(p => {
      const epochs = p.epochs.map(id => ep.epochs.get(id)).map(e => ({ epochId: e.id, phase: !persisted && e.completionPending ? 'finalizing' : e.phase,
        bytes: e.bytes, chunks: e.sequence, ...(e.name ? { name: e.name } : {}) }));
      let phase = 'pending';
      if (ep.metadataError || p.incomplete || epochs.some(e => e.phase === 'incomplete')) phase = 'incomplete';
      else if (epochs.some(e => e.phase === 'finalizing')) phase = 'finalizing';
      else if (epochs.some(e => e.phase === 'recording')) phase = 'recording';
      else if (epochs.length && epochs.every(e => e.phase === 'complete')) phase = 'complete';
      const failed = ep.metadataError || p.failed || p.epochs.some(id => ep.epochs.get(id).failed);
      return { participantId: p.id, label: p.label, phase, failed, epochs, bytes: p.bytes,
        // ClaudeBWAI — time since this source last proved it could deliver (begin/chunk/finish). Not persisted.
        ...(!persisted ? { idleMs: typeof p.lastActive === 'number' ? Math.max(0, performance.now() - p.lastActive) : null } : {}),
        ...(!persisted && p.damaged ? { damaged:true, damageReason:p.damaged } : {}),
        ...(phase === 'incomplete' ? { message: p.damaged ? `Part of this original could not be verified (${p.damaged}). Verified media is retained and unverified files were left unchanged.` : ep.metadataError ? 'Original metadata could not be saved. Media is retained.' : 'This original is incomplete. Saved partial media is retained.' } : {}) };
    });
    return { episodeId: ep.id, hostNowMs: performance.now(), phase: ep.phase, closing: ep.closing && !ep.closedReady,
      ...(ep.recovered ? { recovered:true } : {}), sources,
      allSourcesComplete: ep.phase !== 'recording' && !ep.metadataError && sources.every(p => p.phase === 'complete') };
  }
  function persist(ep) {
    // Serialize snapshots and replace atomically. Never remove the preceding durable metadata first.
    const task = ep.metadataTail.catch(() => {}).then(async () => {
      const metadata = { version: 2, id: ep.id, hostStartedMs: ep.hostStartedMs, hostTimeOriginMs: performance.timeOrigin,
        phase: ep.phase, participants: [...ep.participants.values()].map(p => ({ id:p.id,label:p.label,recoveryHash:p.recoveryHash ?? null })),
        sources: summarize(ep, true).sources, descriptors: [...ep.epochs.values()].map(e => ({ ...e.descriptor,
          participantId:e.participantId,endedMonoMs:e.end?.endedMonoMs ?? null,storageId:e.storageId ?? null })) };
      const bytes = Buffer.from(JSON.stringify(metadata));
      if (bytes.length > 1024 * 1024) throw new Error('Metadata bound exceeded');
      const temporary = path.join(ep.directory, `metadata-${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await io.open(temporary, 'wx', 0o600);
        await writeAll(handle, bytes); await handle.sync();
      } finally { if (handle) await handle.close(); }
      await io.rename(temporary, path.join(ep.directory, 'metadata.json'));
    });
    ep.metadataTail = task; return task;
  }
  async function markFailure(ep, e, failed) {
    if (e) { e.phase = 'incomplete'; e.completionPending = false; e.failed ||= failed; }
    try { await persist(ep); } catch { ep.metadataError = true; }
  }
  async function closeHandles(e) {
    for (const key of ['mediaHandle','journalHandle']) if (e[key]) {
      await e[key].close(); e[key] = null;
    }
  }
  async function deadline(work, duration) {
    let timer;
    try { return await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(bad('Original I/O is still outstanding. Files are retained; this is not a clean close.')), duration); })]); }
    finally { clearTimeout(timer); }
  }
  function closeWork(ep) {
    if (ep.closeWork) return ep.closeWork;
    ep.closing = true; ep.phase = 'closed';
    ep.closeWork = (async () => {
      // New operations are already barred. Await complete operations, including their metadata writes.
      await Promise.allSettled([...operations]);
      try {
        for (const e of ep.epochs.values()) {
          if (e.phase !== 'complete') e.phase = 'incomplete';
          await closeHandles(e);
        }
        for (const p of ep.participants.values()) if (!p.epochs.length || p.epochs.some(id => ep.epochs.get(id).phase !== 'complete')) p.incomplete = true;
        await persist(ep); ep.closedReady = true;
        return { ok: true, episodeId: ep.id };
      } catch { ep.metadataError = true; ep.closeWork = null; return bad('Original files could not close cleanly. All media is retained.'); }
    })();
    return ep.closeWork;
  }
  const api = {
    beginEpisode(input) {
      if (recoveryError) return Promise.resolve(bad(recoveryError));
      if (recovering) return Promise.resolve(bad('Wait for interrupted originals to finish loading.'));
      if (shuttingDown || opening || importing || (episode && !episode.closedReady)) return Promise.resolve(bad('Finish the previous originals before starting another episode.'));
      if (!shape(input, ['id','participants']) || !uuid(input.id) || !Array.isArray(input.participants) || !integer(input.participants.length, 1, 8)) return Promise.resolve(bad('Invalid source episode.'));
      const roster = new Map();
      for (const p of input.participants) {
        if (!shape(p,['id','label']) || !participant(p.id) || roster.has(p.id) || typeof p.label !== 'string' || !p.label.trim() || p.label.length > 80 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(p.label)) return Promise.resolve(bad('Invalid participant roster.'));
        const recoveryKey = p.id === 'host' ? null : randomBytes(32).toString('base64url');
        roster.set(p.id, { id:p.id,label:p.label,epochs:[],bytes:0,reserved:0,incomplete:false,recoveryKey,lastActive:performance.now(),
          recoveryHash:recoveryKey ? createHash('sha256').update(recoveryKey).digest('hex') : null });
      }
      if (!roster.has('host')) return Promise.resolve(bad('The source roster must include the host.'));
      const selected = folder(); if (!selected) return Promise.resolve(bad('Choose a recording folder first.'));
      const ep = { id:input.id, directory:path.join(selected,`sources-${input.id}`), participants:roster, epochs:new Map(),
        phase:'recording', ready:false, closing:false, closedReady:false, closeWork:null, metadataTail:Promise.resolve(),
        metadataError:false, bytes:0, reserved:0, hostStartedMs:performance.now() };
      opening = true;
      return track(async () => {
        try {
          await io.mkdir(ep.directory, { recursive:false, mode:0o700 });
          await persist(ep);
          if (shuttingDown) return bad('Source startup was interrupted. Files are retained.');
          episode = ep; ep.ready = true;
          return { ok:true, episodeId:ep.id, hostStartedMs:ep.hostStartedMs };
        } catch { return bad('Original recording metadata could not be prepared. Existing files were not replaced.'); }
        finally { opening = false; }
      });
    },
    beginSource(participantId, input) {
      if (!shape(input, DESCRIPTOR) || !uuid(input.episodeId) || !uuid(input.epochId) || input.mimeType !== 'video/webm;codecs=vp8,opus' ||
        !time(input.startedMonoMs) || !time(input.hostStartedMs) || !time(input.clockUncertaintyMs) || !integer(input.width,0,3840) || !integer(input.height,0,3840) || Math.max(input.width,input.height) > 3840 || Math.min(input.width,input.height) > 2160) return Promise.resolve(bad('Invalid source descriptor.')); // orientation-neutral: portrait passes the landscape limits
      const ep = episode, p = ep?.participants.get(participantId);
      if (!ep || ep.id !== input.episodeId || ep.phase === 'closed' || !p) return Promise.resolve({ ...bad('No active source episode for this participant.'), gone:true });
      if (!current(ep) || importing) return Promise.resolve(bad('No active source episode for this participant.'));
      const existing = ep.epochs.get(input.epochId);
      if (existing) return Promise.resolve(existing.ready && existing.participantId === participantId && equal(existing.descriptor,input,DESCRIPTOR)
        ? { ok:true,episodeId:ep.id,epochId:existing.id } : bad('Conflicting or pending source epoch.'));
      if (p.epochs.length >= 8 || ep.epochs.size >= 64) return Promise.resolve(bad('Source epoch limit reached.'));
      const descriptor = Object.fromEntries(DESCRIPTOR.map(k => [k,input[k]]));
      const base = path.join(ep.directory,`${participantId}-${input.epochId}`);
      const e = { id:input.epochId, participantId, descriptor, mediaPath:base+'.webm.partial', journalPath:base+'.journal',
        mediaHandle:null,journalHandle:null,phase:'pending',failed:false,ready:false,busy:true,sequence:0,bytes:0,lastEnd:input.startedMonoMs,pending:null,end:null };
      e.storageId = null;
      ep.epochs.set(e.id,e); p.epochs.push(e.id); // Reserve before any asynchronous file open.
      e.pending = track(async () => {
        try {
          e.mediaHandle = await io.open(e.mediaPath,'wx',0o600);
          e.journalHandle = await io.open(e.journalPath,'wx+',0o600);
          if (!current(ep)) throw INCOMPLETE;
          e.phase = 'recording'; await persist(ep);
          if (!current(ep)) throw INCOMPLETE;
          e.ready = true; ep.participants.get(participantId).lastActive = performance.now(); return { ok:true,episodeId:ep.id,epochId:e.id };
        } catch (error) { await markFailure(ep,e,error !== INCOMPLETE); return bad('Original source could not start. Partial files are retained.'); }
        finally { e.busy = false; }
      });
      return e.pending;
    },
    appendSource(participantId, input, bytes) {
      if (!shape(input, CHUNK) || !uuid(input.episodeId) || !uuid(input.epochId) || !integer(input.sequence,0,MAX_CHUNKS-1) ||
        !integer(input.byteLength,1,MAX_CHUNK) || !(bytes instanceof ArrayBuffer) || bytes.byteLength !== input.byteLength ||
        typeof input.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.sha256) || !time(input.startMonoMs) || !time(input.endMonoMs) || input.endMonoMs < input.startMonoMs) return Promise.resolve(bad('Invalid original chunk.'));
      const ep = episode, e = ep?.epochs.get(input.epochId), p = ep?.participants.get(participantId);
      const unavailable = 'Original source is unavailable or busy.';
      // gone: the episode, guest or epoch can never accept this chunk (guest gets 410). busy: a write is settling, retry shortly.
      if (!ep || ep.id !== input.episodeId || !p || ep.phase === 'closed' || !e || e.participantId !== participantId) return Promise.resolve({ ...bad(unavailable), gone:true });
      if (e.busy) return Promise.resolve({ ...bad(unavailable), busy:true });
      if (!current(ep) || importing || !e.ready) return Promise.resolve(bad(unavailable));
      // Copy before hashing and asynchronous I/O; a caller cannot mutate an acknowledged buffer.
      const data = Buffer.from(new Uint8Array(bytes));
      if (createHash('sha256').update(data).digest('hex') !== input.sha256) return Promise.resolve(bad('Original chunk checksum does not match.'));
      const meta = Object.fromEntries(CHUNK.map(k => [k,input[k]]));
      const duplicate = meta.sequence < e.sequence;
      if (meta.startMonoMs < e.descriptor.startedMonoMs || (!duplicate && (meta.sequence !== e.sequence || e.phase !== 'recording' || meta.startMonoMs < e.lastEnd))) return Promise.resolve(bad('Original chunk sequence or timing is invalid.'));
      if (!duplicate && (p.bytes+p.reserved+data.length > MAX_PARTICIPANT || ep.bytes+ep.reserved+data.length > MAX_EPISODE)) return Promise.resolve(bad('Original recording size limit reached.'));
      e.busy = true;
      if (!duplicate) { p.reserved += data.length; ep.reserved += data.length; }
      e.pending = track(async () => {
        try {
          if (duplicate) {
            let handle = e.journalHandle, temporary = false;
            try {
              if (!handle) { handle = await io.open(e.journalPath,'r'); temporary = true; }
              const buffer = Buffer.alloc(JOURNAL_SIZE); let offset = 0;
              while (offset < JOURNAL_SIZE) {
                const read = await handle.read(buffer,offset,JOURNAL_SIZE-offset,meta.sequence*JOURNAL_SIZE+offset);
                if (!read.bytesRead) throw new Error('Truncated journal'); offset += read.bytesRead;
              }
              const prior = JSON.parse(buffer.toString('utf8').trim());
              if (!equal(prior,meta,['sequence','byteLength','sha256','startMonoMs','endMonoMs'])) return bad('Conflicting duplicate original chunk.');
            } finally { if (temporary) await handle.close(); }
          } else {
            const record = JSON.stringify({ sequence:meta.sequence,byteLength:meta.byteLength,sha256:meta.sha256,startMonoMs:meta.startMonoMs,endMonoMs:meta.endMonoMs });
            if (Buffer.byteLength(record) > JOURNAL_SIZE-1) throw new Error('Journal bound exceeded');
            await writeAll(e.mediaHandle,data);
            await writeAll(e.journalHandle,Buffer.from(record.padEnd(JOURNAL_SIZE-1,' ')+'\n'));
            await e.mediaHandle.sync(); await e.journalHandle.sync();
            e.sequence++; e.bytes += data.length; e.lastEnd = meta.endMonoMs; p.lastActive = performance.now(); p.bytes += data.length; ep.bytes += data.length;
          }
          if (!current(ep)) throw INCOMPLETE;
          return { ok:true,episodeId:ep.id,epochId:e.id,sequence:meta.sequence,sha256:meta.sha256,byteLength:meta.byteLength };
        } catch (error) { await markFailure(ep,e,error !== INCOMPLETE); return bad('Original chunk could not be confirmed on disk. Partial media is retained.'); }
        finally { e.busy = e.phase === 'finalizing'; if (!duplicate) { p.reserved -= data.length; ep.reserved -= data.length; } }
      });
      return e.pending;
    },
    finishSource(participantId, input) {
      if (!shape(input,END) || !uuid(input.episodeId) || !uuid(input.epochId) || !integer(input.chunkCount,0,MAX_CHUNKS) || !time(input.endedMonoMs)) return Promise.resolve(bad('Invalid original finish request.'));
      const ep = episode, e = ep?.epochs.get(input.epochId);
      if (!ep || !current(ep) || importing || ep.id !== input.episodeId || !e || !e.ready || e.participantId !== participantId) return Promise.resolve(bad('Original source is unavailable.'));
      if (e.completionPending) return equal(e.end,input,END) ? e.pending : Promise.resolve(bad('Conflicting original finish.'));
      if (e.phase === 'complete') return Promise.resolve(equal(e.end,input,END) ? { ok:true,episodeId:ep.id,epochId:e.id,name:e.name,bytes:e.bytes } : bad('Conflicting original finish.'));
      if (e.phase === 'finalizing') return equal(e.end,input,END) ? e.pending : Promise.resolve(bad('Original finalization is already running.'));
      if (e.phase !== 'recording') return Promise.resolve(bad('This original is incomplete.'));
      const prior = e.pending;
      e.end = Object.fromEntries(END.map(k => [k,input[k]])); e.phase = 'finalizing'; e.busy = true;
      e.pending = track(async () => {
        try {
          if (prior) await prior;
          if (!current(ep) || e.phase === 'incomplete' || e.sequence !== e.end.chunkCount || e.end.endedMonoMs < e.lastEnd || !e.bytes) throw INCOMPLETE;
          await e.mediaHandle.sync(); await e.journalHandle.sync(); await closeHandles(e);
          const name = `${e.id}.webm`, staging = path.join(ep.directory,`${e.id}.webm.finalizing`), target = path.join(ep.directory,name);
          await finalize(e.mediaPath,staging,io);
          if (!current(ep)) throw INCOMPLETE;
          await io.link(staging,target); await io.unlink(staging);
          e.name = name; e.phase = 'complete'; e.completionPending = true; await persist(ep);
          if (!current(ep)) throw INCOMPLETE;
          e.completionPending = false;
          ep.participants.get(participantId).lastActive = performance.now();
          return { ok:true,episodeId:ep.id,epochId:e.id,name,bytes:e.bytes };
        } catch (error) { await markFailure(ep,e,error !== INCOMPLETE); return bad('Original could not be finalized. All saved media and metadata are retained.'); }
        finally { e.busy = false; }
      });
      return e.pending;
    },
    stopEpisode(id) {
      const ep = episode;
      if (!ep || ep.id !== id || !current(ep)) return Promise.resolve(bad('No active source episode.'));
      ep.phase = 'stopped';
      for (const p of ep.participants.values()) if (!p.epochs.length) p.incomplete = true;
      return track(async () => {
        try { await persist(ep); if (!current(ep)) return bad('Original episode was closed.'); return { ok:true,episodeId:id }; }
        catch { ep.metadataError = true; return bad('Original stop metadata could not be saved. Media is retained.'); }
      });
    },
    closeEpisode(id) {
      const ep = episode;
      if (!ep || ep.id !== id || shuttingDown) return Promise.resolve(bad('No matching source episode.'));
      return deadline(closeWork(ep),5000);
    },
    status() { return episode?.ready ? summarize(episode) : null; },
    recoveryKey(participantId) {
      const ep = episode, p = ep?.participants.get(participantId);
      return ep?.ready && !ep.closedReady && p?.recoveryKey ? p.recoveryKey : null;
    },
    importRecovery(file) {
      const ep = episode;
      if (typeof file !== 'string' || !file || file.length > 32768) return Promise.resolve(bad('Choose one guest recovery file.'));
      if (!ep || !current(ep) || ep.phase !== 'stopped' || ep.closing || importing || recovering || opening || operations.size) {
        return Promise.resolve(bad('Stop the episode and wait for current original-file work before importing guest recovery.'));
      }
      importing = true;
      return track(async () => {
        try {
          const staged = await stageRecoveryImport({ file,episode:ep,io,finalize });
          if (!current(ep)) throw INCOMPLETE;
          const p = ep.participants.get(staged.manifest.participantId);
          for (const plan of staged.plans) {
            if (plan.complete) continue;
            const state = { id:plan.manifest.descriptor.epochId,participantId:staged.manifest.participantId,
              descriptor:plan.manifest.descriptor,storageId:plan.storageId,mediaPath:plan.mediaPath,journalPath:plan.journalPath,
              mediaHandle:null,journalHandle:null,phase:plan.phase,failed:false,ready:true,busy:false,
              sequence:plan.currentSequence,bytes:plan.currentBytes,lastEnd:plan.lastEnd,pending:null,
              end:plan.manifest.end,completionPending:false,...(plan.name?{name:plan.name}:{}) };
            if (plan.existing) ep.epochs.set(state.id,state);
            else { ep.epochs.set(state.id,state);p.epochs.push(state.id); }
          }
          p.bytes += staged.addedBytes; ep.bytes += staged.addedBytes;
          p.incomplete = !p.epochs.length || p.epochs.some(id => ep.epochs.get(id).phase !== 'complete');
          await persist(ep);
          if (!current(ep)) throw INCOMPLETE;
          const imported = staged.plans.filter(plan => !plan.complete);
          return { ok:true,episodeId:ep.id,participantId:p.id,epochs:staged.plans.length,bytes:staged.addedBytes,
            complete:p.epochs.every(id => ep.epochs.get(id).phase === 'complete'),unchanged:!imported.length };
        } catch { return bad('Guest recovery could not be imported. Existing originals and the recovery file were left unchanged; any new derived files were retained.'); }
        finally { importing = false; }
      });
    },
    async recover() {
      if (recovering || importing || shuttingDown || opening || operations.size || (episode && !episode.closedReady && !summarize(episode).allSourcesComplete)) {
        return bad('Finish the current originals before recovering another folder.');
      }
      const selected = folder();
      if (!selected) return bad('Choose a recording folder first.');
      episode = null; recoveryError = null; recovering = true;
      try {
        const found = await recoverLatestSourceEpisode({ folder:selected, io });
        episode = found.episode;
        // ClaudeBWAI — einh 4 Oct: note a damaged earlier recording, keep recording.
        const damaged = found.damagedEpisodes.length ? { damagedEpisodes:found.damagedEpisodes,
          notices:found.damagedEpisodes.map(d => `One earlier recording could not be read; its files were left untouched in ${d.directory}.`) } : {};
        return episode ? { ok:true, recovered:true, episodeId:episode.id, ...damaged } : { ok:true, recovered:false, ...damaged };
      } catch {
        recoveryError = 'Interrupted originals could not be verified. Existing files were left unchanged.';
        return bad(recoveryError);
      } finally { recovering = false; }
    },
    interrupt({ timeoutMs = 5000 } = {}) {
      if (!time(timeoutMs) || timeoutMs <= 0) return Promise.resolve(bad('Invalid shutdown deadline.'));
      shuttingDown = true;
      const work = (async () => {
        await Promise.allSettled([...operations]);
        if (episode) for (const e of episode.epochs.values()) await closeHandles(e);
        return { ok:true };
      })();
      return deadline(work,Math.min(timeoutMs,30000));
    },
    shutdown({ timeoutMs = 5000 } = {}) {
      if (!time(timeoutMs) || timeoutMs <= 0) return Promise.resolve(bad('Invalid shutdown deadline.'));
      shuttingDown = true;
      const closing = episode ? closeWork(episode) : Promise.resolve({ ok:true });
      // A previous episode can already be closed while the next one is opening.
      // Its cached close result does not cover that newly admitted startup I/O.
      const work = Promise.all([closing, Promise.allSettled([...operations])]).then(([result]) => result);
      return deadline(work,Math.min(timeoutMs,30000));
    },
  };
  return api;
}
module.exports = { createSourceStore };
