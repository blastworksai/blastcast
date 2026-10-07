// ClaudeBWAI — einh 5 Oct: Mac App Store build. Invariant sweep, launch proof and refusals for `package.mjs --mas`.
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assembleMacApp as assembleRaw, buildNativeMacPackage, transformPlist, masHelperBundleId, MAS_ARCHIVE_HASHES, MAS_EXCLUDED, matchArchive } from '../packaging/macos/package.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const CAR_BYTES = Buffer.from('fake-assets-car');
const CAR_FIXTURE = { path: null, sha256: sha(CAR_BYTES) };
// Task 5.1: every assembly needs a pinned icon catalog; the fixture stands in for the committed Assets.car.
const assembleMacApp = (opts) => assembleRaw({ assetsCar: CAR_FIXTURE, ...opts });
const HELPER_BYTES = Buffer.from('fake-arm64-ssh-helper');
const PLIST = (id) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n<key>CFBundleName</key>\n<string>Electron</string>\n<key>CFBundleIconFile</key>\n<string>electron.icns</string>\n<key>CFBundleExecutable</key>\n<string>Electron</string>\n<key>CFBundleIdentifier</key>\n<string>${id}</string>\n</dict>\n</plist>`;

async function walk(dir) {
  const out = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...await walk(full));
    else if (item.isFile()) out.push(full);
  }
  return out;
}

async function exists(p) { try { await fs.lstat(p); return true; } catch { return false; } }

describe('Mac App Store packaging (--mas)', () => {
  let tmp, runtimeDir, sourceDir, helper, buildinfo, masApp, plainApp;

  async function fixtureRuntime(dir) {
    const app = path.join(dir, 'Electron.app', 'Contents');
    await fs.mkdir(path.join(app, 'MacOS'), { recursive: true });
    await fs.writeFile(path.join(app, 'MacOS', 'Electron'), 'fake-binary');
    await fs.writeFile(path.join(app, 'Info.plist'), PLIST('com.github.electron'));
    for (const name of ['Electron Helper.app', 'Electron Helper (Renderer).app', 'Electron Helper (GPU).app', 'Electron Helper (Plugin).app']) {
      const c = path.join(app, 'Frameworks', name, 'Contents');
      await fs.mkdir(path.join(c, 'MacOS'), { recursive: true });
      await fs.writeFile(path.join(c, 'Info.plist'), PLIST(`com.github.Electron.${name}`));
    }
    const login = path.join(app, 'Library', 'LoginItems', 'Electron Login Helper.app', 'Contents');
    await fs.mkdir(login, { recursive: true });
    await fs.writeFile(path.join(login, 'Info.plist'), PLIST('com.github.Electron.loginhelper'));
    await fs.writeFile(path.join(dir, 'LICENSE'), 'fake-license');
    await fs.writeFile(path.join(dir, 'LICENSES.chromium.html'), 'fake-chromium');
  }

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-mas-test-'));
    runtimeDir = path.join(tmp, 'runtime');
    sourceDir = path.join(tmp, 'src');
    CAR_FIXTURE.path = path.join(tmp, 'Assets.car.fixture');
    await fs.writeFile(CAR_FIXTURE.path, CAR_BYTES);
    await fs.mkdir(runtimeDir); await fixtureRuntime(runtimeDir);
    // The real app tree, with the MAS dist: every compiled module from dist/ plus build.mjs --mas output on top.
    await fs.mkdir(sourceDir);
    for (const name of ['desktop', 'assets', 'dist']) await fs.cp(path.join(root, name), path.join(sourceDir, name), { recursive: true });
    for (const name of ['LICENSE', 'package.json']) await fs.copyFile(path.join(root, name), path.join(sourceDir, name));
    const built = spawnSync(process.execPath, ['scripts/build.mjs', '--mas', '--out', path.join(sourceDir, 'dist')], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(built.status, 0, built.stderr);
    await fs.mkdir(path.join(tmp, 'helper'));
    helper = path.join(tmp, 'helper', 'ssh');
    buildinfo = path.join(tmp, 'helper', 'BUILDINFO.txt');
    await fs.writeFile(helper, HELPER_BYTES);
    await fs.writeFile(buildinfo, `openssl-3.5.9.tar.gz sha256: ${'0'.repeat(64)}\nout/ssh sha256: ${sha(HELPER_BYTES)}\n`);
    masApp = (await assembleMacApp({ runtimeDir, sourceDir, outDir: path.join(tmp, 'out-mas'), targetArch: 'mas-arm64', mas: true, helperPath: helper, platform: 'linux' })).appPath;
    // Non-MAS twin needs the default (non-MAS) dist.
    const plainSource = path.join(tmp, 'plain-src');
    await fs.mkdir(plainSource);
    for (const name of ['desktop', 'assets', 'dist']) await fs.cp(path.join(root, name), path.join(plainSource, name), { recursive: true });
    for (const name of ['LICENSE', 'package.json']) await fs.copyFile(path.join(root, name), path.join(plainSource, name));
    plainApp = (await assembleMacApp({ runtimeDir, sourceDir: plainSource, outDir: path.join(tmp, 'out-plain'), targetArch: 'darwin-arm64' })).appPath;
  });

  after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('INVARIANT SWEEP: no key, purchase or releases text anywhere in the MAS app, and the helper is 0755', async () => {
    const needles = [
      'public-key.txt', 'license-store.cjs', 'license-key.cjs', 'releases-link.cjs',
      'BlastCast requires a key purchased from Blastworks.ai',
      'github.com/blastworksai/blastcast/releases',
    ];
    const FILE_NAMES = needles.slice(0, 4);
    const urlPattern = /https?:\/\/[^\s"'<>)]*blastworks\.ai[^\s"'<>)]*/i;
    const files = await walk(path.join(masApp, 'Contents', 'Resources', 'app'));
    assert.ok(files.length > 50, 'sweep must cover the real app tree');
    assert.ok(files.some(f => f.endsWith(path.join('desktop', 'main.cjs'))), 'sweep covers desktop/');
    const hits = [];
    for (const f of files) {
      const text = (await fs.readFile(f)).toString('latin1');
      // desktop/main.cjs and mas-flavour.cjs name the excluded modules in comments and in the guarded non-MAS require sites;
      // the files themselves are absent (asserted below), so a name there is dead text, not a leak.
      const namesAllowed = /desktop[\\/](main|mas-flavour)\.cjs$/.test(f);
      for (const n of needles) if (text.includes(n) && !(namesAllowed && FILE_NAMES.includes(n))) hits.push(`${path.relative(masApp, f)}: ${n}`);
      const m = urlPattern.exec(text);
      if (m) hits.push(`${path.relative(masApp, f)}: ${m[0]}`);
    }
    assert.deepStrictEqual(hits, []);
    for (const rel of MAS_EXCLUDED) assert.strictEqual(await exists(path.join(masApp, 'Contents', 'Resources', 'app', rel)), false, rel);
    const st = await fs.stat(path.join(masApp, 'Contents', 'Helpers', 'ssh'));
    assert.strictEqual(st.mode & 0o777, 0o755);
    assert.deepStrictEqual(await fs.readFile(path.join(masApp, 'Contents', 'Helpers', 'ssh')), HELPER_BYTES);
  });

  it('TWIN: the non-MAS output still ships the four files, the key sentence and has no Helpers/ssh', async () => {
    for (const rel of MAS_EXCLUDED) assert.ok(await exists(path.join(plainApp, 'Contents', 'Resources', 'app', rel)), rel);
    const index = await fs.readFile(path.join(plainApp, 'Contents', 'Resources', 'app', 'dist', 'index.html'), 'utf8');
    assert.ok(index.includes('BlastCast requires a key purchased from Blastworks.ai'));
    assert.strictEqual(await exists(path.join(plainApp, 'Contents', 'Helpers')), false);
    assert.ok(!(await fs.readFile(path.join(plainApp, 'Contents', 'Info.plist'), 'utf8')).includes('ElectronTeamID'));
  });

  it('licence texts sit where licences-window.cjs reads them', async () => {
    const appDir = path.join(masApp, 'Contents', 'Resources', 'app');
    for (const f of ['OpenSSH-LICENCE.txt', 'OpenSSL-LICENSE.txt']) assert.ok(await exists(path.join(appDir, 'assets', 'licences', f)), f);
    assert.ok(await exists(path.join(appDir, 'LICENSE')));
    assert.ok(await exists(path.join(masApp, 'Contents', 'Resources', 'LICENSE')));
    assert.ok(await exists(path.join(masApp, 'Contents', 'Resources', 'LICENSES.chromium.html')));
  });

  // Runs main.cjs in a child node under a stubbed electron. The stub's promises resolve at once, so
  // app.whenReady().then(handler) runs the handler, where the guarded license-store / releases-link requires live.
  function launch(mainPath, mas) {
    const script = path.join(tmp, `launch-${crypto.randomUUID()}.cjs`);
    const source = `
const Module = require('node:module');
const make = () => new Proxy(function () {}, {
  get: (_t, k) => k === 'then' ? (res) => { if (res) queueMicrotask(() => res(undefined)); return make(); } : k === Symbol.toPrimitive ? () => '' : make(),
  apply: () => make(), construct: () => make(),
});
const stub = make();
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? stub : load.call(this, request, ...rest); };
const errors = [];
process.on('unhandledRejection', e => errors.push(e)); process.on('uncaughtException', e => errors.push(e));
const before = process.mas;
if (${mas}) process.mas = true;
process.resourcesPath = '/x/BlastCast.app/Contents/Resources';
try { require(${JSON.stringify(mainPath)}); } catch (e) { errors.push(e); }
setTimeout(() => {
  if (before === undefined) delete process.mas; else process.mas = before;
  for (const e of errors) console.log('ERR ' + (e && e.code) + ' ' + (e && e.message));
  console.log('DONE'); process.exit(0);
}, 400);`;
    return fs.writeFile(script, source).then(() => spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30000 }));
  }

  it('LAUNCH PROOF: main.cjs and the ready handler load under process.mas with no MODULE_NOT_FOUND', async () => {
    const r = await launch(path.join(masApp, 'Contents', 'Resources', 'app', 'desktop', 'main.cjs'), true);
    const out = r.stdout + r.stderr;
    assert.match(out, /DONE/, out);
    assert.ok(!/MODULE_NOT_FOUND/.test(out), out);
  });

  it('launch proof is not vacuous: the same run without process.mas fails once license-store.cjs is gone', async () => {
    const dir = path.join(tmp, 'neg');
    await fs.cp(path.join(plainApp, 'Contents', 'Resources', 'app'), dir, { recursive: true });
    const withStore = await launch(path.join(dir, 'desktop', 'main.cjs'), false);
    assert.ok(!/MODULE_NOT_FOUND/.test(withStore.stdout), withStore.stdout);
    await fs.rm(path.join(dir, 'desktop', 'license-store.cjs'));
    const without = await launch(path.join(dir, 'desktop', 'main.cjs'), false);
    assert.match(without.stdout, /MODULE_NOT_FOUND/, without.stdout + without.stderr);
  });

  it('rewrites every Electron helper and the login helper to Blastworks bundle ids, and sets the plist keys', async () => {
    const fw = path.join(masApp, 'Contents', 'Frameworks');
    const ids = {};
    for (const name of await fs.readdir(fw)) ids[name] = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)/.exec(await fs.readFile(path.join(fw, name, 'Contents', 'Info.plist'), 'utf8'))[1];
    assert.deepStrictEqual(ids, {
      'Electron Helper (GPU).app': 'com.blastworks.blastcast.helper.gpu',
      'Electron Helper (Plugin).app': 'com.blastworks.blastcast.helper.plugin',
      'Electron Helper (Renderer).app': 'com.blastworks.blastcast.helper.renderer',
      'Electron Helper.app': 'com.blastworks.blastcast.helper',
    });
    const login = await fs.readFile(path.join(masApp, 'Contents', 'Library', 'LoginItems', 'Electron Login Helper.app', 'Contents', 'Info.plist'), 'utf8');
    assert.match(login, /<string>com\.blastworks\.blastcast\.loginhelper<\/string>/);
    assert.strictEqual(masHelperBundleId('Electron Helper (Renderer).app'), 'com.blastworks.blastcast.helper.renderer');
    const plist = await fs.readFile(path.join(masApp, 'Contents', 'Info.plist'), 'utf8');
    assert.match(plist, /<key>LSApplicationCategoryType<\/key>\s*<string>public\.app-category\.video<\/string>/);
    assert.match(plist, /<key>ElectronTeamID<\/key>\s*<string>RN28A922NH<\/string>/);
    assert.match(plist, /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
    assert.match(plist, /<string>com\.blastworks\.blastcast<\/string>/);
    assert.match(plist, /NSCameraUsageDescription/);
    assert.match(plist, /NSMicrophoneUsageDescription/);
  });

  it('transformPlist: an existing ITSAppUsesNonExemptEncryption true is replaced by false', () => {
    const xml = PLIST('x').replace('</dict>', '<key>ITSAppUsesNonExemptEncryption</key>\n<true/>\n</dict>');
    const out = transformPlist(xml, null, { mas: true });
    assert.match(out, /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
    assert.ok(!out.includes('<true/>'));
  });

  const base = () => ({ runtimeDir, sourceDir, outDir: path.join(tmp, `refuse-${crypto.randomUUID()}`) });

  it('refuses a helper whose SHA-256 differs from BUILDINFO', async () => {
    const bad = path.join(tmp, 'helper', 'ssh-bad');
    await fs.writeFile(bad, 'tampered');
    await assert.rejects(assembleMacApp({ ...base(), targetArch: 'mas-arm64', mas: true, helperPath: bad, helperBuildinfo: buildinfo, platform: 'linux' }), /does not match BUILDINFO/);
  });

  it('refuses a missing BUILDINFO, a missing helper, and --mas without --helper', async () => {
    await fs.mkdir(path.join(tmp, 'lonely'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'lonely', 'ssh'), 'x');
    await assert.rejects(assembleMacApp({ ...base(), targetArch: 'mas-arm64', mas: true, helperPath: path.join(tmp, 'lonely', 'ssh'), platform: 'linux' }), /Missing helper BUILDINFO/);
    await assert.rejects(assembleMacApp({ ...base(), targetArch: 'mas-arm64', mas: true, helperPath: path.join(tmp, 'helper', 'nope'), helperBuildinfo: buildinfo, platform: 'linux' }), /Missing or unreadable helper/);
    await assert.rejects(assembleMacApp({ ...base(), targetArch: 'mas-arm64', mas: true, platform: 'linux' }), /requires --helper/);
  });

  it('on darwin refuses anything but exactly arm64 from lipo', async () => {
    await assert.rejects(assembleMacApp({ ...base(), targetArch: 'mas-arm64', mas: true, helperPath: helper, platform: 'darwin', lipoArchs: () => 'x86_64 arm64' }), /arm64 only/);
    await assert.rejects(assembleMacApp({ ...base(), targetArch: 'mas-arm64', mas: true, helperPath: helper, platform: 'darwin', lipoArchs: () => 'x86_64' }), /arm64 only/);
  });

  it('refuses --mas on a non-MAS runtime target, and --helper without --mas', async () => {
    await assert.rejects(assembleMacApp({ ...base(), targetArch: 'darwin-arm64', mas: true, helperPath: helper, platform: 'linux' }), /arm64 Mac App Store runtime only/);
    await assert.rejects(assembleMacApp({ ...base(), targetArch: 'darwin-arm64', helperPath: helper }), /only valid with --mas/);
  });

  it('Task 5.1: the MAS app ships the pinned Assets.car and CFBundleIconName, like the plain build', async () => {
    for (const app of [masApp, plainApp]) {
      assert.deepStrictEqual(await fs.readFile(path.join(app, 'Contents', 'Resources', 'Assets.car')), CAR_BYTES);
      const plist = await fs.readFile(path.join(app, 'Contents', 'Info.plist'), 'utf8');
      assert.match(plist, /<key>CFBundleIconName<\/key>\s*<string>AppIcon<\/string>/);
      assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>BlastCast\.icns<\/string>/);
    }
  });

  it('Task 5.1 (--mas): wrong SHA, PENDING pin and bad build number are refused; a good one sets CFBundleVersion', async () => {
    const mas = { targetArch: 'mas-arm64', mas: true, helperPath: helper, platform: 'linux' };
    await assert.rejects(assembleRaw({ ...base(), ...mas, assetsCar: { ...CAR_FIXTURE, sha256: 'b'.repeat(64) } }), /does not match the pin/);
    await assert.rejects(assembleRaw({ ...base(), ...mas, assetsCar: { ...CAR_FIXTURE, sha256: 'PENDING' } }), /Assets\.car not pinned yet; run build-icon-assets\.sh on Thor/);
    await assert.rejects(assembleMacApp({ ...base(), ...mas, buildNumber: '0' }), /Invalid --build-number/);
    const res = await assembleMacApp({ ...base(), ...mas, buildNumber: '12' });
    assert.match(await fs.readFile(path.join(res.appPath, 'Contents', 'Info.plist'), 'utf8'), /<key>CFBundleVersion<\/key>\s*<string>12<\/string>/);
  });

  describe('archive pins (darwin only past the platform gate, so tested through the CLI-level entry on Linux by the gate message)', () => {
    it('--mas with --arch x64 is refused before anything else', async () => {
      await assert.rejects(buildNativeMacPackage({ archivePath: 'x', sourceDir, outDir: path.join(tmp, 'o'), mas: true, arch: 'x64', helperPath: helper }), /arm64 only; --arch x64 is refused/);
    });
    it('the two pin tables are disjoint, so neither mode accepts the other zip', () => {
      const darwin = ['a212eee63ba2f45fd83bd28f77a3e3313a336ad17a4c25adf617942eef5e0e2c', '778350cc572c36484dd56c130cae96ad1a9a5b695ba22dd06abd23ba0a46c9de'];
      assert.deepStrictEqual(Object.keys(MAS_ARCHIVE_HASHES), ['mas-arm64']);
      for (const h of darwin) assert.ok(!Object.values(MAS_ARCHIVE_HASHES).includes(h));
      assert.ok(!darwin.includes(MAS_ARCHIVE_HASHES['mas-arm64']));
      const mas = MAS_ARCHIVE_HASHES['mas-arm64'];
      assert.strictEqual(matchArchive(mas, true), 'mas-arm64');
      assert.throws(() => matchArchive(mas, false), /does not match any official Electron .* macOS pin/);
      assert.strictEqual(matchArchive(darwin[0], false), 'darwin-arm64');
      assert.strictEqual(matchArchive(darwin[1], false), 'darwin-x64');
      for (const h of darwin) assert.throws(() => matchArchive(h, true), /Mac App Store pin/);
    });
  });
});
