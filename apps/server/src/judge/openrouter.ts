/**
 * OpenRouterProvider (D-012): LLMProvider implementation backed by OpenRouter's
 * OpenAI-compatible chat-completions API. Constructed from env config so the
 * judge vendor is switchable without touching call sites:
 *   OPENROUTER_API_KEY — required; without it fromEnv() yields null.
 *   OPENROUTER_MODEL   — optional; defaults to 'anthropic/claude-3.5-haiku' (cost).
 */
import type { LLMProvider, LlmCompleteRequest, LlmCompleteResponse } from './llm-provider.js';

export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-3.5-haiku';

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 15_000;

/** Typed error for auth failures (HTTP 401/403) — bad/revoked/unauthorized key. */
export class LlmAuthError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'LlmAuthError';
    this.status = status;
  }
}

/** Typed error for rate limiting (HTTP 429); carries server-advised backoff. */
export class LlmRateLimitError extends Error {
  /** Milliseconds to wait before retrying, parsed from Retry-After (undefined if absent/unparseable). */
  readonly retryAfterMs: number | undefined;

  constructor(retryAfterMs: number | undefined) {
    super('OpenRouter rate limited the request (429)');
    this.name = 'LlmRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Non-retryable client failure (HTTP 4xx other than auth/rate-limit). */
export class LlmRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'LlmRequestError';
    this.status = status;
  }
}

export interface OpenRouterProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

interface ChatCompletionResponse {
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
}

/** Parses a Retry-After header value (delta-seconds or HTTP-date) into ms. */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds)) return Math.max(0, Math.round(asSeconds * 1000));
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

export class OpenRouterProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenRouterProviderOptions, fetchImpl: typeof fetch = fetch) {
    if (options.apiKey === '') throw new Error('OpenRouterProvider requires an apiKey');
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_OPENROUTER_MODEL;
    this.baseUrl = (options.baseUrl ?? OPENROUTER_CHAT_URL).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  /** Env-driven factory (D-012): null signals "no vendor configured" so callers can fall back. */
  static fromEnv(env: NodeJS.ProcessEnv): LLMProvider | null {
    const apiKey = env['OPENROUTER_API_KEY'];
    if (apiKey === undefined || apiKey === '') return null;
    return new OpenRouterProvider({
      apiKey,
      ...(env['OPENROUTER_MODEL'] !== undefined ? { model: env['OPENROUTER_MODEL'] } : {}),
    });
  }

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          // OpenRouter attribution headers.
          'http-referer': 'https://aux-battles.local',
          'x-title': 'AUX BATTLES',
        },
        body: JSON.stringify({
          model: this.model,
          messages: req.messages,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          // Structured-output ask maps to OpenAI-compatible JSON mode.
          ...(req.jsonSchema !== undefined ? { response_format: { type: 'json_object' } } : {}),
        }),
      });

      if (res.status === 401 || res.status === 403) {
        throw new LlmAuthError(res.status, `OpenRouter rejected credentials (${res.status})`);
      }
      if (res.status === 429) {
        throw new LlmRateLimitError(parseRetryAfter(res.headers.get('retry-after')));
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new LlmRequestError(
          res.status,
          `OpenRouter returned ${res.status}${detail !== '' ? `: ${detail.slice(0, 300)}` : ''}`,
        );
      }

      const body = (await res.json()) as ChatCompletionResponse;
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        throw new LlmRequestError(res.status, 'OpenRouter response had no text content');
      }
      return { text, model: typeof body.model === 'string' ? body.model : this.model };
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        throw new LlmRequestError(0, `OpenRouter request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
