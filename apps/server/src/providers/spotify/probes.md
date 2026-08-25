# Spotify Probes — Day-One Findings (Phase 2.5 SPIKE)

**Run date:** 2026-08-25 · **Script:** `scripts/spotify-probe.ts` (`npx tsx scripts/spotify-probe.ts` from repo root) · **Auth:** Client-Credentials from `.env` (catalog endpoints only — no user data touched)

Empirical results against the **real Spotify Web API** under Dev Mode. These decide TDD §15 open items 1 and 3.

## Results

| #   | Probe                                                                                      | Expected                                                            | Observed                                                                                | Verdict                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Client-Credentials auth                                                                    | HTTP 200, bearer token, `expires_in≈3600`                           | HTTP 200, `token_type=Bearer`, `expires_in=3600`, 382 ms                                | ✅ PASS — catalog-only auth works                                                                                                                             |
| P2  | Search with `limit=10`                                                                     | HTTP 200, ≤10 items (TDD §7 says Dev Mode caps search limit≤10)     | HTTP 200, exactly 10 items returned (29 total available for query)                      | ✅ PASS — limit=10 is safe                                                                                                                                    |
| P3  | Search with `limit=50` (above presumed cap)                                                | TDD did not specify reject vs clamp                                 | **HTTP 400** `"Invalid limit"` — hard rejection, not a silent clamp                     | 🔒 CAP CONFIRMED (hard reject) — provider must never send `limit>10`; clamp client-side before calling                                                        |
| P4  | `preview_url` availability (known track `4cOdK2wGLETKBW3PvgPWqT` + 10-track search sample) | TDD presumes previews dead in Dev Mode → expect all null            | Known track: `preview_url` **absent/null**. Sample of 10 tracks: **0/10 have previews** | 💀 PREVIEWS CONFIRMED DEAD — manual-mode path (L4) stands; `getPreviewClip` can be cut from scope                                                             |
| P5  | Rate-limit burst: 20 rapid sequential searches (~8.8 s total)                              | Some 429 threshold exists; record trip point + `Retry-After` values | All **20 requests → HTTP 200**, zero 429s, zero `Retry-After` headers                   | 🟢 NO LIMIT HIT at this scale — ceiling >20 rapid searches; normal polling cadence is far below risk. Circuit breaker on 429 still required but untested here |

## TODO(AUX-001) — requires host OAuth (Premium)

These probes are stubbed in the script and print `needs host OAuth`. They cannot run with Client-Credentials:

| #   | Probe                                   | Expected                                                        | Observed                          | Verdict          |
| --- | --------------------------------------- | --------------------------------------------------------------- | --------------------------------- | ---------------- |
| P6  | Device list (`GET /me/player/devices`)  | ≥1 active Premium device visible                                | _not runnable without host OAuth_ | ⏳ TODO(AUX-001) |
| P7  | Transfer-playback latency & reliability | TDD §15 open item 2; informs verify-don't-drive polling cadence | _not runnable without host OAuth_ | ⏳ TODO(AUX-001) |

## Engineering consequences

1. **Search limit:** enforce `limit = min(limit, 10)` inside `SpotifyProvider.search()` before hitting the API — Spotify rejects rather than clamps.
2. **Previews dead:** drop any `previewOnly` cue-path work; L4 manual mode is the confirmed day-one playback fallback (matches D-E).
3. **Rate limits generous for our scale:** a party's submission-driven search traffic won't trip 429s; keep the Retry-After-honoring circuit breaker anyway per TDD §7.

## Re-running

```sh
npx tsx scripts/spotify-probe.ts   # prints human-readable log + JSON blob
```

Requires `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` in `.env`.
