// CodexBWAI — synthetic layout fixtures, never native Windows acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assembleWindowsApp, hashFile } from '../packaging/windows/layout.mjs';
import { parseArguments, packageWindows, systemPowerShell, verifyRuntimeArchive } from '../packaging/windows/package.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'blastcast-win-layout-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'app'), runtime = path.join(root, 'runtime'), output = path.join(root, 'output');
  for (const [name, content] of Object.entries({
    'app/package.json': JSON.stringify({ name: 'blastcast', version: '0.1.0', main: 'desktop/main.cjs', devDependencies: { typescript: '7.0.2' } }), 'app/LICENSE':'fixture licence',
    'app/desktop/main.cjs': '// fixture', 'app/desktop/preload.cjs': '// bridge', 'app/desktop/guests.cjs': '// guests',
    'app/dist/index.html': '<html>fixture</html>', 'app/dist/studio.js': '// fixture UI', 'app/dist/guest.js': '// guest',
    'app/dist/package.json': '{"type":"module"}', 'app/assets/brand/Blastworks-Cast-256.png': 'fake image',
    'app/assets/scenes/defaults/1cam.png': 'fake background', 'app/.env': 'must not ship',
    'app/node_modules/excluded.txt': 'compiler stays out', 'app/.evidence/excluded.txt': 'evidence stays out',
    'runtime/electron.exe': 'fake executable', 'runtime/version': '44.4.5\n', 'runtime/LICENSE': 'fake MIT notice',
    'runtime/LICENSES.chromium.html': '<p>fake notices</p>', 'runtime/ffmpeg.dll': 'fake library',
    'runtime/resources/default_app.asar': 'fake upstream application',
  })) { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); }
  for (const name of ['invite-automation.js', 'invite-list.js', 'guest-invite.js', 'recording-library.js', 'screen-share.js', 'studio-shell.js', 'tokens.css', 'blastcast.css', 'logo-icon.svg', 'fonts/BlastworksSans-Regular.woff2', 'fonts/BlastworksSans-SemiBold.woff2', 'fonts/BlastworksSans-ExtraBold.woff2', 'fonts/BlastworksSans-UNLICENSE.txt']) { const f = path.join(app, 'dist', name); await mkdir(path.dirname(f), {recursive:true}); await writeFile(f, 'fixture'); }
  for (const name of ['free-tunnel', 'guest-access', 'guest-settings', 'guest-wizard', 'recording-library', 'studio-preferences', 'display-picker', 'media-access', 'boundary', 'destination', 'recording', 'webm', 'guest-http', 'guest-rate-limit', 'guest-static', 'guest-route', 'guest-readiness', 'guest-status', 'guest-lifecycle', 'guest-api', 'guest-api-source', 'direct-access', 'relay-config', 'admission', 'signaling', 'sources', 'source-recovery', 'source-limits', 'source-import', 'source-controller', 'license-key', 'license-store']) await writeFile(path.join(app, `desktop/${name}.cjs`), '// fixture module');
  await mkdir(path.join(app,'assets/licensing'),{recursive:true}); await writeFile(path.join(app,'assets/licensing/public-key.txt'),'public fixture'); await writeFile(path.join(app,'assets/localhost-run-known-hosts.txt'),'localhost.run ssh-ed25519 FIXTURE\n');
  for (const name of ['recording-status.js', 'source-protocol.js', 'source-bitrate.js', 'source-capture.js', 'source-session.js', 'source-outbox.js', 'source-limits.js', 'source-limits.json', 'source-recovery.js', 'host-calls.js', 'guest-call.js', 'peer-call.js', 'audio-mix.js', 'admission-ui.js', 'admission.css', 'scenes.js', 'scene-controls.js', 'screen-share-attention.js', 'program-output.js', 'studio.css', 'invites.js', 'relay-input.js', 'recording.js', 'preview.js', 'device-access.js', 'camera-background.js', 'guest.html', 'guest.css', 'readiness.html', 'readiness.js', 'readiness.css', 'Blastworks-Cast-256.png']) await writeFile(path.join(app, 'dist', name), 'fixture');
  for (const name of ['tf.min.js', 'body-pix.min.js', 'model-stride16.json', 'group1-shard1of1.bin', 'NOTICE.txt']) { const f = path.join(app, `dist/bodypix/${name}`); await mkdir(path.dirname(f), {recursive:true}); await writeFile(f, 'fixture'); }
  for (const name of ['cloudflare-tunnel-ready', 'cloudflare-route-form', 'cloudflare-route-ready', 'expressturn-fields']) { const f = path.join(app, `dist/instructions/${name}.png`); await mkdir(path.dirname(f), {recursive:true}); await writeFile(f, 'fixture'); }
  for (const name of ['2cam', '3cam', '4cam', '5cam', '6cam', '7cam', '8cam', 'screensharevert-8', 'screensharehorizont-8']) await writeFile(path.join(app, `assets/scenes/defaults/${name}.png`), 'fixture');
  for (const name of ['1cam', '2cam', '3cam', '4cam', '5cam', '6cam', '7cam', '8cam', 'screensharevert-8', 'screensharehorizont-8']) await writeFile(path.join(app, `dist/${name}.png`), 'fixture');
  return { root, app, runtime, output, arch: 'x64' };
}

test('Windows development layout preserves runtime and notices, ships compiled app only', async t => {
  const f = await fixture(t);
  const inventory = await assembleWindowsApp(f);
  assert.equal(await hashFile(path.join(f.output, 'BlastCast.exe')), await hashFile(path.join(f.runtime, 'electron.exe')));
  for (const name of ['LICENSE', 'LICENSES.chromium.html', 'ffmpeg.dll']) assert.equal(await hashFile(path.join(f.output, name)), await hashFile(path.join(f.runtime, name)));
  const manifest = JSON.parse(await readFile(path.join(f.output, 'resources/app/package.json')));
  assert.equal(manifest.main, 'desktop/main.cjs'); assert.equal(manifest.devDependencies, undefined);
  assert.equal(inventory.target, 'win32-x64'); assert.equal(inventory.signing, 'no-blastcast-signing-performed'); assert.equal(inventory.upstreamAuthenticode, 'not-verified'); assert.equal(inventory.nativeAcceptance, 'not-run');
  assert.match(inventory.runtimeVerification, /does not verify archive provenance/);
  const paths = inventory.payload.map(f => f.path);
  assert.ok(paths.includes('resources/app/desktop/guests.cjs'));
  assert.ok(paths.includes('resources/app/desktop/direct-access.cjs'));
  assert.ok(paths.includes('resources/app/desktop/guest-settings.cjs'));
  assert.ok(paths.includes('resources/app/desktop/guest-wizard.cjs'));
  assert.ok(paths.includes('resources/app/assets/scenes/defaults/1cam.png'));
  assert.ok(paths.includes('resources/app/dist/guest.js'));
  assert.ok(paths.includes('resources/app/dist/bodypix/group1-shard1of1.bin'));
  assert.ok(paths.includes('resources/app/dist/readiness.js'));
  assert.ok(!paths.some(p => /node_modules|\.env|\.evidence|electron\.exe/.test(p)));
  for (const entry of inventory.payload) assert.equal(entry.sha256, await hashFile(path.join(f.output, entry.path)));
  assert.deepEqual(JSON.parse(await readFile(path.join(f.output, 'blastcast-inventory.json'))), inventory);
});

test('existing output and overlapping input/output are refused without mutation', async t => {
  const f = await fixture(t); await mkdir(f.output); await writeFile(path.join(f.output, 'recording.webm'), 'keep');
  await assert.rejects(assembleWindowsApp(f), /already exists/);
  assert.equal(await readFile(path.join(f.output, 'recording.webm'), 'utf8'), 'keep');
  await assert.rejects(assembleWindowsApp({ ...f, output: path.join(f.app, 'nested') }), /separate/);
  await assert.rejects(assembleWindowsApp({ ...f, output: f.root }), /separate/);
});

test('symlinked inputs cannot include unrelated files or escape the source', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'private.txt'), 'private fixture');
  await symlink(path.join(f.root, 'private.txt'), path.join(f.app, 'desktop/escape.cjs'));
  await assert.rejects(assembleWindowsApp(f), /Symlinks/);
  assert.ok(!(await readdir(f.root)).includes('output'));
});

test('wrong runtime, unsupported architecture and preloaded app are refused before creating output', async t => {
  const f = await fixture(t);
  await assert.rejects(assembleWindowsApp({ ...f, arch: 'ia32' }), /architecture/);
  await writeFile(path.join(f.runtime, 'version'), '1.0.0');
  await assert.rejects(assembleWindowsApp(f), /44.4.5/);
  await writeFile(path.join(f.runtime, 'version'), '44.4.5');
  await writeFile(path.join(f.runtime, 'resources/app.asar'), 'untrusted existing app');
  await assert.rejects(assembleWindowsApp(f), /already contains/);
  assert.ok(!(await readdir(f.root)).includes('output'));
});

test('incomplete application modules, styles, guest page or scene assets fail before output creation', async t => {
  for (const missing of ['desktop/sources.cjs', 'desktop/source-recovery.cjs', 'desktop/source-limits.cjs', 'desktop/source-import.cjs', 'desktop/source-controller.cjs', 'dist/recording-status.js', 'dist/source-protocol.js', 'dist/source-capture.js', 'dist/source-session.js', 'dist/source-outbox.js', 'dist/source-limits.js', 'dist/source-limits.json', 'dist/source-recovery.js', 'desktop/signaling.cjs', 'dist/host-calls.js', 'dist/guest-call.js', 'dist/peer-call.js', 'dist/audio-mix.js', 'desktop/admission.cjs', 'dist/admission-ui.js', 'dist/admission.css', 'desktop/boundary.cjs', 'desktop/recording.cjs', 'desktop/guests.cjs', 'desktop/direct-access.cjs', 'desktop/relay-config.cjs', 'desktop/guest-settings.cjs', 'desktop/guest-wizard.cjs', 'dist/studio.js', 'dist/studio.css', 'dist/preview.js', 'dist/device-access.js', 'dist/invites.js', 'dist/guest.html', 'dist/guest.css', 'dist/readiness.html', 'dist/readiness.js', 'dist/readiness.css', 'dist/scenes.js', 'dist/scene-controls.js', 'dist/1cam.png', 'dist/screensharevert-8.png', 'dist/Blastworks-Cast-256.png', 'assets/scenes/defaults/screensharevert-8.png']) {
    const f = await fixture(t); await rm(path.join(f.app, missing));
    await assert.rejects(assembleWindowsApp(f), /ENOENT/);
    assert.ok(!(await readdir(f.root)).includes('output'), missing);
  }
});

test('archive guard rejects modified bytes and unsupported targets without extraction', async t => {
  const f = await fixture(t), archive = path.join(f.root, 'runtime.zip');
  await writeFile(archive, 'untrusted bytes');
  for (const arch of ['x64', 'arm64']) await assert.rejects(verifyRuntimeArchive(archive, arch), /hash does not match/);
  await assert.rejects(verifyRuntimeArchive(archive, 'ia32'), /architecture/);
  await assert.rejects(verifyRuntimeArchive(f.runtime, 'x64'), /regular file/);
  assert.ok(!(await readdir(f.root)).includes('output'));
});

test('offline background processor files are mandatory package inputs', async t => {
  for (const missing of ['dist/camera-background.js', 'dist/bodypix/tf.min.js', 'dist/bodypix/body-pix.min.js',
    'dist/bodypix/model-stride16.json', 'dist/bodypix/group1-shard1of1.bin', 'dist/bodypix/NOTICE.txt']) {
    const f = await fixture(t); await rm(path.join(f.app, missing));
    await assert.rejects(assembleWindowsApp(f), /ENOENT/);
    assert.ok(!(await readdir(f.root)).includes('output'), missing);
  }
});

test('PowerShell uses the system executable independently of PATH', () => {
  assert.equal(systemPowerShell('C:\\Windows'), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(systemPowerShell('D:\\System Root'), 'D:\\System Root\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  for (const value of [undefined, '', 'Windows', '\\Windows', 'C:Windows']) assert.throws(() => systemPowerShell(value), /absolute/);
});

test('CLI input is explicit and native package command refuses non-Windows', async () => {
  for (const args of [[], ['--arch', 'ia32'], ['--unknown', 'x'], ['--archive', 'one', '--archive', 'two']]) assert.throws(() => parseArguments(args));
  const options = parseArguments(['--archive', 'official.zip', '--app', 'app', '--output', 'new', '--arch', 'arm64']);
  assert.equal(options.arch, 'arm64');
  if (process.platform !== 'win32') await assert.rejects(packageWindows(options), /on Windows/);
});
