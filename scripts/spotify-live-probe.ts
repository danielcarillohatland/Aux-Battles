/**
 * Phase 2.5 live-device probes (P6/P7/P8) — verifies the host's real Premium
 * session end-to-end through the running spike server.
 *
 * Usage: AUX_HOST_SESSION=<value of aux_host_session cookie> npx tsx scripts/spotify-live-probe.ts
 * (Cookie value: DevTools → Application → Cookies → 127.0.0.1:8787)
 *
 * These probes exercise the REAL token path: server-side encrypted store →
 * access token → Spotify Web API user endpoints. No tokens are printed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../..');
for (const candidate of [process.cwd(), repoRoot]) {
  try {
    for (const line of readFileSync(resolve(candidate, '.env'), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m?.[1] && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* no .env here */
  }
}

const SESSION = process.env.AUX_HOST_SESSION ?? '';
if (!SESSION) {
  console.error(
    'Set AUX_HOST_SESSION to the aux_host_session cookie value from your browser\n' +
      '(DevTools → Application → Cookies → http://127.0.0.1:8787) after OAuth.',
  );
  process.exit(1);
}
const BASE = process.env.AUX_BASE_URL ?? 'http://127.0.0.1:8787';

/** Mint a short-lived debug access token via the server's own store. */
async function getAccessToken(): Promise<string | null> {
  const res = await fetch(`${BASE}/api/v1/spotify/debug-token`, {
    headers: { cookie: `aux_host_session=${SESSION}` },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { ok: boolean; data?: { accessToken?: string } };
  return body.ok === true ? (body.data?.accessToken ?? null) : null;
}

interface ProbeResult {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

function record(name: string, ok: boolean, detail: string, t0: number): ProbeResult {
  return { name, ok, detail, ms: Date.now() - t0 };
}

async function main(): Promise<void> {
  const results: ProbeResult[] = [];

  const t0 = Date.now();
  const token = await getAccessToken();
  results.push(
    token
      ? record('P6a host session resolves to live access token', true, 'token retrieved', t0)
      : record('P6a host session resolves to live access token', false, 'no token — re-auth?', t0),
  );
  if (!token) {
    for (const r of results)
      console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name} (${r.ms}ms) — ${r.detail}`);
    process.exit(1);
  }

  const auth = { authorization: `Bearer ${String(token)}` };

  // P6b: device list reachable with a Premium user token
  const t6 = Date.now();
  const dev = await fetch('https://api.spotify.com/v1/me/player/devices', { headers: auth });
  const devices = dev.ok
    ? (((await dev.json()) as { devices?: Array<{ id: string; name: string; is_active: boolean }> })
        .devices ?? [])
    : [];
  results.push(
    record(
      'P6 device list',
      dev.ok,
      dev.ok
        ? `${devices.length} device(s): ${devices.map((d) => d.name).join(', ') || 'none'}`
        : `HTTP ${dev.status}`,
      t6,
    ),
  );

  // P7: transfer-playback latency to the first available device
  const target = devices[0];
  if (target !== undefined) {
    const t7 = Date.now();
    const tr = await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ device_ids: [target.id], play: false }),
    });
    results.push(
      record(
        'P7 transfer-playback',
        tr.ok || tr.status === 204,
        tr.ok || tr.status === 204 ? `transferred to ${target.name}` : `HTTP ${tr.status}`,
        t7,
      ),
    );

    // P8: playback state polling shape (verify-don't-drive helper contract)
    const t8 = Date.now();
    const st = await fetch('https://api.spotify.com/v1/me/player', { headers: auth });
    if (st.status === 204) {
      results.push(
        record(
          'P8 playback state',
          true,
          '204 no active session (expected right after transfer)',
          t8,
        ),
      );
    } else {
      const body = (await st.json()) as { is_playing?: boolean; progress_ms?: number };
      results.push(
        record(
          'P8 playback state',
          st.ok,
          st.ok
            ? `is_playing=${body.is_playing} progress=${body.progress_ms}`
            : `HTTP ${st.status}`,
          t8,
        ),
      );
    }
  } else {
    results.push(
      record(
        'P7 transfer-playback',
        false,
        'skipped — no devices visible (open Spotify on a device first)',
        Date.now(),
      ),
    );
  }

  let fail = 0;
  for (const r of results) {
    if (!r.ok) fail++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name} (${r.ms}ms) — ${r.detail}`);
  }
  console.log(fail === 0 ? '\nALL LIVE PROBES PASS ✅' : `\n${fail} probe(s) failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
