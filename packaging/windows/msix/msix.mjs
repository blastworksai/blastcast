// ClaudeBWAI — CP5b task 5b-1: MSIX layout + AppxManifest for the Microsoft Store.
// Build-time only. makeappx (Windows SDK, proprietary) is optional and never shipped.
import { cp, mkdir, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const DEFAULT_IDENTITY = Object.freeze({ name: 'BlastworksAI.BlastCast.Test', publisher: 'CN=BlastCast Test', publisherDisplayName: 'Blastworks AI (TEST)' });
export const MIN_VERSION = '10.0.17763.0'; // Windows 10 1809
export const ASSET_DIR = 'msix-assets';
export const CAPABILITIES = Object.freeze({ standard: ['internetClient', 'privateNetworkClientServer'], device: ['webcam', 'microphone'], restricted: ['runFullTrust'] });
const FLAGS = ['--payload', '--version', '--output', '--identity-name', '--publisher', '--publisher-display-name', '--makeappx', '--makepri', '--arch'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRAND_PNG = path.resolve(HERE, '../../../assets/brand/icons/blastcast-256.png');

export function parseArguments(args) {
  const o = {};
  for (let i = 0; i < args.length; i += 2) {
    const f = args[i], v = args[i + 1];
    if (!FLAGS.includes(f) || !v || Object.hasOwn(o, f.slice(2))) throw new Error('Usage: node packaging/windows/msix/msix.mjs --payload <staged app dir> --version <x.y.z> --output <dir> [--identity-name N --publisher CN=.. --publisher-display-name P] [--arch x64|arm64] [--makeappx <path>] [--makepri <path>]');
    o[f.slice(2)] = v;
  }
  for (const r of ['payload', 'version', 'output']) if (!o[r]) throw new Error(`--${r} is required.`);
  return o;
}
export function msixVersion(v) {
  if (!/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(v ?? '')) throw new Error('Version must be x.y.z (digits only).');
  return `${v}.0`; // Store reserves the 4th part; it must be 0.
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
export function resolveIdentity({ identityName, publisher, publisherDisplayName } = {}) {
  const real = Boolean(identityName && publisher && publisherDisplayName);
  if (!real && (identityName || publisher || publisherDisplayName)) throw new Error('A real identity needs --identity-name, --publisher and --publisher-display-name together.');
  return real ? { name: identityName, publisher, publisherDisplayName, test: false } : { ...DEFAULT_IDENTITY, test: true };
}
export function buildManifest({ version, identity, arch = 'x64' }) {
  const id = resolveIdentity(identity);
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Architecture must be x64 or arm64.');
  const display = id.test ? 'BlastCast (TEST)' : 'BlastCast';
  const desc = id.test ? 'BlastCast TEST build - placeholder identity, not the Store package' : 'BlastCast';
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity Name="${esc(id.name)}" Version="${msixVersion(version)}" Publisher="${esc(id.publisher)}" ProcessorArchitecture="${arch}" />
  <Properties>
    <DisplayName>${esc(display)}</DisplayName>
    <PublisherDisplayName>${esc(id.publisherDisplayName)}</PublisherDisplayName>
    <Logo>${ASSET_DIR}\\StoreLogo.png</Logo>
  </Properties>
  <Resources><Resource Language="en-us" /></Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="${MIN_VERSION}" MaxVersionTested="${MIN_VERSION}" />
  </Dependencies>
  <Applications>
    <Application Id="BlastCast" Executable="BlastCast.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="${esc(display)}" Description="${esc(desc)}" BackgroundColor="transparent"
        Square150x150Logo="${ASSET_DIR}\\Square150x150Logo.png" Square44x44Logo="${ASSET_DIR}\\Square44x44Logo.png" />
    </Application>
  </Applications>
  <Capabilities>
${CAPABILITIES.standard.map((c) => `    <Capability Name="${c}" />`).join('\n')}
${CAPABILITIES.restricted.map((c) => `    <rescap:Capability Name="${c}" />`).join('\n')}
${CAPABILITIES.device.map((c) => `    <DeviceCapability Name="${c}" />`).join('\n')}
  </Capabilities>
</Package>
`;
}

// --- dependency-free PNG downscale (8-bit RGBA, non-interlaced) ---
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); }
export function decodePng(buf) {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Not a PNG.');
  let pos = 8, w, h, idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), d = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); if (d[8] !== 8 || d[9] !== 6 || d[12] !== 0) throw new Error('Brand PNG must be 8-bit RGBA, non-interlaced.'); }
    if (type === 'IDAT') idat.push(d);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = w * 4, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= 4 && y ? px[(y - 1) * stride + x - 4] : 0;
      let p = 0;
      if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (f !== 0) throw new Error('Bad PNG filter.');
      px[y * stride + x] = (line[x] + p) & 255;
    }
  }
  return { w, h, px };
}
export function resizePng(src, size) { // area average, premultiplied alpha
  const out = Buffer.alloc(size * size * 4), r = src.w / size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let R = 0, G = 0, B = 0, A = 0, n = 0;
    for (let sy = Math.floor(y * r); sy < Math.max(Math.floor(y * r) + 1, Math.floor((y + 1) * r)); sy++) for (let sx = Math.floor(x * r); sx < Math.max(Math.floor(x * r) + 1, Math.floor((x + 1) * r)); sx++) {
      const i = (sy * src.w + sx) * 4, a = src.px[i + 3]; R += src.px[i] * a; G += src.px[i + 1] * a; B += src.px[i + 2] * a; A += a; n++;
    }
    const o = (y * size + x) * 4; if (A) { out[o] = Math.round(R / A); out[o + 1] = Math.round(G / A); out[o + 2] = Math.round(B / A); } out[o + 3] = Math.round(A / n);
  }
  const rows = Buffer.alloc(size * (size * 4 + 1)); for (let y = 0; y < size; y++) out.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
// ClaudeBWAI — einh 5 Oct: the sideloaded MSIX showed a blank white taskbar icon. Taskbar, Start and Alt-Tab look for
// Square44x44Logo.targetsize-N (and the _altform-unplated twin, which skips the plate) and scale-N files; the manifest keeps
// the unqualified names and Windows resolves the qualified siblings from them. Names: Microsoft's app-icon asset naming (not re-verified online).
const TARGET_SIZES = [16, 24, 32, 48, 256];
export const ASSET_SIZES = Object.freeze({
  'StoreLogo.png': 50, 'Square44x44Logo.png': 44, 'Square150x150Logo.png': 150,
  ...Object.fromEntries(TARGET_SIZES.flatMap((n) => [[`Square44x44Logo.targetsize-${n}.png`, n], [`Square44x44Logo.targetsize-${n}_altform-unplated.png`, n]])),
  'Square44x44Logo.scale-100.png': 44, 'Square44x44Logo.scale-200.png': 88,
  'Square150x150Logo.scale-100.png': 150, 'Square150x150Logo.scale-200.png': 300, // 300 is an upscale from the 256 px source
  'StoreLogo.scale-100.png': 50, 'StoreLogo.scale-200.png': 100,
});

// ClaudeBWAI — einh 5 Oct: pure builders for the resources.pri index; the config lives beside the layout so it is not packaged.
export const makepriConfigArgs = (layout) => ['createconfig', '/cf', path.join(path.dirname(layout), 'priconfig.xml'), '/dq', 'en-US', '/pv', '10.0.0', '/o'];
export const makepriNewArgs = (layout) => ['new', '/pr', layout, '/cf', path.join(path.dirname(layout), 'priconfig.xml'), '/mn', path.join(layout, 'AppxManifest.xml'), '/of', path.join(layout, 'resources.pri'), '/o'];

export async function prepareLayout({ payload, version, output, identity, arch, makeappx, makepri, run = spawnSync }) {
  msixVersion(version);
  if (!(await stat(payload).catch(() => null))?.isDirectory()) throw new Error('Payload must be an existing staged app directory.');
  if (!(await stat(path.join(payload, 'BlastCast.exe')).catch(() => null))?.isFile()) throw new Error('Payload has no BlastCast.exe; stage it with packaging/windows/package.mjs first.');
  if ((await stat(output).catch(() => null))) throw new Error('Output directory must not exist yet.');
  const layout = path.join(output, 'layout');
  await mkdir(layout, { recursive: true });
  await cp(payload, layout, { recursive: true });
  const src = decodePng(await readFile(BRAND_PNG));
  await mkdir(path.join(layout, ASSET_DIR));
  for (const [name, size] of Object.entries(ASSET_SIZES)) await writeFile(path.join(layout, ASSET_DIR, name), resizePng(src, size));
  await writeFile(path.join(layout, 'AppxManifest.xml'), buildManifest({ version, identity, arch }));
  const result = { layout, msix: null };
  if (makepri) {
    for (const args of [makepriConfigArgs(layout), makepriNewArgs(layout)]) {
      const p = run(makepri, args, { stdio: 'inherit' });
      if (p.error || p.status !== 0) throw p.error ?? new Error(`makepri ${args[0]} failed with status ${p.status}.`);
    }
  }
  if (makeappx) {
    const msix = path.join(output, `BlastCast_${version}.msix`);
    const r = run(makeappx, ['pack', '/d', layout, '/p', msix, '/o'], { stdio: 'inherit' });
    if (r.error || r.status !== 0) throw r.error ?? new Error(`makeappx failed with status ${r.status}.`);
    result.msix = msix;
  }
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = parseArguments(process.argv.slice(2));
    const r = await prepareLayout({ payload: o.payload, version: o.version, output: o.output, arch: o.arch, makeappx: o.makeappx, makepri: o.makepri,
      identity: { identityName: o['identity-name'], publisher: o.publisher, publisherDisplayName: o['publisher-display-name'] } });
    console.log(r.msix ? `Wrote ${r.msix}` : `Layout ready at ${r.layout}; no makeappx path given, nothing packed.`);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
