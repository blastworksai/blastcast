// CodexBWAI — reconstruct restart state only from bounded, rehashed disk facts.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MAX_METADATA = 1024 * 1024;
const MAX_CHUNK = 8 * 1024 * 1024;
const MAX_PARTICIPANT = 16 * 1024 ** 3;
const MAX_EPISODE = 128 * 1024 ** 3;
const MAX_CHUNKS = 100000;
const JOURNAL_SIZE = 512;
const TOP = ['version','id','hostStartedMs','hostTimeOriginMs','phase','participants','sources','descriptors'];
const DESCRIPTOR_V1 = ['episodeId','epochId','mimeType','startedMonoMs','hostStartedMs','clockUncertaintyMs','width','height','participantId','endedMonoMs'];
const DESCRIPTOR_V2 = [...DESCRIPTOR_V1,'storageId'];
const JOURNAL = ['sequence','byteLength','sha256','startMonoMs','endMonoMs'];
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const participantId = value => value === 'host' || (typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value));
const time = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, required, optional = []) => plain(value) && required.every(key => Object.hasOwn(value,key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key)) && Object.keys(value).length >= required.length;
function invalid() { throw new Error('Invalid source recovery data'); }

async function regular(io, file, maximum = Number.MAX_SAFE_INTEGER) {
  const stat = await io.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) invalid();
  return stat;
}

async function readMetadata(io, candidate) {
  const file = path.join(candidate.directory, 'metadata.json');
  await regular(io,file,MAX_METADATA);
  let metadata;
  try { metadata = JSON.parse(await io.readFile(file,'utf8')); } catch { invalid(); }
  if (!exact(metadata,TOP) || ![1,2].includes(metadata.version) || metadata.id !== candidate.id || !time(metadata.hostStartedMs) ||
    !time(metadata.hostTimeOriginMs) || !['recording','stopped','closed'].includes(metadata.phase) ||
    !Array.isArray(metadata.participants) || !integer(metadata.participants.length,1,8) ||
    !Array.isArray(metadata.sources) || metadata.sources.length !== metadata.participants.length ||
    !Array.isArray(metadata.descriptors) || metadata.descriptors.length > 64) invalid();
  const participants = new Map();
  for (const item of metadata.participants) {
    const keys = metadata.version === 1 ? ['id','label'] : ['id','label','recoveryHash'];
    if (!exact(item,keys) || !participantId(item.id) || participants.has(item.id) || typeof item.label !== 'string' ||
      !item.label.trim() || item.label.length > 80 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(item.label)) invalid();
    const recoveryHash = metadata.version === 1 ? null : item.recoveryHash;
    if (!(recoveryHash === null || (item.id !== 'host' && typeof recoveryHash === 'string' && /^[0-9a-f]{64}$/.test(recoveryHash))) ||
      (item.id !== 'host' && metadata.version === 2 && recoveryHash === null) || (item.id === 'host' && recoveryHash !== null)) invalid();
    participants.set(item.id,{ label:item.label,recoveryHash });
  }
  if (!participants.has('host')) invalid();
  const summaries = new Map();
  for (const source of metadata.sources) {
    if (!exact(source,['participantId','label','phase','failed','epochs','bytes'],['message']) || !participants.has(source.participantId) ||
      summaries.has(source.participantId) || source.label !== participants.get(source.participantId).label ||
      !['pending','recording','finalizing','complete','incomplete'].includes(source.phase) || typeof source.failed !== 'boolean' ||
      !Array.isArray(source.epochs) || source.epochs.length > 8 || !integer(source.bytes,0,MAX_PARTICIPANT) ||
      (Object.hasOwn(source,'message') && (typeof source.message !== 'string' || source.message.length > 240))) invalid();
    const epochs = new Map(); let claimedBytes = 0;
    for (const epoch of source.epochs) {
      if (!exact(epoch,['epochId','phase','bytes','chunks'],['name']) || !uuid(epoch.epochId) || epochs.has(epoch.epochId) ||
        !['pending','recording','finalizing','complete','incomplete'].includes(epoch.phase) || !integer(epoch.bytes,0,MAX_PARTICIPANT) ||
        !integer(epoch.chunks,0,MAX_CHUNKS) || (Object.hasOwn(epoch,'name') && epoch.name !== `${epoch.epochId}.webm`)) invalid();
      claimedBytes += epoch.bytes; if (claimedBytes > MAX_PARTICIPANT) invalid();
      epochs.set(epoch.epochId,epoch);
    }
    if (claimedBytes !== source.bytes) invalid();
    summaries.set(source.participantId,{ source, epochs });
  }
  if (summaries.size !== participants.size) invalid();
  const descriptors = new Map();
  for (const descriptor of metadata.descriptors) {
    const keys = metadata.version === 1 ? DESCRIPTOR_V1 : DESCRIPTOR_V2;
    if (!exact(descriptor,keys) || descriptor.episodeId !== metadata.id || !uuid(descriptor.epochId) || descriptors.has(descriptor.epochId) ||
      !participants.has(descriptor.participantId) || descriptor.mimeType !== 'video/webm;codecs=vp8,opus' || !time(descriptor.startedMonoMs) ||
      !time(descriptor.hostStartedMs) || !time(descriptor.clockUncertaintyMs) || !integer(descriptor.width,0,3840) || !integer(descriptor.height,0,2160) ||
      !(descriptor.endedMonoMs === null || time(descriptor.endedMonoMs)) ||
      (metadata.version === 2 && !(descriptor.storageId === null || uuid(descriptor.storageId)))) invalid();
    if (metadata.version === 1) descriptor.storageId = null;
    const summary = summaries.get(descriptor.participantId);
    if (!summary.epochs.has(descriptor.epochId)) invalid();
    descriptors.set(descriptor.epochId,descriptor);
  }
  for (const { epochs } of summaries.values()) for (const id of epochs.keys()) if (!descriptors.has(id)) invalid();
  return { metadata, participants, summaries, descriptors };
}

async function readRecord(handle, sequence) {
  const buffer = Buffer.alloc(JOURNAL_SIZE); let offset = 0;
  while (offset < JOURNAL_SIZE) {
    const result = await handle.read(buffer,offset,JOURNAL_SIZE-offset,sequence*JOURNAL_SIZE+offset);
    if (!result.bytesRead) invalid();
    offset += result.bytesRead;
  }
  let record;
  try { record = JSON.parse(buffer.toString('utf8').trim()); } catch { invalid(); }
  if (!exact(record,JOURNAL) || record.sequence !== sequence || !integer(record.byteLength,1,MAX_CHUNK) ||
    typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256) || !time(record.startMonoMs) ||
    !time(record.endMonoMs) || record.endMonoMs < record.startMonoMs) invalid();
  return record;
}

async function reconcileEpoch(io, directory, descriptor, claimed) {
  const suffix = descriptor.storageId ? `.reimport-${descriptor.storageId}` : '';
  const base = path.join(directory,`${descriptor.participantId}-${descriptor.epochId}${suffix}`);
  const mediaPath = `${base}.webm.partial`, journalPath = `${base}.journal`;
  const mediaStat = await regular(io,mediaPath,MAX_PARTICIPANT + MAX_CHUNK);
  const journalStat = await regular(io,journalPath,MAX_CHUNKS*JOURNAL_SIZE);
  if (journalStat.size % JOURNAL_SIZE !== 0) invalid();
  const count = journalStat.size / JOURNAL_SIZE;
  let journalHandle, mediaHandle, bytes = 0, lastEnd = descriptor.startedMonoMs;
  try {
    journalHandle = await io.open(journalPath,'r'); mediaHandle = await io.open(mediaPath,'r');
    for (let sequence=0; sequence<count; sequence++) {
      const record = await readRecord(journalHandle,sequence);
      if (record.startMonoMs < descriptor.startedMonoMs || record.startMonoMs < lastEnd || bytes + record.byteLength > MAX_PARTICIPANT) invalid();
      const data = Buffer.alloc(record.byteLength); let offset = 0;
      while (offset < data.length) {
        const result = await mediaHandle.read(data,offset,data.length-offset,bytes+offset);
        if (!result.bytesRead) invalid();
        offset += result.bytesRead;
      }
      if (createHash('sha256').update(data).digest('hex') !== record.sha256) invalid();
      bytes += record.byteLength; lastEnd = record.endMonoMs;
    }
  } finally {
    if (journalHandle) await journalHandle.close();
    if (mediaHandle) await mediaHandle.close();
  }
  if (claimed.bytes > bytes || claimed.chunks > count) invalid();
  const tail = mediaStat.size !== bytes;
  let complete = claimed.phase === 'complete' && claimed.bytes === bytes && claimed.chunks === count && !tail &&
    descriptor.endedMonoMs !== null && descriptor.endedMonoMs >= lastEnd && claimed.name === `${descriptor.epochId}.webm`;
  if (complete) {
    try { const stat = await regular(io,path.join(directory,claimed.name)); if (!stat.size) complete = false; }
    catch { complete = false; }
  }
  const cleanDescriptor = Object.fromEntries(['episodeId','epochId','mimeType','startedMonoMs','hostStartedMs','clockUncertaintyMs','width','height']
    .map(key => [key,descriptor[key]]));
  return { id:descriptor.epochId, participantId:descriptor.participantId, descriptor:cleanDescriptor, storageId:descriptor.storageId, mediaPath, journalPath,
    mediaHandle:null, journalHandle:null, phase:complete?'complete':'incomplete', failed:false, ready:true, busy:false,
    sequence:count, bytes, lastEnd, pending:null,
    end:complete ? { episodeId:descriptor.episodeId, epochId:descriptor.epochId, chunkCount:count, endedMonoMs:descriptor.endedMonoMs } : null,
    ...(complete ? { name:claimed.name } : {}) };
}

async function reconcile(io, candidate, parsed) {
  const { metadata, participants, summaries, descriptors } = parsed;
  const recoveredParticipants = new Map(), epochs = new Map();
  for (const [id,identity] of participants) recoveredParticipants.set(id,{ id,label:identity.label,recoveryHash:identity.recoveryHash,
    recoveryKey:null,epochs:[],bytes:0,reserved:0,incomplete:false,failed:summaries.get(id).source.failed });
  let total = 0;
  for (const descriptor of descriptors.values()) {
    const claimed = summaries.get(descriptor.participantId).epochs.get(descriptor.epochId);
    const epoch = await reconcileEpoch(io,candidate.directory,descriptor,claimed);
    const participant = recoveredParticipants.get(descriptor.participantId);
    participant.epochs.push(epoch.id); participant.bytes += epoch.bytes; total += epoch.bytes;
    if (participant.bytes > MAX_PARTICIPANT || total > MAX_EPISODE) invalid();
    if (epoch.phase !== 'complete') participant.incomplete = true;
    epochs.set(epoch.id,epoch);
  }
  for (const participant of recoveredParticipants.values()) {
    if (!participant.epochs.length) participant.incomplete = true;
    if (summaries.get(participant.id).source.bytes > participant.bytes) invalid();
  }
  return { id:metadata.id, directory:candidate.directory, participants:recoveredParticipants, epochs,
    phase:'stopped', recovered:true, ready:true, closing:false, closedReady:false, closeWork:null,
    metadataTail:Promise.resolve(), metadataError:false, bytes:total, reserved:0, hostStartedMs:metadata.hostStartedMs };
}

async function recoverLatestSourceEpisode({ folder, io: supplied = fs }) {
  const io = { ...fs, ...supplied };
  const entries = await io.readdir(folder,{withFileTypes:true});
  const candidates = [];
  for (const entry of entries) {
    const match = /^sources-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(entry.name);
    if (!match) continue;
    const directory = path.join(folder,entry.name), stat = await io.lstat(directory);
    if (!entry.isDirectory() || stat.isSymbolicLink() || !stat.isDirectory()) invalid();
    let order = stat.mtimeMs;
    try { order = (await io.lstat(path.join(directory,'metadata.json'))).mtimeMs; } catch { /* The newest unreadable candidate must fail below. */ }
    candidates.push({ id:match[1], directory, order });
  }
  candidates.sort((a,b) => b.order-a.order || b.id.localeCompare(a.id));
  for (const candidate of candidates) {
    const parsed = await readMetadata(io,candidate);
    if (parsed.metadata.phase === 'closed') continue;
    return reconcile(io,candidate,parsed);
  }
  return null;
}

module.exports = { recoverLatestSourceEpisode };
