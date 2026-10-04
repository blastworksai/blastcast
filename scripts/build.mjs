import { copyFile, writeFile, mkdir } from 'node:fs/promises';
for (const name of ['index.html', 'studio.css', 'guest.html', 'guest.css', 'readiness.html', 'readiness.css', 'admission.css', 'tokens.css', 'blastcast.css']) await copyFile(`src/${name}`, `dist/${name}`);
// Browser modules can also be imported by Node's built-in test runner.
await writeFile('dist/package.json', '{"type":"module"}\n');
await copyFile('assets/brand/Blastworks-Cast-256.png', 'dist/Blastworks-Cast-256.png');
for (const name of ['1cam', '2cam', '3cam', '4cam', '5cam', '6cam', '7cam', '8cam', 'screensharevert-8', 'screensharehorizont-8']) {
  await copyFile(`assets/scenes/defaults/${name}.png`, `dist/${name}.png`);
}

// CodexBWAI — owner-supplied UI kit; font exception approved 29 September 2026.
await mkdir('dist/fonts', { recursive: true });
for (const name of ['BlastworksSans-Regular.woff2', 'BlastworksSans-SemiBold.woff2', 'BlastworksSans-ExtraBold.woff2', 'BlastworksSans-UNLICENSE.txt']) await copyFile(`assets/fonts/${name}`, `dist/fonts/${name}`);
await copyFile('assets/brand/logo-icon.svg', 'dist/logo-icon.svg');
await mkdir('dist/instructions', { recursive: true });
for (const name of ['cloudflare-tunnel-ready', 'cloudflare-route-form', 'cloudflare-route-ready', 'expressturn-fields']) {
  await copyFile(`assets/instructions/${name}.png`, `dist/instructions/${name}.png`);
}
await mkdir('dist/bodypix', { recursive: true });
for (const name of ['tf.min.js', 'body-pix.min.js', 'model-stride16.json', 'group1-shard1of1.bin', 'NOTICE.txt']) {
  await copyFile(`assets/bodypix/${name}`, `dist/bodypix/${name}`);
}

// ClaudeBWAI — desktop (CommonJS) reads the shared source limits from the compiled TS module, never a copy.
const limits = await import('../dist/source-limits.js');
await writeFile('dist/source-limits.json', `${JSON.stringify(limits, null, 2)}\n`);
