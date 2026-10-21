import { describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider, parseOpenRouterUsage } from '../src/judge/openrouter.js';
import {
  LlmProviderError,
  type LlmAttemptRecord,
  type LlmCompleteRequest,
} from '../src/judge/llm-provider.js';

const request: LlmCompleteRequest = {
  messages: [{ role: 'user', content: 'Private song choice' }],
  maxTokens: 800,
  context: { roomCode: 'ABCDE', roundIdx: 2, promptVersion: 'round-fit-v5' },
};
const response = () =>
  new Response(
    JSON.stringify({
      model: 'fixed',
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168, cost: 0.0001 },
    }),
    { status: 200 },
  );

describe('paid judge attempt accounting', () => {
  it('reserves before dispatch and reports bounded usage with safe context', async () => {
    const order: string[] = [];
    const records: LlmAttemptRecord[] = [];
    const provider = new OpenRouterProvider(
      {
        apiKey: 'private-key',
        model: 'fixed',
        attemptHooks: {
          beforeAttempt(attempt) {
            order.push('reserve');
            expect(attempt).toMatchObject({
              roomCode: 'ABCDE',
              roundIdx: 2,
              promptVersion: 'round-fit-v5',
              model: 'fixed',
              maxTokens: 800,
            });
          },
          onAttempt(record) {
            order.push('reconcile');
            records.push(record);
          },
        },
      },
      vi.fn(async () => {
        order.push('dispatch');
        return response();
      }) as typeof fetch,
    );
    expect((await provider.complete(request)).usage).toEqual({
      inputTokens: 123,
      outputTokens: 45,
      totalTokens: 168,
      costUsd: 0.0001,
    });
    expect(order).toEqual(['reserve', 'dispatch', 'reconcile']);
    expect(records[0]).toMatchObject({
      status: 'succeeded',
      dispatched: true,
      usage: { costUsd: 0.0001 },
    });
    expect(JSON.stringify(records)).not.toContain('Private song choice');
    expect(JSON.stringify(records)).not.toContain('private-key');
  });

  it('denies spending before any network request when the ledger rejects a reservation', async () => {
    const fetchMock = vi.fn(async () => response());
    const onAttempt = vi.fn();
    const provider = new OpenRouterProvider(
      {
        apiKey: 'key',
        attemptHooks: {
          beforeAttempt() {
            throw new LlmProviderError('budget_exhausted', 'Game budget reached', false);
          },
          onAttempt,
        },
      },
      fetchMock as typeof fetch,
    );
    await expect(provider.complete(request)).rejects.toMatchObject({ code: 'budget_exhausted' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onAttempt).not.toHaveBeenCalled();
    expect(provider.getStatus().requests).toBe(0);
  });

  it('rechecks request caps after asynchronous reservations and accounts cancelled dispatches', async () => {
    const fetchMock = vi.fn(async () => response());
    const records: LlmAttemptRecord[] = [];
    const provider = new OpenRouterProvider(
      {
        apiKey: 'key',
        maxCalls: 1,
        maxConcurrent: 3,
        attemptHooks: {
          beforeAttempt: async () => {
            await Promise.resolve();
          },
          onAttempt: (record) => {
            records.push(record);
          },
        },
      },
      fetchMock as typeof fetch,
    );
    const outcomes = await Promise.allSettled([
      provider.complete(request),
      provider.complete(request),
      provider.complete(request),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(records.filter((r) => r.dispatched)).toHaveLength(1);
    expect(records.filter((r) => !r.dispatched && r.errorCode === 'budget_exhausted')).toHaveLength(
      2,
    );
    expect(new Set(records.map((r) => r.id)).size).toBe(3);
  });

  it('records failed dispatched attempts with unknown usage rather than a made-up zero', async () => {
    const onAttempt = vi.fn();
    const provider = new OpenRouterProvider(
      { apiKey: 'key', attemptHooks: { onAttempt } },
      vi.fn(async () => new Response('Upstream error', { status: 503 })) as typeof fetch,
    );
    await expect(provider.complete(request)).rejects.toMatchObject({ status: 503 });
    expect(onAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ dispatched: true, status: 'failed', errorCode: 'request_failed' }),
    );
    expect(onAttempt.mock.calls[0]![0].usage).toBeUndefined();
  });

  it('opens a circuit after repeated failures and blocks extra paid attempts', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 503 }));
    const provider = new OpenRouterProvider(
      { apiKey: 'key', circuitFailureThreshold: 2 },
      fetchMock as typeof fetch,
    );
    await expect(provider.complete(request)).rejects.toMatchObject({ status: 503 });
    await expect(provider.complete(request)).rejects.toMatchObject({ status: 503 });
    await expect(provider.complete(request)).rejects.toMatchObject({
      code: 'circuit_open',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(provider.getStatus().circuitOpenUntil).toBeDefined();
  });

  it('fails closed when accounting cannot be reconciled', async () => {
    const fetchMock = vi.fn(async () => response());
    const provider = new OpenRouterProvider(
      {
        apiKey: 'key',
        attemptHooks: {
          onAttempt() {
            throw new Error('Database unavailable');
          },
        },
      },
      fetchMock as typeof fetch,
    );
    await expect(provider.complete(request)).rejects.toMatchObject({
      code: 'accounting_unavailable',
    });
    await expect(provider.complete(request)).rejects.toMatchObject({ code: 'circuit_open' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects unsafe usage representations while retaining valid fields', () => {
    expect(
      parseOpenRouterUsage({
        prompt_tokens: '123',
        completion_tokens: -2,
        total_tokens: Infinity,
        cost: -1,
      }),
    ).toBeUndefined();
    expect(
      parseOpenRouterUsage({ prompt_tokens: 1.5, completion_tokens: 0, cost: '0.001' }),
    ).toEqual({ outputTokens: 0 });
    expect(parseOpenRouterUsage(null)).toBeUndefined();
    expect(parseOpenRouterUsage([])).toBeUndefined();
  });
});
