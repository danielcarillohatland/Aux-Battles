import { describe, expect, it, vi } from 'vitest';
import { LlmProviderError, type LlmCompleteRequest } from '../src/judge/llm-provider.js';
import { DEFAULT_OPENROUTER_MODEL, OpenRouterProvider } from '../src/judge/openrouter.js';
import { judgeTrack } from '../src/judge/service.js';
import { TRACK_JUDGEMENT_JSON_SCHEMA } from '../src/judge/schema.js';

const judgement = {
  knowledge: 'known',
  totalScore: 7,
  categories: { scenarioFit: 2, mood: 2, lyrics: 1, genre: 1, wildcard: 1 },
  reasons: ['Its known theme suits the escape.', 'This getaway has excellent timing.'],
  defense: 'No defense filed.',
  verdict: 'A strong choice.',
};
const response = () =>
  Response.json({
    model: 'verified-model',
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(judgement) } }],
  });
const request: LlmCompleteRequest = {
  messages: [{ role: 'user', content: 'Judge this song.' }],
  jsonSchema: TRACK_JUDGEMENT_JSON_SCHEMA,
  maxTokens: 800,
  temperature: 0.4,
};
const song = { index: 0, id: 'test', title: 'A Song', artist: 'An Artist' };

function abortableFetch(): typeof fetch {
  return vi.fn(
    (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  );
}

describe('OpenRouter production transport', () => {
  it.each([
    [undefined, 'https://openrouter.ai/api/v1/chat/completions'],
    ['https://router.test/api/v1/', 'https://router.test/api/v1/chat/completions'],
    ['https://router.test/api/v1/chat/completions/', 'https://router.test/api/v1/chat/completions'],
  ])('uses the chat endpoint exactly once with base %s', async (baseUrl, endpoint) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response());
    const provider = new OpenRouterProvider(
      { apiKey: 'test-key', ...(baseUrl === undefined ? {} : { baseUrl }) },
      fetchMock,
    );
    expect(await provider.complete(request)).toEqual({
      model: 'verified-model',
      text: JSON.stringify(judgement),
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(endpoint);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: DEFAULT_OPENROUTER_MODEL,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'track_judgement', strict: true, schema: TRACK_JUDGEMENT_JSON_SCHEMA },
      },
      provider: { require_parameters: true },
      max_tokens: 800,
    });
    expect(provider.getStatus()).toMatchObject({
      configured: true,
      requests: 1,
      maxRequests: 1000,
      inFlight: 0,
      maxConcurrent: 8,
      lastSuccessAt: expect.any(String),
    });
    expect(JSON.stringify(provider.getStatus())).not.toContain('test-key');
  });

  it('normalizes empty configuration and rejects malformed limits', () => {
    expect(OpenRouterProvider.fromEnv({ OPENROUTER_API_KEY: '  ' })).toBeNull();
    const provider = OpenRouterProvider.fromEnv({
      OPENROUTER_API_KEY: ' test-key ',
      OPENROUTER_MODEL: '  ',
      AUX_LLM_MAX_CALLS: '0',
      AUX_LLM_MAX_CONCURRENT: '2',
    });
    expect(provider?.getStatus()).toMatchObject({
      model: DEFAULT_OPENROUTER_MODEL,
      maxRequests: 0,
      maxConcurrent: 2,
    });
    for (const bad of ['NaN', '-1', '2.5', 'Infinity', '2oops']) {
      expect(() =>
        OpenRouterProvider.fromEnv({ OPENROUTER_API_KEY: 'test-key', AUX_LLM_MAX_CALLS: bad }),
      ).toThrow('whole numbers');
    }
  });

  it.each([
    [400, 'request_failed', false],
    [401, 'auth', false],
    [402, 'payment_required', false],
    [403, 'auth', false],
    [404, 'request_failed', false],
    [429, 'rate_limited', true],
    [500, 'request_failed', true],
    [503, 'request_failed', true],
  ])('classifies HTTP %s without leaking response bodies', async (status, code, retryable) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('secret-provider-body', { status, headers: { 'retry-after': '2' } }),
      );
    const provider = new OpenRouterProvider({ apiKey: 'secret-key' }, fetchMock);
    await expect(provider.complete(request)).rejects.toMatchObject({ code, retryable, status });
    expect(provider.getStatus()).toMatchObject({ lastError: { code, status }, inFlight: 0 });
    expect(JSON.stringify(provider.getStatus())).not.toMatch(/secret-key|secret-provider-body/);
  });

  it('parses Retry-After and clears failure metadata on recovery', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0.5' } }))
      .mockResolvedValueOnce(response());
    const provider = new OpenRouterProvider({ apiKey: 'test-key' }, fetchMock);
    await expect(provider.complete(request)).rejects.toMatchObject({ retryAfterMs: 500 });
    await provider.complete(request);
    expect(provider.getStatus().lastError).toBeUndefined();
    expect(provider.getStatus().requests).toBe(2);
  });

  it.each([
    null,
    {},
    { choices: [{ message: { content: '' } }] },
    { choices: [{ finish_reason: 'length', message: { content: '{}' } }] },
    { choices: [{ finish_reason: 'error', message: { content: '{}' } }] },
    { error: { code: 503, message: 'private' } },
  ])('rejects malformed/truncated and embedded-error responses', async (body) => {
    const provider = new OpenRouterProvider(
      { apiKey: 'test-key' },
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)),
    );
    await expect(provider.complete(request)).rejects.toBeInstanceOf(LlmProviderError);
    expect(provider.getStatus().lastSuccessAt).toBeUndefined();
  });

  it('aborts the network request at the provider deadline and releases capacity', async () => {
    const provider = new OpenRouterProvider({ apiKey: 'test-key', timeoutMs: 5 }, abortableFetch());
    await expect(provider.complete(request)).rejects.toMatchObject({ code: 'timeout' });
    expect(provider.getStatus().inFlight).toBe(0);
  });

  it('enforces the request budget across retries and never sends excess calls', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response());
    const provider = new OpenRouterProvider({ apiKey: 'test-key', maxCalls: 1 }, fetchMock);
    await provider.complete(request);
    await expect(provider.complete(request)).rejects.toMatchObject({
      code: 'budget_exhausted',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provider.getStatus().requests).toBe(1);
  });

  it('judges twelve simultaneous tracks with eight slots instead of falling back after the eighth', async () => {
    const active: number[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      active.push(provider.getStatus().inFlight);
      return response();
    });
    const provider = new OpenRouterProvider({ apiKey: 'test-key' }, fetchMock);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => judgeTrack('A getaway', song, provider)),
    );
    expect(results.every((result) => result.judgeModel === 'verified-model')).toBe(true);
    expect(Math.max(...active)).toBeLessThanOrEqual(8);
    expect(provider.getStatus()).toMatchObject({ requests: 12, inFlight: 0, queued: 0 });
  });

  it('dispatches queued requests in arrival order and charges only actual dispatch', async () => {
    let finishFirst: ((res: Response) => void) | undefined;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockImplementation(async () => response());
    const provider = new OpenRouterProvider({ apiKey: 'test-key', maxConcurrent: 1 }, fetchMock);
    const pending = [0, 1, 2, 3].map((index) =>
      provider.complete({ messages: [{ role: 'user', content: String(index) }] }),
    );
    await Promise.resolve();
    expect(provider.getStatus()).toMatchObject({ requests: 1, inFlight: 1, queued: 3 });
    finishFirst!(response());
    await Promise.all(pending);
    expect(
      fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).messages[0].content),
    ).toEqual(['0', '1', '2', '3']);
    expect(provider.getStatus()).toMatchObject({ requests: 4, inFlight: 0, queued: 0 });
  });

  it('bounds the queue and never charges for rejected excess requests', async () => {
    let finishFirst: ((res: Response) => void) | undefined;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValue(response());
    const provider = new OpenRouterProvider(
      { apiKey: 'test-key', maxConcurrent: 1, maxQueued: 1 },
      fetchMock,
    );
    const first = provider.complete(request);
    const queued = provider.complete(request);
    await expect(provider.complete(request)).rejects.toMatchObject({
      code: 'busy',
      retryable: false,
    });
    expect(provider.getStatus()).toMatchObject({ requests: 1, queued: 1 });
    finishFirst!(response());
    await Promise.all([first, queued]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(provider.getStatus()).toMatchObject({ inFlight: 0, queued: 0 });
  });

  it('removes cancelled waiters and does not send or charge them later', async () => {
    let finishFirst: ((res: Response) => void) | undefined;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValue(response());
    const provider = new OpenRouterProvider({ apiKey: 'test-key', maxConcurrent: 1 }, fetchMock);
    const first = provider.complete(request);
    const cancellation = new AbortController();
    const cancelled = provider.complete({ ...request, signal: cancellation.signal });
    const third = provider.complete(request);
    cancellation.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'timeout' });
    expect(provider.getStatus()).toMatchObject({ requests: 1, queued: 1 });
    finishFirst!(response());
    await Promise.all([first, third]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(provider.getStatus()).toMatchObject({ requests: 2, inFlight: 0, queued: 0 });
  });

  it('checks cancellation again after reserving a slot but before dispatch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const provider = new OpenRouterProvider({ apiKey: 'test-key' }, fetchMock);
    const cancellation = new AbortController();
    const cancelled = provider.complete({ ...request, signal: cancellation.signal });
    cancellation.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'timeout' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(provider.getStatus()).toMatchObject({ requests: 0, inFlight: 0, queued: 0 });
  });

  it('rechecks the remaining budget for queued requests before dispatch', async () => {
    let finishFirst: ((res: Response) => void) | undefined;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValue(response());
    const provider = new OpenRouterProvider(
      { apiKey: 'test-key', maxConcurrent: 1, maxCalls: 2 },
      fetchMock,
    );
    const pending = Array.from({ length: 4 }, () => provider.complete(request));
    const results = Promise.allSettled(pending);
    await Promise.resolve();
    expect(provider.getStatus()).toMatchObject({ requests: 1, queued: 3 });
    finishFirst!(response());
    const settled = await results;
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(settled.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'budget_exhausted' }) }),
      expect.objectContaining({ reason: expect.objectContaining({ code: 'budget_exhausted' }) }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(provider.getStatus()).toMatchObject({ requests: 2, inFlight: 0, queued: 0 });
  });

  it('never overspends the last request across concurrently reserved slots', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response());
    const provider = new OpenRouterProvider(
      { apiKey: 'test-key', maxConcurrent: 8, maxCalls: 1 },
      fetchMock,
    );
    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, () => provider.complete(request)),
    );
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provider.getStatus()).toMatchObject({ requests: 1, inFlight: 0, queued: 0 });
  });

  it('releases slots and drains the queue when the adapter fails synchronously', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => {
        throw new Error('transport failed');
      })
      .mockResolvedValue(response());
    const provider = new OpenRouterProvider({ apiKey: 'test-key', maxConcurrent: 1 }, fetchMock);
    const settled = await Promise.allSettled([
      provider.complete(request),
      provider.complete(request),
    ]);
    expect(settled.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(provider.getStatus()).toMatchObject({ requests: 2, inFlight: 0, queued: 0 });
  });

  it('bounds waiting and active work even without a caller signal or a cooperative adapter', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const provider = new OpenRouterProvider(
      { apiKey: 'test-key', maxConcurrent: 1, timeoutMs: 5 },
      fetchMock,
    );
    const settled = await Promise.allSettled([
      provider.complete(request),
      provider.complete(request),
    ]);
    expect(settled).toEqual([
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'timeout' }),
      }),
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'timeout' }),
      }),
    ]);
    expect(provider.getStatus()).toMatchObject({ inFlight: 0, queued: 0 });
  });
});

describe('judge service over the real provider adapter', () => {
  it('returns the real judgement through the production request/parse pipeline', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response());
    const provider = new OpenRouterProvider({ apiKey: 'test-key' }, fetchMock);
    const judged = await judgeTrack('A getaway', song, provider);
    expect(judged).toMatchObject({
      judgeModel: 'verified-model',
      totalScore: 7,
      reasons: judgement.reasons,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.max_tokens).toBe(800);
    expect(body.messages[0].content).toContain('you cannot listen');
  });

  it.each([401, 402, 403, 404])('never repeats permanent HTTP %s failures', async (status) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('', { status }));
    const provider = new OpenRouterProvider({ apiKey: 'test-key' }, fetchMock);
    await expect(
      judgeTrack('A getaway', song, provider, { attempts: 3, backoffMs: 0 }),
    ).rejects.toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures and still applies the actual request cap', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(response());
    const provider = new OpenRouterProvider({ apiKey: 'test-key', maxCalls: 2 }, fetchMock);
    expect((await judgeTrack('A getaway', song, provider, { backoffMs: 0 })).judgeModel).toBe(
      'verified-model',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors long Retry-After by giving up without hammering the provider', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '60' } }));
    const provider = new OpenRouterProvider({ apiKey: 'test-key' }, fetchMock);
    await expect(judgeTrack('A getaway', song, provider)).rejects.toMatchObject({
      code: 'rate_limited',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels the transport when the service deadline is shorter than the provider deadline', async () => {
    const fetchMock = abortableFetch();
    const provider = new OpenRouterProvider({ apiKey: 'test-key' }, fetchMock);
    await expect(
      judgeTrack('A getaway', song, provider, { attempts: 1, timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: 'timeout' });
    await Promise.resolve();
    expect(provider.getStatus().inFlight).toBe(0);
  });

  it('removes a queued track when the service deadline expires, with no later paid dispatch', async () => {
    let finishFirst: ((res: Response) => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    );
    const provider = new OpenRouterProvider({ apiKey: 'test-key', maxConcurrent: 1 }, fetchMock);
    const first = provider.complete(request);
    await expect(
      judgeTrack('A getaway', song, provider, { attempts: 1, timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(provider.getStatus()).toMatchObject({ requests: 1, queued: 0 });
    finishFirst!(response());
    await first;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provider.getStatus()).toMatchObject({ requests: 1, inFlight: 0, queued: 0 });
  });

  it('reports invalid structured output as degraded rather than a healthy connection', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ choices: [{ message: { content: '{"totalScore": 7}' } }] }),
      );
    const provider = new OpenRouterProvider({ apiKey: 'test-key' }, fetchMock);
    await expect(judgeTrack('A getaway', song, provider, { attempts: 1 })).rejects.toThrow(
      'schema validation',
    );
    expect(provider.getStatus().lastError).toEqual({ code: 'invalid_response' });
  });

  it('continues safely if the failure logger itself throws', async () => {
    const provider = new OpenRouterProvider({ apiKey: 'test-key', maxCalls: 0 }, vi.fn());
    await expect(
      judgeTrack('A getaway', song, provider, {
        onFailure: () => {
          throw new Error('logger failed');
        },
      }),
    ).rejects.toMatchObject({ code: 'budget_exhausted' });
  });
});
