#!/usr/bin/env node
// CodexBWAI — offline BlastCast licence authority. Private keys never belong in the repository.
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PREFIX = 'BCAST1';
const usage = `Usage:
  node scripts/license-keys.mjs init --directory <private-directory>
  node scripts/license-keys.mjs issue --private-key <private.pem> --holder <name> --kind <owner|test|customer> --out <file>`;

function option(name) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0 || at === process.argv.length - 1 || process.argv[at + 1].startsWith('--')) throw new Error(`Missing --${name}.`);
  return process.argv[at + 1];
}
function clean(value, name, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`Invalid ${name}.`);
  return value.trim();
}
async function exclusive(filename, bytes, mode) {
  const handle = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await chmod(filename, mode);
}

async function init() {
  const directory = path.resolve(option('directory'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  await exclusive(path.join(directory, 'signing-private.pem'), privateKey, 0o600);
  await exclusive(path.join(directory, 'signing-public.pem'), publicKey, 0o644);
  process.stdout.write(`Created a BlastCast Ed25519 licence authority in ${directory}.\n`);
}

async function issue() {
  const privateFile = path.resolve(option('private-key'));
  const holder = clean(option('holder'), 'holder');
  const kind = clean(option('kind'), 'kind', 20);
  if (!['owner', 'test', 'customer'].includes(kind)) throw new Error('Kind must be owner, test or customer.');
  const output = path.resolve(option('out'));
  const payload = { v: 1, product: 'blastcast', licenseId: randomUUID(), holder, kind, issuedAt: new Date().toISOString() };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const privateKey = await readFile(privateFile, 'utf8');
  const signature = sign(null, Buffer.from(encoded, 'ascii'), privateKey).toString('base64url');
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await exclusive(output, `${PREFIX}.${encoded}.${signature}\n`, 0o600);
  process.stdout.write(`Issued ${kind} licence ${payload.licenseId} for ${holder} at ${output}.\n`);
}

try {
  const command = process.argv[2];
  if (command === 'init') await init();
  else if (command === 'issue') await issue();
  else throw new Error(usage);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Licence command failed.'}\n`);
  process.exitCode = 1;
}
