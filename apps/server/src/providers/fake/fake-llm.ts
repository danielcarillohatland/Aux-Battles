/**
 * FakeLLM (D-012): deterministic LLMProvider for tests and local dev —
 * implements the SAME seam the judge consumes, so no vendor SDK ever leaks
 * into game logic. Returns schema-shaped JSON text; never calls network.
 */
import type {
  LlmCompleteRequest,
  LlmCompleteResponse,
  LLMProvider,
} from '../../judge/llm-provider.js';

export class FakeLLM implements LLMProvider {
  readonly prompts: LlmCompleteRequest[] = [];
  model = 'fake-llm-1';

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    this.prompts.push(req);
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    // Deterministic structured payload: consumers parse `text` as JSON.
    const text = JSON.stringify({
      winner: 'player-1',
      ranking: ['player-1'],
      explanation: `fake judgement for: ${lastUser?.content.slice(0, 80) ?? ''}`,
    });
    return { text, model: this.model };
  }
}
