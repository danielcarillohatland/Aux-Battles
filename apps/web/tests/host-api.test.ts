/**
 * Regression tests for host/api.ts request headers (Create Room bug):
 * `apiRequest` must NOT send `content-type: application/json` on bodyless
 * requests — Fastify answers FST_ERR_CTP_EMPTY_JSON_BODY (400) to those,
 * which made the Create Room button fail. With a JSON body the header MUST
 * be present.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '../src/host/api.js';

const jsonResponse = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const mockFetch = vi.fn();

// api.ts uses global fetch — replace it for every test.
vi.stubGlobal('fetch', mockFetch);

afterEach(() => {
  mockFetch.mockReset();
});

describe('apiRequest content-type contract', () => {
  it('does NOT set application/json on a bodyless POST (Create Room)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ code: 'ABCDE', hostToken: 't'.repeat(20), playerId: 'p'.repeat(8) }),
    );

    await apiRequest('/api/v1/rooms', { method: 'POST' });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(init.method).toBe('POST');
    expect(headers['content-type']).toBeUndefined();
  });

  it('DOES set application/json when a JSON body is present', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ playerToken: 't'.repeat(20), playerId: 'p'.repeat(8), nickname: 'Ada' }),
    );

    await apiRequest('/api/v1/rooms/ABCDE/join', {
      method: 'POST',
      body: JSON.stringify({ code: 'ABCDE', nickname: 'Ada' }),
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
  });

  it('lets explicit caller headers win over the inferred ones', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await apiRequest('/api/v1/rooms/ABCDE/host/start_game', {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['content-type']).toBeUndefined(); // still no phantom JSON header
  });

  it('still unwraps the {ok,data} envelope after the header fix', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ code: 'ABCDE', hostToken: 't'.repeat(20), playerId: 'p'.repeat(8) }),
    );

    const data = await apiRequest<{ code: string }>('/api/v1/rooms', { method: 'POST' });
    expect(data.code).toBe('ABCDE');
  });
});
