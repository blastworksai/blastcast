// CodexBWAI — hostile recovery files are verified before and during derived writes.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { writeAll } = require('./webm.cjs');

const MAGIC = Buffer.from('BLASTCASTRECOV1\n');
const MAX_MANIFEST = 1024 * 1024, MAX_META = 1024, MAX_PIECE = 64 * 1024;
const MAX_RETAINED = 2 * 1024 ** 3, MAX_FILE = MAX_RETAINED + 64 * 1024 ** 2;
const MAX_SOURCE = 16 * 1024 ** 3, MAX_EPISODE = 128 * 1024 ** 3, MAX_CHUNKS = 100000, JOURNAL_SIZE = 512;
const TOP = ['version','participantId','recoveryKey','episodeId','epochs'];
const EPOCH = ['descriptor','acked','next','ackedBytes','bytes','end','retainedChunks','retainedBytes'];
const DESCRIPTOR = ['episodeId','epochId','mimeType','startedMonoMs','hostStartedMs','clockUncertaintyMs','width','height'];
const END = ['episodeId','epochId','chunkCount','endedMonoMs'];
const CHUNK = ['episodeId','epochId','sequence','byteLength','sha256','startMonoMs','endMonoMs'];
const JOURNAL = ['sequence','byteLength','sha256','startMonoMs','endMonoMs'];
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const participant = value => typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);
const key = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const integer = (value,min,max) => Number.isSafeInteger(value) && value >= min && value <= max;
const time = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value,keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(name => Object.hasOwn(value,name));
const equal = (a,b,keys) => keys.every(name => a[name] === b[name]);
function invalid(message = 'Guest recovery file is invalid.') { throw new Error(message); }
function decode(bytes) { try { return new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { invalid(); } }
function json(bytes) { try { return JSON.parse(decode(bytes)); } catch { invalid(); } }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function readAt(handle, position, length) {
  const bytes = Buffer.alloc(length); let offset = 0;
  while (offset < length) { const result = await handle.read(bytes,offset,length-offset,position+offset); if (!result.bytesRead) invalid(); offset += result.bytesRead; }
  return bytes;
}
async function regular(io,file,maximum=Number.MAX_SAFE_INTEGER) {
  const stat = await io.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) invalid();
  return stat;
}
async function hashFile(io,file) {
  const handle=await io.open(file,'r'), digest=createHash('sha256'), buffer=Buffer.alloc(1024*1024);
  try { for(let at=0;;){const result=await handle.read(buffer,0,buffer.length,at);if(!result.bytesRead)break;
      digest.update(buffer.subarray(0,result.bytesRead));at+=result.bytesRead;} return digest.digest('hex'); }
  finally { await handle.close(); }
}
function validateDescriptor(value, episodeId) {
  if (!exact(value,DESCRIPTOR) || value.episodeId !== episodeId || !uuid(value.epochId) ||
    value.mimeType !== 'video/webm;codecs=vp8,opus' || !time(value.startedMonoMs) || !time(value.hostStartedMs) ||
    !time(value.clockUncertaintyMs) || !integer(value.width,0,3840) || !integer(value.height,0,2160)) invalid();
}
function validateManifest(value) {
  if (!exact(value,TOP) || value.version !== 1 || !participant(value.participantId) || !key(value.recoveryKey) ||
    !uuid(value.episodeId) || !Array.isArray(value.epochs) || !integer(value.epochs.length,1,8)) invalid();
  const ids = new Set(); let total = 0, useful = false;
  for (const epoch of value.epochs) {
    if (!exact(epoch,EPOCH)) invalid(); validateDescriptor(epoch.descriptor,value.episodeId);
    if (ids.has(epoch.descriptor.epochId) || !integer(epoch.next,0,MAX_CHUNKS) || !integer(epoch.acked,0,epoch.next) ||
      !integer(epoch.bytes,0,MAX_SOURCE) || !integer(epoch.ackedBytes,0,epoch.bytes) ||
      epoch.retainedChunks !== epoch.next-epoch.acked || epoch.retainedBytes !== epoch.bytes-epoch.ackedBytes ||
      !integer(epoch.retainedChunks,0,MAX_CHUNKS) || !integer(epoch.retainedBytes,0,MAX_RETAINED) ||
      (!epoch.retainedChunks && epoch.retainedBytes) || (epoch.retainedChunks && !epoch.retainedBytes)) invalid();
    if (epoch.end !== null && (!exact(epoch.end,END) || epoch.end.episodeId !== value.episodeId ||
      epoch.end.epochId !== epoch.descriptor.epochId || epoch.end.chunkCount !== epoch.next || !time(epoch.end.endedMonoMs))) invalid();
    ids.add(epoch.descriptor.epochId); total += epoch.retainedBytes; useful ||= Boolean(epoch.retainedBytes || epoch.end);
    if (total > MAX_RETAINED) invalid();
  }
  if (!useful) invalid();
  return value;
}
function validateChunk(value, epoch, sequence, lastEnd) {
  if (!exact(value,CHUNK) || value.episodeId !== epoch.descriptor.episodeId || value.epochId !== epoch.descriptor.epochId ||
    value.sequence !== sequence || !integer(value.byteLength,1,MAX_PIECE) || typeof value.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sha256) || !time(value.startMonoMs) || !time(value.endMonoMs) ||
    value.startMonoMs < epoch.descriptor.startedMonoMs || value.startMonoMs < lastEnd || value.endMonoMs < value.startMonoMs) invalid();
}

async function openRecoveryBundle({ file, io: supplied = fs }) {
  const io = { ...fs,...supplied };
  const before = await regular(io,file,MAX_FILE);
  const handle = await io.open(file,'r');
  const opened = await handle.stat();
  if (!opened.isFile() || opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino ||
    opened.size < MAGIC.length+5 || opened.size > MAX_FILE) { await handle.close(); invalid(); }
  async function scan(expectedManifest, onChunk) {
    let at = 0;
    const magic = await readAt(handle,at,MAGIC.length); at += MAGIC.length;
    if (!magic.equals(MAGIC)) invalid();
    const manifestLength = (await readAt(handle,at,4)).readUInt32BE(); at += 4;
    if (!integer(manifestLength,1,MAX_MANIFEST) || at+manifestLength > opened.size) invalid();
    const raw = await readAt(handle,at,manifestLength); at += manifestLength;
    const manifest = validateManifest(json(raw));
    if (expectedManifest && !raw.equals(expectedManifest.raw)) invalid('Guest recovery file changed while it was being imported.');
    for (let index=0; index<manifest.epochs.length; index++) {
      const epoch = manifest.epochs[index]; let retained = 0, lastEnd = epoch.descriptor.startedMonoMs;
      for (let sequence=epoch.acked; sequence<epoch.next; sequence++) {
        const metaLength = (await readAt(handle,at,4)).readUInt32BE(); at += 4;
        if (!integer(metaLength,1,MAX_META) || at+metaLength+4 > opened.size) invalid();
        const chunk = json(await readAt(handle,at,metaLength)); at += metaLength;
        validateChunk(chunk,epoch,sequence,lastEnd);
        const length = (await readAt(handle,at,4)).readUInt32BE(); at += 4;
        if (length !== chunk.byteLength || !integer(length,1,MAX_PIECE) || at+length > opened.size) invalid();
        const data = await readAt(handle,at,length); at += length;
        if (hash(data) !== chunk.sha256) invalid();
        if (onChunk) await onChunk({ manifest,epoch,index,chunk,data });
        retained += length; lastEnd = chunk.endMonoMs;
      }
      if (retained !== epoch.retainedBytes || (epoch.end && epoch.end.endedMonoMs < lastEnd)) invalid();
    }
    if (at !== opened.size) invalid();
    return { manifest,raw };
  }
  try {
    const first = await scan(null,null);
    return { manifest:first.manifest,
      replay:onChunk => scan(first,onChunk),
      close:() => handle.close() };
  } catch (error) { await handle.close().catch(()=>{}); throw error; }
}

async function journalFacts(io, epoch) {
  await regular(io,epoch.mediaPath,MAX_SOURCE+MAX_PIECE);
  const journalStat = await regular(io,epoch.journalPath,MAX_CHUNKS*JOURNAL_SIZE);
  if (journalStat.size !== epoch.sequence*JOURNAL_SIZE) invalid('The host original no longer matches its verified journal.');
  const journal = await io.open(epoch.journalPath,'r'), media = await io.open(epoch.mediaPath,'r');
  const records=[]; let bytes=0,lastEnd=epoch.descriptor.startedMonoMs;
  try {
    for(let sequence=0;sequence<epoch.sequence;sequence++) {
      const value=json(await readAt(journal,sequence*JOURNAL_SIZE,JOURNAL_SIZE).then(buffer=>Buffer.from(buffer.toString('utf8').trim())));
      if (!exact(value,JOURNAL) || value.sequence !== sequence || !integer(value.byteLength,1,8*1024*1024) ||
        typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256) || !time(value.startMonoMs) ||
        !time(value.endMonoMs) || value.startMonoMs < lastEnd || value.endMonoMs < value.startMonoMs || bytes+value.byteLength > MAX_SOURCE) invalid();
      const data=await readAt(media,bytes,value.byteLength); if(hash(data)!==value.sha256) invalid('The host original no longer matches its verified journal.');
      records.push({ ...value,offset:bytes });bytes+=value.byteLength;lastEnd=value.endMonoMs;
    }
  } finally { await Promise.allSettled([journal.close(),media.close()]); }
  if(bytes!==epoch.bytes) invalid('The host original no longer matches its verified journal.');
  return {records,bytes,lastEnd};
}
async function copyExact(source,target,length) {
  const buffer=Buffer.alloc(Math.min(1024*1024,Math.max(1,length)));let at=0;
  while(at<length){const count=Math.min(buffer.length,length-at),read=await source.read(buffer,0,count,at);if(!read.bytesRead)invalid();
    await writeAll(target,buffer.subarray(0,read.bytesRead));at+=read.bytesRead;}
}

async function stageRecoveryImport({ file, episode, io: supplied = fs, finalize }) {
  const io={...fs,...supplied}; const bundle=await openRecoveryBundle({file,io});
  const {manifest}=bundle; const participantState=episode.participants.get(manifest.participantId);
  if (!participantState || manifest.participantId === 'host' || manifest.episodeId !== episode.id || !participantState.recoveryHash ||
    hash(Buffer.from(manifest.recoveryKey)) !== participantState.recoveryHash) { await bundle.close(); invalid('This recovery file does not belong to this guest and episode.'); }
  const plans=[]; let added=0;
  try {
    for(const manifestEpoch of manifest.epochs) {
      const id=manifestEpoch.descriptor.epochId, existing=episode.epochs.get(id) ?? null;
      if (existing && (existing.participantId !== manifest.participantId || !equal(existing.descriptor,manifestEpoch.descriptor,DESCRIPTOR) ||
        !existing.ready || existing.busy || !['recording','incomplete','complete'].includes(existing.phase))) invalid('The recovery epoch conflicts with the host original.');
      if (!existing && (participantState.epochs.length+plans.filter(plan=>!plan.existing).length >= 8 || episode.epochs.size+plans.filter(plan=>!plan.existing).length >= 64)) invalid();
      const sequence=existing?.sequence ?? 0, bytes=existing?.bytes ?? 0;
      if (sequence < manifestEpoch.acked || sequence > manifestEpoch.next || bytes > manifestEpoch.bytes) invalid('The recovery file has a missing or conflicting sequence.');
      if (existing?.phase === 'complete' && (!manifestEpoch.end || !equal(existing.end,manifestEpoch.end,END) || sequence !== manifestEpoch.next || bytes !== manifestEpoch.bytes)) invalid('The recovery file conflicts with a complete original.');
      const facts=existing ? await journalFacts(io,existing) : {records:[],bytes:0,lastEnd:manifestEpoch.descriptor.startedMonoMs};
      added += manifestEpoch.bytes-bytes;
      if (participantState.bytes+added > MAX_SOURCE || episode.bytes+added > MAX_EPISODE) invalid('Imported original exceeds the recording size limit.');
      plans.push({manifest:manifestEpoch,existing,facts,currentSequence:sequence,currentBytes:bytes,lastEnd:facts.lastEnd,
        storageId:null,mediaPath:null,journalPath:null,mediaHandle:null,journalHandle:null,complete:existing?.phase==='complete'});
    }
    for(const plan of plans.filter(plan=>!plan.complete)) {
      plan.storageId=randomUUID(); const base=path.join(episode.directory,`${manifest.participantId}-${plan.manifest.descriptor.epochId}.reimport-${plan.storageId}`);
      plan.mediaPath=base+'.webm.partial';plan.journalPath=base+'.journal';
      plan.mediaHandle=await io.open(plan.mediaPath,'wx+',0o600);plan.journalHandle=await io.open(plan.journalPath,'wx+',0o600);
      if(plan.existing){const sourceMedia=await io.open(plan.existing.mediaPath,'r'),sourceJournal=await io.open(plan.existing.journalPath,'r');
        try{await copyExact(sourceMedia,plan.mediaHandle,plan.currentBytes);await copyExact(sourceJournal,plan.journalHandle,plan.currentSequence*JOURNAL_SIZE);}
        finally{await Promise.allSettled([sourceMedia.close(),sourceJournal.close()]);}}
    }
    await bundle.replay(async ({epoch,chunk,data})=>{
      const plan=plans.find(candidate=>candidate.manifest.descriptor.epochId===epoch.descriptor.epochId);if(!plan)invalid();
      if(chunk.sequence<plan.currentSequence){const prior=plan.facts.records[chunk.sequence];
        if(!prior||!equal(prior,chunk,JOURNAL))invalid('A retained duplicate conflicts with the host original.');
        const handle=plan.complete?await io.open(plan.existing.mediaPath,'r'):plan.mediaHandle;
        try{const local=await readAt(handle,prior.offset,prior.byteLength);if(!local.equals(data))invalid('A retained duplicate conflicts with the host original.');}
        finally{if(plan.complete)await handle.close();}
        return;
      }
      if(plan.complete||chunk.sequence!==plan.currentSequence||chunk.startMonoMs<plan.lastEnd)invalid('The recovery file has a missing or conflicting sequence.');
      const record=JSON.stringify({sequence:chunk.sequence,byteLength:chunk.byteLength,sha256:chunk.sha256,startMonoMs:chunk.startMonoMs,endMonoMs:chunk.endMonoMs});
      if(Buffer.byteLength(record)>JOURNAL_SIZE-1)invalid();
      await writeAll(plan.mediaHandle,data);await writeAll(plan.journalHandle,Buffer.from(record.padEnd(JOURNAL_SIZE-1,' ')+'\n'));
      plan.currentSequence++;plan.currentBytes+=data.length;plan.lastEnd=chunk.endMonoMs;
    });
    for(const plan of plans) {
      if(plan.currentSequence!==plan.manifest.next||plan.currentBytes!==plan.manifest.bytes)invalid('The imported byte totals do not match the recovery manifest.');
      if(plan.complete)continue;
      await plan.mediaHandle.sync();await plan.journalHandle.sync();await plan.mediaHandle.close();await plan.journalHandle.close();
      plan.mediaHandle=null;plan.journalHandle=null;
      if(plan.manifest.end&&plan.currentBytes){const staging=path.join(episode.directory,`${plan.manifest.descriptor.epochId}.reimport-${plan.storageId}.finalizing`);
        await finalize(plan.mediaPath,staging,io);const target=path.join(episode.directory,`${plan.manifest.descriptor.epochId}.webm`);
        try{await io.link(staging,target);}catch(error){if(error.code!=='EEXIST'||(await hashFile(io,staging))!==(await hashFile(io,target)))throw error;}
        await io.unlink(staging);plan.name=`${plan.manifest.descriptor.epochId}.webm`;plan.phase='complete';
      }else plan.phase='incomplete';
    }
    for(const plan of plans.filter(plan=>!plan.complete&&plan.existing)) {
      if(plan.existing.mediaHandle){await plan.existing.mediaHandle.close();plan.existing.mediaHandle=null;}
      if(plan.existing.journalHandle){await plan.existing.journalHandle.close();plan.existing.journalHandle=null;}
    }
    return { manifest,plans,addedBytes:added };
  } catch(error) {
    for(const plan of plans)for(const handle of [plan.mediaHandle,plan.journalHandle])if(handle)await handle.close().catch(()=>{});
    throw error;
  } finally { await bundle.close(); }
}

module.exports={ openRecoveryBundle,stageRecoveryImport };
