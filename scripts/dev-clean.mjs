import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function output(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

export function isAuxDevProcess(command, cwd, root = repoRoot) {
  const insideRepo = cwd === root || cwd.startsWith(`${root}/`);
  const viteDev = /(?:^|\s)(?:vite|[^\s]*\/vite)(?:\s|$)/i.test(command);
  const serverDev =
    command.includes(`${root}/node_modules/tsx/`) && /(?:^|\s)src\/index\.ts(?:\s|$)/.test(command);
  return (
    insideRepo &&
    (viteDev || serverDev || /tsx.*watch|npm.*dev:(?:web|server)|scripts\/dev\.mjs/i.test(command))
  );
}

export function auxDevPids() {
  const pids = new Set();
  for (const raw of output('ps', ['-axo', 'pid=']).split('\n')) {
    const pid = Number(raw.trim());
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    const command = output('ps', ['-p', String(pid), '-o', 'command=']);
    const cwdLine = output('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
      .split('\n')
      .find((line) => line.startsWith('n'));
    const cwd = cwdLine?.slice(1) ?? '';
    if (isAuxDevProcess(command, cwd)) pids.add(pid);
  }
  return [...pids].sort((a, b) => b - a);
}

export function cleanAuxDev() {
  const pids = auxDevPids();
  if (pids.length === 0) {
    console.log('No stale AUX BATTLES dev processes found on ports 5173/8787.');
    return;
  }
  for (const pid of pids) process.kill(pid, 'SIGTERM');
  console.log(
    `Stopped AUX BATTLES dev process${pids.length === 1 ? '' : 'es'}: ${pids.join(', ')}`,
  );
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) cleanAuxDev();
