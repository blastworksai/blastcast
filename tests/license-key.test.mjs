import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { verifyLicenseKey } = require('../desktop/license-key.cjs');

function authority() {
  return generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}
function issue(privateKey, changes = {}) {
  const payload = { v: 1, product: 'blastcast', licenseId: randomUUID(), holder: 'Test user', kind: 'test', issuedAt: new Date().toISOString(), ...changes };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `BCAST1.${encoded}.${sign(null, Buffer.from(encoded, 'ascii'), privateKey).toString('base64url')}`;
}

test('valid signed BlastCast keys cross the activation boundary', () => {
  const keys = authority(); const key = issue(keys.privateKey);
  const result = verifyLicenseKey(key, keys.publicKey);
  assert.equal(result?.holder, 'Test user'); assert.equal(result?.kind, 'test');
  assert.match(result?.licenseId ?? '', /^[0-9a-f-]{36}$/); assert.match(result?.issuedAt ?? '', /^\d{4}-/);
  assert.equal(verifyLicenseKey(`  ${key}\n`, keys.publicKey)?.holder, 'Test user');
});

test('tampered, foreign, malformed and expanded licence keys are rejected', () => {
  const keys = authority(), foreign = authority(); const key = issue(keys.privateKey);
  const [prefix, payload, signature] = key.split('.');
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), holder: 'Attacker' })).toString('base64url');
  for (const candidate of ['', key.slice(0, -1), `${prefix}.${changed}.${signature}`, issue(foreign.privateKey), issue(keys.privateKey, { product: 'other' }), issue(keys.privateKey, { extra: true }), 'x'.repeat(4097)]) {
    assert.equal(verifyLicenseKey(candidate, keys.publicKey), null);
  }
});

test('manual authority command creates protected signing material and issues a verifiable key', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-authority-')); t.after(() => fs.rm(root,{recursive:true,force:true}));
  const script = path.resolve('scripts/license-keys.mjs');
  let run = spawnSync(process.execPath,[script,'init','--directory',root],{encoding:'utf8'}); assert.equal(run.status,0,run.stderr);
  const output=path.join(root,'issued/customer.bcast-key');
  run=spawnSync(process.execPath,[script,'issue','--private-key',path.join(root,'signing-private.pem'),'--holder','Manual customer','--kind','customer','--out',output],{encoding:'utf8'}); assert.equal(run.status,0,run.stderr);
  const key=await fs.readFile(output,'utf8'), publicKey=await fs.readFile(path.join(root,'signing-public.pem'),'utf8');
  assert.equal(verifyLicenseKey(key,publicKey)?.holder,'Manual customer');
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(path.join(root,'signing-private.pem'))).mode & 0o777,0o600);
    assert.equal((await fs.stat(output)).mode & 0o777,0o600);
  }
  assert.notEqual(spawnSync(process.execPath,[script,'init','--directory',root]).status,0);
});
