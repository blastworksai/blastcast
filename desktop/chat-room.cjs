'use strict';
// ClaudeBWAI — einh 4-5 Oct: live chat, never saved
// Pure in-memory chat ring. No I/O, no persistence. The caller supplies the stored admitted name.

const RING_MAX = 200;
const HISTORY_MAX = 50;
const TEXT_MAX = 500;
const RATE_COUNT = 5;
const RATE_WINDOW_MS = 5000;
// Copied from desktop/admission.cjs NAME_RE (not exported there): C0, DEL, bidi embeds/overrides/isolates.
const NAME_RE = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/;
const C1_RE = /[\u0080-\u009f]/;
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function validText(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  if (NAME_RE.test(text) || C1_RE.test(text) || LONE_SURROGATE_RE.test(text)) return null;
  if ([...text].length > TEXT_MAX) return null;
  return text;
}

function createChatRoom({ now = Date.now } = {}) {
  let ring = [];
  let nextId = 1;
  const stamps = new Map(); // from -> recent send times

  function view(e, viewer) {
    return { id: e.id, at: e.at, name: e.name, text: e.text, mine: e.from === viewer, host: e.from === 'host' };
  }

  function send({ from, name, text } = {}) {
    const clean = validText(text);
    if (clean === null || typeof from !== 'string' || !from || typeof name !== 'string') {
      return { ok: false, reason: 'invalid' };
    }
    const t = now();
    const recent = (stamps.get(from) || []).filter((s) => t - s < RATE_WINDOW_MS);
    if (recent.length >= RATE_COUNT) {
      stamps.set(from, recent);
      return { ok: false, reason: 'rate-limited' };
    }
    recent.push(t);
    stamps.set(from, recent);
    const message = { id: nextId++, at: t, from, name, text: clean };
    ring.push(message);
    if (ring.length > RING_MAX) ring = ring.slice(-RING_MAX);
    return { ok: true, message: view(message, from) };
  }

  function since(id, viewer) {
    const after = Number.isFinite(id) ? id : 0;
    return ring.filter((e) => e.id > after).map((e) => view(e, viewer));
  }

  function joinHistory(viewer) {
    return ring.slice(-HISTORY_MAX).map((e) => ({ ...view(e, viewer), history: true }));
  }

  function clear() { ring = []; }
  function latestId() { return nextId - 1; }

  return { send, since, joinHistory, clear, latestId };
}

module.exports = { createChatRoom, RING_MAX, HISTORY_MAX, TEXT_MAX };
