// ClaudeBWAI — CP5b 5b-1 tests (Linux; no makeappx needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildManifest, prepareLayout, msixVersion, parseArguments, decodePng, ASSET_DIR, makepriConfigArgs, makepriNewArgs } from '../packaging/windows/msix/msix.mjs';

const real = { identityName: 'BlastworksAI.BlastCast', publisher: 'CN=ABCD-1234', publisherDisplayName: 'Blastworks AI' };
const names = (xml, tag) => [...xml.matchAll(new RegExp(`<(?:rescap:)?${tag} Name="([^"]+)"`, 'g'))].map((m) => m[1]);

test('manifest has the required elements and exact capabilities', () => {
  const xml = buildManifest({ version: '0.2.4', identity: {} });
  for (const t of ['<?xml', '<Package', '<Identity', '<Properties>', '<Dependencies>', '<Applications>', '<Capabilities>', 'EntryPoint="Windows.FullTrustApplication"', 'Executable="BlastCast.exe"', 'MinVersion="10.0.17763.0"', 'Name="Windows.Desktop"']) assert.ok(xml.includes(t), t);
  assert.deepEqual(names(xml, 'Capability').sort(), ['internetClient', 'privateNetworkClientServer', 'runFullTrust']);
  assert.deepEqual(names(xml, 'DeviceCapability').sort(), ['microphone', 'webcam']);
  assert.ok(xml.includes('<rescap:Capability Name="runFullTrust"'));
  assert.equal((xml.match(/<(\w+:)?\w+/g) ?? []).length > 10, true);
  assert.ok(!/update/i.test(xml), 'no updater');
});
test('manifest is well-formed (tags balance)', () => {
  const xml = buildManifest({ version: '1.2.3', identity: real });
  const stack = [];
  for (const m of xml.replace(/<\?.*?\?>/s, '').matchAll(/<(\/?)([\w:]+)[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (m[1]) assert.equal(stack.pop(), m[2]); else stack.push(m[2]);
  }
  assert.deepEqual(stack, []);
});
test('version x.y.z maps to x.y.z.0 and bad versions are refused', () => {
  assert.equal(msixVersion('0.2.4'), '0.2.4.0');
  assert.match(buildManifest({ version: '0.2.4', identity: {} }), /Version="0\.2\.4\.0"/);
  for (const v of ['1.2', '1.2.3.4', 'x', '']) assert.throws(() => msixVersion(v));
});
test('TEST marker on placeholder identity only', () => {
  const t = buildManifest({ version: '0.2.4', identity: {} });
  assert.match(t, /Name="BlastworksAI\.BlastCast\.Test"/); assert.match(t, /Publisher="CN=BlastCast Test"/); assert.match(t, /<DisplayName>BlastCast \(TEST\)<\/DisplayName>/);
  const r = buildManifest({ version: '0.2.4', identity: real });
  assert.ok(!/TEST/.test(r)); assert.match(r, /Name="BlastworksAI\.BlastCast"/); assert.match(r, /Publisher="CN=ABCD-1234"/);
  assert.throws(() => buildManifest({ version: '0.2.4', identity: { identityName: 'X' } }));
});
test('identity values are XML-escaped', () => {
  assert.match(buildManifest({ version: '0.2.4', identity: { ...real, publisherDisplayName: 'A & B <c>' } }), /A &amp; B &lt;c&gt;/);
});
test('layout contains BlastCast.exe, every payload file, manifest and assets', async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'msix-test-'));
  try {
    const payload = path.join(d, 'payload'); await mkdir(path.join(payload, 'resources'), { recursive: true });
    await writeFile(path.join(payload, 'BlastCast.exe'), 'x'); await writeFile(path.join(payload, 'resources', 'app.asar'), 'y'); await writeFile(path.join(payload, 'a.dll'), 'z');
    const out = path.join(d, 'out');
    const r = await prepareLayout({ payload, version: '0.2.4', output: out, identity: {} });
    assert.equal(r.msix, null);
    for (const f of ['BlastCast.exe', 'resources/app.asar', 'a.dll', 'AppxManifest.xml']) assert.equal((await readFile(path.join(r.layout, f))).length > 0, true, f);
    for (const [f, s] of [['StoreLogo.png', 50], ['Square44x44Logo.png', 44], ['Square150x150Logo.png', 150]]) {
      const p = decodePng(await readFile(path.join(r.layout, ASSET_DIR, f))); assert.equal(p.w, s); assert.equal(p.h, s);
    }
    // ClaudeBWAI — einh 5 Oct: taskbar/Start/Alt-Tab read the targetsize and scale variants; without them Windows shows a blank plate.
    const want = [];
    for (const n of [16, 24, 32, 48, 256]) want.push([`Square44x44Logo.targetsize-${n}.png`, n], [`Square44x44Logo.targetsize-${n}_altform-unplated.png`, n]);
    want.push(['Square44x44Logo.scale-100.png', 44], ['Square44x44Logo.scale-200.png', 88], ['Square150x150Logo.scale-100.png', 150], ['Square150x150Logo.scale-200.png', 300], ['StoreLogo.scale-100.png', 50], ['StoreLogo.scale-200.png', 100]);
    const files = await readdir(path.join(r.layout, ASSET_DIR));
    for (const [f, sz] of want) {
      assert.ok(files.includes(f), `missing ${f}`);
      const q = decodePng(await readFile(path.join(r.layout, ASSET_DIR, f))); assert.equal(q.w, sz, f); assert.equal(q.h, sz, f);
    }
    const manifest = await readFile(path.join(r.layout, 'AppxManifest.xml'), 'utf8');
    for (const f of ['StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png']) assert.ok(manifest.includes(f), `manifest references ${f}`);
    assert.doesNotMatch(manifest, /targetsize|scale-\d/);
    await assert.rejects(prepareLayout({ payload, version: '0.2.4', output: out, identity: {} }), /must not exist/);
    const empty = path.join(d, 'empty'); await mkdir(empty);
    await assert.rejects(prepareLayout({ payload: empty, version: '0.2.4', output: path.join(d, 'o2'), identity: {} }), /BlastCast\.exe/);
  } finally { await rm(d, { recursive: true, force: true }); }
});
test('argument parsing', () => {
  assert.deepEqual(parseArguments(['--payload', 'p', '--version', '1.0.0', '--output', 'o']), { payload: 'p', version: '1.0.0', output: 'o' });
  assert.throws(() => parseArguments(['--payload', 'p']));
  assert.throws(() => parseArguments(['--bogus', 'x']));
});
// ClaudeBWAI — einh 5 Oct: Odin layout had correct logo refs but no resources.pri and the taskbar icon stayed blank; --makepri adds the index.
test('makepri argument shapes: config outside the layout, /pr layout, /mn manifest, /of layout resources.pri', () => {
  const layout = path.join('out', 'layout'), cfg = path.join('out', 'priconfig.xml');
  assert.deepEqual(makepriConfigArgs(layout), ['createconfig', '/cf', cfg, '/dq', 'en-US', '/pv', '10.0.0', '/o']);
  assert.deepEqual(makepriNewArgs(layout), ['new', '/pr', layout, '/cf', cfg, '/mn', path.join(layout, 'AppxManifest.xml'), '/of', path.join(layout, 'resources.pri'), '/o']);
  assert.ok(!makepriConfigArgs(layout)[2].startsWith(layout + path.sep), 'config must not be packaged');
});
test('makepri runs only when given, before makeappx, and fails loudly', async () => {
  const mk = async (opts, run) => {
    const d = await mkdtemp(path.join(tmpdir(), 'msix-pri-'));
    try {
      const payload = path.join(d, 'payload'); await mkdir(payload); await writeFile(path.join(payload, 'BlastCast.exe'), 'x');
      return await prepareLayout({ payload, version: '0.2.4', output: path.join(d, 'out'), identity: {}, run, ...opts });
    } finally { await rm(d, { recursive: true, force: true }); }
  };
  const calls = []; const ok = (exe, args) => { calls.push([exe, args[0]]); return { status: 0 }; };
  await mk({}, ok); assert.deepEqual(calls, []);
  await mk({ makepri: 'P', makeappx: 'A' }, ok); assert.deepEqual(calls, [['P', 'createconfig'], ['P', 'new'], ['A', 'pack']]);
  await assert.rejects(mk({ makepri: 'P' }, () => ({ status: 3 })), /makepri createconfig failed with status 3/);
  assert.equal(parseArguments(['--payload', 'p', '--version', '1.0.0', '--output', 'o', '--makepri', 'm.exe']).makepri, 'm.exe');
});
