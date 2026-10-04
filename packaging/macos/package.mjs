import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { writeIcns } from './icns.mjs';

const PINNED_VERSION = '44.4.5';
const ARCHIVE_HASHES = {
  'darwin-arm64': 'a212eee63ba2f45fd83bd28f77a3e3313a336ad17a4c25adf617942eef5e0e2c',
  'darwin-x64': '778350cc572c36484dd56c130cae96ad1a9a5b695ba22dd06abd23ba0a46c9de'
};

async function getHash(filePath) {
  const data = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Apple application bundles contain framework symlink layouts that Node's
// recursive copy can mis-handle on macOS. ditto is the native bundle copier;
// retain fs.cp for layout fixtures on other platforms.
export async function copyRuntimeBundle(source, destination, { platform = process.platform, run = nativeCommand } = {}) {
  if (platform === 'darwin') {
    run('/usr/bin/ditto', [source, destination]);
    return;
  }
  await fs.cp(source, destination, { recursive: true, verbatimSymlinks: true });
}

// CodexBWAI — bounded XML transformation; reject unsupported/duplicate values.
// The pinned runtime is the only production plist source. No dynamic XML input.
export function transformPlist(xml, version = null) {
  const rootEnd = /<\/dict>\s*<\/plist>\s*$/;
  if (!rootEnd.test(xml)) throw new Error('Unparseable Info.plist dict termination');
  function set(key, value, required = false) {
    const keyPattern = `<key>\\s*${key}\\s*</key>`;
    const count = (xml.match(new RegExp(keyPattern, 'g')) || []).length;
    if (count > 1 || (required && count !== 1)) throw new Error(`Plist replacement failed: ${key} occurred ${count} times`);
    const replacement = `<key>${key}</key>\n<string>${value}</string>`;
    if (count === 0) xml = xml.replace(rootEnd, `${replacement}\n</dict>\n</plist>`);
    else {
      const entry = new RegExp(`${keyPattern}\\s*<string>[^<]*</string>`);
      if (!entry.test(xml)) throw new Error(`Plist replacement failed: ${key} must contain a string`);
      xml = xml.replace(entry, replacement);
    }
  }
  set('CFBundleName', 'BlastCast', true);
  set('CFBundleDisplayName', 'BlastCast');
  set('CFBundleExecutable', 'BlastCast', true);
  set('CFBundleIdentifier', 'com.blastworks.blastcast', true);
  if (version !== null) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid app version');
    set('CFBundleVersion', version);
    set('CFBundleShortVersionString', version);
  }
  set('NSCameraUsageDescription', 'BlastCast needs camera access to record your podcast.');
  set('NSMicrophoneUsageDescription', 'BlastCast needs microphone access to record your podcast.');
  set('CFBundleIconFile', 'BlastCast.icns', true); // ClaudeBWAI — Electron's generic icon replaced by the brand .icns
  return xml;
}

export const ICON_SIZES = [16, 32, 64, 128, 256, 512, 1024];
export const ICON_FILES = ICON_SIZES.map(s => `assets/brand/icons/blastcast-${s}.png`);

export async function assembleMacApp({ runtimeDir, sourceDir, outDir, targetArch, archiveVerification = null }) {
  const resolvedSource = await fs.realpath(sourceDir);
  sourceDir = resolvedSource;
  const absOutParent = await fs.realpath(path.dirname(outDir));
  const absOutDir = path.join(absOutParent, path.basename(outDir));
  
  // Overlap checks
  if (absOutDir === resolvedSource || absOutDir.startsWith(resolvedSource + path.sep) ||
      resolvedSource === absOutDir || resolvedSource.startsWith(absOutDir + path.sep)) {
    throw new Error('Overlap between source and output');
  }
  
  const resolvedRuntime = await fs.realpath(runtimeDir);
  runtimeDir = resolvedRuntime;
  if (absOutDir === resolvedRuntime || absOutDir.startsWith(resolvedRuntime + path.sep) ||
      resolvedRuntime === absOutDir || resolvedRuntime.startsWith(absOutDir + path.sep)) {
    throw new Error('Overlap between runtime and output');
  }

  // Prevent existing output using lstat
  try {
    const st = await fs.lstat(absOutDir);
    throw new Error('Existing output would be overwritten');
  } catch (e) {
    if (e.code !== 'ENOENT') {
      if (e.message.includes('Existing output')) throw e;
      throw new Error(`Failed to stat output dir: ${e.message}`);
    }
  }

  const electronApp = path.join(runtimeDir, 'Electron.app');
  try { await fs.access(electronApp); }
  catch { throw new Error(`Missing Electron.app in ${runtimeDir}`); }

  // Require notice files
  const noticeFiles = ['LICENSE', 'LICENSES.chromium.html'];
  const noticeHashes = {};
  for (const file of noticeFiles) {
    const src = path.join(runtimeDir, file);
    try {
      noticeHashes[file] = await getHash(src);
    } catch {
      throw new Error(`Missing or unreadable notice file: ${file}`);
    }
  }

  // Validate payload completeness
  const requiredFiles = [
    'LICENSE','assets/licensing/public-key.txt','assets/localhost-run-known-hosts.txt','desktop/license-key.cjs','desktop/license-store.cjs',
    'desktop/free-tunnel.cjs','desktop/guest-access.cjs','desktop/guest-settings.cjs','desktop/guest-wizard.cjs','dist/invite-automation.js','desktop/recording-library.cjs','desktop/studio-preferences.cjs','desktop/display-picker.cjs','desktop/media-access.cjs','dist/invite-list.js','dist/guest-invite.js','dist/recording-library.js','dist/screen-share.js','dist/studio-shell.js','dist/tokens.css','dist/blastcast.css','dist/logo-icon.svg','dist/fonts/BlastworksSans-Regular.woff2','dist/fonts/BlastworksSans-SemiBold.woff2','dist/fonts/BlastworksSans-ExtraBold.woff2','dist/fonts/BlastworksSans-UNLICENSE.txt',
  'dist/recording-status.js',
    'package.json',
    'desktop/admission.cjs', 'desktop/main.cjs', 'desktop/preload.cjs', 'desktop/recording.cjs',
    'desktop/destination.cjs', 'desktop/boundary.cjs', 'desktop/guests.cjs', 'desktop/guest-http.cjs', 'desktop/guest-rate-limit.cjs', 'desktop/guest-static.cjs', 'desktop/guest-route.cjs', 'desktop/guest-readiness.cjs', 'desktop/guest-status.cjs', 'desktop/guest-lifecycle.cjs', 'desktop/guest-api.cjs', 'desktop/guest-api-source.cjs', 'desktop/direct-access.cjs', 'desktop/relay-config.cjs', 'desktop/webm.cjs',
    'desktop/sources.cjs', 'desktop/source-recovery.cjs', 'desktop/source-limits.cjs', 'desktop/source-import.cjs', 'desktop/source-controller.cjs',
    'dist/source-protocol.js', 'dist/source-bitrate.js', 'dist/source-capture.js', 'dist/source-session.js', 'dist/source-outbox.js', 'dist/source-limits.js', 'dist/source-limits.json', 'dist/source-recovery.js',
    'dist/admission-ui.js', 'dist/admission.css', 'dist/scenes.js', 'dist/scene-controls.js', 'dist/screen-share-attention.js', 'dist/program-output.js',
    'desktop/signaling.cjs', 'dist/host-calls.js', 'dist/guest-call.js', 'dist/device-access.js', 'dist/camera-background.js', 'dist/peer-call.js', 'dist/audio-mix.js',
    ...['tf.min.js', 'body-pix.min.js', 'model-stride16.json', 'group1-shard1of1.bin', 'NOTICE.txt'].map(name => `dist/bodypix/${name}`),
    ...['1cam', '2cam', '3cam', '4cam', '5cam', '6cam', '7cam', '8cam', 'screensharevert-8', 'screensharehorizont-8'].map(name => `dist/${name}.png`),
    'dist/index.html', 'dist/studio.js', 'dist/studio.css', 'dist/invites.js', 'dist/relay-input.js',
    ...['cloudflare-tunnel-ready', 'cloudflare-route-form', 'cloudflare-route-ready', 'expressturn-fields'].map(name => `dist/instructions/${name}.png`),
    'dist/recording.js', 'dist/preview.js', 'dist/guest.html', 'dist/guest.js', 'dist/guest.css',
    'dist/readiness.html', 'dist/readiness.js', 'dist/readiness.css',
    'dist/Blastworks-Cast-256.png', 'dist/package.json',
    'assets/brand/Blastworks-Cast-256.png', ...ICON_FILES,
    'assets/scenes/defaults/1cam.png', 'assets/scenes/defaults/2cam.png',
    'assets/scenes/defaults/3cam.png', 'assets/scenes/defaults/4cam.png',
    'assets/scenes/defaults/5cam.png', 'assets/scenes/defaults/6cam.png',
    'assets/scenes/defaults/7cam.png', 'assets/scenes/defaults/8cam.png',
    'assets/scenes/defaults/screensharehorizont-8.png', 'assets/scenes/defaults/screensharevert-8.png'
  ];
  for (const req of requiredFiles) {
    try { 
      const st = await fs.lstat(path.join(sourceDir, req)); 
      if (!st.isFile()) throw new Error(`Not a regular file: ${req}`);
    } catch (e) { 
      if (e.message.includes('Not a regular file')) throw e;
      throw new Error(`Missing required asset: ${req}`); 
    }
  }

  // Walk source tree for symlinks and non-regular files
  async function walkSource(dir) {
    const directory = await fs.lstat(dir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error(`Symlinks not allowed in source app: ${dir}`);
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, item.name);
      if (item.isSymbolicLink()) {
        throw new Error(`Symlinks not allowed in source app: ${fullPath}`);
      } else if (item.isDirectory()) {
        await walkSource(fullPath);
      } else if (!item.isFile()) {
        throw new Error(`Non-regular file in source app: ${fullPath}`);
      }
    }
  }
  await walkSource(path.join(sourceDir, 'desktop'));
  await walkSource(path.join(sourceDir, 'dist'));
  await walkSource(path.join(sourceDir, 'assets'));

  const pkgLstat = await fs.lstat(path.join(sourceDir, 'package.json'));
  if (pkgLstat.isSymbolicLink() || !pkgLstat.isFile()) throw new Error('package.json is not a regular file');

  // Walk runtime tree for symlinks
  async function walkRuntime(dir) {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isSymbolicLink()) {
        const linkTarget = await fs.readlink(fullPath);
        if (path.isAbsolute(linkTarget)) {
           throw new Error(`Absolute symlink in runtime: ${fullPath}`);
        }
        const resolved = await fs.realpath(fullPath);
        if (!resolved.startsWith(resolvedRuntime + path.sep) && resolved !== resolvedRuntime) {
          throw new Error(`Symlink escapes runtime: ${fullPath} -> ${resolved}`);
        }
      } else if (item.isDirectory()) {
        await walkRuntime(fullPath);
      } else if (!item.isFile()) {
        throw new Error(`Non-regular file in runtime: ${fullPath}`);
      }
    }
  }
  if (!(await fs.lstat(electronApp)).isDirectory()) throw new Error('Electron.app must be a real directory');
  await walkRuntime(electronApp);

  // Validate package.json
  const pkgStr = await fs.readFile(path.join(sourceDir, 'package.json'), 'utf8');
  let pkg;
  try { pkg = JSON.parse(pkgStr); } catch { throw new Error('Unparseable package.json'); }
  if (pkg.name !== 'blastcast' || typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pkg.version) || pkg.main !== 'desktop/main.cjs') {
    throw new Error('Invalid package.json manifest');
  }

  const minPkg = { name: pkg.name, version: pkg.version, main: pkg.main };
  if ('private' in pkg) minPkg.private = pkg.private;
  if ('license' in pkg) minPkg.license = pkg.license;

  // Build the app structure
  await fs.mkdir(absOutDir);
  const appName = 'BlastCast.app';
  const outApp = path.join(absOutDir, appName);

  // Copy Electron app, preserving relative symlinks
  await copyRuntimeBundle(electronApp, outApp);

  // Rename executable
  const macosDir = path.join(outApp, 'Contents', 'MacOS');
  await fs.rename(path.join(macosDir, 'Electron'), path.join(macosDir, 'BlastCast'));
  const executableHash = await getHash(path.join(macosDir, 'BlastCast'));

  // Copy app payload
  const appDir = path.join(outApp, 'Contents', 'Resources', 'app');
  await fs.mkdir(appDir, { recursive: true });

  await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify(minPkg, null, 2));
  await fs.copyFile(path.join(sourceDir, 'LICENSE'), path.join(appDir, 'LICENSE'));
  await fs.cp(path.join(sourceDir, 'desktop'), path.join(appDir, 'desktop'), { recursive: true, verbatimSymlinks: true });
  await fs.cp(path.join(sourceDir, 'dist'), path.join(appDir, 'dist'), { recursive: true, verbatimSymlinks: true });
  await fs.cp(path.join(sourceDir, 'assets'), path.join(appDir, 'assets'), { recursive: true, verbatimSymlinks: true });

  // CodexBWAI: accept supported upstream plist values and replace each key once.
  const plistPath = path.join(outApp, 'Contents', 'Info.plist');
  await fs.writeFile(plistPath, transformPlist(await fs.readFile(plistPath, 'utf8'), pkg.version));

  // ClaudeBWAI: brand icon, built from the validated PNGs; the plist above points CFBundleIconFile at it.
  const iconMap = {};
  for (const size of ICON_SIZES) iconMap[size] = await fs.readFile(path.join(sourceDir, `assets/brand/icons/blastcast-${size}.png`));
  await fs.writeFile(path.join(outApp, 'Contents', 'Resources', 'BlastCast.icns'), writeIcns(iconMap));

  // Copy notices
  for (const file of noticeFiles) {
    const dest = path.join(outApp, 'Contents', 'Resources', file);
    await fs.copyFile(path.join(runtimeDir, file), dest);
    const destHash = await getHash(dest);
    if (destHash !== noticeHashes[file]) throw new Error(`Notice file ${file} hash mismatch after copy`);
  }

  const inventory = {
    app: minPkg.name,
    version: minPkg.version,
    build: {
      type: archiveVerification ? "native-packaging" : "layout-fixture",
      date: new Date().toISOString()
    },
    runtime: {
      version: PINNED_VERSION,
      target: targetArch,
      executableHash: executableHash,
      executableHashScope: "runtime executable before development re-signing"
    },
    notices: noticeHashes,
    status: {
      signing: "no BlastCast signing/notarization performed; upstream bundle signature not verified and modified by bundling",
      gatekeeper: "no Gatekeeper success or bypass claimed"
    }
  };
  
  if (archiveVerification) {
    inventory.runtime.archiveDigest = archiveVerification.digest;
    inventory.runtime.archiveSource = archiveVerification.source;
  }
  
  await fs.writeFile(path.join(outApp, 'Contents', 'Resources', 'inventory.json'), JSON.stringify(inventory, null, 2));

  return { appPath: outApp, inventory };
}

// CodexBWAI — Apple-native installer, no scripts and no user-data payload.
export const componentPlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><array><dict>
<key>RootRelativeBundlePath</key><string>BlastCast.app</string>
<key>BundleIsRelocatable</key><false/>
<key>BundleIsVersionChecked</key><true/>
<key>BundleHasStrictIdentifier</key><true/>
<key>BundleOverwriteAction</key><string>upgrade</string>
</dict></array></plist>
`;

function nativeCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} failed: ${result.error?.message || result.stderr || result.status}`);
  }
}

export function signMacApp(appPath, run = nativeCommand) {
  // The official Electron archive contains nested ad-hoc components. Once the
  // outer bundle changes, re-seal the complete bundle before strict validation.
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', appPath]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
}

export function removeMacStagingDirectory(stagingDir, { tmpDir = os.tmpdir(), run = nativeCommand } = {}) {
  const resolvedStage = path.resolve(stagingDir);
  const resolvedTmp = path.resolve(tmpDir);
  if (path.dirname(resolvedStage) !== resolvedTmp || !/^blastcast-mac-stage-[A-Za-z0-9]+$/.test(path.basename(resolvedStage))) {
    throw new Error(`Refusing to remove non-BlastCast staging directory: ${resolvedStage}`);
  }
  // Electron's Node mode treats .asar files specially, which can leave its own
  // fs.rm waiting indefinitely. The native remover sees the bounded temp tree.
  run('/bin/rm', ['-rf', resolvedStage]);
}

export async function createMacInstaller({ appPath, outDir, stagingDir, version, targetArch, run = nativeCommand }) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !['darwin-arm64', 'darwin-x64'].includes(targetArch)) throw new Error('Invalid installer version or architecture');
  const appPlist = await fs.readFile(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
  const minimum = [...appPlist.matchAll(/<key>\s*LSMinimumSystemVersion\s*<\/key>\s*<string>(\d+\.\d+(?:\.\d+)?)<\/string>/g)];
  if (minimum.length !== 1) throw new Error('Missing or invalid runtime LSMinimumSystemVersion');
  const requirements = path.join(stagingDir, 'requirements.plist');
  await fs.writeFile(requirements, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>arch</key><array><string>${targetArch === 'darwin-arm64' ? 'arm64' : 'x86_64'}</string></array>
<key>os</key><array><string>${minimum[0][1]}</string></array>
</dict></plist>\n`);
  const payload = path.join(stagingDir, 'installer-root');
  await fs.mkdir(payload);
  await copyRuntimeBundle(appPath, path.join(payload, 'BlastCast.app'), { run });
  const plist = path.join(stagingDir, 'components.plist');
  await fs.writeFile(plist, componentPlist);
  const component = path.join(stagingDir, 'BlastCast-component.pkg');
  const packagePath = path.join(outDir, `BlastCast-${version}-${targetArch}.pkg`);
  // A fixed identifier lets Installer recognize upgrades. Atomic bundle replacement
  // drops retired application files; no paths in the user's home are touched.
  run('/usr/bin/pkgbuild', ['--root', payload, '--component-plist', plist,
    '--identifier', 'com.blastworks.blastcast.pkg', '--version', version,
    '--install-location', '/Applications', '--ownership', 'recommended', component]);
  run('/usr/bin/productbuild', ['--package', component, '--product', requirements, packagePath]);
  return packagePath;
}

export async function buildNativeMacPackage({ archivePath, sourceDir, outDir, buildDmg = false, buildPkg = false }) {
  if (process.platform !== 'darwin') {
    throw new Error('Native packaging is refused on Linux/Windows; requires macOS.');
  }

  const absArchive = path.resolve(archivePath);
  try { await fs.access(absArchive); } catch { throw new Error(`Missing archive: ${absArchive}`); }
  
  const actualHash = await getHash(absArchive);
  let targetArch = null;
  for (const [arch, expectedHash] of Object.entries(ARCHIVE_HASHES)) {
    if (actualHash === expectedHash) {
      targetArch = arch;
      break;
    }
  }
  if (!targetArch) {
    throw new Error(`Archive hash ${actualHash} does not match any official Electron ${PINNED_VERSION} macOS pin.`);
  }

  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-mac-stage-'));
  
  try {
    const ditto = spawnSync('/usr/bin/ditto', ['-x', '-k', absArchive, stagingDir]);
    if (ditto.status !== 0) throw new Error('Archive extraction failed via ditto.');

    const res = await assembleMacApp({
      runtimeDir: stagingDir,
      sourceDir,
      outDir,
      targetArch,
      archiveVerification: { digest: actualHash, source: absArchive }
    });

    // Re-seal the changed bundle and its nested ad-hoc Electron components.
    res.inventory.status.signing = 'ad-hoc development signature; no Developer ID or notarization';
    await fs.writeFile(path.join(res.appPath, 'Contents', 'Resources', 'inventory.json'), JSON.stringify(res.inventory, null, 2));
    signMacApp(res.appPath);
    if (buildPkg) {
      res.packagePath = await createMacInstaller({ appPath: res.appPath, outDir, stagingDir,
        version: res.inventory.version, targetArch });
    }

    if (buildDmg) {
      const dmgPath = path.join(outDir, 'BlastCast.dmg');
      try {
        await fs.lstat(dmgPath);
        throw new Error('Existing output DMG would be overwritten');
      } catch (e) {
        if (e.code !== 'ENOENT') {
          if (e.message.includes('Existing output')) throw e;
          throw new Error(`Failed to stat dmg path: ${e.message}`);
        }
      }

      const hdiutil = spawnSync('/usr/bin/hdiutil', [
        'create', '-volname', 'BlastCast', '-srcfolder', res.appPath, '-format', 'UDZO', dmgPath
      ]);
      if (hdiutil.status !== 0) {
        throw new Error(`DMG creation failed: ${hdiutil.stderr?.toString()}`);
      }
    }

    return res;
  } finally {
    removeMacStagingDirectory(stagingDir);
  }
}

if (typeof process !== 'undefined' && process.argv && process.argv.length > 1 && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const flags = new Set();
  let archivePath, sourceDir, outDir, buildDmg = false, buildPkg = false;
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flags.has(arg)) {
      console.error(`Duplicate flag: ${arg}`);
      process.exit(1);
    }
    flags.add(arg);
    
    if (arg === '--archive') { archivePath = args[++i]; }
    else if (arg === '--app') { sourceDir = args[++i]; }
    else if (arg === '--out') { outDir = args[++i]; }
    else if (arg === '--dmg') { buildDmg = true; }
    else if (arg === '--pkg') { buildPkg = true; }
    else {
      console.error(`Unknown flag: ${arg}`);
      process.exit(1);
    }
  }
  
  if (!archivePath || !sourceDir || !outDir) {
    console.error('Usage: node package.mjs --archive <path> --app <path> --out <path> [--pkg] [--dmg]');
    process.exit(1);
  }

  buildNativeMacPackage({
    archivePath,
    sourceDir,
    outDir,
    buildDmg,
    buildPkg
  }).then(res => {
    console.log(`Successfully packaged to ${res.packagePath || res.appPath}`);
  }).catch(err => {
    console.error(`Packaging failed: ${err.message}`);
    process.exit(1);
  });
}
