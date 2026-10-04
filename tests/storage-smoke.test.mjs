// ClaudeBWAI — real browser storage (IndexedDB + Web Locks) in the default gate, when Electron is available.
// Runs tests/guest-recovery-smoke.cjs in the pinned Electron. Skips, with the reason, when no runtime exists.
// Runtime: BLASTCAST_ELECTRON=<binary>, else the checksum-verified .runtime/ extraction (node scripts/runtime.mjs).
// Never downloads or installs. Needs a display: uses the current DISPLAY or xvfb-run when it is installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { executable, root } from '../scripts/runtime.mjs';

const electron = process.env.BLASTCAST_ELECTRON || executable;
const hasXvfb = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).status === 0;
const needsXvfb = process.platform === 'linux' && !process.env.DISPLAY;
let skip = false;
if (!existsSync(electron)) skip = `no Electron runtime at ${electron} (set BLASTCAST_ELECTRON or run node scripts/runtime.mjs); real IndexedDB smoke not run`;
else if (needsXvfb && !hasXvfb) skip = 'no DISPLAY and no xvfb-run; real IndexedDB smoke not run';
else if (!existsSync(new URL('../dist/guest.html', import.meta.url))) skip = 'dist/ is not built; run npm run build';

test('guest recovery smoke passes in real Electron (IndexedDB, Web Locks, streamed recovery)', { skip, timeout: 180000 }, () => {
  const smoke = ['--no-sandbox', `${root}tests/guest-recovery-smoke.cjs`];
  const [command, args] = needsXvfb
    ? ['xvfb-run', ['-a', '-s', '-screen 0 1920x1080x24', electron, ...smoke]]
    : [electron, smoke];
  const run = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 150000 });
  const line = (run.stdout || '').split('\n').reverse().find(text => text.startsWith('{"result"'));
  const report = line ? JSON.parse(line) : null;
  assert.equal(run.status, 0, `exit ${run.status}\n${run.stderr?.slice(-2000)}\n${report?.error ?? ''}`);
  assert.equal(report?.result, 'PASS', report?.error);
  console.log(`# storage smoke PASS in Electron ${report.electron}: ${report.checks.length} checks`);
});
