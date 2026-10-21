/** Vendor-neutral contract for judging, cancellation, and safe operational status. */
export interface LlmMessage {
  role: 'system' | 'user';
  content: string;
}

export interface LlmRequestContext {
  roomCode: string;
  roundIdx: number;
  promptVersion: string;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface LlmAttempt extends Partial<LlmRequestContext> {
  id: string;
  model: string;
  maxTokens: number;
}

export interface LlmAttemptRecord extends LlmAttempt {
  status: 'succeeded' | 'failed';
  dispatched: boolean;
  durationMs: number;
  usage?: LlmUsage;
  errorCode?: string;
}

export interface LlmAttemptHooks {
  /** Authorize and reserve budget before dispatch. A rejection prevents the paid request. */
  beforeAttempt?: (attempt: LlmAttempt) => void | Promise<void>;
  /** Reconcile a dispatched attempt. Raw prompts and provider bodies are never included. */
  onAttempt?: (record: LlmAttemptRecord) => void | Promise<void>;
}

export interface LlmCompleteRequest {
  messages: LlmMessage[];
  context?: LlmRequestContext;
  /** Providers map this to their native schema-constrained output mechanism. */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  /** Aborts the actual transport when the judge deadline expires. */
  signal?: AbortSignal;
}

export interface LlmCompleteResponse {
  text: string;
  model: string;
  usage?: LlmUsage;
}

export interface LlmProviderStatus {
  configured: true;
  provider: string;
  model: string;
  requests: number;
  maxRequests: number;
  inFlight: number;
  maxConcurrent: number;
  queued?: number;
  maxQueued?: number;
  lastError?: { code: string; status?: number };
  lastSuccessAt?: string;
  circuitOpenUntil?: string;
}

/** Safe, vendor-neutral error metadata; upstream bodies never enter status/logs. */
export class LlmProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

export interface LLMProvider {
  readonly providerName?: string;
  readonly modelName?: string;
  getStatus?(): LlmProviderStatus;
  /** Marks a transport success whose judgement failed local validation. */
  reportInvalidResponse?(): void;
  complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse>;
}
