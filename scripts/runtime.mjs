// CodexBWAI — exact official runtime; no npm downloader dependencies.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const version = '44.4.5';
const hashes = {
  'linux-x64': '04586a0ec46c3283fbdaef85530f561f71f0b5e136ad0cb9ef63683615609780',
  'linux-arm64': '3bf0acab49c4ea3c9283cdb86bf3dd7204bd52a6fba6c8ae51101bdba2adae0e',
  'darwin-arm64': 'a212eee63ba2f45fd83bd28f77a3e3313a336ad17a4c25adf617942eef5e0e2c',
  'darwin-x64': '778350cc572c36484dd56c130cae96ad1a9a5b695ba22dd06abd23ba0a46c9de',
  'win32-arm64': '92c19d550a80a8bd62fc801325b8135d4c45733a7d7fac2b5d6b95f2eed71b5f',
  'win32-x64': '11c395820a5aaa8ebcc0686b476d0ac98a730274ebfbdc8cf5538a7c2815cb5d',
};
export const runtimeDir = path.join(root, '.runtime', `${version}-${process.platform}-${process.arch}`);
export const executable = path.join(runtimeDir, process.platform === 'darwin'
  ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = `${process.platform}-${process.arch}`;
  const checksum = hashes[target];
  if (!checksum) throw new Error(`No approved runtime for ${target}`);
  const filename = `electron-v${version}-${target}.zip`;
  const url = `https://github.com/electron/electron/releases/download/v${version}/${filename}`;
  await mkdir(path.join(root, '.runtime'), { recursive: true });
  const archive = path.join(root, '.runtime', filename);
  let bytes;
  try { bytes = await readFile(archive); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`Runtime download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(bytes).digest('hex') !== checksum) {
    throw new Error('Runtime checksum mismatch; nothing extracted.');
  }
  await writeFile(archive, bytes);
  try { await access(executable); }
  catch {
    await mkdir(runtimeDir, { recursive: true });
    const unpack = process.platform === 'darwin'
      ? spawnSync('/usr/bin/ditto', ['-x', '-k', archive, runtimeDir], { stdio: 'inherit' })
      : process.platform === 'win32'
        ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            'Expand-Archive -LiteralPath $env:BCAST_ARCHIVE -DestinationPath $env:BCAST_RUNTIME -Force'],
          { stdio: 'inherit', env: { ...process.env, BCAST_ARCHIVE: archive, BCAST_RUNTIME: runtimeDir } })
        : spawnSync('unzip', ['-q', '-o', archive, '-d', runtimeDir], { stdio: 'inherit' });
    if (unpack.error || unpack.status !== 0) throw unpack.error ?? new Error('Runtime extraction failed.');
  }
  await writeFile(path.join(root, '.runtime/electron-manifest.json'), JSON.stringify({
    version, target, url, sha256: checksum, manifestSource:
      `https://github.com/electron/electron/releases/download/v${version}/SHASUMS256.txt`,
  }, null, 2) + '\n');
  console.log(`Verified Electron ${version} (${target}): ${executable}`);
}
