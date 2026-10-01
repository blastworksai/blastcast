// CodexBWAI — explicit, bounded PCP ownership for an existing local HTTPS proxy.
const dgram = require('node:dgram');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomBytes, timingSafeEqual } = require('node:crypto');

const PCP_PORT = 5351;
const PCP_VERSION = 2;
const PCP_MAP = 1;
const PCP_TCP = 6;
const PREFER_FAILURE = 2;
const LEASE_SECONDS = 1800;
const JOURNAL_OWNER = 'BlastCast';
const JOURNAL_LIMIT = 4096;

class PcpError extends Error {
  constructor(code, message, definitive = false) {
    super(message);
    this.code = code;
    this.definitive = definitive;
  }
}

function parseIPv4(value, label = 'IPv4 address') {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}.`);
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9][0-9]{0,2})$/.test(part))) {
    throw new Error(`Invalid ${label}.`);
  }
  const bytes = parts.map(Number);
  if (bytes.some(byte => byte > 255)) throw new Error(`Invalid ${label}.`);
  return bytes;
}

function validUnicastIPv4(value, label) {
  const bytes = parseIPv4(value, label);
  if (bytes[0] === 0 || bytes[0] === 127 || bytes[0] >= 224 || bytes.every(byte => byte === 255)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function parseGatewayOutput(platform, output) {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > 4096) {
    throw new Error('Default gateway output was invalid.');
  }
  let candidates = [];
  if (platform === 'win32') {
    candidates = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  } else if (platform === 'darwin') {
    candidates = [...output.matchAll(/^\s*gateway:\s*(\S+)\s*$/gm)].map(match => match[1]);
  } else {
    candidates = [...output.matchAll(/^default\s+via\s+(\S+)\s+dev\s+\S+(?:\s|$)/gm)].map(match => match[1]);
  }
  const unique = [...new Set(candidates.map(value => validUnicastIPv4(value, 'default gateway')))];
  if (unique.length !== 1) throw new Error('BlastCast could not identify one IPv4 default gateway.');
  return unique[0];
}

function runCommand(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 2000, maxBuffer: 4096, windowsHide: true, ...options }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function discoverGateway({ platform = process.platform, execute = runCommand } = {}) {
  let output;
  if (platform === 'win32') {
    output = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric,InterfaceMetric | Select-Object -First 1 -ExpandProperty NextHop"]);
  } else if (platform === 'darwin') {
    output = await execute('/sbin/route', ['-n', 'get', 'default']);
  } else {
    output = await execute('ip', ['-4', 'route', 'show', 'default']);
  }
  return parseGatewayOutput(platform, output);
}

function localAddressForGateway(gateway, { socketFactory = () => dgram.createSocket('udp4'), pcpPort = PCP_PORT } = {}) {
  validUnicastIPv4(gateway, 'default gateway');
  return new Promise((resolve, reject) => {
    const socket = socketFactory();
    let settled = false;
    const finish = (error, address) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch {}
      if (error) reject(error);
      else resolve(address);
    };
    socket.once('error', error => finish(error));
    socket.connect(pcpPort, gateway, () => {
      try { finish(null, validUnicastIPv4(socket.address().address, 'local network address')); }
      catch (error) { finish(error); }
    });
  });
}

async function discoverNetwork(options = {}) {
  const gateway = await discoverGateway(options);
  const localAddress = await localAddressForGateway(gateway, options);
  return { gateway, localAddress };
}

function writeMappedIPv4(buffer, offset, value, allowUnspecified = false) {
  buffer.fill(0, offset, offset + 16);
  if (allowUnspecified && value === '0.0.0.0') return;
  const bytes = parseIPv4(value);
  buffer[offset + 10] = 0xff;
  buffer[offset + 11] = 0xff;
  for (let index = 0; index < 4; index++) buffer[offset + 12 + index] = bytes[index];
}

function readMappedIPv4(buffer, offset, allowUnspecified = false) {
  if (allowUnspecified && buffer.subarray(offset, offset + 16).every(byte => byte === 0)) return '0.0.0.0';
  if (buffer.subarray(offset, offset + 10).some(byte => byte !== 0) || buffer[offset + 10] !== 0xff || buffer[offset + 11] !== 0xff) {
    throw new PcpError('PCP_ADDRESS', 'Router returned an unsupported external address.');
  }
  const value = [...buffer.subarray(offset + 12, offset + 16)].join('.');
  return validUnicastIPv4(value, 'external address');
}

function validPort(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid ${label}.`);
  return value;
}

function validLifetime(value, allowZero = false) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > LEASE_SECONDS) throw new Error('Invalid PCP lifetime.');
  return value;
}

function validNonce(value) {
  if (!Buffer.isBuffer(value) || value.length !== 12) throw new Error('Invalid PCP mapping nonce.');
  return value;
}

function encodeMapRequest({ localAddress, nonce, internalPort, externalPort, externalAddress = '0.0.0.0', lifetime }) {
  parseIPv4(localAddress, 'local network address');
  validNonce(nonce);
  validPort(internalPort, 'local proxy port');
  validPort(externalPort, 'public port');
  validLifetime(lifetime, true);
  const message = Buffer.alloc(64);
  message[0] = PCP_VERSION;
  message[1] = PCP_MAP;
  message.writeUInt32BE(lifetime, 4);
  writeMappedIPv4(message, 8, localAddress);
  nonce.copy(message, 24);
  message[36] = PCP_TCP;
  message.writeUInt16BE(internalPort, 40);
  message.writeUInt16BE(externalPort, 42);
  writeMappedIPv4(message, 44, externalAddress, true);
  message[60] = PREFER_FAILURE;
  message.writeUInt16BE(0, 62);
  return message;
}

function decodeMapResponse(message, expected, operation = 'acquire') {
  if (!Buffer.isBuffer(message) || message.length < 60 || message.length > 1024) {
    throw new PcpError('PCP_RESPONSE', 'Router returned a malformed PCP response.');
  }
  validNonce(expected.nonce);
  if (message[0] !== PCP_VERSION || message[1] !== (0x80 | PCP_MAP) || message[2] !== 0 ||
      message.subarray(12, 24).some(byte => byte !== 0)) {
    throw new PcpError('PCP_RESPONSE', 'Router returned a mismatched PCP response.');
  }
  if (!timingSafeEqual(message.subarray(24, 36), expected.nonce) || message[36] !== PCP_TCP ||
      message.subarray(37, 40).some(byte => byte !== 0) ||
      message.readUInt16BE(40) !== expected.internalPort) {
    throw new PcpError('PCP_RESPONSE', 'Router returned a mismatched PCP mapping.');
  }
  const resultCode = message[3];
  if (resultCode !== 0) throw new PcpError(`PCP_RESULT_${resultCode}`, `Router refused temporary access (PCP result ${resultCode}).`, true);
  const lifetime = message.readUInt32BE(4);
  const responseExternalPort = message.readUInt16BE(42);
  const deleting = operation === 'delete';
  if (deleting ? (responseExternalPort !== 0 && responseExternalPort !== expected.externalPort) : responseExternalPort === 0) {
    throw new PcpError('PCP_RESPONSE', 'Router returned a mismatched PCP mapping.');
  }
  if (responseExternalPort !== 0) validPort(responseExternalPort, 'router external port');
  const externalAddress = readMappedIPv4(message, 44, deleting);
  if (deleting && expected.externalAddress && expected.externalAddress !== '0.0.0.0' &&
      externalAddress !== '0.0.0.0' && externalAddress !== expected.externalAddress) {
    throw new PcpError('PCP_RESPONSE', 'Router returned a mismatched PCP mapping.');
  }
  if (operation === 'delete') {
    if (lifetime !== 0) throw new PcpError('PCP_DELETE', 'Router did not confirm removal of temporary access.');
  } else if (lifetime < 1 || lifetime > expected.requestedLifetime) {
    throw new PcpError('PCP_LIFETIME', 'Router returned an invalid temporary-access lifetime.');
  }
  if (!deleting && responseExternalPort !== expected.externalPort) {
    const error = new PcpError('PCP_PORT_MISMATCH', 'Router assigned a different public port; BlastCast will remove that mapping.');
    error.mapping = { externalAddress, externalPort: responseExternalPort };
    throw error;
  }
  return { lifetime, externalAddress, externalPort: responseExternalPort, epoch: message.readUInt32BE(8) };
}

function createPcpExchange({ socketFactory = () => dgram.createSocket('udp4'), pcpPort = PCP_PORT, timeoutMs = 3000 } = {}) {
  return function exchange(request) {
    const message = encodeMapRequest({
      localAddress: request.localAddress,
      nonce: request.nonce,
      internalPort: request.internalPort,
      externalPort: request.externalPort,
      externalAddress: request.externalAddress ?? '0.0.0.0',
      lifetime: request.lifetime,
    });
    return new Promise((resolve, reject) => {
      const socket = socketFactory();
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch {}
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => finish(new PcpError('PCP_TIMEOUT', 'Router did not answer the temporary-access request.')), timeoutMs);
      socket.once('error', error => finish(new PcpError('PCP_TRANSPORT', `Temporary-access request failed: ${error.message}`)));
      socket.on('message', (response, info) => {
        if (info.address !== request.gateway || info.port !== pcpPort) return;
        try {
          finish(null, decodeMapResponse(response, {
            nonce: request.nonce,
            internalPort: request.internalPort,
            externalPort: request.externalPort,
            externalAddress: request.externalAddress,
            requestedLifetime: request.lifetime,
          }, request.operation));
        } catch (error) { finish(error); }
      });
      socket.bind(0, request.localAddress, () => {
        socket.send(message, pcpPort, request.gateway, error => {
          if (error) finish(new PcpError('PCP_TRANSPORT', `Temporary-access request failed: ${error.message}`));
        });
      });
    });
  };
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function decodeNonce(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(value)) throw new Error('Invalid direct-access journal nonce.');
  const nonce = Buffer.from(value, 'base64url');
  if (nonce.length !== 12) throw new Error('Invalid direct-access journal nonce.');
  return nonce;
}

function validateLease(value) {
  if (!exactKeys(value, ['externalAddress', 'grantedLifetimeSeconds', 'expiresAt'])) throw new Error('Invalid direct-access journal lease.');
  return {
    externalAddress: validUnicastIPv4(value.externalAddress, 'journal external address'),
    grantedLifetimeSeconds: validLifetime(value.grantedLifetimeSeconds),
    expiresAt: validTimestamp(value.expiresAt) ? value.expiresAt : (() => { throw new Error('Invalid direct-access journal expiry.'); })(),
  };
}

function validateJournal(value) {
  const common = ['schemaVersion', 'owner', 'phase', 'gateway', 'localAddress', 'internalPort', 'externalPort', 'nonce', 'conservativeExpiresAt'];
  const variants = {
    'acquire-pending': [...common, 'requestedAt', 'requestedLifetimeSeconds'],
    active: [...common, 'lease'],
    'refresh-pending': [...common, 'lease', 'requestedAt', 'requestedLifetimeSeconds'],
    'cleanup-pending': [...common, 'externalAddress'],
  };
  if (!value || !Object.hasOwn(variants, value.phase) || !exactKeys(value, variants[value.phase])) throw new Error('Invalid direct-access journal shape.');
  if (value.schemaVersion !== 1 || value.owner !== JOURNAL_OWNER) throw new Error('Invalid direct-access journal owner.');
  const journal = {
    schemaVersion: 1,
    owner: JOURNAL_OWNER,
    phase: value.phase,
    gateway: validUnicastIPv4(value.gateway, 'journal gateway'),
    localAddress: validUnicastIPv4(value.localAddress, 'journal local address'),
    internalPort: validPort(value.internalPort, 'journal local proxy port'),
    externalPort: validPort(value.externalPort, 'journal public port'),
    nonce: value.nonce,
    conservativeExpiresAt: value.conservativeExpiresAt,
  };
  decodeNonce(value.nonce);
  if (!validTimestamp(value.conservativeExpiresAt)) throw new Error('Invalid direct-access journal expiry.');
  if (value.phase === 'active' || value.phase === 'refresh-pending') journal.lease = validateLease(value.lease);
  if (value.phase === 'acquire-pending' || value.phase === 'refresh-pending') {
    if (!validTimestamp(value.requestedAt)) throw new Error('Invalid direct-access journal request time.');
    journal.requestedAt = value.requestedAt;
    journal.requestedLifetimeSeconds = validLifetime(value.requestedLifetimeSeconds);
  }
  if (value.phase === 'cleanup-pending') {
    journal.externalAddress = value.externalAddress === null ? null : validUnicastIPv4(value.externalAddress, 'journal external address');
  }
  if (value.phase === 'acquire-pending' && value.conservativeExpiresAt !== value.requestedAt + value.requestedLifetimeSeconds * 1000) {
    throw new Error('Invalid direct-access acquisition expiry.');
  }
  if (value.phase === 'active' && value.conservativeExpiresAt !== value.lease.expiresAt) {
    throw new Error('Invalid direct-access active expiry.');
  }
  if (value.phase === 'refresh-pending' && value.conservativeExpiresAt !== Math.max(value.lease.expiresAt, value.requestedAt + value.requestedLifetimeSeconds * 1000)) {
    throw new Error('Invalid direct-access refresh expiry.');
  }
  return journal;
}

async function atomicWriteJournal(file, journal, io = fs, random = randomBytes) {
  const validated = validateJournal(journal);
  const parent = path.dirname(file);
  await io.mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${path.basename(file)}.${random(8).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await io.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(validated)}\n`, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await io.rename(temporary, file);
    await io.chmod(file, 0o600);
    try { const directory = await io.open(parent, 'r'); await directory.sync(); await directory.close(); } catch {}
  } catch (error) {
    try { await handle?.close(); } catch {}
    try { await io.unlink(temporary); } catch {}
    throw error;
  }
}

async function readJournal(file, io = fs) {
  let stat;
  try { stat = await io.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > JOURNAL_LIMIT) throw new Error('Direct-access journal is not a safe regular file.');
  const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
  const handle = await io.open(file, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== stat.size || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('Direct-access journal changed while opening.');
    const text = await handle.readFile('utf8');
    if (Buffer.byteLength(text, 'utf8') > JOURNAL_LIMIT) throw new Error('Direct-access journal is too large.');
    return validateJournal(JSON.parse(text));
  } finally { await handle.close(); }
}

function parseProposalInput(input) {
  if (!exactKeys(input, ['generation', 'guestTarget', 'origin']) || !Number.isSafeInteger(input.generation) || input.generation < 0 ||
      typeof input.guestTarget !== 'string' || !/^127\.0\.0\.1:(?:[1-9][0-9]{0,4})$/.test(input.guestTarget)) {
    throw new Error('Current direct-route details are invalid.');
  }
  const targetPort = Number(input.guestTarget.slice(input.guestTarget.lastIndexOf(':') + 1));
  validPort(targetPort, 'guest listener port');
  let url;
  try { url = new URL(input.origin); } catch { throw new Error('Current HTTPS origin is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Current HTTPS origin is invalid.');
  const proxyPort = url.port ? Number(url.port) : 443;
  validPort(proxyPort, 'HTTPS proxy port');
  return { generation: input.generation, guestTarget: input.guestTarget, proxyPort };
}

function createDirectAccess({
  journalPath,
  discover = discoverNetwork,
  exchange = createPcpExchange(),
  io = fs,
  now = Date.now,
  random = randomBytes,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  beforeLeaseCleanup = async () => {},
} = {}) {
  if (typeof journalPath !== 'string' || !path.isAbsolute(journalPath)) throw new Error('Direct-access journal path must be absolute.');
  let current = { ok: true, phase: 'idle', plan: null, lease: null, message: 'No router change made.' };
  let journal = null;
  let timer = null;
  let busy = false;
  let idleWaiters = [];
  let unsafeJournal = false;
  let cleanupAttempted = false;

  const publicPlan = plan => plan ? { ...plan } : null;
  const publicLease = lease => lease ? { externalAddress: lease.externalAddress, externalPort: lease.externalPort, expiresAt: lease.expiresAt } : null;
  const output = () => ({ ...current, plan: publicPlan(current.plan), lease: publicLease(current.lease) });
  const cancelRefresh = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const unlock = () => {
    busy = false;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };
  const waitUntilIdle = () => busy ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve();
  const nonceFor = value => decodeNonce(value.nonce);
  const requestFor = (value, operation, lifetime) => ({
    gateway: value.gateway,
    localAddress: value.localAddress,
    nonce: nonceFor(value),
    internalPort: value.internalPort,
    externalPort: value.externalPort,
    externalAddress: value.phase === 'active' || value.phase === 'refresh-pending' ? value.lease.externalAddress : value.externalAddress ?? '0.0.0.0',
    lifetime,
    operation,
  });
  const cleanupRecord = (value, conservativeExpiresAt = value.conservativeExpiresAt) => ({
    schemaVersion: 1, owner: JOURNAL_OWNER, phase: 'cleanup-pending',
    gateway: value.gateway, localAddress: value.localAddress,
    internalPort: value.internalPort, externalPort: value.externalPort,
    nonce: value.nonce, conservativeExpiresAt,
    externalAddress: value.phase === 'active' || value.phase === 'refresh-pending' ? value.lease.externalAddress : value.externalAddress ?? null,
  });
  const withResponseMapping = (value, error) => {
    if (!error?.mapping) return value;
    if (value.phase === 'active' || value.phase === 'refresh-pending') {
      return { ...value, externalPort: error.mapping.externalPort,
        lease: { ...value.lease, externalAddress: error.mapping.externalAddress } };
    }
    return { ...value, externalPort: error.mapping.externalPort, externalAddress: error.mapping.externalAddress };
  };
  const removeJournal = async () => {
    try { await io.unlink(journalPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    journal = null;
  };

  async function attemptCleanup(message) {
    cancelRefresh();
    if (!journal) { current = { ok: true, phase: 'idle', plan: null, lease: null, message: 'No router change made.' }; return output(); }
    if (now() >= journal.conservativeExpiresAt) {
      await removeJournal();
      cleanupAttempted = false;
      current = { ok: true, phase: 'idle', plan: null, lease: null, message: 'The temporary router access has expired.' };
      return output();
    }
    journal = cleanupRecord(journal);
    await atomicWriteJournal(journalPath, journal, io, random);
    try {
      cleanupAttempted = true;
      await exchange(requestFor(journal, 'delete', 0));
      await removeJournal();
      cleanupAttempted = false;
      current = { ok: true, phase: 'idle', plan: null, lease: null, message };
    } catch {
      const lease = journal.externalAddress ? { externalAddress: journal.externalAddress, externalPort: journal.externalPort, expiresAt: journal.conservativeExpiresAt } : null;
      current = { ok: false, phase: 'cleanup-pending', plan: current.plan, lease,
        message: `BlastCast could not confirm removal. Guest service is off and this app-owned lease expires by ${new Date(journal.conservativeExpiresAt).toISOString()}.` };
    }
    return output();
  }

  function scheduleRefresh(active) {
    cancelRefresh();
    const delay = Math.max(1000, Math.floor(active.lease.grantedLifetimeSeconds * 500));
    timer = setTimer(() => { timer = null; void refresh(); }, delay);
  }

  async function refresh() {
    if (busy || !journal || journal.phase !== 'active' || current.phase !== 'active') return;
    busy = true;
    const old = journal;
    const requestedAt = now();
    const requestedExpiry = requestedAt + LEASE_SECONDS * 1000;
    journal = { ...old, phase: 'refresh-pending', requestedAt, requestedLifetimeSeconds: LEASE_SECONDS,
      conservativeExpiresAt: Math.max(old.conservativeExpiresAt, requestedExpiry) };
    try {
      await atomicWriteJournal(journalPath, journal, io, random);
      const result = await exchange(requestFor(journal, 'refresh', LEASE_SECONDS));
      const expiresAt = now() + result.lifetime * 1000;
      journal = { schemaVersion: 1, owner: JOURNAL_OWNER, phase: 'active', gateway: old.gateway,
        localAddress: old.localAddress, internalPort: old.internalPort, externalPort: old.externalPort,
        nonce: old.nonce, conservativeExpiresAt: expiresAt,
        lease: { externalAddress: result.externalAddress, grantedLifetimeSeconds: result.lifetime, expiresAt } };
      await atomicWriteJournal(journalPath, journal, io, random);
      current = { ok: true, phase: 'active', plan: current.plan,
        lease: { externalAddress: result.externalAddress, externalPort: old.externalPort, expiresAt },
        message: 'Temporary router access is active. Complete the outside-network check before sharing invitations.' };
      scheduleRefresh(journal);
    } catch (error) {
      const conservative = error.definitive ? old.conservativeExpiresAt : Math.max(old.conservativeExpiresAt, requestedExpiry);
      try { await beforeLeaseCleanup(); } catch {}
      journal = cleanupRecord(withResponseMapping(journal, error), conservative);
      await atomicWriteJournal(journalPath, journal, io, random);
      await attemptCleanup('Temporary router access was removed after its refresh failed.');
    } finally { unlock(); }
  }

  return {
    status: output,
    async recover() {
      if (busy) return { ok: false, phase: 'blocked', plan: null, lease: null, message: 'A temporary-access action is already in progress.' };
      busy = true;
      try {
        try { journal = await readJournal(journalPath, io); }
        catch (error) {
          unsafeJournal = true;
          current = { ok: false, phase: 'blocked', plan: null, lease: null,
            message: `BlastCast cannot safely read its temporary-access journal: ${error.message}` };
          return output();
        }
        if (!journal) return output();
        cleanupAttempted = false;
        current = { ok: false, phase: 'cleanup-pending', plan: null, lease: null, message: 'Cleaning up temporary router access from an earlier run.' };
        return await attemptCleanup('Temporary router access from the earlier run was removed.');
      } finally { unlock(); }
    },
    async prepare(input) {
      if (busy) return { ok: false, phase: 'blocked', plan: current.plan, lease: current.lease, message: 'A temporary-access action is already in progress.' };
      if (unsafeJournal) return output();
      if (journal) return { ok: false, phase: 'cleanup-pending', plan: current.plan, lease: current.lease, message: current.message };
      busy = true;
      try {
        const parsed = parseProposalInput(input);
        const network = await discover();
        const plan = {
          generation: parsed.generation,
          gateway: validUnicastIPv4(network.gateway, 'default gateway'),
          localAddress: validUnicastIPv4(network.localAddress, 'local network address'),
          transport: 'TCP', protocol: 'PCP', publicPort: parsed.proxyPort, localProxyPort: parsed.proxyPort,
          guestTarget: parsed.guestTarget, requestedLifetimeSeconds: LEASE_SECONDS,
        };
        current = { ok: true, phase: 'planned', plan, lease: null,
          message: 'No router change made. Review the exact temporary access, then approve it if it is correct.' };
        return output();
      } catch (error) {
        current = { ok: false, phase: 'blocked', plan: null, lease: null, message: error.message };
        return output();
      } finally { unlock(); }
    },
    async approve() {
      if (busy || unsafeJournal || current.phase !== 'planned' || !current.plan || journal) {
        return { ok: false, phase: current.phase === 'cleanup-pending' ? 'cleanup-pending' : 'blocked', plan: current.plan, lease: current.lease,
          message: busy ? 'A temporary-access action is already in progress.' : 'Show the current temporary access before approving it.' };
      }
      busy = true;
      const plan = current.plan;
      const nonce = random(12);
      const requestedAt = now();
      journal = { schemaVersion: 1, owner: JOURNAL_OWNER, phase: 'acquire-pending',
        gateway: plan.gateway, localAddress: plan.localAddress,
        internalPort: plan.localProxyPort, externalPort: plan.publicPort,
        nonce: nonce.toString('base64url'), requestedAt, requestedLifetimeSeconds: LEASE_SECONDS,
        conservativeExpiresAt: requestedAt + LEASE_SECONDS * 1000 };
      cleanupAttempted = false;
      try {
        await atomicWriteJournal(journalPath, journal, io, random);
        const result = await exchange(requestFor(journal, 'acquire', LEASE_SECONDS));
        const expiresAt = now() + result.lifetime * 1000;
        journal = { schemaVersion: 1, owner: JOURNAL_OWNER, phase: 'active', gateway: plan.gateway,
          localAddress: plan.localAddress, internalPort: plan.localProxyPort, externalPort: plan.publicPort,
          nonce: nonce.toString('base64url'), conservativeExpiresAt: expiresAt,
          lease: { externalAddress: result.externalAddress, grantedLifetimeSeconds: result.lifetime, expiresAt } };
        await atomicWriteJournal(journalPath, journal, io, random);
        current = { ok: true, phase: 'active', plan,
          lease: { externalAddress: result.externalAddress, externalPort: plan.publicPort, expiresAt },
          message: 'Temporary router access is active. Complete the outside-network check before sharing invitations.' };
        scheduleRefresh(journal);
        return output();
      } catch (error) {
        if (error.definitive) {
          await removeJournal();
          current = { ok: false, phase: 'blocked', plan, lease: null, message: error.message };
          return output();
        }
        try { await beforeLeaseCleanup(); } catch {}
        journal = cleanupRecord(withResponseMapping(journal, error));
        await atomicWriteJournal(journalPath, journal, io, random);
        current = { ok: false, phase: 'cleanup-pending', plan, lease: null, message: error.message };
        return await attemptCleanup('The unconfirmed temporary-access attempt was removed.');
      } finally { unlock(); }
    },
    async stop() {
      while (busy) await waitUntilIdle();
      if (unsafeJournal) return output();
      if (journal && current.phase === 'cleanup-pending' && cleanupAttempted && now() < journal.conservativeExpiresAt) return output();
      busy = true;
      try {
        if (!journal) {
          cancelRefresh();
          current = { ok: true, phase: 'idle', plan: null, lease: null, message: 'No router change made.' };
          return output();
        }
        return await attemptCleanup('Temporary router access was removed.');
      } finally { unlock(); }
    },
  };
}

module.exports = {
  LEASE_SECONDS,
  PCP_PORT,
  PcpError,
  atomicWriteJournal,
  createDirectAccess,
  createPcpExchange,
  decodeMapResponse,
  discoverGateway,
  discoverNetwork,
  encodeMapRequest,
  localAddressForGateway,
  parseGatewayOutput,
  parseProposalInput,
  readJournal,
  validateJournal,
};
