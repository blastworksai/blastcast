// CodexBWAI — real filesystem durability, privacy and fail-closed metadata tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat,symlink,unlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRecordingLibrary} from '../desktop/recording-library.cjs';
async function fixture(t) {
 const root=await mkdtemp(path.join(os.tmpdir(),'blastcast-library-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=path.join(root,'library.json'),media=path.join(root,'episode.webm');await writeFile(media,'recording bytes');
 const entry={id:'recording-1',path:media,name:'episode.webm',createdAt:100,durationMs:65000};
 return {root,file,media,entry};
}
test('library persists display names across reload without mutating recording or exposing paths',async t=>{
 const f=await fixture(t);const lib=createRecordingLibrary({file:f.file});assert.equal((await lib.add(f.entry)).ok,true);
 assert.equal((await lib.rename(f.entry.id,'My episode')).ok,true);
 const reloaded=createRecordingLibrary({file:f.file});const list=await reloaded.list();assert.equal(list.ok,true);assert.equal(list.recordings[0].label,'My episode');assert.equal(list.recordings[0].name,'episode.webm');assert.equal('path'in list.recordings[0],false);
 assert.equal(await readFile(f.media,'utf8'),'recording bytes');if(process.platform!=='win32')assert.equal((await stat(f.file)).mode&0o777,0o600);
 let opened;assert.equal((await createRecordingLibrary({file:f.file,open:async p=>{opened=p;return '';}}).open(f.entry.id)).ok,true);assert.equal(opened,f.media);
});
test('parallel mutations serialize without losing entries and rename rejects hostile input',async t=>{
 const f=await fixture(t),lib=createRecordingLibrary({file:f.file});const results=await Promise.all(Array.from({length:12},(_,i)=>lib.add({...f.entry,id:'r'+i,createdAt:i})));assert.ok(results.every(r=>r.ok));
 await Promise.all(Array.from({length:12},(_,i)=>lib.rename('r'+i,'Episode '+i)));const listed=await lib.list();assert.equal(listed.recordings.length,12);assert.equal(listed.recordings[0].label,'Episode 11');
 for(const value of ['', ' '.repeat(3),'a'.repeat(161),'line\nbreak',null])assert.equal((await lib.rename('r1',value)).ok,false);
 assert.equal((await lib.rename('../outside','x')).ok,false);assert.equal((await lib.add({...f.entry,path:'relative'})).ok,false);assert.equal((await lib.add({...f.entry,path:path.join(f.root,'program.exe'),name:'program.exe'})).ok,false);
});
test('corrupt and symlink metadata are preserved; fixing retained metadata permits retry',async t=>{
 const f=await fixture(t),lib=createRecordingLibrary({file:f.file});await writeFile(f.file,'{broken');assert.equal((await lib.list()).ok,false);assert.equal((await lib.add(f.entry)).ok,false);assert.equal(await readFile(f.file,'utf8'),'{broken');
 await writeFile(f.file,JSON.stringify({version:1,entries:[]}));assert.equal((await lib.add(f.entry)).ok,true);
 const target=path.join(f.root,'untouched');await writeFile(target,'do not change');await unlink(f.file);await symlink(target,f.file);
 assert.equal((await lib.add(f.entry)).ok,false);assert.equal(await readFile(target,'utf8'),'do not change');
});
test('missing files and invalid identities cannot invoke native opening',async t=>{
 const f=await fixture(t);let opens=0;const lib=createRecordingLibrary({file:f.file,open:async()=>{opens++;return '';}});await lib.add(f.entry);await unlink(f.media);
 assert.match((await lib.open(f.entry.id)).message,/missing or unavailable/);assert.equal((await lib.open('unknown')).ok,false);assert.equal((await lib.open('../escape')).ok,false);assert.equal(opens,0);
});
