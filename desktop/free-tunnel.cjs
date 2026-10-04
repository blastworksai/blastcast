// CodexBWAI — owned localhost.run OpenSSH child; no user credentials/configuration.
const { spawn: spawnChild } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const MAX_OUTPUT = 65536;
const START_TIMEOUT_MS = 30000;
const STOP_TIMEOUT_MS = 2000;

function parseOrigin(line) {
  if (typeof line !== 'string' || line.length > 1024 || /[\x00-\x1f\x7f]/.test(line)) return null;
  // Match the provider's tunnel announcement, never its documentation/admin links.
  const match = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:localhost\.run|lhr\.life)) tunneled with tls termination, (https:\/\/[^\s]+)$/.exec(line.trim());
  if (!match || match[2] !== `https://${match[1]}`) return null;
  return match[2];
}

// ClaudeBWAI — required pinned localhost.run host key, shipped with the app (never fetched at run time).
const SHIPPED_KNOWN_HOSTS = path.join(__dirname, '..', 'assets', 'localhost-run-known-hosts.txt');
async function pinnedHostsFile(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 16384) return null;
    return (await fs.readFile(file, 'utf8')).trim() ? file : null;
  } catch { return null; }
}

function createFreeTunnel({ directory, spawn = spawnChild, platform = process.platform, onLost = () => {},
  shippedKnownHosts = SHIPPED_KNOWN_HOSTS, startupTimeoutMs = START_TIMEOUT_MS, stopTimeoutMs = STOP_TIMEOUT_MS } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\x00-\x1f\x7f%]/.test(directory) || directory.includes('${')) throw new Error('A private absolute tunnel directory is required.');
  let active = null, generation = 0;
  let current = { phase: 'off', message: 'Guest tunnel is off.', origin: null };
  const status = () => ({ ...current });
  const notifyLost = () => { const message = current.message; Promise.resolve().then(() => onLost(message)).catch(() => {}); };
  function settle(run, result) { if (run.resolve) { const resolve = run.resolve; run.resolve = null; clearTimeout(run.startTimer); resolve(result); } }
  function release(run) {
    clearTimeout(run.startTimer); clearTimeout(run.killTimer); clearTimeout(run.stopTimer);
    run.closed = true;
    if (active === run) active = null;
    run.stopResolve?.({ ok: true }); run.stopResolve = null;
  }
  function kill(run) {
    if (run.closed || run.killing || run.exited) return;
    run.killing = true;
    try { run.child?.kill('SIGTERM'); } catch {}
    if (run.closed) return;
    run.killTimer = setTimeout(() => { if (!run.closed) { try { run.child?.kill('SIGKILL'); } catch {} } }, stopTimeoutMs);
    run.killTimer.unref?.();
  }
  function fail(run, message) {
    if (run.closed || active !== run || run.failed) return;
    run.failed = true;
    const wasReady = current.phase === 'ready';
    current = { phase: 'failed', message, origin: null };
    settle(run, { ok: false, message }); kill(run);
    if (wasReady) notifyLost();
  }
  async function start(port, options) {
    // The host must have acknowledged that localhost.run terminates TLS; the renderer cannot skip this.
    if (options?.privacyAcknowledged !== true) return { ok: false, message: 'Confirm the free address privacy notice in guest settings before using the free address.' };
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return { ok: false, message: 'Choose a local guest port between 1024 and 65535.' };
    if (active) return { ok: false, message: 'Stop the existing guest tunnel before starting another.' };
    const run = { generation: ++generation, child: null, closed: false, failed: false, buffer: '', bytes: 0 };
    active = run; current = { phase: 'starting', message: 'Requesting a temporary guest address…', origin: null };
    const result = new Promise(resolve => { run.resolve = resolve; });
    run.startTimer = setTimeout(() => fail(run, 'The guest tunnel did not provide an address in time. Check your connection and try again.'), startupTimeoutMs);
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await fs.lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe directory');
      await fs.chmod(directory, 0o700);
      const config = path.join(directory, 'ssh-config');
      const hosts = path.join(directory, 'known-hosts');
      // Refuse symlinks for app-owned files; never inspect or modify user SSH files.
      for (const file of [config, hosts]) {
        try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe tunnel file'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await fs.writeFile(config, '', { mode: 0o600 }); await fs.chmod(config, 0o600);
      const handle = await fs.open(hosts, 'a', 0o600); await handle.close(); await fs.chmod(hosts, 0o600);
      if (active !== run || run.failed || run.closed) { release(run); return result; }
      const executable = platform === 'win32' ? path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe') : '/usr/bin/ssh';
      if (platform === 'win32' && !path.win32.isAbsolute(executable)) throw new Error('Invalid system SSH path');
      const pinned = await pinnedHostsFile(shippedKnownHosts);
      if (active !== run || run.failed || run.closed) { release(run); return result; }
      // ClaudeBWAI — fail closed: the pinned host key is mandatory, never trust-on-first-use. Nothing is spawned.
      if (!pinned) { fail(run, 'BlastCast\u2019s localhost.run host key file is missing; reinstall BlastCast.'); release(run); return result; }
      const knownHosts = pinned.replace(/\\/g, '/').replace(/"/g, '\\"');
      const args = ['-F', config, '-T', '-o', 'BatchMode=yes', '-o', 'IdentityAgent=none', '-o', 'IdentityFile=none',
        '-o', 'IdentitiesOnly=yes', '-o', 'PubkeyAuthentication=no', '-o', 'PasswordAuthentication=no',
        '-o', 'KbdInteractiveAuthentication=no', '-o', 'PreferredAuthentications=none', '-o', 'ForwardAgent=no',
        '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile="${knownHosts}"`, '-o', 'GlobalKnownHostsFile=none',
        '-o', 'UpdateHostKeys=no', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=15',
        '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-R', `80:127.0.0.1:${port}`, 'nokey@localhost.run'];
      const env = { ...process.env }; delete env.SSH_AUTH_SOCK; delete env.SSH_AGENT_PID; delete env.SSH_ASKPASS;
      env.SSH_ASKPASS_REQUIRE = 'never';
      const child = run.child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
      const receive = chunk => {
        if (active !== run || run.closed || run.failed || run.killing) return;
        run.bytes += Buffer.byteLength(chunk);
        if (run.bytes > MAX_OUTPUT) { fail(run, 'The guest tunnel returned too much output. It has been stopped.'); return; }
        run.buffer += chunk.toString('utf8');
        if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(run.buffer)) { fail(run, 'The guest provider’s SSH host key could not be verified. The tunnel was stopped; its saved key has not been replaced.'); return; }
        let end;
        while ((end = run.buffer.indexOf('\n')) !== -1) {
          const line = run.buffer.slice(0, end).replace(/\r$/, ''); run.buffer = run.buffer.slice(end + 1);
          const origin = parseOrigin(line);
          if (!origin) continue;
          if (current.phase === 'ready' && current.origin !== origin) { fail(run, 'The guest provider changed the address. Guest access has been stopped; start a new session explicitly.'); return; }
          current = { phase: 'ready', message: 'Temporary guest address created. Outside-network readiness still needs to be checked.', origin };
          settle(run, { ok: true, origin });
        }
      };
      child.stdout?.on('data', receive); child.stderr?.on('data', receive);
      child.once('error', error => {
        fail(run, error.code === 'ENOENT' ? 'OpenSSH is not installed in the system location. Enable the operating system’s OpenSSH client, then retry.' : 'The guest tunnel could not start. Check the operating system’s OpenSSH client.');
        if (!child.pid) release(run);
      });
      child.once('close', () => {
        run.exited = true;
        if (active === run && !run.failed && !run.killing) fail(run, 'The guest tunnel disconnected. Guest access is off; reconnect explicitly for a new address.');
        release(run);
      });
    } catch {
      fail(run, 'The private guest-tunnel configuration could not be prepared. Check application storage permissions.');
      if (!run.child) release(run);
    }
    return result;
  }
  async function stop() {
    const run = active;
    current = { phase: 'off', message: 'Guest tunnel is off.', origin: null };
    if (!run) return { ok: true };
    settle(run, { ok: false, message: 'Guest tunnel startup was cancelled.' });
    if (!run.child) { active = null; run.closed = true; return { ok: true }; }
    if (run.stopPromise) return run.stopPromise;
    run.stopPromise = new Promise(resolve => { run.stopResolve = resolve; });
    kill(run);
    if (!run.closed) run.stopTimer = setTimeout(() => {
      run.stopResolve?.({ ok: false, message: 'OpenSSH has not confirmed exit. Guest access remains off; do not start a replacement tunnel yet.' }); run.stopResolve = null;
    }, stopTimeoutMs * 2);
    return run.stopPromise;
  }
  return { start, stop, status };
}
module.exports = { createFreeTunnel, parseOrigin };
