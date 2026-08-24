/**
 * LLMProvider seam (D-012): judge logic depends on this interface only.
 * Vendor SDKs (OpenRouter/OpenAI/Anthropic/local) implement it behind config.
 * Structured-output contract is enforced ABOVE this line (JudgeService, Phase 4).
 */
export interface LlmMessage {
  role: 'system' | 'user';
  content: string;
}

export interface LlmCompleteRequest {
  messages: LlmMessage[];
  /** Vendor-agnostic ask for schema-constrained output; impls map to their native mechanism. */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmCompleteResponse {
  text: string;
  model: string;
}

export interface LLMProvider {
  complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse>;
}
