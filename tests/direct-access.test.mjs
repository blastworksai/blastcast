import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  LEASE_SECONDS,
  PcpError,
  atomicWriteJournal,
  createDirectAccess,
  createPcpExchange,
  decodeMapResponse,
  encodeMapRequest,
  parseGatewayOutput,
  readJournal,
  validateJournal,
} = require('../desktop/direct-access.cjs');

function mappedIPv4(buffer, offset, value) {
  buffer.fill(0, offset, offset + 16);
  buffer[offset + 10] = 0xff;
  buffer[offset + 11] = 0xff;
  value.split('.').map(Number).forEach((byte, index) => { buffer[offset + 12 + index] = byte; });
}

function responseFor(request, { result = 0, lifetime = request.readUInt32BE(4), externalAddress = '203.0.113.8', externalPort = request.readUInt16BE(42) } = {}) {
  const response = Buffer.alloc(60);
  response[0] = 2;
  response[1] = 0x81;
  response[3] = result;
  response.writeUInt32BE(lifetime, 4);
  response.writeUInt32BE(42, 8);
  request.copy(response, 24, 24, 42);
  response.writeUInt16BE(externalPort, 42);
  mappedIPv4(response, 44, externalAddress);
  return response;
}

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-direct-access-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, journalPath: path.join(root, 'direct-access-lease.json') };
}

const proposal = { origin: 'https://guests.example.com', generation: 7, guestTarget: '127.0.0.1:43821' };
const network = async () => ({ gateway: '192.168.1.1', localAddress: '192.168.1.20' });

test('gateway parsing accepts one canonical IPv4 default and rejects ambiguity or unsafe addresses', () => {
  assert.equal(parseGatewayOutput('win32', '192.168.1.1\r\n'), '192.168.1.1');
  assert.equal(parseGatewayOutput('darwin', '   route to: default\n gateway: 10.0.0.1\ninterface: en0\n'), '10.0.0.1');
  assert.equal(parseGatewayOutput('linux', 'default via 172.16.0.1 dev eth0 proto dhcp\n'), '172.16.0.1');
  assert.throws(() => parseGatewayOutput('win32', '192.168.1.1\n10.0.0.1\n'), /one IPv4/);
  assert.throws(() => parseGatewayOutput('darwin', 'gateway: 127.0.0.1\n'), /Invalid default gateway/);
  assert.throws(() => parseGatewayOutput('linux', 'default via 192.168.001.1 dev eth0\n'), /Invalid default gateway/);
});

test('PCP MAP request has the exact v2 TCP tuple and PREFER_FAILURE option', () => {
  const nonce = Buffer.from('00112233445566778899aabb', 'hex');
  const request = encodeMapRequest({ localAddress: '192.168.1.20', nonce, internalPort: 443, externalPort: 443, lifetime: LEASE_SECONDS });
  assert.equal(request.length, 64);
  assert.equal(request[0], 2);
  assert.equal(request[1], 1);
  assert.equal(request.readUInt32BE(4), 1800);
  assert.deepEqual(request.subarray(18, 24), Buffer.from([0xff, 0xff, 192, 168, 1, 20]));
  assert.deepEqual(request.subarray(24, 36), nonce);
  assert.equal(request[36], 6);
  assert.equal(request.readUInt16BE(40), 443);
  assert.equal(request.readUInt16BE(42), 443);
  assert.ok(request.subarray(44, 60).every(byte => byte === 0));
  assert.deepEqual([...request.subarray(60)], [2, 0, 0, 0]);
});

test('PCP response validation separates positive leases from zero-lifetime deletion', () => {
  const nonce = randomBytes(12);
  const request = encodeMapRequest({ localAddress: '192.168.1.20', nonce, internalPort: 443, externalPort: 443, lifetime: 1800 });
  const expected = { nonce, internalPort: 443, externalPort: 443, requestedLifetime: 1800 };
  assert.deepEqual(decodeMapResponse(responseFor(request), expected), {
    lifetime: 1800, externalAddress: '203.0.113.8', externalPort: 443, epoch: 42,
  });
  assert.throws(() => decodeMapResponse(responseFor(request, { lifetime: 0 }), expected), /lifetime/);
  assert.deepEqual(decodeMapResponse(responseFor(request, { lifetime: 0 }), { ...expected, requestedLifetime: 0 }, 'delete').lifetime, 0);
  const zeroDelete = responseFor(request, { lifetime: 0, externalPort: 0 });
  zeroDelete.fill(0, 44, 60);
  assert.equal(decodeMapResponse(zeroDelete, { ...expected, requestedLifetime: 0 }, 'delete').externalPort, 0);
  assert.throws(() => decodeMapResponse(responseFor(request, { lifetime: 0, externalPort: 444 }),
    { ...expected, requestedLifetime: 0 }, 'delete'), /mismatched/);
  assert.throws(() => decodeMapResponse(responseFor(request), expected, 'delete'), /removal/);
  assert.throws(() => decodeMapResponse(responseFor(request, { externalPort: 444 }), expected), error =>
    error.code === 'PCP_PORT_MISMATCH' && error.mapping.externalPort === 444 && error.mapping.externalAddress === '203.0.113.8');
  const wrongNonce = responseFor(request); wrongNonce[24] ^= 1;
  assert.throws(() => decodeMapResponse(wrongNonce, expected), /mismatched/);
  const refused = responseFor(request, { result: 2 });
  assert.throws(() => decodeMapResponse(refused, expected), error => error.code === 'PCP_RESULT_2' && error.definitive === true);
});

test('real loopback UDP exchange validates the sender and removes only its nonce tuple', async t => {
  const server = dgram.createSocket('udp4');
  const packets = [];
  const mappings = new Map([['unrelated', { externalPort: 8443 }]]);
  server.on('message', (message, info) => {
    packets.push(Buffer.from(message));
    const nonce = message.subarray(24, 36).toString('hex');
    const lifetime = message.readUInt32BE(4);
    if (lifetime === 0) mappings.delete(nonce);
    else mappings.set(nonce, { externalPort: message.readUInt16BE(42) });
    server.send(responseFor(message, { lifetime }), info.port, info.address);
  });
  await new Promise(resolve => server.bind(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const exchange = createPcpExchange({ pcpPort: port, timeoutMs: 1000 });
  const nonce = randomBytes(12);
  const base = { gateway: '127.0.0.1', localAddress: '127.0.0.1', nonce, internalPort: 443, externalPort: 443, externalAddress: '0.0.0.0' };
  const acquired = await exchange({ ...base, lifetime: 1800, operation: 'acquire' });
  assert.equal(acquired.externalPort, 443);
  assert.equal(mappings.has(nonce.toString('hex')), true);
  await exchange({ ...base, externalAddress: acquired.externalAddress, lifetime: 0, operation: 'delete' });
  assert.equal(packets.length, 2);
  assert.deepEqual(packets[0].subarray(24, 36), packets[1].subarray(24, 36));
  assert.equal(mappings.has(nonce.toString('hex')), false);
  assert.deepEqual(mappings.get('unrelated'), { externalPort: 8443 });
});

test('an alternate-port grant is journaled and removed by its exact assigned tuple', async t => {
  const { journalPath } = await temporary(t);
  const localAddress = Object.values(os.networkInterfaces()).flat().find(address =>
    address?.family === 'IPv4' && !address.internal)?.address;
  if (!localAddress) return t.skip('no non-loopback IPv4 interface available');
  const server = dgram.createSocket('udp4');
  const packets = [];
  server.on('message', (message, info) => {
    packets.push(Buffer.from(message));
    const lifetime = message.readUInt32BE(4);
    server.send(responseFor(message, { lifetime, externalPort: 444 }), info.port, info.address);
  });
  await new Promise(resolve => server.bind(0, localAddress, resolve));
  t.after(() => server.close());
  const manager = createDirectAccess({ journalPath,
    discover: async () => ({ gateway: localAddress, localAddress }),
    exchange: createPcpExchange({ pcpPort: server.address().port, timeoutMs: 1000 }) });
  await manager.prepare(proposal);
  const result = await manager.approve();
  assert.equal(result.phase, 'idle');
  assert.deepEqual(packets.map(packet => [packet.readUInt32BE(4), packet.readUInt16BE(42)]), [[1800, 443], [0, 444]]);
  assert.deepEqual([...packets[1].subarray(56, 60)], [203, 0, 113, 8]);
  assert.equal(await fs.access(journalPath).then(() => true, () => false), false);
});

test('journal variants are strict, atomic, private, and reject link-backed input', async t => {
  const { root, journalPath } = await temporary(t);
  const record = {
    schemaVersion: 1, owner: 'BlastCast', phase: 'acquire-pending', gateway: '192.168.1.1', localAddress: '192.168.1.20',
    internalPort: 443, externalPort: 443, nonce: randomBytes(12).toString('base64url'),
    conservativeExpiresAt: 1_800_000, requestedAt: 0, requestedLifetimeSeconds: 1800,
  };
  await atomicWriteJournal(journalPath, record);
  assert.deepEqual(await readJournal(journalPath), record);
  if (process.platform !== 'win32') assert.equal((await fs.stat(journalPath)).mode & 0o777, 0o600);
  assert.throws(() => validateJournal({ ...record, surprise: true }), /shape/);
  assert.throws(() => validateJournal({ ...record, nonce: 'short' }), /nonce/);
  assert.throws(() => validateJournal({ ...record, conservativeExpiresAt: 1_799_999 }), /acquisition expiry/);
  const target = path.join(root, 'target.json');
  await fs.rename(journalPath, target);
  await fs.symlink(target, journalPath);
  await assert.rejects(readJournal(journalPath), /safe regular file/);
});

test('proposal is read-only, immutable outside the manager, and approval journals before sending', async t => {
  const { journalPath } = await temporary(t);
  const operations = [];
  const exchange = async request => {
    operations.push({ ...request, nonce: Buffer.from(request.nonce) });
    assert.equal((await readJournal(journalPath)).phase, request.operation === 'acquire' ? 'acquire-pending' : 'cleanup-pending');
    return { lifetime: request.lifetime, externalAddress: '203.0.113.8', externalPort: request.externalPort };
  };
  let timer;
  const manager = createDirectAccess({ journalPath, discover: network, exchange, now: () => 10_000,
    setTimer: fn => { timer = fn; return 1; }, clearTimer: () => { timer = null; } });
  const planned = await manager.prepare(proposal);
  assert.equal(planned.phase, 'planned');
  assert.equal(operations.length, 0);
  assert.equal(await fs.access(journalPath).then(() => true, () => false), false);
  planned.plan.publicPort = 9443;
  const active = await manager.approve();
  assert.equal(active.phase, 'active');
  assert.equal(operations[0].externalPort, 443);
  assert.equal((await readJournal(journalPath)).phase, 'active');
  assert.equal(typeof timer, 'function');
  const stopped = await manager.stop();
  assert.equal(stopped.phase, 'idle');
  assert.deepEqual(operations.map(operation => operation.operation), ['acquire', 'delete']);
  assert.deepEqual(operations[0].nonce, operations[1].nonce);
  assert.equal(await fs.access(journalPath).then(() => true, () => false), false);
});

test('definitive refusal clears intent while ambiguous acquisition keeps cleanup ownership', async t => {
  const first = await temporary(t);
  const refused = createDirectAccess({ journalPath: first.journalPath, discover: network,
    exchange: async () => { throw new PcpError('PCP_RESULT_2', 'Router refused.', true); } });
  await refused.prepare(proposal);
  assert.equal((await refused.approve()).phase, 'blocked');
  assert.equal(await fs.access(first.journalPath).then(() => true, () => false), false);

  const second = path.join(first.root, 'ambiguous.json');
  const calls = [];
  const ambiguous = createDirectAccess({ journalPath: second, discover: network, exchange: async request => {
    calls.push(request.operation);
    throw new PcpError('PCP_TIMEOUT', 'No answer.');
  } });
  await ambiguous.prepare(proposal);
  const pending = await ambiguous.approve();
  assert.equal(pending.phase, 'cleanup-pending');
  assert.deepEqual(calls, ['acquire', 'delete']);
  assert.equal((await readJournal(second)).phase, 'cleanup-pending');
});

test('refresh failure stops the owned lifecycle, attempts one delete, and does not retry', async t => {
  const { journalPath } = await temporary(t);
  const calls = [];
  let timerCallback;
  let cleanupCalls = 0;
  const manager = createDirectAccess({ journalPath, discover: network,
    exchange: async request => {
      calls.push(request.operation);
      if (request.operation === 'refresh') throw new PcpError('PCP_RESULT_8', 'Router refused refresh.', true);
      return { lifetime: request.lifetime, externalAddress: '203.0.113.8', externalPort: request.externalPort };
    },
    setTimer: callback => { timerCallback = callback; return 1; }, clearTimer: () => {},
    beforeLeaseCleanup: async () => { cleanupCalls++; },
  });
  await manager.prepare(proposal);
  await manager.approve();
  timerCallback();
  for (let count = 0; count < 100 && manager.status().phase === 'active'; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(manager.status().phase, 'idle');
  assert.deepEqual(calls, ['acquire', 'refresh', 'delete']);
  assert.equal(cleanupCalls, 1);
  assert.equal(await fs.access(journalPath).then(() => true, () => false), false);
});

test('startup recovery expires old intent locally and deletes an unexpired exact tuple once', async t => {
  const { root, journalPath } = await temporary(t);
  const base = {
    schemaVersion: 1, owner: 'BlastCast', phase: 'acquire-pending', gateway: '192.168.1.1', localAddress: '192.168.1.20',
    internalPort: 443, externalPort: 443, nonce: randomBytes(12).toString('base64url'), requestedAt: 0,
    requestedLifetimeSeconds: 1, conservativeExpiresAt: 1000,
  };
  await atomicWriteJournal(journalPath, base);
  let exchanges = 0;
  const expired = createDirectAccess({ journalPath, now: () => 1001, exchange: async () => { exchanges++; } });
  assert.equal((await expired.recover()).phase, 'idle');
  assert.equal(exchanges, 0);

  const livePath = path.join(root, 'live.json');
  await atomicWriteJournal(livePath, { ...base, requestedLifetimeSeconds: 10, conservativeExpiresAt: 10_000 });
  let operation;
  const live = createDirectAccess({ journalPath: livePath, now: () => 5000, exchange: async request => {
    operation = request.operation;
    assert.equal((await readJournal(livePath)).phase, 'cleanup-pending');
    return { lifetime: 0, externalAddress: '203.0.113.8', externalPort: 443 };
  } });
  assert.equal((await live.recover()).phase, 'idle');
  assert.equal(operation, 'delete');
  assert.equal(await fs.access(livePath).then(() => true, () => false), false);
});

test('cleanup failure keeps the conservative journal and blocks a new proposal', async t => {
  const { journalPath } = await temporary(t);
  let deletes = 0;
  const manager = createDirectAccess({ journalPath, discover: network, exchange: async request => {
    if (request.operation === 'delete') { deletes++; throw new PcpError('PCP_TIMEOUT', 'No delete response.'); }
    return { lifetime: 1800, externalAddress: '203.0.113.8', externalPort: 443 };
  } });
  await manager.prepare(proposal);
  await manager.approve();
  assert.equal((await manager.stop()).phase, 'cleanup-pending');
  assert.equal((await manager.stop()).phase, 'cleanup-pending');
  assert.equal(deletes, 1);
  assert.equal((await readJournal(journalPath)).phase, 'cleanup-pending');
  assert.equal((await manager.prepare(proposal)).phase, 'cleanup-pending');
});

test('stop waits for an in-flight approval and then deletes the granted lease', async t => {
  const { journalPath } = await temporary(t);
  const calls = [];
  let releaseAcquire;
  const acquireGate = new Promise(resolve => { releaseAcquire = resolve; });
  const manager = createDirectAccess({ journalPath, discover: network, exchange: async request => {
    calls.push(request.operation);
    if (request.operation === 'acquire') await acquireGate;
    return { lifetime: request.lifetime, externalAddress: '203.0.113.8', externalPort: 443 };
  } });
  await manager.prepare(proposal);
  const approving = manager.approve();
  while (calls.length === 0) await new Promise(resolve => setTimeout(resolve, 1));
  let stopped = false;
  const stopping = manager.stop().then(value => { stopped = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(stopped, false);
  releaseAcquire();
  assert.equal((await approving).phase, 'active');
  assert.equal((await stopping).phase, 'idle');
  assert.deepEqual(calls, ['acquire', 'delete']);
});

test('an unsafe journal stays in place and blocks stop or a new proposal', async t => {
  const { journalPath } = await temporary(t);
  await fs.writeFile(journalPath, '{"owner":"someone-else"}\n');
  const manager = createDirectAccess({ journalPath, discover: network });
  assert.equal((await manager.recover()).phase, 'blocked');
  assert.equal((await manager.stop()).phase, 'blocked');
  assert.equal((await manager.prepare(proposal)).phase, 'blocked');
  assert.equal(await fs.readFile(journalPath, 'utf8'), '{"owner":"someone-else"}\n');
});
