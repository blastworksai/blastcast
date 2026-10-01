// CodexBWAI — deterministic Windows app layout; no downloader or installer service.
import { lstat, readdir, mkdir, copyFile, readFile, writeFile, rename, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const ELECTRON_VERSION = '44.4.5';
export const ARCHIVE_HASHES = Object.freeze({
  x64: '11c395820a5aaa8ebcc0686b476d0ac98a730274ebfbdc8cf5538a7c2815cb5d',
  arm64: '92c19d550a80a8bd62fc801325b8135d4c45733a7d7fac2b5d6b95f2eed71b5f',
});
const REQUIRED_APP_FILES = [
  'LICENSE','assets/licensing/public-key.txt','desktop/license-key.cjs','desktop/license-store.cjs',
  'desktop/free-tunnel.cjs','desktop/guest-access.cjs','desktop/guest-settings.cjs','desktop/guest-wizard.cjs','dist/invite-automation.js','desktop/recording-library.cjs','desktop/studio-preferences.cjs','desktop/display-picker.cjs','dist/recording-library.js','dist/screen-share.js','dist/studio-shell.js','dist/tokens.css','dist/blastcast.css','dist/logo-icon.svg','dist/fonts/BlastworksSans-Regular.woff2','dist/fonts/BlastworksSans-SemiBold.woff2','dist/fonts/BlastworksSans-ExtraBold.woff2','dist/fonts/BlastworksSans-UNLICENSE.txt',
  'dist/recording-status.js', 'dist/synchronization.js',
  'package.json',
  'desktop/signaling.cjs', 'dist/host-calls.js', 'dist/guest-call.js', 'dist/peer-call.js', 'dist/audio-mix.js',
  ...['main', 'preload', 'boundary', 'destination', 'recording', 'webm', 'guests', 'direct-access', 'relay-config', 'admission', 'sources', 'source-recovery', 'source-import', 'source-controller'].map(name => `desktop/${name}.cjs`),
  ...['source-protocol.js', 'source-capture.js', 'source-session.js', 'source-outbox.js', 'source-recovery.js', 'admission-ui.js', 'admission.css', 'scenes.js', 'scene-controls.js', 'screen-share-attention.js', 'program-output.js', 'index.html', 'studio.js', 'studio.css', 'invites.js', 'relay-input.js', 'recording.js', 'preview.js','device-access.js', 'camera-background.js', 'guest.html', 'guest.js', 'guest.css', 'readiness.html', 'readiness.js', 'readiness.css', 'package.json', 'Blastworks-Cast-256.png'].map(name => `dist/${name}`),
  ...['tf.min.js', 'body-pix.min.js', 'model-stride16.json', 'group1-shard1of1.bin', 'NOTICE.txt'].map(name => `dist/bodypix/${name}`),
  ...['cloudflare-tunnel-ready', 'cloudflare-route-form', 'cloudflare-route-ready', 'expressturn-fields'].map(name => `dist/instructions/${name}.png`),
  'assets/brand/Blastworks-Cast-256.png',
  ...['1cam', '2cam', '3cam', '4cam', '5cam', '6cam', '7cam', '8cam', 'screensharevert-8', 'screensharehorizont-8'].flatMap(name => [`assets/scenes/defaults/${name}.png`, `dist/${name}.png`]),
];
export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function within(parent, child) { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
async function realDirectory(value) {
  const stat = await lstat(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected a real directory: ${value}`);
  return realpath(value);
}
async function files(root, relative = '') {
  const result = [];
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    const file = path.join(relative, name); const stat = await lstat(path.join(root, file));
    if (stat.isSymbolicLink()) throw new Error(`Symlinks are not supported in Windows package inputs: ${file}`);
    if (stat.isDirectory()) result.push(...await files(root, file));
    else if (stat.isFile()) result.push(file);
    else throw new Error(`Unsupported package input: ${file}`);
  }
  return result;
}
async function copyFiles(source, destination, paths) {
  for (const name of paths) {
    const target = path.join(destination, name);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(source, name), target);
  }
}
async function required(root, names) {
  for (const name of names) { const stat = await lstat(path.join(root, name)); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Missing regular package input: ${name}`); }
}

// Used only after the CLI verifies and extracts the official archive. Fixtures
// may call this with tiny fake runtime inputs; they are not native-build proof.
export async function assembleWindowsApp({ app, runtime, output, arch }) {
  if (!Object.hasOwn(ARCHIVE_HASHES, arch)) throw new Error('Windows architecture must be x64 or arm64.');
  app = await realDirectory(app); runtime = await realDirectory(runtime);
  const parent = await realDirectory(path.dirname(path.resolve(output)));
  output = path.join(parent, path.basename(path.resolve(output)));
  if (within(app, output) || within(runtime, output) || within(output, app) || within(output, runtime)) throw new Error('Package output must be separate from both input trees.');
  try { await lstat(output); throw new Error('Output already exists; choose a new directory.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await required(runtime, ['electron.exe', 'version', 'LICENSE', 'LICENSES.chromium.html']);
  if ((await readFile(path.join(runtime, 'version'), 'utf8')).trim() !== ELECTRON_VERSION) throw new Error('Only the approved Electron 44.4.5 runtime is supported.');
  await required(app, REQUIRED_APP_FILES);
  const manifest = JSON.parse(await readFile(path.join(app, 'package.json'), 'utf8'));
  if (manifest.name !== 'blastcast' || manifest.main !== 'desktop/main.cjs' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Unexpected BlastCast app manifest.');
  const runtimeFiles = await files(runtime);
  if (runtimeFiles.some(f => /^blastcast\.exe$/i.test(f) || /^resources[\\/]app(?:[\\/.]|$)/i.test(f))) throw new Error('Runtime already contains an application or conflicting executable.');
  const appFiles = ['LICENSE'];
  for (const area of ['desktop', 'dist', 'assets']) {
    await realDirectory(path.join(app, area));
    for (const file of await files(path.join(app, area))) {
      if (/\.(?:cjs|js|json|html|css|png|svg|woff2|txt|bin|pem)$/i.test(file)) appFiles.push(path.join(area, file));
    }
  }
  await mkdir(output); // Exclusive: never overwrite an installed app or recordings.
  await copyFiles(runtime, output, runtimeFiles);
  await rename(path.join(output, 'electron.exe'), path.join(output, 'BlastCast.exe'));
  const appOutput = path.join(output, 'resources/app');
  await mkdir(appOutput, { recursive: true });
  await copyFiles(app, appOutput, appFiles);
  await writeFile(path.join(appOutput, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, main: manifest.main, author: manifest.author, private: true, license: manifest.license }, null, 2) + '\n');
  await writeFile(path.join(output, 'READ-ME.txt'), 'BlastCast development build\r\n\r\nLaunch BlastCast.exe from this extracted folder. No developer tools are required.\r\nNo BlastCast signing was performed. Upstream executable signatures have not been checked. Native Windows acceptance is pending.\r\nNo SmartScreen/security bypass is part of the supported installation path.\r\nKeep recordings in a separate folder. Remove only this application folder to remove the app.\r\nNo uninstaller or recording deletion is performed.\r\n');
  const payload = [];
  for (const file of await files(output)) payload.push({ path: file.split(path.sep).join('/'), bytes: (await lstat(path.join(output, file))).size, sha256: await hashFile(path.join(output, file)) });
  const inventory = {
    schemaVersion: 1, product: 'BlastCast', appVersion: manifest.version, target: `win32-${arch}`,
    electronVersion: ELECTRON_VERSION, signing: 'no-blastcast-signing-performed', upstreamAuthenticode: 'not-verified', nativeAcceptance: 'not-run', installer: 'portable-directory',
    runtimeSource: `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-win32-${arch}.zip`,
    expectedRuntimeArchiveSha256: ARCHIVE_HASHES[arch],
    runtimeVerification: 'Layout does not verify archive provenance; package.mjs must verify the archive before extraction.',
    components: [{ name: 'Electron', version: ELECTRON_VERSION, license: 'MIT plus bundled third-party notices', notices: ['LICENSE', 'LICENSES.chromium.html'] }, { name: 'BlastCast', version: manifest.version, author: 'BlastworksAI and attributed project contributors' }],
    payload,
  };
  await writeFile(path.join(output, 'blastcast-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
  return inventory;
}
