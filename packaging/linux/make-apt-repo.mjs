#!/usr/bin/env node
// ClaudeBWAI — flat APT repository generator for GitHub Releases. Node built-ins only (no apt-ftparchive/reprepro/aptly: GPL, not ruled).
// System tools used: `dpkg-deb --field` (read-only metadata) and `gpg` (build-time signing only).
//
// Layout (Debian "flat repository", suite "./"): every file lands directly in --out, no subdirectories, so each one is a
// GitHub release asset and users add:
//   deb [signed-by=/usr/share/keyrings/blastcast-archive-keyring.gpg] https://github.com/blastworksai/blastcast/releases/latest/download/ ./
// Packages `Filename:` is relative (the basename); apt prefixes it with the repository base URI.
import * as fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_OWNER = 'blastworksai';
export const REPO_NAME = 'blastcast';
const here = path.dirname(fileURLToPath(import.meta.url));

const hex = (alg, buf) => crypto.createHash(alg).update(buf).digest('hex');

export function debControl(file) {
  const r = spawnSync('dpkg-deb', ['--field', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`dpkg-deb --field failed for ${file}: ${r.stderr}`);
  return r.stdout.replace(/\n+$/, '');
}
const field = (ctl, name) => (new RegExp(`^${name}: (.*)$`, 'm').exec(ctl) || [])[1];

export function buildRepo({ debs, out, date = new Date() }) {
  fs.mkdirSync(out, { recursive: true });
  const stanzas = [];
  for (const deb of debs) {
    const buf = fs.readFileSync(deb), base = path.basename(deb), ctl = debControl(deb);
    const arch = field(ctl, 'Architecture');
    if (arch !== 'amd64') throw new Error(`${base}: Architecture is ${arch}, only amd64 is published`);
    if (!/^[A-Za-z0-9._+-]+$/.test(base)) throw new Error(`${base}: not a safe flat release-asset name`);
    fs.copyFileSync(deb, path.join(out, base));
    stanzas.push(`${ctl}\nFilename: ${base}\nSize: ${buf.length}\nMD5sum: ${hex('md5', buf)}\nSHA1: ${hex('sha1', buf)}\nSHA256: ${hex('sha256', buf)}\n`);
  }
  const packages = Buffer.from(stanzas.join('\n'));
  const gz = zlib.gzipSync(packages, { level: 9, mtime: 0 });
  fs.writeFileSync(path.join(out, 'Packages'), packages);
  fs.writeFileSync(path.join(out, 'Packages.gz'), gz);
  const entries = [['Packages', packages], ['Packages.gz', gz]];
  const sect = (name, alg) => `${name}:\n` + entries.map(([p, b]) => ` ${hex(alg, b)} ${String(b.length).padStart(16)} ${p}\n`).join('');
  // Flat repo: no Codename/Components. Date + Architectures + hashes are what apt needs; Origin/Label are cosmetic.
  const release = `Origin: Blastworks.ai\nLabel: BlastCast\nDate: ${date.toUTCString().replace('GMT', 'UTC')}\nArchitectures: amd64\nDescription: BlastCast APT repository\n` +
    sect('MD5Sum', 'md5') + sect('SHA1', 'sha1') + sect('SHA256', 'sha256');
  fs.writeFileSync(path.join(out, 'Release'), release);
  return { dist: out, release };
}

export function signRelease({ dist, gnupghome, key }) {
  const base = ['--yes', '--pinentry-mode', 'loopback', ...(gnupghome ? ['--homedir', gnupghome] : []), ...(key ? ['--local-user', key] : [])];
  const run = args => { const r = spawnSync('gpg', [...base, ...args], { stdio: 'inherit' }); if (r.status !== 0) throw new Error(`gpg ${args[0]} failed (exit ${r.status})`); };
  run(['--clearsign', '--output', path.join(dist, 'InRelease'), path.join(dist, 'Release')]);
  run(['--armor', '--detach-sign', '--output', path.join(dist, 'Release.gpg'), path.join(dist, 'Release')]);
}

function main(argv) {
  const debs = []; let out, gnupghome, key;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out = argv[++i]; else if (a === '--gnupghome') gnupghome = argv[++i]; else if (a === '--key') key = argv[++i];
    else debs.push(a);
  }
  if (!debs.length || !out) {
    console.error('usage: make-apt-repo.mjs <deb...> --out <dir> [--gnupghome <dir>] [--key <fpr>]'); process.exit(2);
  }
  const { dist } = buildRepo({ debs, out });
  signRelease({ dist, gnupghome, key });
  for (const f of ['blastcast-archive-keyring.gpg', 'blastcast-archive-keyring.asc']) {
    const src = path.join(here, f);
    if (!fs.existsSync(src)) throw new Error(`missing ${src}; run create-signing-key.sh first`);
    fs.copyFileSync(src, path.join(out, f));
  }
  console.log(`flat repository written to ${out}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
