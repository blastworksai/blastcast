// ClaudeBWAI — icon coverage added: CFBundleIconFile, BlastCast.icns, required icon PNGs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { assembleMacApp as assembleRaw, loadAssetsCar, ASSETS_CAR_SHA256, transformPlist, createMacInstaller, componentPlist, copyRuntimeBundle, signMacApp, removeMacStagingDirectory, ICON_SIZES } from '../packaging/macos/package.mjs';

describe('macOS Package builder (Layout Assembly)', () => {
  let tempBase, carFixture;
  // Task 5.1: every assembly needs a pinned icon catalog; the fixture stands in for the committed Assets.car.
  const assemble = (opts) => assembleRaw({ assetsCar: carFixture, ...opts });

  beforeEach(async () => {
    tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-mac-test-'));
    const data = Buffer.from('fake-assets-car');
    carFixture = { path: path.join(tempBase, 'Assets.car.fixture'), sha256: crypto.createHash('sha256').update(data).digest('hex') };
    await fs.writeFile(carFixture.path, data);
  });

  afterEach(async () => {
    await fs.rm(tempBase, { recursive: true, force: true });
  });

  async function createFakeSkeleton(runtimeDir, customPlist = null) {
    await fs.mkdir(path.join(runtimeDir, 'Electron.app', 'Contents', 'MacOS'), { recursive: true });
    await fs.writeFile(path.join(runtimeDir, 'Electron.app', 'Contents', 'MacOS', 'Electron'), 'fake-binary');
    
    await fs.mkdir(path.join(runtimeDir, 'Electron.app', 'Contents', 'Frameworks', 'A'), { recursive: true });
    await fs.writeFile(path.join(runtimeDir, 'Electron.app', 'Contents', 'Frameworks', 'A', 'lib.dylib'), 'fake-lib');
    await fs.symlink('A', path.join(runtimeDir, 'Electron.app', 'Contents', 'Frameworks', 'Current'));
    
    const fakePlist = customPlist ?? `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n<key>CFBundleName</key>\n<string>Electron</string>\n<key>CFBundleIconFile</key>\n<string>electron.icns</string>\n<key>CFBundleExecutable</key>\n<string>Electron</string>\n<key>CFBundleDisplayName</key>\n<string>Electron</string>\n<key>CFBundleIdentifier</key>\n<string>com.github.electron</string>\n</dict>\n</plist>`;
    await fs.writeFile(path.join(runtimeDir, 'Electron.app', 'Contents', 'Info.plist'), fakePlist);
    
    await fs.writeFile(path.join(runtimeDir, 'LICENSE'), 'fake-license');
    await fs.writeFile(path.join(runtimeDir, 'LICENSES.chromium.html'), 'fake-chromium-license');
  }

  async function createFakeApp(sourceDir) {
    const files = [
      'LICENSE', 'assets/licensing/public-key.txt', 'assets/localhost-run-known-hosts.txt', 'desktop/license-key.cjs', 'desktop/license-store.cjs', 'desktop/admission.cjs', 'desktop/chat-room.cjs', 'desktop/session-diagnostics.cjs', 'desktop/main.cjs', 'desktop/preload.cjs', 'desktop/recording.cjs',
      'desktop/destination.cjs', 'desktop/licences-window.cjs', 'desktop/mas-flavour.cjs', 'desktop/releases-link.cjs', 'desktop/boundary.cjs', 'desktop/guests.cjs', 'desktop/guest-http.cjs', 'desktop/guest-rate-limit.cjs', 'desktop/guest-static.cjs', 'desktop/guest-route.cjs', 'desktop/guest-readiness.cjs', 'desktop/guest-status.cjs', 'desktop/guest-lifecycle.cjs', 'desktop/guest-api.cjs', 'desktop/guest-api-source.cjs', 'desktop/direct-access.cjs', 'desktop/relay-config.cjs', 'desktop/webm.cjs',
      'desktop/sources.cjs', 'desktop/source-recovery.cjs', 'desktop/source-limits.cjs', 'desktop/source-import.cjs', 'desktop/source-controller.cjs',
      'desktop/free-tunnel.cjs','desktop/guest-access.cjs','desktop/guest-settings.cjs','desktop/guest-wizard.cjs','dist/invite-automation.js','desktop/recording-library.cjs','desktop/studio-preferences.cjs','desktop/display-picker.cjs','desktop/media-access.cjs','dist/invite-list.js','dist/guest-invite.js','dist/recording-library.js','dist/screen-share.js','dist/studio-shell.js','dist/chat-ui.js','dist/tokens.css','dist/blastcast.css','dist/logo-icon.svg','dist/fonts/BlastworksSans-Regular.woff2','dist/fonts/BlastworksSans-SemiBold.woff2','dist/fonts/BlastworksSans-ExtraBold.woff2','dist/fonts/BlastworksSans-UNLICENSE.txt', 'dist/recording-status.js', 'dist/source-protocol.js','dist/source-bitrate.js','dist/source-capture.js', 'dist/source-session.js', 'dist/source-outbox.js', 'dist/source-limits.js', 'dist/source-limits.json', 'dist/source-recovery.js',
      'dist/admission-ui.js', 'dist/admission.css', 'dist/scenes.js', 'dist/scene-controls.js', 'dist/screen-share-attention.js', 'dist/program-output.js',
      'desktop/signaling.cjs', 'dist/host-calls.js', 'dist/guest-call.js', 'dist/device-access.js', 'dist/camera-background.js', 'dist/peer-call.js', 'dist/audio-mix.js',
      ...['vision_bundle.mjs', 'selfie_segmenter.tflite', 'NOTICE.txt', 'wasm/vision_wasm_internal.js', 'wasm/vision_wasm_internal.wasm', 'wasm/vision_wasm_nosimd_internal.js', 'wasm/vision_wasm_nosimd_internal.wasm'].map(name => `dist/mediapipe/${name}`),
      ...['1cam', '2cam', '3cam', '4cam', '5cam', '6cam', '7cam', '8cam', 'screensharevert-8', 'screensharehorizont-8'].map(name => `dist/${name}.png`),
      'dist/index.html', 'dist/studio.js', 'dist/studio.css', 'dist/invites.js', 'dist/relay-input.js',
      ...['cloudflare-tunnel-ready', 'cloudflare-route-form', 'cloudflare-route-ready', 'expressturn-fields'].map(name => `dist/instructions/${name}.png`),
      'dist/recording.js', 'dist/preview.js', 'dist/guest.html', 'dist/guest.js', 'dist/guest.css',
      'dist/readiness.html', 'dist/readiness.js', 'dist/readiness.css',
      'dist/Blastworks-Cast-256.png', 'dist/package.json',
      'assets/brand/Blastworks-Cast-256.png', 'assets/mediapipe/vision_bundle.mjs', // ClaudeBWAI — vendored source copy; must not ship
      'assets/scenes/defaults/1cam.png', 'assets/scenes/defaults/2cam.png',
      'assets/scenes/defaults/3cam.png', 'assets/scenes/defaults/4cam.png',
      'assets/scenes/defaults/5cam.png', 'assets/scenes/defaults/6cam.png',
      'assets/scenes/defaults/7cam.png', 'assets/scenes/defaults/8cam.png',
      'assets/scenes/defaults/screensharehorizont-8.png', 'assets/scenes/defaults/screensharevert-8.png'
    ];
    for (const f of files) {
      await fs.mkdir(path.dirname(path.join(sourceDir, f)), { recursive: true });
      await fs.writeFile(path.join(sourceDir, f), 'data');
    }
    await fs.chmod(path.join(sourceDir, 'dist/mediapipe/vision_bundle.mjs'), 0o640); // ClaudeBWAI — npm tarball mode; must ship readable for all
    // ClaudeBWAI: header-only PNGs of the right size are enough for the icns writer.
    await fs.mkdir(path.join(sourceDir, 'assets/brand/icons'), { recursive: true });
    for (const n of ICON_SIZES) {
      const png = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
      png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'latin1'); png.writeUInt32BE(n, 16); png.writeUInt32BE(n, 20);
      await fs.writeFile(path.join(sourceDir, `assets/brand/icons/blastcast-${n}.png`), png);
    }
    await fs.writeFile(path.join(sourceDir, 'package.json'), JSON.stringify({
      name: 'blastcast', version: '0.1.0', main: 'desktop/main.cjs', devDependencies: { "mocha": "^1.0" }
    }));
  }

  it('packages successfully using fake skeleton and preserves notices/symlinks', async () => {
    const runtimeDir = path.join(tempBase, 'runtime');
    const sourceDir = path.join(tempBase, 'app');
    const outDir = path.join(tempBase, 'out');
    await fs.mkdir(runtimeDir);
    await fs.mkdir(sourceDir);

    await createFakeSkeleton(runtimeDir);
    await createFakeApp(sourceDir);

    const res = await assemble({
      runtimeDir,
      sourceDir,
      outDir,
      targetArch: 'darwin-arm64'
    });

    assert.strictEqual(path.basename(res.appPath), 'BlastCast.app');
    
    // Symlink preservation check
    const currentLink = await fs.readlink(path.join(res.appPath, 'Contents', 'Frameworks', 'Current'));
    assert.strictEqual(currentLink, 'A');

    // Plist checks
    const plist = await fs.readFile(path.join(res.appPath, 'Contents', 'Info.plist'), 'utf8');
    assert.strictEqual((plist.match(/<key>CFBundleExecutable<\/key>/g) || []).length, 1);
    assert.strictEqual((plist.match(/<key>NSMicrophoneUsageDescription<\/key>/g) || []).length, 1);
    assert.ok(!plist.includes('NSScreenCaptureDescription'));
    assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>BlastCast\.icns<\/string>/);
    const icns = await fs.readFile(path.join(res.appPath, 'Contents', 'Resources', 'BlastCast.icns'));
    assert.equal(icns.toString('latin1', 0, 4), 'icns');
    assert.equal(icns.readUInt32BE(4), icns.length);

    // Inventory checks
    const inventory = JSON.parse(await fs.readFile(path.join(res.appPath, 'Contents', 'Resources', 'inventory.json'), 'utf8'));
    assert.strictEqual(inventory.app, 'blastcast');
    assert.strictEqual(inventory.build.type, 'layout-fixture');
    assert.strictEqual(inventory.status.signing, 'no BlastCast signing/notarization performed; upstream bundle signature not verified and modified by bundling');
    
    // Package.json checks (devDependencies stripped)
    const outPkg = JSON.parse(await fs.readFile(path.join(res.appPath, 'Contents', 'Resources', 'app', 'package.json'), 'utf8'));
    await assert.rejects(fs.stat(path.join(res.appPath, 'Contents', 'Resources', 'app', 'assets', 'mediapipe')), /ENOENT/, 'the vendored MediaPipe source copy ships only once, as dist/mediapipe');
    await fs.stat(path.join(res.appPath, 'Contents', 'Resources', 'app', 'dist', 'mediapipe', 'selfie_segmenter.tflite'));
    const unreadable = [];
    const sweep = async dir => { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isSymbolicLink()) continue; const m = (await fs.stat(f)).mode; if ((m & 0o004) === 0 || (e.isDirectory() && (m & 0o001) === 0)) unreadable.push(f); if (e.isDirectory()) await sweep(f); } };
    await sweep(path.join(res.appPath, 'Contents', 'Resources', 'app'));
    assert.deepEqual(unreadable, [], 'every app payload file is readable by non-root users (App Store Connect 90255)');
    assert.strictEqual(outPkg.devDependencies, undefined);
    for (const module of ['guest-settings.cjs', 'guest-wizard.cjs']) {
      assert.strictEqual(
        await fs.readFile(path.join(res.appPath, 'Contents', 'Resources', 'app', 'desktop', module), 'utf8'),
        'data'
      );
    }
  });

  it('uses ditto to copy application bundles on macOS', async () => {
    const calls = [];
    await copyRuntimeBundle('/runtime/Electron.app', '/output/BlastCast.app', {
      platform: 'darwin',
      run: (cmd, args) => calls.push({ cmd, args })
    });
    assert.deepEqual(calls, [{
      cmd: '/usr/bin/ditto',
      args: ['/runtime/Electron.app', '/output/BlastCast.app']
    }]);
  });

  it('deep-signs and strictly verifies the complete macOS bundle', () => {
    const calls = [];
    signMacApp('/output/BlastCast.app', (cmd, args) => calls.push({ cmd, args }));
    assert.deepEqual(calls, [
      { cmd: '/usr/bin/codesign', args: ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', '/output/BlastCast.app'] },
      { cmd: '/usr/bin/codesign', args: ['--verify', '--deep', '--strict', '/output/BlastCast.app'] }
    ]);
  });

  it('restricts native cleanup to a BlastCast directory directly under the temporary root', () => {
    const calls = [];
    removeMacStagingDirectory('/tmp/blastcast-mac-stage-Ab12', {
      tmpDir: '/tmp',
      run: (cmd, args) => calls.push({ cmd, args })
    });
    assert.deepEqual(calls, [{ cmd: '/bin/rm', args: ['-rf', '/tmp/blastcast-mac-stage-Ab12'] }]);
    assert.throws(
      () => removeMacStagingDirectory('/tmp/unrelated', { tmpDir: '/tmp', run: () => {} }),
      /Refusing to remove non-BlastCast staging directory/
    );
    assert.throws(
      () => removeMacStagingDirectory('/tmp/nested/blastcast-mac-stage-Ab12', { tmpDir: '/tmp', run: () => {} }),
      /Refusing to remove non-BlastCast staging directory/
    );
  });

  it('builds a fixed-location installer containing only the app, with stable upgrade metadata', async () => {
    const appPath = path.join(tempBase, 'BlastCast.app');
    const stagingDir = path.join(tempBase, 'stage'), outDir = path.join(tempBase, 'out');
    await fs.mkdir(appPath); await fs.mkdir(stagingDir); await fs.mkdir(outDir);
    await fs.writeFile(path.join(appPath, 'payload'), 'app-only');
    await fs.mkdir(path.join(appPath, 'Contents'));
    await fs.writeFile(path.join(appPath, 'Contents', 'Info.plist'), '<plist><dict><key>LSMinimumSystemVersion</key><string>12.0</string></dict></plist>');
    const calls = [];
    const packagePath = await createMacInstaller({ appPath, outDir, stagingDir,
      version: '0.1.0', targetArch: 'darwin-arm64', run: (cmd, args) => calls.push({ cmd, args }) });
    assert.deepEqual(await fs.readdir(path.join(stagingDir, 'installer-root')), ['BlastCast.app']);
    assert.equal(await fs.readFile(path.join(stagingDir, 'installer-root', 'BlastCast.app', 'payload'), 'utf8'), 'app-only');
    assert.equal(calls[0].cmd, '/usr/bin/pkgbuild');
    for (const [flag, value] of [['--install-location', '/Applications'], ['--identifier', 'com.blastworks.blastcast.pkg'], ['--version', '0.1.0'], ['--ownership', 'recommended']]) {
      assert.equal(calls[0].args[calls[0].args.indexOf(flag) + 1], value);
    }
    assert.ok(!calls[0].args.includes('--scripts'));
    assert.match(componentPlist, /BundleIsRelocatable<\/key><false\/>/);
    assert.match(componentPlist, /BundleOverwriteAction<\/key><string>upgrade/);
    assert.deepEqual(calls[1], { cmd: '/usr/bin/productbuild', args: ['--package', path.join(stagingDir, 'BlastCast-component.pkg'), '--product', path.join(stagingDir, 'requirements.plist'), packagePath] });
    const requirements = await fs.readFile(path.join(stagingDir, 'requirements.plist'), 'utf8');
    assert.match(requirements, /<key>arch<\/key><array><string>arm64<\/string>/);
    assert.match(requirements, /<key>os<\/key><array><string>12.0<\/string>/);
    assert.equal(path.basename(packagePath), 'BlastCast-0.1.0-darwin-arm64.pkg');
  });

  it('uses the application version rather than the Electron version in both bundle fields', () => {
    const input = '<plist><dict><key>CFBundleName</key><string>Electron</string><key>CFBundleIconFile</key><string>electron.icns</string><key>CFBundleExecutable</key><string>Electron</string><key>CFBundleIdentifier</key><string>org.electron</string><key>CFBundleVersion</key><string>44.4.5</string></dict></plist>';
    const result = transformPlist(input, '0.1.0');
    assert.match(result, /CFBundleVersion<\/key>\s*<string>0.1.0<\/string>/);
    assert.match(result, /CFBundleShortVersionString<\/key>\s*<string>0.1.0<\/string>/);
    assert.ok(!result.includes('44.4.5'));
    assert.throws(() => transformPlist(input, '<bad>'), /Invalid app version/);
  });

  it('rejects missing or extra symlinks in source directory', async () => {
    const runtimeDir = path.join(tempBase, 'runtime');
    const sourceDir = path.join(tempBase, 'app');
    const outDir = path.join(tempBase, 'out');
    await fs.mkdir(runtimeDir);
    await fs.mkdir(sourceDir);
    await createFakeSkeleton(runtimeDir);
    await createFakeApp(sourceDir);

    const escapeTarget = path.join(tempBase, 'secret.txt');
    await fs.writeFile(escapeTarget, 'secret');
    await fs.symlink(escapeTarget, path.join(sourceDir, 'assets', 'sneaky-link'));

    await assert.rejects(
      assemble({ runtimeDir, sourceDir, outDir, targetArch: 'darwin-x64' }),
      /Symlinks not allowed in source app: .*sneaky-link/
    );
  });
  
  it('rejects invalid or duplicate plist keys', async () => {
    const runtimeDir = path.join(tempBase, 'runtime');
    const sourceDir = path.join(tempBase, 'app');
    const outDir = path.join(tempBase, 'out');
    await fs.mkdir(runtimeDir);
    await fs.mkdir(sourceDir);
    
    // missing executable
    await fs.rm(runtimeDir, { recursive: true, force: true });
    await fs.mkdir(runtimeDir, { recursive: true });
    await createFakeSkeleton(runtimeDir, `<plist><dict><key>CFBundleName</key><string>E</string></dict></plist>`);
    await createFakeApp(sourceDir);
    await assert.rejects(
      assemble({ runtimeDir, sourceDir, outDir, targetArch: 'darwin-x64' }),
      /Plist replacement failed/
    );
    
    // duplicate existing permission
    await fs.rm(runtimeDir, { recursive: true, force: true });
    await fs.mkdir(runtimeDir, { recursive: true });
    await createFakeSkeleton(runtimeDir, `<plist><dict><key>CFBundleName</key><string>E</string><key>CFBundleDisplayName</key><string>E</string><key>CFBundleIdentifier</key><string>E</string><key>CFBundleExecutable</key><string>E</string><key>NSCameraUsageDescription</key><string>x</string><key>NSCameraUsageDescription</key><string>duplicate</string></dict></plist>`);
    await assert.rejects(
      assemble({ runtimeDir, sourceDir, outDir: outDir + '2', targetArch: 'darwin-x64' }),
      /NSCameraUsageDescription occurred 2 times/
    );
    
    // duplicate key
    await fs.rm(runtimeDir, { recursive: true, force: true });
    await fs.mkdir(runtimeDir, { recursive: true });
    await createFakeSkeleton(runtimeDir, `<plist><dict><key>CFBundleName</key><string>E</string><key>CFBundleDisplayName</key><string>E</string><key>CFBundleIdentifier</key><string>E</string><key>CFBundleExecutable</key><string>E</string><key>CFBundleExecutable</key><string>E</string></dict></plist>`);
    await assert.rejects(
      assemble({ runtimeDir, sourceDir, outDir: outDir + '3', targetArch: 'darwin-x64' }),
      /Plist replacement failed: CFBundleExecutable occurred 2 times/
    );
  });

  it('replaces existing permissions once and accepts root whitespace without a display name', () => {
    const input = '<plist><dict><key>CFBundleName</key><string>Electron</string><key>CFBundleIconFile</key><string>electron.icns</string><key>CFBundleExecutable</key><string>Electron</string><key>CFBundleIdentifier</key><string>org.electron</string><key>NSCameraUsageDescription</key><string>Old camera text</string><key>NSMicrophoneUsageDescription</key><string>Old microphone text</string></dict>  \n\t</plist>\n';
    const result = transformPlist(input);
    assert.equal((result.match(/<key>NSCameraUsageDescription<\/key>/g) || []).length, 1);
    assert.equal((result.match(/<key>NSMicrophoneUsageDescription<\/key>/g) || []).length, 1);
    assert.ok(!result.includes('Old camera text'));
    assert.ok(result.includes('<key>CFBundleExecutable</key>\n<string>BlastCast</string>'));
    assert.ok(result.includes('<key>CFBundleIdentifier</key>\n<string>com.blastworks.blastcast</string>'));
    assert.ok(result.includes('<key>CFBundleDisplayName</key>'));
    assert.throws(() => transformPlist(input.replace('<key>CFBundleExecutable</key><string>Electron</string>', '<key>CFBundleExecutable</key><false/>')), /must contain a string/);
  });

  it('rejects a symlinked source area and preserves an existing output marker', async () => {
    const runtimeDir = path.join(tempBase, 'runtime'), sourceDir = path.join(tempBase, 'app'), outDir = path.join(tempBase, 'out');
    await fs.mkdir(runtimeDir); await fs.mkdir(sourceDir);
    await createFakeSkeleton(runtimeDir); await createFakeApp(sourceDir);
    await fs.rename(path.join(sourceDir, 'assets'), path.join(tempBase, 'outside-assets'));
    await fs.symlink(path.join(tempBase, 'outside-assets'), path.join(sourceDir, 'assets'));
    await assert.rejects(assemble({ runtimeDir, sourceDir, outDir, targetArch: 'darwin-x64' }), /Symlinks not allowed/);
    await fs.mkdir(outDir); await fs.writeFile(path.join(outDir, 'recording.webm'), 'keep');
    await assert.rejects(assemble({ runtimeDir, sourceDir, outDir, targetArch: 'darwin-x64' }), /Existing output/);
    assert.equal(await fs.readFile(path.join(outDir, 'recording.webm'), 'utf8'), 'keep');
  });

  it('rejects missing launch-time scene modules and compiled backgrounds before creating output', async () => {
    const runtimeDir = path.join(tempBase, 'runtime'), sourceDir = path.join(tempBase, 'app');
    await fs.mkdir(runtimeDir); await fs.mkdir(sourceDir);
    await createFakeSkeleton(runtimeDir); await createFakeApp(sourceDir);
    for (const missing of ['dist/admission-ui.js', 'dist/admission.css', 'dist/scenes.js', 'dist/scene-controls.js',
      'desktop/signaling.cjs', 'desktop/direct-access.cjs', 'desktop/relay-config.cjs', 'desktop/guest-settings.cjs', 'desktop/guest-wizard.cjs', 'dist/host-calls.js', 'dist/guest-call.js', 'dist/device-access.js', 'dist/camera-background.js', 'dist/mediapipe/selfie_segmenter.tflite', 'dist/mediapipe/wasm/vision_wasm_internal.wasm', 'dist/peer-call.js', 'dist/audio-mix.js', 'dist/1cam.png', 'dist/screensharevert-8.png',
      'assets/brand/icons/blastcast-1024.png', 'assets/brand/icons/blastcast-16.png', 'desktop/sources.cjs', 'desktop/source-recovery.cjs', 'desktop/source-limits.cjs', 'desktop/source-import.cjs', 'desktop/source-controller.cjs', 'dist/recording-status.js', 'dist/source-protocol.js','dist/source-bitrate.js','dist/source-capture.js', 'dist/source-session.js', 'dist/source-outbox.js', 'dist/source-limits.js', 'dist/source-limits.json', 'dist/source-recovery.js']) {
      const file = path.join(sourceDir, missing), contents = await fs.readFile(file);
      await fs.rm(file);
      const outDir = path.join(tempBase, 'out');
      await assert.rejects(assemble({ runtimeDir, sourceDir, outDir, targetArch: 'darwin-x64' }), /Missing required asset/);
      await assert.rejects(fs.lstat(outDir), { code: 'ENOENT' });
      await fs.writeFile(file, contents);
    }
  });

  async function stage() {
    const runtimeDir = path.join(tempBase, 'runtime'), sourceDir = path.join(tempBase, 'app');
    await fs.mkdir(runtimeDir); await fs.mkdir(sourceDir);
    await createFakeSkeleton(runtimeDir); await createFakeApp(sourceDir);
    return { runtimeDir, sourceDir };
  }

  it('Task 5.1: copies the pinned Assets.car and sets CFBundleIconName beside CFBundleIconFile', async () => {
    const res = await assemble({ ...(await stage()), outDir: path.join(tempBase, 'out'), targetArch: 'darwin-arm64' });
    assert.deepStrictEqual(await fs.readFile(path.join(res.appPath, 'Contents', 'Resources', 'Assets.car')), Buffer.from('fake-assets-car'));
    const plist = await fs.readFile(path.join(res.appPath, 'Contents', 'Info.plist'), 'utf8');
    assert.match(plist, /<key>CFBundleIconName<\/key>\s*<string>AppIcon<\/string>/);
    assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>BlastCast\.icns<\/string>/);
    assert.strictEqual(res.inventory.assetsCar.sha256, carFixture.sha256);
  });

  it('Task 5.1: refuses a catalog that does not match its pin, a missing one, and a PENDING pin, before creating output', async () => {
    const dirs = await stage();
    const outDir = path.join(tempBase, 'out');
    await assert.rejects(assembleRaw({ ...dirs, outDir, targetArch: 'darwin-arm64', assetsCar: { ...carFixture, sha256: 'a'.repeat(64) } }), /Assets\.car SHA-256 .* does not match the pin/);
    await assert.rejects(assembleRaw({ ...dirs, outDir, targetArch: 'darwin-arm64', assetsCar: { path: path.join(tempBase, 'nope.car'), sha256: carFixture.sha256 } }), /Missing Assets\.car/);
    await assert.rejects(assembleRaw({ ...dirs, outDir, targetArch: 'darwin-arm64', assetsCar: { ...carFixture, sha256: 'PENDING' } }), /Assets\.car not pinned yet; run build-icon-assets\.sh on Thor/);
    await assert.rejects(fs.lstat(outDir), { code: 'ENOENT' });
  });

  it('Task 5.1: the committed pin is what the CLI path uses, and PENDING refuses it', async () => {
    if (ASSETS_CAR_SHA256 === 'PENDING') {
      await assert.rejects(loadAssetsCar(), /Assets\.car not pinned yet/);
      await assert.rejects(assembleRaw({ ...(await stage()), outDir: path.join(tempBase, 'out'), targetArch: 'darwin-arm64' }), /Assets\.car not pinned yet/);
    } else {
      assert.strictEqual((await loadAssetsCar()).sha256, ASSETS_CAR_SHA256);
    }
  });

  it('Task 5.1: --build-number sets CFBundleVersion; absent leaves the package version; bad values are refused', async () => {
    const dirs = await stage();
    const withBuild = await assemble({ ...dirs, outDir: path.join(tempBase, 'out-b'), targetArch: 'darwin-arm64', buildNumber: '7' });
    const plist = await fs.readFile(path.join(withBuild.appPath, 'Contents', 'Info.plist'), 'utf8');
    assert.match(plist, /<key>CFBundleVersion<\/key>\s*<string>7<\/string>/);
    assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>0\.1\.0<\/string>/);
    assert.strictEqual(withBuild.inventory.buildNumber, '7');
    const plain = await assemble({ ...dirs, outDir: path.join(tempBase, 'out-p'), targetArch: 'darwin-arm64' });
    assert.match(await fs.readFile(path.join(plain.appPath, 'Contents', 'Info.plist'), 'utf8'), /<key>CFBundleVersion<\/key>\s*<string>0\.1\.0<\/string>/);
    for (const bad of ['0', '-1', '1.', 'abc', '1.2.3.4', '', '1e3', ' 7']) {
      await assert.rejects(assemble({ ...dirs, outDir: path.join(tempBase, 'out-x'), targetArch: 'darwin-arm64', buildNumber: bad }), /Invalid --build-number/, bad);
    }
    assert.match(transformPlist('<plist><dict><key>CFBundleName</key><string>E</string><key>CFBundleExecutable</key><string>E</string><key>CFBundleIdentifier</key><string>E</string><key>CFBundleIconFile</key><string>e</string></dict></plist>', '0.1.0', { buildNumber: '1.0.7' }), /<key>CFBundleVersion<\/key>\s*<string>1\.0\.7<\/string>/);
  });

  it('Task 5.1: build-icon-assets.sh parses with bash -n and passes shellcheck when installed', () => {
    const script = fileURLToPath(new URL('../packaging/macos/build-icon-assets.sh', import.meta.url));
    const syntax = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
    assert.strictEqual(syntax.status, 0, syntax.stderr);
    const probe = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' });
    if (probe.error) return; // shellcheck not installed here
    const lint = spawnSync('shellcheck', [script], { encoding: 'utf8' });
    assert.strictEqual(lint.status, 0, lint.stdout);
  });

  it('cli handles arguments and refuses on Linux', async () => {
    const cliPath = fileURLToPath(new URL('../packaging/macos/package.mjs', import.meta.url));
    
    // Linux native refusal check
    if (process.platform !== 'darwin') {
      const res = spawnSync(process.execPath, [cliPath, '--archive', 'fake.zip', '--app', '.', '--out', 'out']);
      assert.strictEqual(res.status, 1);
      assert.ok(res.stderr.toString().includes('Native packaging is refused on Linux/Windows; requires macOS.'));
    }
    
    // Missing args
    let res = spawnSync(process.execPath, [cliPath, '--archive', 'a', '--out', 'o']);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.toString().includes('Usage: node package.mjs'));
    
    // Duplicate flag
    res = spawnSync(process.execPath, [cliPath, '--archive', 'a', '--archive', 'b']);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.toString().includes('Duplicate flag: --archive'));
    
    // Unknown flag
    res = spawnSync(process.execPath, [cliPath, '--archive', 'a', '--app', 'b', '--out', 'c', '--unknown']);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.toString().includes('Unknown flag: --unknown'));
  });
});
