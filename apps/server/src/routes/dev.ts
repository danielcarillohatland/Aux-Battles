/**
 * Dev-only debug dashboard endpoint (D-011). Registered ONLY when AUX_DEV_MODE=1.
 * Read-only introspection over the same in-process state the game uses —
 * no second source of truth. Phase 2 swaps the DebugState source to RoomManager.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export interface RoomDebugInfo {
  code: string;
  state: string;
  roundIdx: number;
  players: number;
  connectedPlayers: number;
  submissionsCount: number;
  playbackMode: string;
  phaseEndsAt: number | null;
}

export interface DebugState {
  getRooms(): RoomDebugInfo[];
}

/** Plugin factory: `app.register(devRoute(debugState))`. */
export function devRoute(debug: DebugState): FastifyPluginAsync {
  return async (app: FastifyInstance): Promise<void> => {
    app.get('/dev/state', async () => ({
      ok: true as const,
      data: {
        rooms: debug.getRooms(),
        generatedAt: new Date().toISOString(),
        note: 'dev-only introspection (DECISIONS.md D-011)',
      },
    }));
  };
}
