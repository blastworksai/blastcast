// CodexBWAI — real authenticated ciphertext behind an injected OS-store boundary; no network.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {createGuestSettings} from '../desktop/guest-settings.cjs';
const config=()=>({domain:'no',freeRouteAcknowledged:true,origin:'',port:43821,helper:{provider:'localhost-run',freeAccountConfirmed:true,relay:{urls:['turn:relay.expressturn.com:3478?transport=udp'],username:'private-username',credential:'never-plaintext-secret',iceTransportPolicy:'all'}}});
function crypt(){const key=randomBytes(32);return {isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'gnome_libsecret',encryptString(value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([c.update(value,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes]);},decryptString(bytes){const d=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));d.setAuthTag(bytes.subarray(12,28));return Buffer.concat([d.update(bytes.subarray(28)),d.final()]).toString('utf8');}};}
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'blastcast-guest-settings-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const safeStorage=crypt();return {directory,safeStorage,store:createGuestSettings({directory,safeStorage}),filename:path.join(directory,'guest-settings/settings.json')};}
test('encrypted settings survive restart; public results contain no credential or plaintext config on disk',async t=>{
 const f=await fixture(t);assert.deepEqual(await f.store.load(),{ok:true,settings:null});const saved=await f.store.save(config());assert.equal(saved.ok,true);assert.equal(saved.settings.helper.relay.credential,'');assert.equal(saved.settings.credentialSaved,true);
 const bytes=await fs.readFile(f.filename);for(const secret of ['never-plaintext-secret','private-username','expressturn'])assert.ok(!bytes.includes(secret));assert.equal((await fs.stat(f.filename)).mode&0o777,0o600);
 const restarted=createGuestSettings({directory:f.directory,safeStorage:f.safeStorage});assert.deepEqual(await restarted.load(),saved);assert.deepEqual(await restarted.configuration(),config());
 saved.settings.helper.relay.urls[0]='mutated';assert.deepEqual(await restarted.configuration(),config());assert.deepEqual(await restarted.clear(),{ok:true,settings:null});assert.deepEqual(await restarted.load(),{ok:true,settings:null});
});
test('blank password preserves only identical relay identity; changed username/URLs require new password',async t=>{
 const f=await fixture(t);await f.store.save(config());const blank=config();blank.helper.relay.credential='';blank.port=43822;assert.equal((await f.store.save(blank)).ok,true);assert.equal((await f.store.configuration()).helper.relay.credential,config().helper.relay.credential);
 for(const field of ['username','urls']){const changed=structuredClone(blank);changed.helper.relay[field]=field==='username'?'other':['turn:other.expressturn.com:3478?transport=tcp'];assert.equal((await f.store.save(changed)).ok,false);}
 await f.store.clear();assert.equal((await f.store.save(blank)).ok,false);
});
test('invalid schemas/provider/address/port/relay preserve existing encrypted settings',async t=>{
 const f=await fixture(t);await f.store.save(config());const before=await fs.readFile(f.filename);
 const values=[null,{...config(),extra:true},{...config(),domain:'yes'}, {...config(),port:80}, {...config(),helper:{...config().helper,provider:'other'}}, {...config(),origin:'\0'}];
 const noRelay=config();noRelay.helper=undefined;values.push(noRelay);const dangerous=config();Object.defineProperty(dangerous.helper.relay,'credential',{get(){throw Error('secret accessor');},enumerable:true});values.push(dangerous);
 for(const value of values){const result=await f.store.save(value);assert.equal(result.ok,false);assert.ok(!result.message.includes('secret accessor'));}
 assert.deepEqual(await fs.readFile(f.filename),before);const own=config();own.domain='yes';own.origin='https://guests.example.com/';own.helper.provider='cloudflare';assert.equal((await f.store.save(own)).settings.origin,'https://guests.example.com');
});
test('unavailable or basic_text storage never writes plaintext and reports sanitized errors',async t=>{
 const f=await fixture(t);for(const safeStorage of [{...f.safeStorage,isEncryptionAvailable:()=>false},{...f.safeStorage,getSelectedStorageBackend:()=> 'basic_text'}, {...f.safeStorage,encryptString(){throw Error('never-plaintext-secret');}}]){
 const store=createGuestSettings({directory:f.directory,safeStorage});const result=await store.save(config());assert.equal(result.ok,false);assert.ok(!result.message.includes('never-plaintext-secret'));await assert.rejects(fs.stat(f.filename),{code:'ENOENT'});
 }
});
test('corrupt envelopes and decrypted invalid data fail closed; internal errors never reflect secret bytes',async t=>{
 const f=await fixture(t);await f.store.save(config());
 for(const text of ['never-plaintext-secret',JSON.stringify({version:2,ciphertext:'YWJj'}),JSON.stringify({version:1,ciphertext:'$bad'}),JSON.stringify({version:1,ciphertext:f.safeStorage.encryptString(JSON.stringify({...config(),port:1})).toString('base64')})]){
 await fs.writeFile(f.filename,text);const result=await f.store.load();assert.equal(result.ok,false);assert.ok(!result.message.includes('never-plaintext-secret'));await assert.rejects(f.store.configuration(),e=>!e.message.includes('never-plaintext-secret'));
 }
 await fs.writeFile(f.filename,Buffer.alloc(65537));assert.equal((await f.store.load()).ok,false);
});
test('symlink and hardlink settings are refused without touching their targets',async t=>{
 const f=await fixture(t);await f.store.load();const target=path.join(f.directory,'private-target');await fs.writeFile(target,'untouched');await fs.symlink(target,f.filename);
 assert.equal((await f.store.load()).ok,false);assert.equal((await f.store.save(config())).ok,false);assert.equal((await f.store.clear()).ok,false);assert.equal(await fs.readFile(target,'utf8'),'untouched');
 await fs.unlink(f.filename);await fs.link(target,f.filename);assert.equal((await f.store.load()).ok,false);assert.equal((await f.store.save(config())).ok,false);assert.equal(await fs.readFile(target,'utf8'),'untouched');
});
test('read validates decrypted helper again and serialized saves do not mix concurrent credentials',async t=>{
 const f=await fixture(t);const second=config();second.helper.relay.credential='second-secret';const blank=config();blank.helper.relay.credential='';
 const results=await Promise.all([f.store.save(config()),f.store.save(second),f.store.save(blank)]);assert.ok(results.every(r=>r.ok));assert.equal((await f.store.configuration()).helper.relay.credential,'second-secret');
 const bad=config();bad.helper.relay.urls=['turn:attacker.example:3478?transport=udp'];await fs.writeFile(f.filename,JSON.stringify({version:1,ciphertext:f.safeStorage.encryptString(JSON.stringify(bad)).toString('base64')}));assert.equal((await f.store.load()).ok,false);
});
