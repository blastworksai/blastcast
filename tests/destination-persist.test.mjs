// ClaudeBWAI — Task 3.3: recording folder persistence and MAS security-scoped bookmarks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createDestination } = require('../desktop/destination.cjs');

const ready = async folder => ({ status: 'ready', label: folder });
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dest-'));
  const settings = path.join(root, 'userData'); fs.mkdirSync(settings);
  const folder = path.join(root, 'rec'); fs.mkdirSync(folder);
  return { root, settings, file: path.join(settings, 'recording-folder.json'), folder };
}
const make = (o, extra = {}) => createDestination({ pick: async () => o.folder, open: async () => '', file: o.file, ...extra });
const b64 = text => Buffer.from(text).toString('base64');
const unb64 = text => Buffer.from(text, 'base64').toString();

test('cold start with no file: no folder', async () => {
  const o = sandbox(); const d = make(o);
  assert.equal((await d.load()).status, 'none'); assert.equal(d.selectedFolder(), null);
});
test('pick writes the file 0600 and a reload returns the same folder', async () => {
  const o = sandbox(); const d = make(o);
  assert.equal((await d.choose()).status, 'ready');
  assert.equal(fs.statSync(o.file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(o.settings), ['recording-folder.json']);
  const again = make(o); assert.equal((await again.load()).status, 'ready'); assert.equal(again.selectedFolder(), o.folder);
});
test('saved folder deleted: falls back to no folder with the unavailable message', async () => {
  const o = sandbox(); await make(o).choose(); fs.rmdirSync(o.folder);
  const d = make(o); const r = await d.load();
  assert.equal(r.status, 'error'); assert.match(r.message, /This folder is unavailable/); assert.equal(d.selectedFolder(), null);
});
test('symlinked or corrupt json is refused, never followed or crashed on', async () => {
  const o = sandbox(); const target = path.join(o.root, 'elsewhere.json');
  fs.writeFileSync(target, JSON.stringify({ version: 1, folder: o.folder }));
  fs.symlinkSync(target, o.file);
  const d = make(o); const r = await d.load();
  assert.equal(r.status, 'error'); assert.equal(d.selectedFolder(), null);
  await d.choose(); // must not write through or over the link
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).folder, o.folder);
  assert.equal(fs.lstatSync(o.file).isSymbolicLink(), true);
  fs.rmSync(o.file); fs.writeFileSync(o.file, '{nope');
  assert.equal((await make(o).load()).status, 'error');
});
test('failed new pick clears the remembered folder', async () => {
  const o = sandbox(); await make(o).choose();
  const bad = make(o, { probe: async () => ({ status: 'error', message: 'x' }) });
  await bad.choose(); assert.equal((await make(o).load()).status, 'none');
});

function masFixture(o) {
  const log = [];
  const bookmarks = {
    create: r => { log.push(['create', r.tag]); return b64('bm:' + r.tag); },
    start: b => { log.push(['start', unb64(b)]); return () => log.push(['stop', unb64(b)]); },
  };
  const opts = [];
  const mk = (extra = {}) => createDestination({
    pick: async option => { opts.push(option); return { folder: o.folder, dialogResult: { tag: 'a' } }; },
    open: async () => '', file: o.file, bookmarks, ...extra,
  });
  return { log, mk, opts };
}
test('MAS: pick requests bookmarks, stores one, reload starts it before the probe', async () => {
  const o = sandbox(); const m = masFixture(o);
  await m.mk().choose();
  assert.deepEqual(m.opts, [{ securityScopedBookmarks: true }]);
  const saved = JSON.parse(fs.readFileSync(o.file, 'utf8'));
  assert.equal(saved.bookmarks.length, 1); assert.equal(saved.bookmarks[0].folder, o.folder);
  m.log.length = 0;
  const d = m.mk({ probe: async f => { m.log.push(['probe']); return ready(f); } });
  assert.equal((await d.load()).status, 'ready');
  assert.deepEqual(m.log.map(x => x[0]), ['start', 'probe']);
});
test('MAS: stop on folder change and on dispose; earlier folders keep their bookmark', async () => {
  const o = sandbox(); const other = path.join(o.root, 'rec2'); fs.mkdirSync(other);
  let active = 0; const stopped = [];
  const bookmarks = {
    create: r => b64('bm:' + r.tag),
    start: b => { active++; return () => { active--; stopped.push(unb64(b)); }; },
  };
  const first = createDestination({ pick: async () => ({ folder: o.folder, dialogResult: { tag: 'a' } }), open: async () => '', file: o.file, bookmarks });
  await first.choose(); first.dispose(); active = 0; stopped.length = 0;
  const d = createDestination({ pick: async () => ({ folder: other, dialogResult: { tag: 'b' } }), open: async () => '', file: o.file, bookmarks });
  await d.load(); assert.equal(active, 1);
  await d.choose(); // change: stop what ran, restart both kept bookmarks
  assert.deepEqual(stopped, ['bm:a']); assert.equal(active, 2);
  assert.equal(JSON.parse(fs.readFileSync(o.file, 'utf8')).bookmarks.length, 2);
  d.dispose(); assert.equal(active, 0); assert.equal(stopped.length, 3);
});
test('MAS: stale bookmark (throws or falsy) gives the unavailable message and no folder', async () => {
  for (const start of [() => { throw new Error('stale'); }, () => null]) {
    const o = sandbox(); await masFixture(o).mk().choose();
    const d = createDestination({ pick: async () => null, open: async () => '', file: o.file, bookmarks: { create: () => 'AA==', start } });
    const r = await d.load();
    assert.equal(r.status, 'error'); assert.match(r.message, /This folder is unavailable/); assert.equal(d.selectedFolder(), null);
  }
});
test('MAS: a failed bookmark create does not select a folder', async () => {
  const o = sandbox();
  const d = createDestination({ pick: async () => ({ folder: o.folder, dialogResult: {} }), open: async () => '', file: o.file, bookmarks: { create: () => null, start: () => () => {} } });
  assert.equal((await d.choose()).status, 'error'); assert.equal(d.selectedFolder(), null);
});
test('non-MAS: pick gets no options, no bookmark is stored', async () => {
  const o = sandbox(); const seen = [];
  const d = createDestination({ pick: async (...args) => { seen.push(args); return o.folder; }, open: async () => '', file: o.file });
  await d.choose(); await make(o).load(); d.dispose();
  assert.deepEqual(seen, [[]]);
  assert.equal('bookmarks' in JSON.parse(fs.readFileSync(o.file, 'utf8')), false);
});
