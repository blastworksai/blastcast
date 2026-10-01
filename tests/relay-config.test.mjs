import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { parseHelper } = require('../desktop/relay-config.cjs');

function valid(overrides = {}) {
  return {
    provider: 'cloudflare',
    freeAccountConfirmed: true,
    relay: {
      urls: [
        'turn:us-1.expressturn.com:3478?transport=udp',
        'turn:us-1.expressturn.com:3478?transport=tcp',
      ],
      username: 'allocation-user',
      credential: 'allocation-secret',
      iceTransportPolicy: 'relay',
    },
    ...overrides,
  };
}

describe('parseHelper', () => {
  it('keeps absent helper mode absent', () => {
    assert.equal(parseHelper(undefined), null);
  });

  it('normalizes both helper choices and valid TURN transports', () => {
    const input = valid();
    assert.deepEqual(parseHelper(input), {
      provider: 'cloudflare',
      iceServers: [{
        urls: input.relay.urls,
        username: 'allocation-user',
        credential: 'allocation-secret',
      }],
      iceTransportPolicy: 'relay',
    });
    const local = valid({
      provider: 'localhost-run',
      relay: { ...input.relay, urls: ['turn:eu.expressturn.com:3478?transport=tcp'], iceTransportPolicy: 'all' },
    });
    assert.equal(parseHelper(local).provider, 'localhost-run');
    assert.equal(parseHelper(local).iceTransportPolicy, 'all');
  });

  it('clones URL arrays and nested output on every call', () => {
    const input = valid();
    const first = parseHelper(input);
    input.relay.urls[0] = 'turn:other.expressturn.com:3478?transport=udp';
    assert.equal(first.iceServers[0].urls[0], 'turn:us-1.expressturn.com:3478?transport=udp');
    first.iceServers[0].urls[0] = 'changed';
    assert.equal(parseHelper(input).iceServers[0].urls[0], 'turn:other.expressturn.com:3478?transport=udp');
  });

  it('rejects invalid shape, extra fields, accessors and unapproved helpers', () => {
    const bad = [null, [], 'cloudflare', valid({ provider: 'other' }),
      valid({ freeAccountConfirmed: false }), valid({ freeAccountConfirmed: 'true' }),
      valid({ adminToken: 'secret' }), valid({ relay: { ...valid().relay, secret: 'secret' } }),
      valid({ relay: null }), valid({ relay: { ...valid().relay, urls: [] } }),
      valid({ relay: { ...valid().relay, urls: [valid().relay.urls[0], valid().relay.urls[1], valid().relay.urls[0]] } }),
      valid({ relay: { ...valid().relay, urls: 'turn:x.expressturn.com:3478?transport=udp' } }),
      valid({ relay: { ...valid().relay, iceTransportPolicy: 'unknown' } }),
      Object.assign(Object.create({ inherited: true }), valid()),
      Object.defineProperty(valid(), 'provider', { get() { throw Error('secret'); }, enumerable: true }),
    ];
    for (const input of bad) assert.throws(() => parseHelper(input), /^Error: Invalid helper configuration\.$/);
  });

  it('rejects unsafe and noncanonical TURN URLs', () => {
    const bad = [
      'turn:expressturn.com:3478?transport=udp',
      'turn:evilexpressturn.com:3478?transport=udp',
      'turn:x.expressturn.com.evil.test:3478?transport=udp',
      'turn:192.0.2.1:3478?transport=udp',
      'turn:[2001:db8::1]:3478?transport=udp',
      'turn:evil@x.expressturn.com:3478?transport=udp',
      'turns:x.expressturn.com:443?transport=tcp',
      'turn:x.expressturn.com:443?transport=tcp',
      'turn:x.expressturn.com:3478',
      'turn:x.expressturn.com:3478?transport=tls',
      'turn:x.expressturn.com:3478?transport=udp&token=abc',
      'turn:x.expressturn.com:3478?transport=udp#fragment',
      'turn:x.expressturn.com:3478/path?transport=udp',
      'turn:x%2eexpressturn.com:3478?transport=udp',
      'turn:x.expressturn.com%2eexample.org:3478?transport=udp',
      'turn:x..expressturn.com:3478?transport=udp',
      'turn:-x.expressturn.com:3478?transport=udp',
      'turn:x.expressturn.com:03478?transport=udp',
      'TURN:x.expressturn.com:3478?transport=udp',
      ' turn:x.expressturn.com:3478?transport=udp',
    ];
    for (const url of bad) {
      const input = valid({ relay: { ...valid().relay, urls: [url] } });
      assert.throws(() => parseHelper(input), /^Error: Invalid helper configuration\.$/, url);
    }
  });

  it('rejects empty, oversized and multiline allocation credentials without echoing them', () => {
    for (const [field, value] of [
      ['username', ''], ['username', '  '], ['username', 'u'.repeat(129)],
      ['credential', ''], ['credential', '\nadmin-secret'],
      ['credential', 'admin-secret\r'], ['credential', 'p'.repeat(513)],
    ]) {
      const input = valid({ relay: { ...valid().relay, [field]: value } });
      assert.throws(() => parseHelper(input), /^Error: Invalid helper configuration\.$/);
    }
    assert.equal(parseHelper(valid({ relay: { ...valid().relay, username: 'u'.repeat(128), credential: 'p'.repeat(512) } })).iceServers[0].credential.length, 512);
  });
});
