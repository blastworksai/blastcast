// CodexBWAI — native Windows packaging from an already downloaded pinned archive.
import { mkdtemp, writeFile, rm, realpath, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assembleWindowsApp, ARCHIVE_HASHES, ELECTRON_VERSION, hashFile } from './layout.mjs';

export function parseArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]; const value = args[i + 1];
    if (!['--archive', '--app', '--output', '--arch'].includes(flag) || !value || Object.hasOwn(options, flag.slice(2))) throw new Error('Usage: node packaging/windows/package.mjs --archive <official-electron.zip> --app <built-project> --output <new-directory> --arch <x64|arm64>');
    options[flag.slice(2)] = value;
  }
  if (Object.keys(options).length !== 4 || !Object.hasOwn(ARCHIVE_HASHES, options.arch)) throw new Error('Archive, built app, new output directory and x64/arm64 architecture are required.');
  return options;
}
export function systemPowerShell(systemRoot) {
  if (typeof systemRoot !== 'string' || !/^[a-z]:\\/i.test(systemRoot) || systemRoot.includes('\0')) throw new Error('An absolute Windows SystemRoot is required.');
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
export async function verifyRuntimeArchive(archive, arch) {
  if (!Object.hasOwn(ARCHIVE_HASHES, arch)) throw new Error('Windows architecture must be x64 or arm64.');
  if (!(await lstat(archive)).isFile()) throw new Error('Runtime archive must be a regular file.');
  const digest = await hashFile(archive);
  if (digest !== ARCHIVE_HASHES[arch]) throw new Error('Runtime archive hash does not match the approved Electron 44.4.5 distribution. Nothing extracted.');
  return digest;
}
export async function packageWindows(options) {
  if (process.platform !== 'win32') throw new Error('Run this packaging command on Windows. Linux fixture tests do not create or qualify a Windows distribution.');
  const archive = await realpath(options.archive);
  const digest = await verifyRuntimeArchive(archive, options.arch);
  const powershell = systemPowerShell(process.env.SystemRoot);
  if (!(await lstat(powershell)).isFile()) throw new Error('System PowerShell executable is missing.');
  const staging = await mkdtemp(path.join(tmpdir(), 'blastcast-package-'));
  try {
    const unpack = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference = "Stop"; $PSModuleAutoLoadingPreference = "None"; [void][System.Reflection.Assembly]::Load("System.IO.Compression.FileSystem, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089"); [System.IO.Compression.ZipFile]::ExtractToDirectory($env:BCAST_PACKAGE_ARCHIVE, $env:BCAST_PACKAGE_RUNTIME)'],
    { stdio: 'inherit', env: { ...process.env, BCAST_PACKAGE_ARCHIVE: archive, BCAST_PACKAGE_RUNTIME: staging } });
    if (unpack.error || unpack.status !== 0) throw unpack.error ?? new Error('Official runtime extraction failed.');
    const inventory = await assembleWindowsApp({ app: options.app, runtime: staging, output: options.output, arch: options.arch });
    inventory.runtimeVerification = 'Official archive SHA-256 matched before extraction.';
    inventory.runtimeArchiveSha256 = digest;
    await writeFile(path.join(options.output, 'blastcast-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
    return inventory;
  } finally { await rm(staging, { recursive: true, force: true }); } // Only our unique extraction directory.
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await packageWindows(parseArguments(process.argv.slice(2))); console.log(`Created BlastCast for ${result.target}; Electron ${ELECTRON_VERSION}; no BlastCast signing performed, native acceptance pending.`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
