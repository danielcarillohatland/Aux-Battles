/**
 * Day-one Spotify probe script (Phase 2.5 SPIKE).
 *
 * Runs against the REAL Spotify Web API using client credentials from .env
 * (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET). Probes PUBLIC catalog endpoints
 * only — no user data, no playback control, no host OAuth required.
 *
 * Probes implemented here:
 *   P1  client-credentials auth works for catalog endpoints
 *   P2  search with limit=10 succeeds (TDD §7 says Dev Mode caps search limit≤10)
 *   P3  search with limit>10 — does Dev Mode reject (>400) or silently clamp?
 *   P4  preview_url availability on a known track (+ top-10 sample from search)
 *   P5  rate-limit behavior: burst of 20 rapid searches; when do 429s start,
 *       what Retry-After values come back?
 *
 * Probes that REQUIRE a Premium host OAuth token are stubbed below and print
 * 'needs host OAuth' — tracked as TODO(AUX-001):
 *   P6  device list
 *   P7  transfer-playback latency
 *
 * Usage:  npx tsx scripts/spotify-probe.ts   (from repo root)
 * Output: human-readable log + JSON blob on stdout (consumed by probes.md author).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// .env loading (no dotenv dependency; repo-root .env)
// ---------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv(): Record<string, string> {
  const raw = readFileSync(join(repoRoot, '.env'), 'utf8');
  const env: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2];
  }
  return env;
}

const env = loadEnv();
const CLIENT_ID = env.SPOTIFY_CLIENT_ID ?? '';
const CLIENT_SECRET = env.SPOTIFY_CLIENT_SECRET ?? '';
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('FATAL: SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET missing from .env');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Probe harness
// ---------------------------------------------------------------------------

interface ProbeResult {
  id: string;
  name: string;
  expected: string;
  observed: Record<string, unknown>;
  verdict: string;
}

const results: ProbeResult[] = [];

function record(
  id: string,
  name: string,
  expected: string,
  observed: Record<string, unknown>,
  verdict: string,
): void {
  results.push({ id, name, expected, observed, verdict });
  console.log(`\n[${id}] ${name}`);
  console.log(`  expected : ${expected}`);
  console.log(`  observed : ${JSON.stringify(observed)}`);
  console.log(`  verdict  : ${verdict}`);
}

function needsHostOauth(id: string, name: string): void {
  const msg = `needs host OAuth (TODO(AUX-001))`;
  console.log(`\n[${id}] ${name}\n  SKIPPED: ${msg}`);
  record(
    id,
    name,
    'measurable with host Premium token',
    { skipped: msg },
    'TODO(AUX-001) — deferred until host OAuth lands',
  );
}

let accessToken = '';

async function api<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T | null; retryAfter?: string }> {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) },
  });
  const retryAfter = res.headers.get('retry-after') ?? undefined;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body: body as T | null, retryAfter };
}

// Canonical well-known track: Rick Astley — Never Gonna Give You Up
const KNOWN_TRACK_ID = '4cOdK2wGLETKBW3PvgPWqT';

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // --- P1: client-credentials auth -----------------------------------------
  const t0 = Date.now();
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  const tokenBody = (await tokenRes.json()) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
  };
  accessToken = tokenBody.access_token ?? '';
  record(
    'P1',
    'Client-Credentials auth (catalog-only)',
    'HTTP 200, bearer token, expires_in≈3600',
    {
      status: tokenRes.status,
      tokenType: tokenBody.token_type,
      expiresIn: tokenBody.expires_in,
      ms: Date.now() - t0,
    },
    tokenRes.status === 200 ? 'PASS' : 'FAIL',
  );

  // --- P2: search limit=10 ---------------------------------------------------
  const p2 = await api<{ tracks?: { total: number; items: unknown[] } }>(
    `/search?q=${encodeURIComponent('never gonna give you up')}&type=track&limit=10`,
  );
  record(
    'P2',
    'Search with limit=10',
    'HTTP 200, ≤10 items returned (Dev Mode cap honored)',
    {
      status: p2.status,
      itemCount: p2.body?.tracks?.items.length,
      totalAvailable: p2.body?.tracks?.total,
    },
    p2.status === 200 && (p2.body?.tracks?.items.length ?? 0) <= 10 ? 'PASS' : 'FAIL',
  );

  // --- P3: search limit>10 — reject or clamp? --------------------------------
  const p3 = await api<{ tracks?: { items: unknown[] } | null; error?: { message: string } }>(
    `/search?q=${encodeURIComponent('daft punk')}&type=track&limit=50`,
  );
  record(
    'P3',
    'Search with limit=50 (above presumed Dev Mode cap)',
    'Either HTTP 400 rejection OR silent clamp to ≤10 — TDD does not specify which',
    {
      status: p3.status,
      itemCount: Array.isArray(p3.body?.tracks?.items) ? p3.body.tracks.items.length : null,
      errorMessage: p3.body?.error?.message ?? null,
    },
    (() => {
      if (p3.status === 400) return 'CONFIRMED CAP (hard reject)';
      if (p3.status === 200 && (p3.body?.tracks?.items.length ?? 51) <= 10)
        return `CONFIRMED CAP (silent clamp to ${p3.body?.tracks?.items.length})`;
      if (p3.status === 200)
        return `CAP NOT ENFORCED (${p3.body?.tracks?.items.length} items returned)`;
      return `UNEXPECTED (HTTP ${p3.status})`;
    })(),
  );

  // --- P4: preview_url availability -------------------------------------------
  const p4a = await api<{ name: string; preview_url: string | null; album: { name: string } }>(
    `/tracks/${KNOWN_TRACK_ID}`,
  );
  const sampleIds = ((p2.body?.tracks?.items ?? []) as Array<{ id: string }>)
    .slice(0, 10)
    .map((t) => t.id);
  const previews: { id: string; hasPreview: boolean }[] = [];
  for (const id of sampleIds) {
    const r = await api<{ preview_url: string | null }>(`/tracks/${id}`);
    previews.push({ id, hasPreview: r.body?.preview_url != null });
  }
  const withPreview = previews.filter((p) => p.hasPreview).length;
  record(
    'P4',
    'preview_url availability (known track + 10-track sample)',
    'TDD presumes previews dead in Dev Mode → expect all null',
    {
      knownTrack: { id: KNOWN_TRACK_ID, name: p4a.body?.name, previewUrl: p4a.body?.preview_url },
      sampleSize: previews.length,
      withPreviewCount: withPreview,
      withPreviewIds: previews.filter((p) => p.hasPreview).map((p) => p.id),
    },
    (() => {
      if (p4a.body == null) return `INCONCLUSIVE (HTTP ${p4a.status})`;
      if (withPreview === 0 && p4a.body.preview_url == null)
        return 'CONFIRMED DEAD — previews unavailable; manual-mode path (L4) stands, getPreviewClip can be cut';
      if (withPreview === previews.length && p4a.body.preview_url != null)
        return 'ALIVE — previews fully available; reconsider previewOnly cue path';
      return `PARTIAL (${withPreview}/${previews.length}) — per-track availability varies; treat preview_url as optional everywhere`;
    })(),
  );

  // --- P5: rate-limit burst (20 rapid searches) --------------------------------
  const queries = [
    'love',
    'night',
    'fire',
    'gold',
    'star',
    'blue',
    'heart',
    'dance',
    'dream',
    'light',
    'rain',
    'ocean',
    'road',
    'wild',
    'free',
    'home',
    'time',
    'eyes',
    'sky',
    'moon',
  ];
  type BurstEntry = { i: number; q: string; status: number; retryAfter?: string };
  const burst: BurstEntry[] = [];
  const burstStart = Date.now();
  for (let i = 0; i < 20; i++) {
    const r = await api(`/search?q=${encodeURIComponent(queries[i])}&type=track&limit=10`);
    burst.push({ i: i + 1, q: queries[i], status: r.status, retryAfter: r.retryAfter });
    if (r.status !== 200) break; // stop hammering once limited
  }
  const first429 = burst.find((b) => b.status === 429);
  record(
    'P5',
    'Rate-limit burst: 20 sequential rapid searches',
    'Some 429 threshold exists; record request # where it trips + Retry-After header values',
    {
      requestsMade: burst.length,
      statuses: burst.map((b) => b.status),
      first429AtRequest: first429?.i ?? null,
      retryAfterSeconds: burst
        .filter((b) => b.retryAfter != null)
        .map((b) => ({ req: b.i, retryAfter: b.retryAfter })),
      elapsedMs: Date.now() - burstStart,
    },
    (() => {
      if (!first429)
        return `NO 429 IN BURST OF ${burst.length} — ceiling higher than 20 rapid searches; polling cadence safe at this scale`;
      return `LIMIT TRIPPED AT REQUEST ${first429.i} of 20 — Retry-After=${first429.retryAfter}s; circuit breaker must honor it`;
    })(),
  );

  // --- P6/P7: Premium host-token probes (stubbed) ------------------------------
  needsHostOauth('P6', 'Device list (/me/player/devices)');
  needsHostOauth('P7', 'Transfer-playback latency & reliability');

  console.log('\n=== JSON RESULTS ===');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error('PROBE CRASHED:', err);
  process.exit(1);
});
