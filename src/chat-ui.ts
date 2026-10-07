// ClaudeBWAI — einh 4-5 Oct: live host/guest chat interface (CP7b). One module serves the studio Chat tab and the guest page panel.
//
// Contract
//  - createChatUi({ root, role, send, poll, isSharing, onAttention, ... }) builds the history list, the input and the send button inside `root`,
//    and an overlay (banner stack + "N new messages" badge) on document.body. Nothing here touches the scene, a recording or any storage.
//  - send(text) -> { ok: true, message? } | { ok: false, reason: 'invalid' | 'rate-limited' }   (host: bridge chatSend; guest: POST /api/chat/send)
//  - poll(since) -> { ok: true, messages, latestId } | { ok: false }                              (host: bridge chatSince; guest: POST /api/chat/poll)
//  - isSharing(): true while THIS viewer's screen share is live. Banners are replaced by a small persistent badge so no banner is captured.
//  - onAttention(count): called while the page is in the background with the number of new messages (host: taskbar flash / dock badge via
//    the bridge; guest: also sets document.title to "(N) New message"). Called with 0 when the viewer returns.
//  - onUnread(count): unread messages while the chat view is not open (the studio tab count). setOpen(true) clears it.
//  - openChat(): called when a banner or the badge is clicked (host: select the Chat tab; guest: focus the input).
// Rules: text only through textContent / createElement (no HTML parsing, no auto-linking), no sound, no storage, no message text in any log.
// The first poll after start() is history for both roles: it never banners, never counts. Own messages never banner.

export interface ChatLine { id: number; at: number; name: string; text: string; mine: boolean; host: boolean; history?: boolean }
export type ChatSendResult = { ok: true; message?: ChatLine } | { ok: false; reason: 'invalid' | 'rate-limited' };
export type ChatPollResult = { ok: true; messages: ChatLine[]; latestId: number } | { ok: false };
export interface ChatTimers {
  setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown; clearInterval(id: unknown): void;
}
export interface ChatUiOptions {
  root: HTMLElement;
  role: 'host' | 'guest';
  send(text: string): Promise<ChatSendResult>;
  poll(since: number): Promise<ChatPollResult>;
  isSharing(): boolean;
  onAttention(count: number): void;
  onUnread?(count: number): void;
  openChat?(): void;
  doc?: Document;
  timers?: ChatTimers;
  pollMs?: number;
}
export interface ChatUi {
  start(): void;
  stop(): void;
  /** Re-evaluates isSharing() now (call when a share starts or stops) instead of waiting for the next poll. */
  refresh(): void;
  setOpen(open: boolean): void;
  tick(): Promise<void>;
  unread(): number;
}
export const BANNER_MS = 10_000;
export const MAX_BANNERS = 3;
const MAX_LINES = 200;
const defaultTimers: ChatTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: id => globalThis.clearTimeout(id as number),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms), clearInterval: id => globalThis.clearInterval(id as number)
};

interface Banner { id: number; node: HTMLElement; timer: unknown }

export function createChatUi(options: ChatUiOptions): ChatUi {
  const { root, role, send, poll, isSharing, onAttention } = options;
  const doc = options.doc ?? document;
  const timers = options.timers ?? defaultTimers;
  const pollMs = options.pollMs ?? 1000;
  const make = (tag: string, className: string, text?: string): HTMLElement => {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const label = (line: ChatLine): HTMLElement => {
    const name = make('strong', line.host ? 'chat-name chat-name-host' : 'chat-name', line.name);
    if (line.host) name.setAttribute('data-host', 'true');
    return name;
  };

  // History list and input.
  const log = make('div', 'chat-log');
  log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'off'); log.setAttribute('aria-label', 'Chat messages');
  const form = doc.createElement('form'); form.className = 'chat-form';
  const input = doc.createElement('input') as HTMLInputElement;
  input.type = 'text'; input.className = 'chat-input'; input.maxLength = 500;
  input.setAttribute('autocomplete', 'off'); input.setAttribute('aria-label', 'Message to everyone');
  input.setAttribute('placeholder', 'Message everyone');
  const sendButton = make('button', 'chat-send', 'Send') as HTMLButtonElement;
  sendButton.type = 'submit';
  const note = make('p', 'chat-note small status');
  note.setAttribute('role', 'status');
  form.append(input, sendButton);
  root.append(log, form, note);

  // Overlay: banner stack and the sharing badge.
  const overlay = make('div', `chat-overlay chat-overlay-${role}`);
  const stack = make('div', 'chat-banners');
  // ClaudeBWAI — einh 5 Oct: "max 3 + N more, click opens the chat" — the pill is a real button (keyboard/AT reachable) wired to openNow below.
  const more = make('button', 'chat-more'); more.hidden = true;
  (more as HTMLButtonElement).type = 'button';
  const badge = make('button', 'chat-badge'); badge.hidden = true;
  (badge as HTMLButtonElement).type = 'button';
  overlay.append(badge, stack, more);
  doc.body.append(overlay);

  let banners: Banner[] = [];
  let lastId = 0, first = true, running = false, polling = false, open = false;
  let unread = 0, badgeCount = 0, away = 0;
  const seen = new Set<number>();
  const originalTitle = doc.title;
  let interval: unknown = null;

  const setUnread = (value: number): void => { if (value !== unread) { unread = value; options.onUnread?.(unread); } };
  const dismiss = (banner: Banner): void => {
    timers.clearTimeout(banner.timer);
    banner.node.remove();
    banners = banners.filter(item => item !== banner);
    layout();
  };
  const clearBanners = (): void => { for (const banner of [...banners]) dismiss(banner); };
  function layout(): void {
    // Newest on top: banners is oldest-first, so show the last MAX_BANNERS reversed.
    const shown = banners.slice(-MAX_BANNERS).reverse();
    stack.replaceChildren(...shown.map(banner => banner.node));
    const extra = banners.length - shown.length;
    more.hidden = extra <= 0;
    more.textContent = extra > 0 ? `${extra} more` : '';
  }
  const renderBadge = (): void => {
    const show = isSharing() && badgeCount > 0;
    // Idempotent on purpose: the studio shell observes the whole body, so an unchanged write must not become a mutation.
    const textNow = show ? `${badgeCount} new message${badgeCount === 1 ? '' : 's'}` : '';
    if (badge.hidden === show) badge.hidden = !show;
    if (badge.textContent !== textNow) badge.textContent = textNow;
  };
  const openNow = (): void => { badgeCount = 0; clearBanners(); renderBadge(); options.openChat?.(); };
  badge.addEventListener('click', openNow);
  more.addEventListener('click', openNow);
  const startTimer = (banner: Banner): void => {
    timers.clearTimeout(banner.timer);
    banner.timer = timers.setTimeout(() => dismiss(banner), BANNER_MS);
  };
  const addBanner = (line: ChatLine): void => {
    const node = make('div', line.host ? 'chat-banner chat-banner-host' : 'chat-banner');
    node.setAttribute('role', 'alert'); node.setAttribute('aria-live', 'assertive');
    const close = make('button', 'chat-banner-close', '×') as HTMLButtonElement;
    close.type = 'button'; close.setAttribute('aria-label', 'Dismiss message');
    node.append(label(line), make('span', 'chat-banner-text', line.text), close);
    const banner: Banner = { id: line.id, node, timer: null };
    node.addEventListener('mouseenter', () => timers.clearTimeout(banner.timer));
    node.addEventListener('mouseleave', () => startTimer(banner));
    node.addEventListener('click', () => { dismiss(banner); options.openChat?.(); });
    close.addEventListener('click', event => { event.stopPropagation(); dismiss(banner); });
    banners.push(banner);
    startTimer(banner);
    layout();
  };
  const addLine = (line: ChatLine): void => {
    const row = make('div', line.mine ? 'chat-line chat-mine' : 'chat-line');
    row.append(label(line), make('span', 'chat-text', line.text));
    log.append(row);
    while (log.children.length > MAX_LINES) log.children[0]!.remove();
    log.scrollTop = log.scrollHeight;
  };
  const background = (): boolean => Boolean(doc.hidden);
  const signalAway = (): void => {
    if (role === 'guest') doc.title = away > 0 ? '(' + String(away) + ') New message' : originalTitle;
    onAttention(away);
  };
  const returned = (): void => {
    if (background() || away === 0) return;
    away = 0; signalAway();
  };
  doc.addEventListener('visibilitychange', returned);
  doc.defaultView?.addEventListener('focus', returned);

  const accept = (line: ChatLine, isHistory: boolean): void => {
    if (seen.has(line.id)) return;
    seen.add(line.id);
    if (line.id > lastId) lastId = line.id;
    addLine(line);
    if (isHistory || line.history || line.mine) return;
    if (!open) setUnread(unread + 1);
    if (background()) { away += 1; signalAway(); }
    if (isSharing()) { badgeCount += 1; renderBadge(); } else addBanner(line);
  };
  const refresh = (): void => {
    if (isSharing()) clearBanners(); else badgeCount = 0;
    renderBadge();
  };
  async function tick(): Promise<void> {
    if (!running || polling) return;
    polling = true;
    try {
      const result = await poll(lastId);
      if (!running || !result.ok) return;
      const isHistory = first; first = false;
      for (const line of result.messages) accept(line, isHistory);
      if (result.latestId > lastId) lastId = result.latestId;
    } catch { /* the next tick retries; nothing about the message is logged */ }
    finally { polling = false; }
    refresh();
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    sendButton.disabled = true;
    void send(text).then(result => {
      if (result.ok) {
        input.value = ''; note.textContent = '';
        if (result.message) accept({ ...result.message, mine: true }, false);
      } else note.textContent = result.reason === 'rate-limited' ? 'Slow down for a moment, then send again.' : 'That message cannot be sent. Use one line of up to 500 characters.';
    }).catch(() => { note.textContent = 'The message could not be sent. Try again.'; })
      .finally(() => { sendButton.disabled = false; });
  });
  return {
    start(): void {
      if (running) return;
      running = true; first = true; lastId = 0;
      interval = timers.setInterval(() => { void tick(); }, pollMs);
      void tick();
    },
    stop(): void {
      if (!running) return;
      running = false;
      if (interval !== null) timers.clearInterval(interval);
      interval = null;
      clearBanners(); log.replaceChildren(); seen.clear();
      lastId = 0; first = true; badgeCount = 0; away = 0; note.textContent = '';
      setUnread(0); renderBadge(); signalAway();
    },
    refresh,
    setOpen(value: boolean): void {
      open = value;
      if (value) { setUnread(0); clearBanners(); badgeCount = 0; renderBadge(); }
    },
    tick,
    unread: () => unread
  };
}
