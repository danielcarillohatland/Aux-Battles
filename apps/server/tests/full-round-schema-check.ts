/**
 * Drives a FULL round to GAME_OVER via the real API and validates every
 * snapshot frame against @aux/shared — catches schema drift in RESULTS/
 * LEADERBOARD/GAME_OVER states that only appear after judging.
 *
 * Usage: npx tsx apps/server/tests/full-round-schema-check.ts
 */
import { buildServer } from '../src/index.js';
import { ServerFrameSchema } from '@aux/shared';
import WebSocket from 'ws';

// Real server (with orchestrator) on one port…
const real = await buildServer({
  LOG_LEVEL: 'error',
  AUX_DEV_MODE: '0',
  AUX_DB_FILE: ':memory:',
  AUX_ENABLE_ORIGINALS: '1',
});
await real.app.ready();
await real.app.listen({ port: 0, host: '127.0.0.1' });
const port = (real.app.server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const created = await fetch(`${base}/api/v1/rooms`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
}).then((r) => r.json());
const room = (created as { data: { code: string; hostToken: string } }).data;
console.log('room:', room.code);

const playerRes = await fetch(`${base}/api/v1/rooms/${room.code}/join`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: room.code, nickname: 'SchemaSam' }),
}).then((r) => r.json());
const p = (playerRes as { data: { playerToken: string } }).data;

await fetch(`${base}/api/v1/rooms/${room.code}/host/start_game`, {
  method: 'POST',
  headers: { authorization: `Bearer ${room.hostToken}`, 'content-type': 'application/json' },
  body: '{}',
});
await fetch(`${base}/api/v1/rooms/${room.code}/host/pick_category`, {
  method: 'POST',
  headers: { authorization: `Bearer ${room.hostToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ category: 'schema test' }),
});
await fetch(`${base}/api/v1/rooms/${room.code}/host/skip_phase`, {
  method: 'POST',
  headers: { authorization: `Bearer ${room.hostToken}` },
});

const sub = await fetch(`${base}/api/v1/rounds/${room.code}:0/submissions`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${p.playerToken}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    clientMsgId: 'cm-schema-0001',
    track: {
      id: 'original:midnight-pancakes',
      title: 'Validate Me',
      artist: 'The Schemas',
      durationMs: 32_000,
    },
  }),
});
console.log('submission:', sub.status);

// Mint a ticket and validate EVERY frame the server pushes through RESULTS →
// LEADERBOARD → GAME_OVER against the shared schema. The WS connects BEFORE
// the state-driving fetches so frames are observed live, not after the fact.
const tkRes = await fetch(`${base}/api/v1/ws-ticket`, {
  method: 'POST',
  headers: { authorization: `Bearer ${room.hostToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ code: room.code }),
});
const ticket = ((await tkRes.json()) as { data: { ticket: string } }).data.ticket;

let checked = 0;
let rejected = 0;
const seenStates = new Set<string>();

await new Promise<void>((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room.code}&ticket=${ticket}`);
  const failTimer = setTimeout(() => {
    console.log(`checked=${checked} states=[${[...seenStates].join(',')}]`);
    resolve();
  }, 4000);
  ws.on('message', (raw) => {
    const parsed = JSON.parse(raw.toString());
    const result = ServerFrameSchema.safeParse(parsed);
    checked += 1;
    if (parsed.t === 'state_change') seenStates.add(parsed.snapshot.state);
    if (!result.success) {
      rejected += 1;
      console.log('REJECTED frame in state:', parsed.snapshot?.state ?? parsed.t);
      for (const issue of result.error.issues.slice(0, 6)) {
        console.log(' ', issue.path.join('.') || '(root)', '→', issue.message);
      }
      console.log(' RAW:', JSON.stringify(parsed).slice(0, 300));
      clearTimeout(failTimer);
      resolve();
    }
    if (parsed.snapshot?.state === 'GAME_OVER') {
      clearTimeout(failTimer);
      resolve();
    }
  });
  // Drive the full round forward while connected: PLAYBACK → AI_JUDGING →
  // RESULTS → LEADERBOARD → GAME_OVER.
  let n = 0;
  const driver = setInterval(async () => {
    n += 1;
    const call = (action: string, body?: Record<string, unknown>) =>
      fetch(`${base}/api/v1/rooms/${room.code}/host/${action}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${room.hostToken}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }).catch(() => {});
    if (n === 1) await call('begin_playback');
    else if (n === 2) await call('queue_done');
    else if (n === 3)
      await call('skip_phase'); // AI_JUDGING → RESULTS (placeholder judge)
    else if (n === 4 || n === 5) await call('advance_reveal', { final: n === 5 });
    else if (n === 6) await call('finish_game');
    if (n > 6) clearInterval(driver);
  }, 300);
});

console.log(
  rejected === 0
    ? `ALL ${checked} FRAMES VALID (states: ${[...seenStates].join(' → ')})`
    : `${rejected}/${checked} frames REJECTED`,
);
process.exit(rejected === 0 ? 0 : 1);
