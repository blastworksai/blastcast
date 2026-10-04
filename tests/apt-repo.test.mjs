// ClaudeBWAI — flat APT repo generator: throwaway passphrase-less key, real dpkg-deb fixture, real gpg verify, offline apt check.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildRepo, signRelease } from '../packaging/linux/make-apt-repo.mjs';
const have = c => spawnSync('sh', ['-c', `command -v ${c}`]).status === 0;
const sha = (f, a) => crypto.createHash(a).update(fs.readFileSync(f)).digest('hex');

test('flat apt repo: relative Filename, Release hashes, signatures, flat dir, offline apt', t => {
  if (!have('gpg') || !have('dpkg-deb')) return t.skip('gpg or dpkg-deb absent');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bcapt-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'g'); fs.mkdirSync(home, { mode: 0o700 });
  const pkg = path.join(base, 'pkg'); fs.mkdirSync(path.join(pkg, 'DEBIAN'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'DEBIAN/control'), 'Package: blastcast\nVersion: 9.9.9\nArchitecture: amd64\nMaintainer: T <t@example.invalid>\nDescription: fixture\n long line\n');
  const deb = path.join(base, 'BlastCast-9.9.9-linux-amd64.deb');
  assert.equal(spawnSync('dpkg-deb', ['--build', pkg, deb], { encoding: 'utf8' }).status, 0);
  const env = { ...process.env, GNUPGHOME: home };
  const g = spawnSync('gpg', ['--batch', '--passphrase', '', '--quick-generate-key', 'Test <t@example.invalid>', 'ed25519', 'sign', '1d'], { env, encoding: 'utf8' });
  assert.equal(g.status, 0, g.stderr);
  const out = path.join(base, 'repo');
  const { dist } = buildRepo({ debs: [deb], out });
  assert.equal(dist, out);
  signRelease({ dist, gnupghome: home });

  const pk = fs.readFileSync(path.join(out, 'Packages'), 'utf8');
  assert.match(pk, /^Package: blastcast$/m); assert.match(pk, /^Version: 9\.9\.9$/m);
  assert.match(pk, /^Filename: BlastCast-9\.9\.9-linux-amd64\.deb$/m);
  assert.doesNotMatch(pk, /^Filename: .*:\/\//m, 'Filename must carry no scheme');
  assert.doesNotMatch(pk, /^Filename: \//m, 'Filename must not be absolute');
  assert.match(pk, new RegExp(`^Size: ${fs.statSync(deb).size}$`, 'm'));
  assert.match(pk, new RegExp(`^SHA256: ${sha(deb, 'sha256')}$`, 'm')); assert.match(pk, new RegExp(`^MD5sum: ${sha(deb, 'md5')}$`, 'm'));
  assert.ok(fs.existsSync(path.join(out, 'BlastCast-9.9.9-linux-amd64.deb')));

  const rel = fs.readFileSync(path.join(out, 'Release'), 'utf8');
  assert.match(rel, /^Architectures: amd64$/m); assert.match(rel, /^Origin: Blastworks\.ai$/m); assert.match(rel, /^Label: BlastCast$/m);
  assert.doesNotMatch(rel, /^Components:/m);
  assert.match(rel, /^Date: \w{3}, \d\d \w{3} \d{4} \d\d:\d\d:\d\d UTC$/m);
  for (const [alg, sect] of [['md5', 'MD5Sum'], ['sha1', 'SHA1'], ['sha256', 'SHA256']])
    for (const f of ['Packages', 'Packages.gz']) {
      const p = path.join(out, f);
      assert.ok(rel.split(`${sect}:\n`)[1].includes(` ${sha(p, alg)} ${String(fs.statSync(p).size).padStart(16)} ${f}\n`), `${sect} ${f}`);
    }
  for (const args of [['--verify', path.join(out, 'InRelease')], ['--verify', path.join(out, 'Release.gpg'), path.join(out, 'Release')]]) {
    const v = spawnSync('gpg', args, { env, encoding: 'utf8' }); assert.equal(v.status, 0, v.stderr);
  }
  const entries = fs.readdirSync(out, { withFileTypes: true });
  assert.ok(entries.every(e => e.isFile()), 'no subdirectories: every file is a release asset');
  assert.deepEqual(entries.map(e => e.name).sort(), ['BlastCast-9.9.9-linux-amd64.deb', 'InRelease', 'Packages', 'Packages.gz', 'Release', 'Release.gpg']);

  // Real offline apt check against a file: flat repo.
  if (!have('apt-get') || !have('apt-cache')) return;
  const kr = path.join(base, 'keyring.gpg');
  const ex = spawnSync('gpg', ['--export', '--output', kr], { env }); assert.equal(ex.status, 0);
  const lists = path.join(base, 'lists'), cache = path.join(base, 'cache');
  fs.mkdirSync(path.join(lists, 'partial'), { recursive: true }); fs.mkdirSync(path.join(cache, 'archives/partial'), { recursive: true });
  const src = path.join(base, 'sources.list');
  fs.writeFileSync(src, `deb [signed-by=${kr}] file:${out} ./\n`);
  const o = ['-o', `Dir::Etc::sourcelist=${src}`, '-o', 'Dir::Etc::sourceparts=-', '-o', `Dir::State::Lists=${lists}`, '-o', `Dir::Cache=${cache}`, '-o', 'Dir::State::status=/dev/null', '-o', 'APT::Get::List-Cleanup=0'];
  const up = spawnSync('apt-get', [...o, 'update'], { encoding: 'utf8' });
  if (up.status !== 0 && /permission|root|lock/i.test(up.stderr)) return t.diagnostic(`apt-get update needs root here, skipped: ${up.stderr}`);
  assert.equal(up.status, 0, up.stdout + up.stderr);
  const sh = spawnSync('apt-cache', [...o, 'show', 'blastcast'], { encoding: 'utf8' });
  assert.equal(sh.status, 0, sh.stderr);
  assert.match(sh.stdout, /^Filename: BlastCast-9\.9\.9-linux-amd64\.deb$/m);
});
