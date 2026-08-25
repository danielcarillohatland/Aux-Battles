/**
 * Phase-2 hard-case suite — RoomStore persistence (testing-strategy §1 flow 5,
 * TDD §3 crash recovery, D-B).
 *
 * The store is the WAL checkpoint tier: authoritative state lives in memory,
 * but every committed put() must survive a SIGKILL. Crash recovery is
 * exercised the honest way — a CHILD PROCESS commits checkpoints, is SIGKILLed
 * with no close(), and this process reopens the same SQLite file to verify
 * every committed snapshot survived (the hard-case brief's "spawn child
 * process or reopen store" recipe, both halves).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { SqliteRoomStore, StaleWriteError } from '../src/core/room-store.js';

const SERVER_DIR = fileURLToPath(new URL('../..', import.meta.url)); // apps/server

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aux-roomstore-'));
  file = join(dir, 'rooms.sqlite');
});

describe('snapshot CRUD + monotonic versions', () => {
  it('put/get round-trips an opaque state blob without knowing its shape', () => {
    const store = new SqliteRoomStore(file);
    const blobby = {
      fsm: { state: 'SONG_SELECTION', phaseEndsAt: 1730000090000 },
      players: [{ id: 'pl_A', nick: 'Sam 🎸', connected: true }],
      nested: { deep: { arr: [1, 'two', { three: null }] } },
    };
    const put = store.put('XK4TQ', blobby, { now: 1000 });
    expect(put).toMatchObject({ code: 'XK4TQ', version: 1, updatedAt: 1000 });

    const got = store.get('XK4TQ');
    expect(got?.state).toEqual(blobby); // JSON round-trip preserves structure
    expect(store.get('NOPE9')).toBeUndefined();
    store.close();
  });

  it('bumps version monotonically across puts — racing puts can never share a version', () => {
    const store = new SqliteRoomStore(file);
    const v1 = store.put('XK4TQ', { step: 1 });
    const v2 = store.put('XK4TQ', { step: 2 });
    const v3 = store.put('XK4TQ', { step: 3 });
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
    expect(store.get('XK4TQ')?.state).toEqual({ step: 3 }); // last write wins, versions unique
    store.close();
  });

  it('CAS: expectedVersion mismatch throws StaleWriteError and leaves the row untouched', () => {
    const store = new SqliteRoomStore(file);
    store.put('XK4TQ', { rev: 'current' });

    expect(() => store.put('XK4TQ', { rev: 'stale' }, { expectedVersion: 99 })).toThrow(
      StaleWriteError,
    );
    expect(() => store.put('MISSING', {}, { expectedVersion: 0 })).toThrow(StaleWriteError);
    expect(store.get('XK4TQ')?.state).toEqual({ rev: 'current' }); // no clobber
    expect(store.get('MISSING')).toBeUndefined();

    // Matching version succeeds and bumps.
    expect(store.put('XK4TQ', { rev: 'new' }, { expectedVersion: 1 }).version).toBe(2);
    store.close();
  });

  it('codes() enumerates oldest-updated-first for the boot sweep; delete reports existence', () => {
    const store = new SqliteRoomStore(file);
    store.put('AAAAA', {}, { now: 3000 });
    store.put('BBBBB', {}, { now: 1000 });
    store.put('CCCCC', {}, { now: 2000 });
    expect(store.codes()).toEqual(['BBBBB', 'CCCCC', 'AAAAA']);

    store.put('BBBBB', {}, { now: 4000 }); // touched → moves to the tail
    expect(store.codes()).toEqual(['CCCCC', 'AAAAA', 'BBBBB']);

    expect(store.delete('CCCCC')).toBe(true);
    expect(store.delete('CCCCC')).toBe(false); // second eviction is a no-op
    expect(store.get('CCCCC')).toBeUndefined();
    store.close();
  });
});

describe('crash recovery: reopen against the same file', () => {
  it('snapshots survive close + reopen; version continuity carries across restarts', () => {
    const first = new SqliteRoomStore(file);
    first.put('XK4TQ', { state: 'PLAYBACK', round: 2 }, { now: 7 });
    first.close(); // graceful shutdown path

    const reopened = new SqliteRoomStore(file);
    expect(reopened.get('XK4TQ')).toMatchObject({
      code: 'XK4TQ',
      version: 1,
      updatedAt: 7,
      state: { state: 'PLAYBACK', round: 2 },
    });
    expect(reopened.put('XK4TQ', { state: 'AI_JUDGING' }).version).toBe(2); // no reset-to-v1
    reopened.close();
  });
});

describe('hard case: SIGKILL mid-party → WAL recovery on reopen', () => {
  /**
   * Child writer (plain node, native TS stripping): commits 10 checkpoints on
   * an interval, then idles forever with NO close() — exactly a server that
   * crashed between transitions. The parent polls through a SECOND connection
   * (WAL: readers never block writers) until all 10 commits are visible, then
   * SIGKILLs the child with timers still armed, reopens, and asserts nothing
   * committed before the kill was lost.
   */
  function spawnCrashWriter(dbFile: string): ReturnType<typeof spawn> {
    const scriptPath = join(dir, 'crash-writer.mjs');
    writeFileSync(
      scriptPath,
      [
        `import { SqliteRoomStore } from ${JSON.stringify(
          fileURLToPath(new URL('../src/core/room-store.ts', import.meta.url)),
        )};`,
        `const store = new SqliteRoomStore(process.env.DB_FILE);`,
        `let n = 0;`,
        `const iv = setInterval(() => {`,
        `  store.put('KILL' + String(n).padStart(2, '0'), { n, t: Date.now() });`,
        `  if (++n === 10) clearInterval(iv); // stop writing; stay alive unflushed`,
        `}, 15);`,
        `setInterval(() => {}, 60_000); // keep the event loop alive until SIGKILL`,
      ].join('\n'),
    );
    return spawn(process.execPath, [scriptPath], {
      env: { ...process.env, DB_FILE: dbFile },
      cwd: SERVER_DIR, // so relative TS import resolves inside apps/server
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  it('a real SIGKILL of a writing process loses zero committed snapshots', async () => {
    let stderr = '';
    let exited: Promise<string | null>;
    let child: ReturnType<typeof spawn> | undefined;

    try {
      child = spawnCrashWriter(file);
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      exited = new Promise((res) => child!.once('exit', (_code, signal) => res(signal)));

      // Wait until all 10 checkpoints are visible from an independent handle.
      const deadline = Date.now() + 10_000;
      let committed = 0;
      while (Date.now() < deadline) {
        const probe = new SqliteRoomStore(file);
        committed = probe.codes().filter((c) => c.startsWith('KILL')).length;
        probe.close();
        if (committed === 10) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(committed).toBe(10);

      child.kill('SIGKILL');
      const signal = await exited;
      expect(signal).toBe('SIGKILL'); // died mid-flight, no graceful close
    } finally {
      child?.kill('SIGKILL');
    }

    // "Restart": reopen cold and verify every pre-kill commit is intact.
    const reopened = new SqliteRoomStore(file);
    const codes = reopened.codes().filter((c) => c.startsWith('KILL'));
    expect(codes).toHaveLength(10);
    codes.forEach((c, i) => {
      expect(c).toBe(`KILL${String(i).padStart(2, '0')}`); // none lost, none reordered
      const snap = reopened.get(c);
      expect(snap?.state).toMatchObject({ n: i }); // blobs intact post-mortem
      expect(typeof (snap?.state as { t?: number })?.t).toBe('number');
      expect(snap?.version).toBe(1);
    });
    reopened.close();
    void stderr;
  }, 15_000);
});
