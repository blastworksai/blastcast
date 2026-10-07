// ClaudeBWAI — einh 4-5 Oct: live chat interface (CP7b): banners, badge, background signals, and the source sweeps that keep chat out of the scene.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChatUi, BANNER_MS } from '../dist/chat-ui.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

// Minimal DOM: just what chat-ui touches.
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.handlers = {}; this.className = ''; this._text = ''; this.hidden = false; this.scrollTop = 0; this.scrollHeight = 0; this.value = ''; }
  get textContent() { return this.children.length ? this.children.map(c => c.textContent).join('') : this._text; }
  set textContent(v) { this.children = []; this._text = String(v); }
  append(...items) { for (const i of items) { if (i.parent) i.parent.children = i.parent.children.filter(c => c !== i); i.parent = this; this.children.push(i); } }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
  fire(type, event = {}) { for (const fn of this.handlers[type] ?? []) fn({ preventDefault() {}, stopPropagation() {}, ...event }); }
  find(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.find(pred, out); } return out; }
  byClass(name) { return this.find(n => n.className.split(' ').includes(name)); }
}
function makeDoc() {
  const doc = new Node('document');
  doc.body = new Node('body'); doc.hidden = false; doc.title = 'BlastCast Guest';
  doc.createElement = tag => new Node(tag);
  doc.defaultView = new Node('window');
  return doc;
}
function makeTimers() {
  let now = 0, next = 1; const jobs = new Map();
  return {
    setTimeout: (fn, ms) => { const id = next++; jobs.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => { jobs.delete(id); },
    setInterval: () => next++, clearInterval() {},
    advance(ms) { now += ms; for (const [id, job] of [...jobs]) if (job.at <= now) { jobs.delete(id); job.fn(); } },
    pending: () => jobs.size
  };
}
function harness({ role = 'guest', sharing = false } = {}) {
  const doc = makeDoc(), timers = makeTimers(), root = new Node('div');
  doc.body.append(root);
  const state = { sharing, queue: [], latestId: 0, attention: [], unread: [], opened: 0, polled: [], sent: [] };
  const ui = createChatUi({
    root, role, doc, timers,
    send: async text => { state.sent.push(text); return { ok: true, message: { id: 900 + state.sent.length, at: 1, name: 'Me', text, mine: true, host: false } }; },
    poll: async since => { state.polled.push(since); const messages = state.queue.filter(m => m.id > since || since === 0); state.queue = []; for (const m of messages) state.latestId = Math.max(state.latestId, m.id); return { ok: true, messages, latestId: state.latestId }; },
    isSharing: () => state.sharing,
    onAttention: n => state.attention.push(n),
    onUnread: n => state.unread.push(n),
    openChat: () => { state.opened++; }
  });
  const overlay = doc.body.byClass('chat-overlay')[0];
  const banners = () => overlay.byClass('chat-banner');
  const msg = (id, name, text, extra = {}) => ({ id, at: id, name, text, mine: false, host: false, ...extra });
  const deliver = async (...messages) => { state.queue.push(...messages); await ui.tick(); };
  ui.start(); // first poll is history, empty here
  return { doc, timers, root, state, ui, overlay, banners, msg, deliver };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a banner appears only for other people\'s messages, with role=alert and aria-live=assertive', async () => {
  const h = harness(); await settle();
  await h.deliver(h.msg(1, 'Ana', 'hello <b>there</b>'), h.msg(2, 'Me', 'mine', { mine: true }));
  assert.equal(h.banners().length, 1);
  const banner = h.banners()[0];
  assert.equal(banner.getAttribute('role'), 'alert');
  assert.equal(banner.getAttribute('aria-live'), 'assertive');
  assert.match(banner.textContent, /Ana/);
  assert.match(banner.textContent, /hello <b>there<\/b>/, 'text is shown as text, never parsed');
});

test('history messages never banner or count, even on the host', async () => {
  for (const role of ['guest', 'host']) {
    const h = harness({ role }); await settle();
    // The first poll after start() is history; a message flagged history later is history too.
    h.ui.stop(); h.state.queue.push(h.msg(1, 'Ana', 'old')); h.ui.start(); await settle(); await settle();
    await h.deliver(h.msg(2, 'Ana', 'older', { history: true }));
    assert.equal(h.banners().length, 0, role);
    assert.equal(h.ui.unread(), 0, role);
  }
});

test('stacking: newest on top, at most 3 shown, then "N more"', async () => {
  const h = harness(); await settle();
  await h.deliver(h.msg(1, 'A', 'one'), h.msg(2, 'B', 'two'), h.msg(3, 'C', 'three'), h.msg(4, 'D', 'four'), h.msg(5, 'E', 'five'));
  const shown = h.overlay.byClass('chat-banners')[0].children;
  assert.equal(shown.length, 3);
  assert.match(shown[0].textContent, /five/); assert.match(shown[2].textContent, /three/);
  const more = h.overlay.byClass('chat-more')[0];
  assert.equal(more.hidden, false); assert.equal(more.textContent, '2 more');
});

test('a banner dismisses itself after 10 s, and hovering pauses the timer', async () => {
  const h = harness(); await settle();
  await h.deliver(h.msg(1, 'Ana', 'hi'));
  h.timers.advance(BANNER_MS - 1); assert.equal(h.banners().length, 1);
  h.timers.advance(1); assert.equal(h.banners().length, 0);
  await h.deliver(h.msg(2, 'Ana', 'again'));
  const banner = h.banners()[0];
  banner.fire('mouseenter'); h.timers.advance(60_000); assert.equal(h.banners().length, 1, 'paused while hovered');
  banner.fire('mouseleave'); h.timers.advance(BANNER_MS); assert.equal(h.banners().length, 0);
});

test('the close button dismisses without opening chat; clicking the banner opens chat', async () => {
  const h = harness(); await settle();
  await h.deliver(h.msg(1, 'Ana', 'one'), h.msg(2, 'Bo', 'two'));
  h.banners()[0].byClass('chat-banner-close')[0].fire('click');
  assert.equal(h.banners().length, 1); assert.equal(h.state.opened, 0);
  h.banners()[0].fire('click');
  assert.equal(h.banners().length, 0); assert.equal(h.state.opened, 1);
});

test('while sharing, no banners: a persistent badge counts instead, and clears when the share ends', async () => {
  const h = harness({ sharing: true }); await settle();
  await h.deliver(h.msg(1, 'Ana', 'one'), h.msg(2, 'Bo', 'two'), h.msg(3, 'Me', 'mine', { mine: true }));
  assert.equal(h.banners().length, 0);
  const badge = h.overlay.byClass('chat-badge')[0];
  assert.equal(badge.hidden, false); assert.equal(badge.textContent, '2 new messages');
  h.state.sharing = false; h.ui.refresh();
  assert.equal(badge.hidden, true);
});

test('a share starting clears banners already on screen', async () => {
  const h = harness(); await settle();
  await h.deliver(h.msg(1, 'Ana', 'one'));
  assert.equal(h.banners().length, 1);
  h.state.sharing = true; h.ui.refresh();
  assert.equal(h.banners().length, 0);
});

test('guest in the background: title "(N) New message", restored on return', async () => {
  const h = harness({ role: 'guest' }); await settle();
  h.doc.hidden = true;
  await h.deliver(h.msg(1, 'Ana', 'one'));
  assert.equal(h.doc.title, '(1) New message');
  await h.deliver(h.msg(2, 'Ana', 'two'));
  assert.equal(h.doc.title, '(2) New message');
  h.doc.hidden = false; h.doc.fire('visibilitychange');
  assert.equal(h.doc.title, 'BlastCast Guest');
});

test('host in the background: onAttention(count), then 0 on return; unread feeds the tab and clears when opened', async () => {
  const h = harness({ role: 'host' }); await settle();
  h.doc.hidden = true;
  await h.deliver(h.msg(1, 'Ana', 'one'), h.msg(2, 'Bo', 'two'));
  assert.equal(h.state.attention.at(-1), 2);
  assert.equal(h.doc.title, 'BlastCast Guest', 'the host never retitles');
  h.doc.hidden = false; h.doc.fire('visibilitychange');
  assert.equal(h.state.attention.at(-1), 0);
  assert.equal(h.ui.unread(), 2);
  h.ui.setOpen(true);
  assert.equal(h.ui.unread(), 0); assert.equal(h.state.unread.at(-1), 0);
});

test('history list and input: text only, autocomplete off, 16px-safe, a sent message appears once', async () => {
  const h = harness(); await settle();
  await h.deliver(h.msg(1, 'Ana', 'hi'));
  const input = h.root.find(n => n.tag === 'input')[0];
  assert.equal(input.getAttribute('autocomplete'), 'off');
  input.value = '  ping  ';
  h.root.find(n => n.tag === 'form')[0].fire('submit');
  await settle(); await settle();
  assert.deepEqual(h.state.sent, ['ping']);
  await h.deliver(h.msg(901, 'Me', 'ping', { mine: true }));
  assert.equal(h.root.byClass('chat-line').filter(n => /ping/.test(n.textContent)).length, 1, 'own echo is not duplicated');
  assert.equal(h.banners().filter(n => /ping/.test(n.textContent)).length, 0, 'own message never banners');
});

test('the host\'s own tag is separate from a guest named "Host"', async () => {
  const h = harness(); await settle();
  await h.deliver(h.msg(1, 'Host', 'impostor'), h.msg(2, 'Host', 'real', { host: true }));
  const names = h.root.byClass('chat-name');
  assert.equal(names[0].className, 'chat-name'); assert.equal(names[1].className, 'chat-name chat-name-host');
});

// ---- source sweeps -------------------------------------------------------------------------------------------------------------------
const chatSources = () => {
  const guest = read('src/guest.ts'), shell = read('src/studio-shell.ts');
  const guestChat = guest.slice(guest.indexOf('live chat. Polls only while admitted'), guest.indexOf('share = new ScreenShare('));
  const shellChat = shell.slice(shell.indexOf('chat = createChatUi'), shell.indexOf('chat.start();'));
  return { 'src/chat-ui.ts': read('src/chat-ui.ts'), 'guest.ts chat block': guestChat, 'studio-shell.ts chat block': shellChat };
};
test('chat code never parses HTML', () => {
  for (const [name, source] of Object.entries(chatSources())) {
    assert.ok(source.length > 200, `${name} slice found`);
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, name);
  }
});
test('chat code makes no sound and touches no storage', () => {
  for (const [name, source] of Object.entries(chatSources())) {
    assert.doesNotMatch(source, /\bAudio\b|AudioContext|new Audio|\.play\(/, name);
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|\bcaches\b/, name);
  }
});
test('no console or logging call in chat code, so no message text can reach a log', () => {
  for (const [name, source] of Object.entries(chatSources())) {
    assert.doesNotMatch(source, /console\.|diagnostics|\.record\(/, name);
  }
});

test('the scene, recording and program output never import chat-ui (transitively)', () => {
  const importsOf = file => [...read(`src/${file}`).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"]\.\/([^'"]+)\.js['"]/g)].map(m => `${m[1]}.ts`);
  const reach = start => { const seen = new Set(), queue = [start]; while (queue.length) { const f = queue.pop(); if (seen.has(f) || !fs.existsSync(path.join(ROOT, 'src', f))) continue; seen.add(f); queue.push(...importsOf(f)); } return seen; };
  for (const file of ['scenes.ts', 'scene-controls.ts', 'program-output.ts', 'recording.ts']) {
    assert.ok(reach(file).size >= 1);
    assert.ok(!reach(file).has('chat-ui.ts'), `${file} must not reach chat-ui`);
  }
});

test('chat-ui.js is served by the studio and guest asset maps and listed by all three packagers', () => {
  assert.match(read('desktop/main.cjs'), /\['\/chat-ui\.js', 'text\/javascript'\]/);
  assert.match(read('desktop/guest-static.cjs'), /\['\/chat-ui\.js', \['chat-ui\.js', 'text\/javascript'\]\]/);
  for (const file of ['packaging/linux/package.mjs', 'packaging/windows/layout.mjs', 'packaging/macos/package.mjs']) assert.match(read(file), /dist\/chat-ui\.js/, file);
});

test('the guest page has a hidden chat panel, no style= attributes, and screen sharing excludes this tab', () => {
  const html = read('src/guest.html');
  assert.match(html, /id="guest-chat-panel"[^>]*hidden/);
  assert.doesNotMatch(html, /\sstyle=/);
  assert.match(read('src/guest.ts'), /selfBrowserSurface: 'exclude'/);
  assert.match(read('src/index.html'), /id="chat-tab"/);
});

test('host attention is one validated IPC that flashes the frame or sets the dock badge', () => {
  assert.match(read('desktop/boundary.cjs'), /blastcast:chatAttention[\s\S]{0,300}isSafeInteger\(args\[0\]\) \|\| args\[0\] < 0/);
  assert.match(read('desktop/main.cjs'), /flashFrame\(count > 0\)/);
  assert.match(read('desktop/main.cjs'), /app\.dock\?\.setBadge\(count > 0 \? String\(count\) : ''\)/);
  assert.match(read('desktop/preload.cjs'), /chatAttention/);
});

// ClaudeBWAI — einh 5 Oct: ruling "max 3 + N more, click opens the chat" — the overflow pill must be clickable.
test('the "N more" overflow pill opens the chat and clears the banner stack, like a banner click', async () => {
  const h = harness(); await settle();
  await h.deliver(h.msg(1, 'A', 'one'), h.msg(2, 'B', 'two'), h.msg(3, 'C', 'three'), h.msg(4, 'D', 'four'), h.msg(5, 'E', 'five'));
  assert.equal(h.banners().length, 3);
  const pill = h.overlay.byClass('chat-more')[0];
  assert.equal(pill.hidden, false);
  assert.equal(pill.textContent, '2 more');
  assert.equal(pill.tag, 'button', 'keyboard/AT reachable, like the badge');
  assert.equal(h.state.opened, 0);
  pill.fire('click');
  assert.equal(h.state.opened, 1, 'the pill triggers the open-chat action');
  assert.equal(h.banners().length, 0, 'the stack is cleared');
  assert.equal(pill.hidden, true);
});
