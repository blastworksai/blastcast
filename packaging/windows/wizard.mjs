// CodexBWAI — build a conventional NSIS wizard from approved, local inputs only.
import { mkdir, readFile, writeFile, readdir, lstat, cp, rename, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, ARCHIVE_HASHES, ELECTRON_VERSION } from './layout.mjs';
import { NSIS_VERSION, NSIS_SHA256, NSIS_SOURCE, renderWizard, validateTerms, validatePayload, termsRtf } from './wizard-plan.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
async function walk(root, relative = '') {
  const files = [];
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    const rel = relative ? `${relative}/${name}` : name; const stat = await lstat(path.join(root, ...rel.split('/')));
    if (stat.isSymbolicLink()) throw new Error('Symlinks are forbidden in the installer payload.');
    if (stat.isDirectory()) files.push(...await walk(root, rel));
    else if (stat.isFile()) files.push(rel);
    else throw new Error('Unsupported payload entry.');
  }
  return files;
}
function run(exe, args, options = {}) {
  const result = spawnSync(exe, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(`Native build step failed: ${result.error?.message ?? result.stderr + result.stdout}`);
  return result.stdout;
}
export async function buildWizard(options) {
  if (process.platform !== 'win32') throw new Error('Build the Windows wizard on Windows.');
  const { mode, version } = options;
  const payload = await realpath(options.payload); const png = await realpath(options.png); const nsisArchive = await realpath(options.nsis);
  const terms = await readFile(options.terms, 'utf8');
  const approval = options.approval ? JSON.parse(await readFile(options.approval, 'utf8')) : undefined;
  let fixture = false;
  try { fixture = JSON.parse(await readFile(path.join(payload, 'fixture-marker.json'), 'utf8')).purpose === 'non-installing-nsis-review'; } catch { /* release payload is not a fixture */ }
  const termsSha256 = validateTerms({ mode, terms, approval, fixture });
  const inputs = await walk(payload); validatePayload(inputs);
  if (mode === 'review') {
    let bytes = 0; for (const file of inputs) bytes += (await lstat(path.join(payload, file))).size;
    if (bytes > 1024 * 1024 || inputs.some(f => f.startsWith('resources/'))) throw new Error('Review mode accepts only a tiny non-application fixture.');
  } else {
    const manifest = JSON.parse(await readFile(path.join(payload, 'resources', 'app', 'package.json'), 'utf8'));
    if (manifest.name !== 'blastcast' || manifest.version !== version) throw new Error('Release version must match the assembled application.');
    const inventory = JSON.parse(await readFile(path.join(payload, 'blastcast-inventory.json'), 'utf8'));
    if (inventory.target !== 'win32-x64' || inventory.electronVersion !== ELECTRON_VERSION || inventory.expectedRuntimeArchiveSha256 !== ARCHIVE_HASHES.x64) throw new Error('Release requires the pinned, verified Windows x64 assembly.');
    if (!Array.isArray(inventory.payload) || inventory.payload.length !== inputs.length - 1) throw new Error('Input inventory does not cover the payload.');
    validatePayload(inventory.payload.map(entry => entry.path));
    for (const entry of inventory.payload) if (await hashFile(path.join(payload, ...entry.path.split('/'))) !== entry.sha256) throw new Error(`Input payload hash mismatch: ${entry.path}`);
  }
  if (await hashFile(nsisArchive) !== NSIS_SHA256) throw new Error('NSIS archive hash differs from the approved 3.13 ZIP.');
  const output = path.resolve(options.output);
  const rel = path.relative(payload, output);
  if (!rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))) throw new Error('Build output must be outside the payload.');
  await mkdir(output); // exclusive; never overwrite another build
  const staging = path.join(output, 'payload'); await cp(payload, staging, { recursive: true, errorOnExist: true, force: false });
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const toolRoot = path.join(output, 'toolchain'); await mkdir(toolRoot);
  run(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:BCAST_NSIS_ZIP,$env:BCAST_NSIS_DEST)'], { env: { ...process.env, BCAST_NSIS_ZIP: nsisArchive, BCAST_NSIS_DEST: toolRoot } });
  const nsis = path.join(toolRoot, `nsis-${NSIS_VERSION}`); const compiler = path.join(nsis, 'makensis.exe');
  const compilerVersion = run(compiler, ['/VERSION']).trim();
  if (compilerVersion !== `v${NSIS_VERSION}`) throw new Error(`Unexpected compiler version: ${compilerVersion}`);
  const icon = path.join(output, 'BlastCast.ico');
  run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', path.join(here, 'brand-executable.ps1'), '-Executable', path.join(staging, 'BlastCast.exe'), '-Png', png, '-Icon', icon, '-Version', version]);
  await rename(path.join(staging, 'BlastCast.exe.branding.json'), path.join(output, 'branding-report.json'));
  if (mode === 'release') await cp(icon, path.join(staging, 'resources', 'app', 'assets', 'brand', 'BlastCast.ico'));
  await writeFile(path.join(staging, 'NSIS-NOTICES.txt'), await readFile(path.join(nsis, 'COPYING')));
  if (mode === 'release') await writeFile(path.join(staging, 'BlastCast-Terms.txt'), terms);
  const termsPath = path.join(output, mode === 'review' ? 'DRAFT-REVIEW-ONLY.rtf' : 'APPROVED-TERMS.rtf'); await writeFile(termsPath, termsRtf(terms), 'ascii');
  const termsDecodeReport = run(powershell, ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'RemoteSigned', '-File', path.join(here, 'verify-terms.ps1'), '-Rtf', termsPath, '-ApprovedText', path.resolve(options.terms)]);
  await writeFile(path.join(output, 'terms-render-report.json'), termsDecodeReport);
  let files = await walk(staging);
  if (mode === 'release') {
    await writeFile(path.join(staging, 'READ-ME.txt'), 'BlastCast desktop application\r\nOpen BlastCast from the Windows Start menu. Uninstall through Windows Settings > Apps. Recordings and the application profile are preserved.\r\nPublisher signing is pending; this build is unsigned. No Windows security bypass is part of the installation instructions.\r\n');
    const inventory = JSON.parse(await readFile(path.join(staging, 'blastcast-inventory.json'), 'utf8'));
    inventory.installer = 'nsis'; inventory.branding = 'approved-native-icon-and-version-resource-update'; inventory.signing = 'unsigned-publisher-signing-pending';
    inventory.payload = [];
    for (const file of files.filter(f => f !== 'blastcast-inventory.json')) inventory.payload.push({ path: file, bytes: (await lstat(path.join(staging, file))).size, sha256: await hashFile(path.join(staging, file)) });
    await writeFile(path.join(staging, 'blastcast-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
  }
  files = await walk(staging);
  const installer = path.join(output, `BlastCast-${version}-${mode === 'review' ? 'REVIEW-NOT-FOR-INSTALL' : 'Setup'}-x64.exe`);
  const script = path.join(output, 'BlastCast.nsi');
  await writeFile(script, renderWizard({ files, payload: staging, output: installer, icon, termsFile: termsPath, version, mode }));
  const compilerLog = run(compiler, ['/NOCD', '/V4', script]); await writeFile(path.join(output, 'makensis.log'), compilerLog);
  const report = { author: 'CodexBWAI', mode, installer, sha256: await hashFile(installer), nsis: { version: NSIS_VERSION, source: NSIS_SOURCE, archiveSha256: NSIS_SHA256, compressor: 'zlib', license: 'zlib/libpng (owner-approved exception)' }, termsSha256, termsStatus: mode === 'review' ? 'draft-review-only' : 'owner-approved', signed: false, installationPerformed: false, installableApplication: mode === 'release' };
  await writeFile(path.join(output, 'wizard-build-report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const options = {}; for (let i = 2; i < process.argv.length; i += 2) { const key = process.argv[i]?.replace(/^--/, ''); if (!['mode', 'version', 'payload', 'png', 'nsis', 'terms', 'approval', 'output'].includes(key) || !process.argv[i + 1] || Object.hasOwn(options, key)) throw new Error('Expected named build options.'); options[key] = process.argv[i + 1]; } console.log(JSON.stringify(await buildWizard(options), null, 2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
