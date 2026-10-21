/**
 * Regression tests for join-URL derivation (LAN QR bug): a QR built from
 * localhost/127.0.0.1 is unreachable by phones — they resolve loopback to
 * themselves. Join origins must come from explicit config or a
 * non-loopback page origin, and the URL builder must never emit loopback.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildJoinUrl,
  resolveJoinOrigin,
  embedSafeHostUrl,
  isIpAddressHost,
} from '../src/host/join-url.js';

function stubLocation(origin: string): void {
  vi.stubGlobal('window', {
    location: new URL(origin),
    ...((globalThis.window as object) ?? {}),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveJoinOrigin', () => {
  it('returns null when the host page is on localhost (dev) — QR would be unreachable', () => {
    stubLocation('http://localhost:5173/host.html');
    expect(resolveJoinOrigin()).toBeNull();
  });

  it('returns null for 127.0.0.1 too', () => {
    stubLocation('http://127.0.0.1:5173/host.html');
    expect(resolveJoinOrigin()).toBeNull();
  });

  it('passes through a LAN IP page origin (host served over LAN)', () => {
    stubLocation('http://192.168.0.122:8787/host.html');
    expect(resolveJoinOrigin()).toBe('http://192.168.0.122:8787');
  });

  it('passes through a deployed domain', () => {
    stubLocation('https://aux-battles.fly.dev/host.html');
    expect(resolveJoinOrigin()).toBe('https://aux-battles.fly.dev');
  });

  it('explicit origin wins over everything, trailing slash trimmed', () => {
    stubLocation('http://localhost:5173/host.html');
    expect(resolveJoinOrigin('http://192.168.0.122:8787/')).toBe('http://192.168.0.122:8787');
  });
});

describe('buildJoinUrl', () => {
  it('builds a player URL from a LAN origin + room code', () => {
    stubLocation('http://localhost:5173/host.html'); // irrelevant when origin given
    const url = buildJoinUrl('JABAR', 'http://192.168.0.122:8787');
    expect(url).toBe('http://192.168.0.122:8787/player.html?code=JABAR');
  });

  it('URL-encodes the room code', () => {
    stubLocation('http://192.168.0.122:8787/host.html');
    const url = buildJoinUrl('AB/C D', 'http://192.168.0.122:8787');
    expect(url).toContain('code=AB%2FC%20D');
  });

  it('falls back to window.location.origin when no origin given', () => {
    stubLocation('http://192.168.0.122:8787/host.html');
    expect(buildJoinUrl('JABAR')).toBe('http://192.168.0.122:8787/player.html?code=JABAR');
  });
});

describe('embed-safe host origin (D-030)', () => {
  it('flags bare IP origins and points at the same page on localhost', () => {
    expect(isIpAddressHost('192.168.0.122')).toBe(true);
    expect(isIpAddressHost('127.0.0.1')).toBe(true);
    expect(isIpAddressHost('[::1]')).toBe(true);
    expect(isIpAddressHost('localhost')).toBe(false);
    expect(isIpAddressHost('daniels-macbook-air.local')).toBe(false);
    expect(isIpAddressHost('aux-battles.fly.dev')).toBe(false);
    expect(embedSafeHostUrl({ protocol: 'http:', port: '5173', pathname: '/host.html' })).toBe(
      'http://localhost:5173/host.html',
    );
    expect(embedSafeHostUrl({ protocol: 'https:', port: '', pathname: '/host.html' })).toBe(
      'https://localhost/host.html',
    );
  });
});
