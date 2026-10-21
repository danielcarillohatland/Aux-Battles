import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { networkInterfaces, hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VIRTUAL_INTERFACE = /^(lo|docker|veth|br-|bridge|vmnet|vbox|utun|awdl|llw|anpi)/i;
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const LOOPBACK_HOST = '127.0.0.1';
const STARTUP_TIMEOUT_MS = 20_000;
const STARTUP_RETRY_MS = 100;

export function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  return (
    parts.length === 4 &&
    (parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168))
  );
}

export function detectLanIp(interfaces = networkInterfaces()) {
  const candidates = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const entry of addresses ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      candidates.push({ name, address: entry.address, private: isPrivateIpv4(entry.address) });
    }
  }
  candidates.sort(
    (a, b) =>
      Number(b.private) - Number(a.private) ||
      Number(/^en\d+$/i.test(b.name)) - Number(/^en\d+$/i.test(a.name)) ||
      a.name.localeCompare(b.name),
  );
  return candidates[0]?.address ?? null;
}

export function assertPortAvailable(port, host = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Port ${port} is already in use.`)));
    server.listen(port, host, () => server.close(resolve));
  });
}

export async function probeHttp(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(750) });
    // 403 means Vite blocked the hostname, which is not "reachable" for a browser.
    return response.status < 400;
  } catch {
    return false;
  }
}

/**
 * The machine's LAN-resolvable hostname (mDNS on macOS: "Name.local"), or null.
 * YouTube refuses to play inside pages whose origin is a bare IP address, so the
 * HOST screen must be opened by hostname while phones may keep using the IP.
 */
export function detectLocalHostname(platform = process.platform, exec = execFileSync) {
  try {
    if (platform === 'darwin') {
      const name = exec('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim();
      if (name !== '') return `${name}.local`;
    }
  } catch {
    // fall through to the generic hostname
  }
  const generic = hostname().trim();
  return generic !== '' && generic.toLowerCase() !== 'localhost' ? generic : null;
}

/** Hostname to open the host screen on: the LAN hostname if it serves the page, else localhost. */
export async function selectHostPageHost(localHostname, probe = probeHttp) {
  if (localHostname !== null && (await probe(`http://${localHostname}:5173/host.html`))) {
    return localHostname;
  }
  return 'localhost';
}

/** Prefer the detected LAN address only when the exact frontend URL answers. */
export async function selectReachableWebHost(lanIp, probe = probeHttp) {
  const candidates = lanIp === null ? [LOOPBACK_HOST] : [lanIp, LOOPBACK_HOST];
  const reachable = await Promise.all(
    candidates.map((host) => probe(`http://${host}:5173/host.html`)),
  );
  const lanIndex = lanIp === null ? -1 : 0;
  if (lanIndex >= 0 && reachable[lanIndex]) return lanIp;
  return reachable[candidates.indexOf(LOOPBACK_HOST)] ? LOOPBACK_HOST : null;
}

export async function waitForStartup(
  lanIp,
  {
    probe = probeHttp,
    timeoutMs = STARTUP_TIMEOUT_MS,
    retryMs = STARTUP_RETRY_MS,
    pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [webHost, apiReady] = await Promise.all([
      selectReachableWebHost(lanIp, probe),
      probe(`http://${LOOPBACK_HOST}:8787/`),
    ]);
    if (webHost !== null && apiReady) return webHost;
    await pause(retryMs);
  }
  throw new Error('Frontend/API did not become reachable within 20 seconds.');
}

export function descendantPids(rootPid, processRows) {
  const rows =
    processRows ??
    execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n');
  const childrenByParent = new Map();
  for (const row of rows) {
    const [pidText, parentText] = row.trim().split(/\s+/);
    const pid = Number(pidText);
    const parent = Number(parentText);
    if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
    const children = childrenByParent.get(parent) ?? [];
    children.push(pid);
    childrenByParent.set(parent, children);
  }
  const descendants = [];
  const visit = (parent) => {
    for (const pid of childrenByParent.get(parent) ?? []) {
      visit(pid);
      descendants.push(pid);
    }
  };
  visit(rootPid);
  return descendants;
}

export async function runDev() {
  try {
    await Promise.all([assertPortAvailable(5173), assertPortAvailable(8787)]);
  } catch (error) {
    console.error(
      `${error.message}\nStop the existing AUX BATTLES dev process or run npm run dev:clean.`,
    );
    process.exitCode = 1;
    return;
  }

  const lanIp = detectLanIp();
  const spawnOptions = {
    stdio: 'inherit',
    env: {
      ...process.env,
      // Phones must join over the LAN IP even when the host screen runs on a hostname.
      ...(lanIp !== null && process.env.VITE_AUX_PUBLIC_ORIGIN === undefined
        ? { VITE_AUX_PUBLIC_ORIGIN: `http://${lanIp}:5173` }
        : {}),
    },
    detached: false,
  };
  const executable = (name) =>
    resolve(
      repoRoot,
      'node_modules',
      '.bin',
      `${name}${process.platform === 'win32' ? '.cmd' : ''}`,
    );
  const children = [
    spawn(executable('tsx'), ['watch', 'src/index.ts'], {
      ...spawnOptions,
      cwd: resolve(repoRoot, 'apps/server'),
    }),
    spawn(executable('vite'), [], {
      ...spawnOptions,
      cwd: resolve(repoRoot, 'apps/web'),
    }),
  ];
  let shuttingDown = false;
  const terminateTree = (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }).unref();
      return;
    }
    for (const pid of descendantPids(child.pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // It may already have exited while walking the process tree.
      }
    }
    child.kill('SIGTERM');
  };
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) terminateTree(child);
    process.exitCode = exitCode;
  };
  for (const [index, child] of children.entries()) {
    child.once('error', (error) => {
      console.error(`${index === 0 ? 'Backend' : 'Frontend'} failed to start: ${error.message}`);
      shutdown(1);
    });
    child.once('exit', (code, signal) => {
      if (!shuttingDown && (code !== 0 || signal !== null)) {
        console.error(`${index === 0 ? 'Backend' : 'Frontend'} stopped unexpectedly.`);
        shutdown(code ?? 1);
      }
    });
  }
  process.once('SIGINT', () => shutdown());
  process.once('SIGTERM', () => shutdown());

  let webHost;
  try {
    webHost = await waitForStartup(lanIp);
  } catch (error) {
    console.error(`AUX BATTLES failed to start: ${error.message}`);
    shutdown(1);
    return;
  }

  // YouTube's embedded player returns error 150 for every video when the page
  // origin is an IP address, so the host screen opens by hostname; phones keep
  // the LAN IP for joining (their QR origin is passed to Vite below).
  const hostPageHost = await selectHostPageHost(detectLocalHostname());
  const hostUrl = `http://${hostPageHost}:5173/host.html`;
  console.log(
    `\nAUX BATTLES ready\nHost (open this one, not the IP):\n${hostUrl}\nPlayer:\nhttp://${webHost}:5173/player.html\nAPI:\nhttp://${webHost}:8787`,
  );
  if (lanIp === null) {
    console.log('LAN IP detection failed; using 127.0.0.1. Phones may not connect.');
  } else if (webHost !== lanIp) {
    console.log(
      `Detected LAN address ${lanIp} was not reachable; opened the reliable local URL instead.`,
    );
  }
  console.log('Players can scan the QR code from phones on the same Wi-Fi.\n');
  if (process.platform === 'darwin' && process.env.AUX_NO_OPEN !== '1') {
    const opener = spawn('open', [hostUrl], { stdio: 'ignore' });
    opener.unref();
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) await runDev();
