// ClaudeBWAI — round-trip and refusal tests for the .icns writer.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { writeIcns, readIcns, ICNS_CHUNKS, pngSize } from '../packaging/macos/icns.mjs';
const dir = new URL('../assets/brand/icons/', import.meta.url);
const sizes = [16, 32, 64, 128, 256, 512, 1024];
const load = async () => Object.fromEntries(await Promise.all(sizes.map(async s => [s, await fs.readFile(new URL(`blastcast-${s}.png`, dir))])));
test('every chunk type is present and carries a PNG of the right size', async () => {
  const chunks = readIcns(writeIcns(await load()));
  assert.deepEqual(chunks.map(c => c.type), ICNS_CHUNKS.map(c => c[0]));
  for (const [type, size] of ICNS_CHUNKS) assert.deepEqual(pngSize(chunks.find(c => c.type === type).data), [size, size], type);
});
test('a wrong-size PNG, a non-PNG and a missing size are refused', async () => {
  const map = await load();
  assert.throws(() => writeIcns({ ...map, 512: map[256] }), /expected 512x512/);
  assert.throws(() => writeIcns({ ...map, 16: Buffer.from('nope') }), /Not a PNG/);
  const { 1024: _, ...rest } = map;
  assert.throws(() => writeIcns(rest), /Missing 1024px/);
  assert.throws(() => readIcns(Buffer.from('junkjunkjunk')), /Not an icns/);
});
