import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { executable, root } from './runtime.mjs';
await access(executable).catch(() => { throw new Error('Run node scripts/runtime.mjs first.'); });
const child = spawn(executable, [root], { stdio: 'inherit', env: process.env });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
