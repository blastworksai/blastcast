import { copyFile, readFile, writeFile, mkdir } from 'node:fs/promises';

// Mac App Store build: `--mas` deletes every <!-- non-mas -->…<!-- /non-mas --> block from index.html, so the key-entry
// UI, the purchase sentence and the GitHub releases link are absent from the bundle, not just hidden.
// The default build keeps the blocks' content and removes only the marker comments themselves.
// `--out <dir>` (default dist) lets tests build elsewhere without touching dist/.
const args = process.argv.slice(2);
const mas = args.includes('--mas');
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? args[outIndex + 1] : 'dist';
if (!out) throw new Error('--out needs a directory');

export function applyMasMarkers(html, strip) {
  const open = '<!-- non-mas -->', close = '<!-- /non-mas -->';
  let result = '', rest = html;
  for (;;) {
    const o = rest.indexOf(open), c = rest.indexOf(close);
    if (o < 0 && c < 0) return result + rest;
    if (o < 0 || c < 0 || c < o) throw new Error('index.html has unbalanced non-mas markers');
    const next = rest.indexOf(open, o + open.length);
    if (next >= 0 && next < c) throw new Error('index.html has nested or unclosed non-mas markers');
    result += rest.slice(0, o) + (strip ? '' : rest.slice(o + open.length, c));
    rest = rest.slice(c + close.length);
  }
}

await mkdir(out, { recursive: true });
await writeFile(`${out}/index.html`, applyMasMarkers(await readFile('src/index.html', 'utf8'), mas));
for (const name of ['studio.css', 'guest.html', 'guest.css', 'readiness.html', 'readiness.css', 'admission.css', 'tokens.css', 'blastcast.css']) await copyFile(`src/${name}`, `${out}/${name}`);
// Browser modules can also be imported by Node's built-in test runner.
await writeFile(`${out}/package.json`, '{"type":"module"}\n');
await copyFile('assets/brand/Blastworks-Cast-256.png', `${out}/Blastworks-Cast-256.png`);
for (const name of ['1cam', '2cam', '3cam', '4cam', '5cam', '6cam', '7cam', '8cam', 'screensharevert-8', 'screensharehorizont-8']) {
  await copyFile(`assets/scenes/defaults/${name}.png`, `${out}/${name}.png`);
}

// CodexBWAI — owner-supplied UI kit; font exception approved 29 September 2026.
await mkdir(`${out}/fonts`, { recursive: true });
for (const name of ['BlastworksSans-Regular.woff2', 'BlastworksSans-SemiBold.woff2', 'BlastworksSans-ExtraBold.woff2', 'BlastworksSans-UNLICENSE.txt']) await copyFile(`assets/fonts/${name}`, `${out}/fonts/${name}`);
await copyFile('assets/brand/logo-icon.svg', `${out}/logo-icon.svg`);
await mkdir(`${out}/instructions`, { recursive: true });
for (const name of ['cloudflare-tunnel-ready', 'cloudflare-route-form', 'cloudflare-route-ready', 'expressturn-fields']) {
  await copyFile(`assets/instructions/${name}.png`, `${out}/instructions/${name}.png`);
}
const mediapipeFiles = ['vision_bundle.mjs', 'selfie_segmenter.tflite', 'NOTICE.txt', 'wasm/vision_wasm_internal.js', 'wasm/vision_wasm_internal.wasm', 'wasm/vision_wasm_nosimd_internal.js', 'wasm/vision_wasm_nosimd_internal.wasm'];
// ClaudeBWAI — MediaPipe Tasks Vision replaces BodyPix (7 Oct 2026): same tree under dist/mediapipe, wasm/ included.
await mkdir(`${out}/mediapipe/wasm`, { recursive: true });
for (const name of mediapipeFiles) await copyFile(`assets/mediapipe/${name}`, `${out}/mediapipe/${name}`);

// ClaudeBWAI — desktop (CommonJS) reads the shared source limits from the compiled TS module, never a copy.
const limits = await import('../dist/source-limits.js');
await writeFile(`${out}/source-limits.json`, `${JSON.stringify(limits, null, 2)}\n`);
