import { describe, expect, it } from 'vitest';
import {
  descendantPids,
  detectLanIp,
  detectLocalHostname,
  isPrivateIpv4,
  selectHostPageHost,
  selectReachableWebHost,
  waitForStartup,
} from '../../../scripts/dev.mjs';
import { isAuxDevProcess } from '../../../scripts/dev-clean.mjs';

const ipv4 = (address: string, internal = false) => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4' as const,
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${address}/24`,
});

describe('one-command dev launcher', () => {
  it('prefers a private physical LAN IPv4 and ignores loopback/virtual adapters', () => {
    expect(
      detectLanIp({
        lo0: [ipv4('127.0.0.1', true)],
        docker0: [ipv4('172.17.0.1')],
        en0: [ipv4('192.168.1.44')],
        en5: [ipv4('203.0.113.8')],
      }),
    ).toBe('192.168.1.44');
  });

  it('falls back cleanly when no LAN interface is available', () => {
    expect(detectLanIp({ lo0: [ipv4('127.0.0.1', true)] })).toBeNull();
    expect(isPrivateIpv4('10.0.0.8')).toBe(true);
    expect(isPrivateIpv4('172.20.0.8')).toBe(true);
    expect(isPrivateIpv4('8.8.8.8')).toBe(false);
  });

  it('opens the host screen by hostname, never by IP, so YouTube embeds work', async () => {
    const probe = async (url: string) => url === 'http://Daniels-MacBook-Air.local:5173/host.html';
    await expect(selectHostPageHost('Daniels-MacBook-Air.local', probe)).resolves.toBe(
      'Daniels-MacBook-Air.local',
    );
    await expect(selectHostPageHost('unreachable.local', probe)).resolves.toBe('localhost');
    await expect(selectHostPageHost(null, probe)).resolves.toBe('localhost');
    expect(detectLocalHostname('darwin', () => 'Daniels-MacBook-Air\n')).toBe(
      'Daniels-MacBook-Air.local',
    );
    expect(
      detectLocalHostname('darwin', () => {
        throw new Error('no scutil');
      }),
    ).toMatch(/^(?!localhost$).+/);
  });

  it('opens the LAN URL only when that exact frontend address is reachable', async () => {
    const probe = async (url: string) => url === 'http://192.168.1.44:5173/host.html';
    await expect(selectReachableWebHost('192.168.1.44', probe)).resolves.toBe('192.168.1.44');
  });

  it('falls back to stable loopback when a detected LAN URL is stale', async () => {
    const probe = async (url: string) => url === 'http://127.0.0.1:5173/host.html';
    await expect(selectReachableWebHost('192.168.0.122', probe)).resolves.toBe('127.0.0.1');
  });

  it('waits for both frontend and API before declaring startup ready', async () => {
    let round = 0;
    const pause = async () => {
      round += 1;
    };
    const probe = async (url: string) => {
      if (url.endsWith(':8787/')) return round >= 2;
      if (url.includes('192.168.1.44')) return round >= 1;
      return false;
    };

    await expect(
      waitForStartup('192.168.1.44', { probe, pause, timeoutMs: 1_000, retryMs: 0 }),
    ).resolves.toBe('192.168.1.44');
    expect(round).toBe(2);
  });

  it('cleanup only accepts AUX dev commands whose cwd is inside this repository', () => {
    const root = '/Users/test/aux-battles';
    expect(isAuxDevProcess('node vite', `${root}/apps/web`, root)).toBe(true);
    expect(isAuxDevProcess('node tsx watch src/index.ts', `${root}/apps/server`, root)).toBe(true);
    expect(
      isAuxDevProcess(
        `node --require ${root}/node_modules/tsx/dist/preflight.cjs --import loader src/index.ts`,
        `${root}/apps/server`,
        root,
      ),
    ).toBe(true);
    expect(isAuxDevProcess('node vite', '/Users/test/other-project', root)).toBe(false);
    expect(isAuxDevProcess('node unrelated-server.js', root, root)).toBe(false);
  });

  it('finds nested npm and watcher children from leaves to root', () => {
    expect(descendantPids(10, ['10 1', '20 10', '30 20', '40 10', '50 999'])).toEqual([30, 20, 40]);
  });
});
