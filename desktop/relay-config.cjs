// CodexBWAI — bounded host-owned allocation configuration, no provider I/O.
'use strict';

const INVALID = 'Invalid helper configuration.';
const URL_PATTERN = /^turn:([a-z0-9.-]+):3478\?transport=(?:udp|tcp)$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function fail() {
  throw new Error(INVALID);
}

function exactObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) fail();
  const data = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail();
    data[key] = descriptor.value;
  }
  return data;
}

function validUrl(value) {
  if (typeof value !== 'string' || value.length > 300) fail();
  const match = URL_PATTERN.exec(value);
  if (!match) fail();
  const host = match[1];
  if (host.length > 253) fail();
  const labels = host.split('.');
  if (labels.length < 3 || labels.at(-2) !== 'expressturn' || labels.at(-1) !== 'com') fail();
  if (!labels.every((label) => DNS_LABEL.test(label))) fail();
  return value;
}

function validCredential(value, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength ||
      value.trim().length === 0 || /[\r\n]/.test(value)) fail();
  return value;
}

function parseHelper(input) {
  if (input === undefined) return null;
  try {
    const helper = exactObject(input, ['provider', 'freeAccountConfirmed', 'relay']);
    if (helper.provider !== 'cloudflare' && helper.provider !== 'localhost-run') fail();
    if (helper.freeAccountConfirmed !== true) fail();
    const relay = exactObject(helper.relay, ['urls', 'username', 'credential', 'iceTransportPolicy']);
    if (!Array.isArray(relay.urls) || Object.getPrototypeOf(relay.urls) !== Array.prototype ||
        relay.urls.length < 1 || relay.urls.length > 2) fail();
    const urls = [];
    for (let index = 0; index < relay.urls.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(relay.urls, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail();
      urls.push(validUrl(descriptor.value));
    }
    if (Reflect.ownKeys(relay.urls).length !== urls.length + 1 || new Set(urls).size !== urls.length) fail();
    const username = validCredential(relay.username, 128);
    const credential = validCredential(relay.credential, 512);
    if (relay.iceTransportPolicy !== 'all' && relay.iceTransportPolicy !== 'relay') fail();
    return {
      provider: helper.provider,
      iceServers: [{ urls, username, credential }],
      iceTransportPolicy: relay.iceTransportPolicy,
    };
  } catch {
    // Never reflect rejected allocation data or an accessor's message to callers.
    fail();
  }
}

module.exports = { parseHelper };
