import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLicenseStore } = require('../desktop/license-store.cjs');

const authority = generateKeyPairSync('ed25519', { privateKeyEncoding:{type:'pkcs8',format:'pem'}, publicKeyEncoding:{type:'spki',format:'pem'} });
function issue() { const payload={v:1,product:'blastcast',licenseId:randomUUID(),holder:'Owner',kind:'owner',issuedAt:new Date().toISOString()}; const body=Buffer.from(JSON.stringify(payload)).toString('base64url'); return `BCAST1.${body}.${sign(null,Buffer.from(body,'ascii'),authority.privateKey).toString('base64url')}`; }
const safeStorage = { isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'secret_service',encryptString:value=>Buffer.from(`safe:${value}`),decryptString:bytes=>bytes.toString().slice(5) };

test('activation is verified, encrypted, restored and removable without exposing key text', async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'blastcast-license-')); t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=createLicenseStore({directory,safeStorage,publicKey:authority.publicKey}); const key=issue();
  assert.deepEqual(await store.load(),{active:false});
  const activated=await store.activate(key); assert.equal(activated.active,true); assert.equal(activated.license.holder,'Owner'); assert.equal(store.active(),true);
  const saved=await fs.readFile(path.join(directory,'activation/license.json'),'utf8'); assert.equal(saved.includes(key),false);
  const restored=createLicenseStore({directory,safeStorage,publicKey:authority.publicKey}); assert.equal((await restored.load()).active,true);
  assert.deepEqual(await restored.deactivate(),{active:false}); assert.equal(restored.active(),false);
});

test('invalid keys and unavailable secure storage stay inactive', async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'blastcast-license-')); t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=createLicenseStore({directory,safeStorage,publicKey:authority.publicKey}); assert.match((await store.activate('wrong')).message,/invalid/); assert.equal(store.active(),false);
  const unavailable=createLicenseStore({directory,safeStorage:{isEncryptionAvailable:()=>false},publicKey:authority.publicKey}); assert.match((await unavailable.activate(issue())).message,/unavailable/);
});
