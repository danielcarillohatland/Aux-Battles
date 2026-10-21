/**
 * Browser-shaped LAN regression: a non-loopback page Origin reaches Fastify
 * through Vite, completes the upgrade, and receives the initial snapshot.
 * The Origin header is essential: origin-less Node probes missed this bug.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import WebSocket, { type RawData } from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../server/src/index.js';
import { createDevProxy } from '../vite.config.js';

let app: FastifyInstance;
let vite: ViteDevServer;
let proxyNetworkOrigin: string;

beforeAll(async () => {
  ({ app } = await buildServer({ LOG_LEVEL: 'error', AUX_DEV_MODE: '0' }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const apiPort = (app.server.address() as { port: number }).port;

  vite = await createServer({
    configFile: false,
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      proxy: createDevProxy(`http://127.0.0.1:${apiPort}`),
    },
  });
  await vite.listen();
  const vitePort = (vite.httpServer!.address() as { port: number }).port;
  proxyNetworkOrigin = `http://127.0.0.1:${vitePort}`;
});

afterAll(async () => {
  await vite?.close();
  await app?.close();
});

describe('Vite WebSocket proxy over a LAN-shaped origin', () => {
  it('preserves the non-loopback Host, upgrades, and forwards the initial state_change', async () => {
    // The TCP connection stays on loopback so this remains portable in CI;
    // Host + Origin exactly model a page served at a non-loopback LAN address.
    const lanHost = '192.168.50.25:5173';
    const proxyHeaders = { host: lanHost };
    const createdRes = await fetch(`${proxyNetworkOrigin}/api/v1/rooms`, {
      method: 'POST',
      headers: proxyHeaders,
    });
    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()) as {
      data: { code: string; hostToken: string };
    };

    const ticketRes = await fetch(`${proxyNetworkOrigin}/api/v1/ws-ticket`, {
      method: 'POST',
      headers: {
        ...proxyHeaders,
        'content-type': 'application/json',
        authorization: `Bearer ${created.data.hostToken}`,
      },
      body: JSON.stringify({ code: created.data.code }),
    });
    expect(ticketRes.status).toBe(200);
    const ticket = (await ticketRes.json()) as { data: { ticket: string } };

    const wsUrl = proxyNetworkOrigin.replace(/^http/, 'ws');
    const socket = new WebSocket(
      `${wsUrl}/ws?room=${created.data.code}&ticket=${ticket.data.ticket}`,
      { origin: `http://${lanHost}`, headers: proxyHeaders },
    );

    type StateFrame = {
      t: string;
      snapshot?: { roomCode: string; players?: Array<{ nickname: string }> };
    };
    const nextMessage = (client: WebSocket) =>
      new Promise<StateFrame>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timed out awaiting frame')), 5_000);
        client.once('error', reject);
        client.once('message', (raw: RawData) => {
          clearTimeout(timeout);
          resolve(JSON.parse(String(raw)) as StateFrame);
        });
      });

    const firstFrame = await new Promise<StateFrame>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('timed out awaiting initial frame')),
        5_000,
      );
      socket.once('unexpected-response', (_req, res) => {
        clearTimeout(timeout);
        reject(new Error(`upgrade refused with HTTP ${res.statusCode}`));
      });
      socket.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      socket.once('message', (raw: RawData) => {
        clearTimeout(timeout);
        resolve(JSON.parse(String(raw)) as StateFrame);
      });
    });

    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(firstFrame.t).toBe('state_change');
    expect(firstFrame.snapshot?.roomCode).toBe(created.data.code);

    // Join after the host is already live: this is the exact 0 → 1 update
    // that was missing in the LAN lobby.
    const rosterUpdatePromise = nextMessage(socket);
    const joinRes = await fetch(`${proxyNetworkOrigin}/api/v1/rooms/${created.data.code}/join`, {
      method: 'POST',
      headers: { ...proxyHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ code: created.data.code, nickname: 'LAN Guest' }),
    });
    expect(joinRes.status).toBe(200);
    const joined = (await joinRes.json()) as { data: { playerToken: string } };
    const rosterUpdate = await rosterUpdatePromise;
    expect(rosterUpdate.t).toBe('state_change');
    expect(rosterUpdate.snapshot?.players?.map((player) => player.nickname)).toEqual(['LAN Guest']);

    // The second client's own browser-shaped upgrade also traverses Vite.
    const playerTicketRes = await fetch(`${proxyNetworkOrigin}/api/v1/ws-ticket`, {
      method: 'POST',
      headers: {
        ...proxyHeaders,
        'content-type': 'application/json',
        authorization: `Bearer ${joined.data.playerToken}`,
      },
      body: JSON.stringify({ code: created.data.code }),
    });
    const playerTicket = (await playerTicketRes.json()) as { data: { ticket: string } };
    const playerSocket = new WebSocket(
      `${wsUrl}/ws?room=${created.data.code}&ticket=${playerTicket.data.ticket}`,
      { origin: `http://${lanHost}`, headers: proxyHeaders },
    );
    const playerInitial = await nextMessage(playerSocket);
    expect(playerInitial.t).toBe('state_change');
    expect(playerInitial.snapshot?.players?.map((player) => player.nickname)).toEqual([
      'LAN Guest',
    ]);

    playerSocket.close();
    socket.close();
  });
});
