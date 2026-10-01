import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { probeFolder, createDestination } = require('../desktop/destination.cjs');
const { registerBridge, registerRecordingBridge, registerGuestBridge, STUDIO_URL, mediaPermission, allowedStudioNavigation } = require('../desktop/boundary.cjs');

test('recording IPC rejects foreign frames and malformed or oversized payloads before disk access', () => {
  const handlers = new Map(); const calls = [];
  const frame = { url: STUDIO_URL }; const contents = { mainFrame: frame, isDestroyed: () => false };
  registerRecordingBridge({ handle: (name, method) => handlers.set(name, method) }, () => contents, {
    append: (...args) => calls.push(args), finish: (...args) => calls.push(args), abort: (...args) => calls.push(args),
  });
  const event = { sender: contents, senderFrame: frame };
  const id = '12345678-1234-1234-1234-123456789abc';
  const bytes = new ArrayBuffer(1);
  for (const name of ['appendRecording', 'finishRecording', 'abortRecording']) {
    const handler = handlers.get(`blastcast:${name}`);
    const args = name === 'appendRecording' ? [id, 0, bytes] : [id];
    handler(event, ...args);
    assert.throws(() => handler({ ...event, sender: {} }, ...args));
    assert.throws(() => handler({ ...event, senderFrame: { url: STUDIO_URL } }, ...args));
    frame.url = 'app://studio/foreign'; assert.throws(() => handler(event, ...args)); frame.url = STUDIO_URL;
    assert.throws(() => handler(event, ...args, '/arbitrary/path'));
    assert.throws(() => handler(event));
    assert.throws(() => handler(event, '12345678----------------------------', ...args.slice(1)));
  }
  const append = handlers.get('blastcast:appendRecording');
  for (const sequence of [-1, 0.5, NaN, Infinity, '0']) assert.throws(() => append(event, id, sequence, bytes));
  for (const value of [new ArrayBuffer(0), new ArrayBuffer(8 * 1024 * 1024 + 1), new Uint8Array(1), {}, null]) {
    assert.throws(() => append(event, id, 0, value));
  }
  assert.equal(calls.length, 3);
});

test('real write check leaves user files intact and no temporary residue', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-test-'));
  try {
    await fs.writeFile(path.join(root, 'episode.txt'), 'keep');
    assert.equal((await probeFolder(root)).status, 'ready');
    assert.deepEqual(await fs.readdir(root), ['episode.txt']);
    assert.equal(await fs.readFile(path.join(root, 'episode.txt'), 'utf8'), 'keep');
    assert.equal((await probeFolder(path.join(root, 'missing'))).status, 'error');
    assert.equal((await probeFolder(path.join(root, 'episode.txt'))).status, 'error');
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      await fs.chmod(root, 0o500);
      assert.match((await probeFolder(root)).message, /not writable/);
      await fs.chmod(root, 0o700);
    }
  } finally { await fs.chmod(root, 0o700); await fs.rm(root, { recursive: true, force: true }); }
});
test('disk-full and cleanup failure remain errors and close the probe handle', async () => {
  let closed = 0; let removed = 0;
  const io = { stat: async () => ({ isDirectory: () => true }), open: async () => ({
    writeFile: async () => { throw Object.assign(new Error(), { code: 'ENOSPC' }); },
    close: async () => { closed++; },
  }), unlink: async () => { removed++; } };
  assert.match((await probeFolder('/chosen', io)).message, /no space/);
  assert.equal(closed, 1); assert.equal(removed, 1);
  io.unlink = async () => { throw new Error('cleanup denied'); };
  assert.match((await probeFolder('/chosen', io)).message, /could not be removed/);
});
test('folder readiness refuses unsupported publication before recording and removes its probes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-link-probe-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let links = 0;
  const io = { ...fs, link: async () => { links++; throw Object.assign(new Error('unsupported'), { code: 'EOPNOTSUPP' }); } };
  const result = await probeFolder(root, io);
  assert.equal(result.status, 'error');
  assert.match(result.message, /finish recordings/);
  assert.equal(links, 1);
  assert.deepEqual(await fs.readdir(root), []);
});
test('publication-probe cleanup failure still removes the other owned name and refuses readiness', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-link-cleanup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const io = { ...fs, unlink: async file => {
    if (file.endsWith('.link')) throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
    return fs.unlink(file);
  } };
  const result = await probeFolder(root, io);
  assert.equal(result.status, 'error'); assert.match(result.message, /could not be removed/);
  const remaining = await fs.readdir(root);
  assert.equal(remaining.length, 1); assert.ok(remaining[0].endsWith('.link'));
});
test('cancel keeps previous selection; a failed replacement invalidates it', async () => {
  let chosen = '/valid'; let opened;
  const destination = createDestination({ pick: async () => chosen, open: async value => { opened = value; return ''; },
    probe: async value => value === '/bad' ? { status: 'error', message: 'Unavailable' } : { status: 'ready', label: value } });
  await destination.choose(); chosen = null;
  assert.equal((await destination.choose()).status, 'cancelled');
  assert.equal((await destination.check()).label, '/valid');
  assert.equal((await destination.open()).ok, true); assert.equal(opened, '/valid');
  chosen = '/bad'; assert.equal((await destination.choose()).status, 'error');
  assert.equal((await destination.open()).ok, false);
});
test('destination disappearance and failed OS open are explicit', async () => {
  let available = true;
  const destination = createDestination({ pick: async () => '/folder', open: async () => 'OS failed',
    probe: async () => available ? { status: 'ready', label: '/folder' } : { status: 'error', message: 'Gone' } });
  await destination.choose(); assert.equal((await destination.open()).ok, false);
  available = false; assert.equal((await destination.check()).status, 'error');
  assert.equal((await destination.open()).ok, false);
});
test('IPC rejects foreign windows, child frames, remote URLs and supplied paths', async () => {
  const methods = new Map(); let calls = 0;
  const frame = { url: STUDIO_URL }; const contents = { mainFrame: frame, isDestroyed: () => false };
  registerBridge({ handle: (name, method) => methods.set(name, method) }, () => contents,
    { chooseFolder: () => { calls++; return 'picked'; } });
  const method = methods.get('blastcast:chooseFolder');
  const event = { sender: contents, senderFrame: frame };
  assert.equal(method(event), 'picked');
  assert.throws(() => method(event, '/etc'));
  assert.throws(() => method({ ...event, sender: {} }));
  assert.throws(() => method({ ...event, senderFrame: { url: STUDIO_URL } }));
  frame.url = 'https://example.com'; assert.throws(() => method(event));
  frame.url = STUDIO_URL; contents.isDestroyed = () => true; assert.throws(() => method(event));
  assert.equal(calls, 1);
});
test('IPC activation guard blocks valid studio requests before product code runs', () => {
  const methods = new Map(); let calls = 0;
  const frame = { url: STUDIO_URL }; const contents = { mainFrame: frame, isDestroyed: () => false };
  registerBridge({ handle: (name, method) => methods.set(name, method) }, () => contents,
    { chooseFolder: () => { calls++; } }, () => false);
  const event = { sender: contents, senderFrame: frame };
  assert.throws(() => methods.get('blastcast:chooseFolder')(event), /activation is required/);
  assert.equal(calls, 0);
});
test('readiness and direct-access actions are zero-argument host-main-frame calls', () => {
  const handlers = new Map(), calls = [];
  const frame = { url: STUDIO_URL }; const contents = { mainFrame: frame, isDestroyed: () => false };
  registerBridge({ handle: (name, method) => handlers.set(name, method) }, () => contents, {
    copyGuestReadiness: () => { calls.push('copy'); return { ok: true }; },
    failGuestReadiness: () => { calls.push('fail'); return { ok: true }; },
    directAccessStatus: () => { calls.push('status'); return { ok: true }; },
    prepareGuestDirectAccess: () => { calls.push('prepare'); return { ok: true }; },
    approveGuestDirectAccess: () => { calls.push('approve'); return { ok: true }; },
  });
  const event = { sender: contents, senderFrame: frame };
  for (const name of ['copyGuestReadiness', 'failGuestReadiness', 'directAccessStatus', 'prepareGuestDirectAccess', 'approveGuestDirectAccess']) {
    const method = handlers.get(`blastcast:${name}`);
    assert.equal(method(event).ok, true);
    assert.throws(() => method(event, 'diagnosis'));
    assert.throws(() => method({ ...event, senderFrame: { url: STUDIO_URL } }));
    assert.throws(() => method({ ...event, sender: {} }));
  }
  assert.deepEqual(calls, ['copy', 'fail', 'status', 'prepare', 'approve']);
});
test('a pending folder recheck cannot invalidate a newer folder selection', async () => {
  let resolve; let pending = false; let chosen = '/old';
  const destination = createDestination({ pick: async () => chosen, open: async () => '', probe: async value => {
    if (pending) return new Promise(r => { resolve = r; });
    return { status: 'ready', label: value };
  } });
  await destination.choose(); pending = true;
  const checking = destination.check(); await Promise.resolve();
  pending = false; chosen = '/new';
  assert.equal((await destination.choose()).status, 'error'); // Check owns the operation until settlement.
  resolve({ status: 'error', message: 'Old drive gone' }); await checking;
  assert.equal((await destination.choose()).label, '/new');
  assert.equal((await destination.check()).label, '/new');
});
test('media access is restricted to the consented studio and its main frame', () => {
  const contents = { getURL: () => STUDIO_URL };
  const details = { requestingOrigin: 'app://studio', isMainFrame: true };
  const check = (change = {}, allowed = true, permission = 'media', caller = contents) =>
    mediaPermission(caller, contents, permission, { ...details, ...change }, allowed);
  assert.equal(check(), true);
  assert.equal(check({}, false), false);
  assert.equal(check({ isMainFrame: false }), false);
  assert.equal(check({}, true, 'geolocation'), false);
  assert.equal(check({}, true, 'media', {}), false);
  for (const origin of ['https://studio', 'app://studio.attacker', 'app://user@studio', 'app://studio:444', '', 'null']) {
    assert.equal(check({ requestingOrigin: origin }), false, origin);
  }
});
test('only the exact studio document may navigate for activation reload', () => {
  assert.equal(allowedStudioNavigation(STUDIO_URL),true);
  for(const value of ['app://studio/','app://studio/index.html?key=value','app://studio/index.html#fragment','https://studio/index.html','']) assert.equal(allowedStudioNavigation(value),false,value);
});

test('admission IPC accepts stable IDs only from the host main frame, including revoke', () => {
  const handlers = new Map(), calls = [];
  const frame = { url: STUDIO_URL }, contents = { mainFrame: frame, isDestroyed: () => false };
  const guests = Object.fromEntries(['configure', 'admit', 'reject', 'remove', 'revokeInvite'].map(name => [name, id => { calls.push([name, id]); return { ok: true }; }]));
  registerGuestBridge({ handle: (key, fn) => handlers.set(key, fn) }, () => contents, guests);
  const event = { sender: contents, senderFrame: frame }, id = 'a'.repeat(22);
  for (const action of ['guestAdmit', 'guestReject', 'guestRemove', 'revokeGuestInvite']) {
    const fn = handlers.get(`blastcast:${action}`);
    assert.equal(fn(event, id).ok, true);
    for (const args of [[], ['a'.repeat(43)], [id, id], [null]]) assert.throws(() => fn(event, ...args));
    assert.throws(() => fn({ ...event, sender: {} }, id));
    assert.throws(() => fn({ ...event, senderFrame: { url: STUDIO_URL } }, id));
  }
  assert.equal(calls.length, 4);
});
