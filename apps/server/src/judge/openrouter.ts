import { randomUUID } from 'node:crypto';
/** OpenRouter transport. All limits count actual requests, including retries. */
import {
  LlmProviderError,
  type LLMProvider,
  type LlmCompleteRequest,
  type LlmCompleteResponse,
  type LlmProviderStatus,
  type LlmAttempt,
  type LlmAttemptHooks,
  type LlmUsage,
} from './llm-provider.js';

// Verified against the public model catalog; operators can pin another compatible model.
export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-3.1-flash-lite';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const REQUEST_TIMEOUT_MS = 15_000;

export class LlmAuthError extends LlmProviderError {
  constructor(status: number, message: string) {
    super('auth', message, false, status);
    this.name = 'LlmAuthError';
  }
}

export class LlmRateLimitError extends LlmProviderError {
  constructor(retryAfterMs: number | undefined) {
    super('rate_limited', 'OpenRouter rate limited the request (429)', true, 429, retryAfterMs);
    this.name = 'LlmRateLimitError';
  }
}

export class LlmRequestError extends LlmProviderError {
  constructor(status: number, message: string) {
    super(
      status === 402 ? 'payment_required' : 'request_failed',
      message,
      status === 0 || status === 408 || status >= 500,
      status,
    );
    this.name = 'LlmRequestError';
  }
}

export interface OpenRouterProviderOptions {
  apiKey: string;
  model?: string;
  /** API base URL; a full chat-completions URL is also accepted for compatibility. */
  baseUrl?: string;
  timeoutMs?: number;
  maxCalls?: number;
  maxConcurrent?: number;
  /** Pending callers are bounded separately from active network requests. */
  maxQueued?: number;
  attemptHooks?: LlmAttemptHooks;
  circuitFailureThreshold?: number;
  circuitCooldownMs?: number;
}

interface PendingRequest {
  signal: AbortSignal;
  resolve: () => void;
  reject: (error: LlmProviderError) => void;
  onAbort: () => void;
}

interface ChatCompletionResponse {
  model?: unknown;
  error?: { code?: unknown };
  usage?: unknown;
  choices?: Array<{
    message?: { content?: unknown };
    finish_reason?: unknown;
    error?: { code?: unknown };
  }>;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds)) return Math.max(0, Math.round(asSeconds * 1000));
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

function integerSetting(value: string | number | undefined, fallback: number, min: number): number {
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new Error(`AI judge limits must be whole numbers greater than or equal to ${min}`);
  }
  return parsed;
}

function responseError(status: number, retryAfter?: string | null): LlmProviderError {
  if (status === 401 || status === 403) {
    return new LlmAuthError(status, `OpenRouter rejected credentials (${status})`);
  }
  if (status === 429) return new LlmRateLimitError(parseRetryAfter(retryAfter ?? null));
  return new LlmRequestError(
    status,
    status === 402 ? 'OpenRouter requires credits (402)' : `OpenRouter returned ${status}`,
  );
}

/** Ignore malformed, negative, non-finite and stringified usage instead of billing guesses. */
export function parseOpenRouterUsage(raw: unknown): LlmUsage | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const usage: LlmUsage = {};
  for (const [source, destination] of [
    ['prompt_tokens', 'inputTokens'],
    ['completion_tokens', 'outputTokens'],
    ['total_tokens', 'totalTokens'],
  ] as const) {
    const count = value[source];
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
      usage[destination] = count;
  }
  const cost = value['cost'];
  if (
    typeof cost === 'number' &&
    Number.isFinite(cost) &&
    cost >= 0 &&
    Number.isSafeInteger(Math.ceil(cost * 1_000_000))
  )
    usage.costUsd = cost;
  return Object.keys(usage).length ? usage : undefined;
}

export class OpenRouterProvider implements LLMProvider {
  readonly providerName = 'openrouter';
  readonly modelName: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxCalls: number;
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly pending: PendingRequest[] = [];
  private requests = 0;
  private inFlight = 0;
  private lastError: LlmProviderStatus['lastError'];
  private lastSuccessAt: string | undefined;
  private attemptHooks: LlmAttemptHooks;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private readonly circuitFailureThreshold: number;
  private readonly circuitCooldownMs: number;

  constructor(options: OpenRouterProviderOptions, fetchImpl: typeof fetch = fetch) {
    if (options.apiKey.trim() === '') throw new Error('OpenRouterProvider requires an apiKey');
    this.apiKey = options.apiKey.trim();
    this.modelName = options.model?.trim() || DEFAULT_OPENROUTER_MODEL;
    if (this.modelName.length > 160) throw new Error('OpenRouter model identifier is too long');
    const base = (options.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, '');
    this.endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = integerSetting(options.timeoutMs, REQUEST_TIMEOUT_MS, 1);
    this.maxCalls = integerSetting(options.maxCalls, 1000, 0);
    this.maxConcurrent = integerSetting(options.maxConcurrent, 8, 1);
    this.maxQueued = integerSetting(options.maxQueued, 64, 0);
    this.attemptHooks = options.attemptHooks ?? {};
    this.circuitFailureThreshold = integerSetting(options.circuitFailureThreshold, 3, 1);
    this.circuitCooldownMs = integerSetting(options.circuitCooldownMs, 30_000, 1);
  }

  static fromEnv(env: NodeJS.ProcessEnv): OpenRouterProvider | null {
    const apiKey = env['OPENROUTER_API_KEY']?.trim();
    if (!apiKey) return null;
    return new OpenRouterProvider({
      apiKey,
      ...(env['OPENROUTER_MODEL'] !== undefined ? { model: env['OPENROUTER_MODEL'] } : {}),
      maxCalls: integerSetting(env['AUX_LLM_MAX_CALLS'], 1000, 0),
      maxConcurrent: integerSetting(env['AUX_LLM_MAX_CONCURRENT'], 8, 1),
    });
  }

  setAttemptHooks(hooks: LlmAttemptHooks): void {
    this.attemptHooks = hooks;
  }

  /** No secret, prompt, song, or upstream error body is exposed here. */
  getStatus(): LlmProviderStatus {
    return {
      configured: true,
      provider: this.providerName,
      model: this.modelName,
      requests: this.requests,
      maxRequests: this.maxCalls,
      inFlight: this.inFlight,
      maxConcurrent: this.maxConcurrent,
      queued: this.pending.length,
      ...(this.circuitOpenUntil > Date.now()
        ? { circuitOpenUntil: new Date(this.circuitOpenUntil).toISOString() }
        : {}),
      maxQueued: this.maxQueued,
      ...(this.lastError === undefined ? {} : { lastError: { ...this.lastError } }),
      ...(this.lastSuccessAt === undefined ? {} : { lastSuccessAt: this.lastSuccessAt }),
    };
  }

  reportInvalidResponse(): void {
    this.recordFailure(
      new LlmProviderError('invalid_response', 'Judge response failed validation', true),
    );
  }

  private recordFailure(error: LlmProviderError): LlmProviderError {
    if (!['cancelled', 'budget_exhausted', 'circuit_open', 'busy'].includes(error.code)) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.circuitFailureThreshold)
        this.circuitOpenUntil = Date.now() + this.circuitCooldownMs;
    }
    this.lastError = {
      code: error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
    };
    return error;
  }

  /** Reserve a slot in arrival order; waiting never consumes the request allowance. */
  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(this.cancelled());
    if (this.circuitOpenUntil > Date.now())
      return Promise.reject(
        new LlmProviderError('circuit_open', 'AI judge is cooling down after an outage', false),
      );
    if (this.requests >= this.maxCalls) return Promise.reject(this.budgetExhausted());
    if (this.inFlight < this.maxConcurrent && this.pending.length === 0) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    if (this.pending.length >= this.maxQueued) {
      return Promise.reject(new LlmProviderError('busy', 'AI judge request queue is full', false));
    }
    return new Promise((resolve, reject) => {
      const waiter: PendingRequest = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.pending.indexOf(waiter);
          if (index >= 0) this.pending.splice(index, 1);
          signal.removeEventListener('abort', waiter.onAbort);
          reject(this.cancelled());
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.pending.push(waiter);
    });
  }

  private cancelled(): LlmProviderError {
    return new LlmProviderError('timeout', 'OpenRouter request timed out or was cancelled', true);
  }

  private budgetExhausted(): LlmProviderError {
    return new LlmProviderError('budget_exhausted', 'AI judge request budget is exhausted', false);
  }

  private release(): void {
    this.inFlight -= 1;
    while (this.inFlight < this.maxConcurrent && this.pending.length > 0) {
      const waiter = this.pending.shift()!;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(this.cancelled());
      } else if (this.requests >= this.maxCalls) {
        waiter.reject(this.budgetExhausted());
      } else {
        this.inFlight += 1;
        waiter.resolve();
      }
    }
  }

  /** The deadline also bounds adapters/bodies that fail to reject on abort. */
  private withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(this.cancelled());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
      if (signal.aborted) onAbort();
    });
  }

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const controller = new AbortController();
    const signal = req.signal
      ? AbortSignal.any([controller.signal, req.signal])
      : controller.signal;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    let acquired = false;
    let authorized = false;
    let dispatched = false;
    let succeeded = false;
    let usage: LlmUsage | undefined;
    let errorCode: string | undefined;
    const startedAt = Date.now();
    const attempt: LlmAttempt = {
      id: randomUUID(),
      model: this.modelName,
      maxTokens: req.maxTokens ?? 800,
      ...(req.context ?? {}),
    };
    try {
      await this.acquire(signal);
      acquired = true;
      // A queued caller may be cancelled after reservation but before this continuation.
      if (signal.aborted) throw this.cancelled();
      // Recheck atomically at actual dispatch: other reserved slots may have spent the final call.
      if (this.requests >= this.maxCalls) throw this.budgetExhausted();
      if (this.attemptHooks.beforeAttempt) await this.attemptHooks.beforeAttempt(attempt);
      authorized = true;
      if (signal.aborted) throw this.cancelled();
      if (this.requests >= this.maxCalls) throw this.budgetExhausted();
      if (this.circuitOpenUntil > Date.now())
        throw new LlmProviderError(
          'circuit_open',
          'AI judge is cooling down after an outage',
          false,
        );
      const init: RequestInit = {
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          'x-openrouter-title': 'AUX BATTLES',
        },
        body: JSON.stringify({
          model: this.modelName,
          messages: req.messages,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          ...(req.jsonSchema !== undefined
            ? {
                response_format: {
                  type: 'json_schema',
                  json_schema: { name: 'track_judgement', strict: true, schema: req.jsonSchema },
                },
                provider: { require_parameters: true },
              }
            : {}),
        }),
      };
      this.requests += 1;
      dispatched = true;
      const res = await this.withAbort(this.fetchImpl(this.endpoint, init), signal);
      if (!res.ok) {
        // Never log provider bodies: these may contain request data or credentials.
        if (res.body) await this.withAbort(res.body.cancel(), signal);
        throw responseError(res.status, res.headers.get('retry-after'));
      }
      const body = (await this.withAbort(res.json(), signal)) as ChatCompletionResponse | null;
      usage = parseOpenRouterUsage(body?.usage);
      const choice = body?.choices?.[0];
      const upstreamError = body?.error ?? choice?.error;
      if (upstreamError !== undefined) {
        const status = typeof upstreamError.code === 'number' ? upstreamError.code : 502;
        throw responseError(status);
      }
      if (choice?.finish_reason === 'length') {
        throw new LlmProviderError(
          'request_failed',
          'OpenRouter response exceeded its token limit',
          true,
        );
      }
      if (choice?.finish_reason === 'error') {
        throw new LlmProviderError(
          'request_failed',
          'OpenRouter could not complete the judgement',
          true,
        );
      }
      if (choice?.finish_reason === 'content_filter') {
        throw new LlmProviderError('request_failed', 'OpenRouter declined this judgement', false);
      }
      const text = choice?.message?.content;
      if (typeof text !== 'string' || text.trim() === '' || text.length > 20_000) {
        throw new LlmProviderError(
          'request_failed',
          'OpenRouter response had invalid text content',
          true,
        );
      }
      if (typeof body?.model === 'string' && body.model.length > 160) {
        throw new LlmProviderError(
          'invalid_response',
          'OpenRouter returned an invalid model identifier',
          false,
        );
      }
      this.lastError = undefined;
      this.consecutiveFailures = 0;
      this.circuitOpenUntil = 0;
      succeeded = true;
      this.lastSuccessAt = new Date().toISOString();
      return {
        text,
        ...(usage ? { usage } : {}),
        model: typeof body?.model === 'string' && body.model.trim() ? body.model : this.modelName,
      };
    } catch (error: unknown) {
      const safeError = signal.aborted
        ? this.cancelled()
        : error instanceof LlmProviderError
          ? error
          : new LlmProviderError('request_failed', 'OpenRouter request failed', true);
      errorCode = safeError.code;
      throw this.recordFailure(safeError);
    } finally {
      clearTimeout(timer);
      if (acquired) this.release();
      if (authorized) {
        try {
          await this.attemptHooks.onAttempt?.({
            ...attempt,
            status: succeeded ? 'succeeded' : 'failed',
            dispatched,
            durationMs: Date.now() - startedAt,
            ...(usage ? { usage } : {}),
            ...(errorCode ? { errorCode } : {}),
          });
        } catch {
          // The reservation stays charged if reconciliation cannot persist; fail closed.
          this.circuitOpenUntil = Date.now() + this.circuitCooldownMs;
          throw this.recordFailure(
            new LlmProviderError(
              'accounting_unavailable',
              'AI usage accounting is unavailable',
              false,
            ),
          );
        }
      }
    }
  }
}
