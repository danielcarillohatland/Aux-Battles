import type { LLMProvider, LlmCompleteRequest, LlmCompleteResponse } from './llm-provider.js';

export class OpenRouterProvider implements LLMProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model = 'google/gemini-2.0-flash-001',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const res = await this.fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        'x-title': 'AUX BATTLES',
      },
      body: JSON.stringify({
        model: this.model,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        ...(req.jsonSchema !== undefined
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'aux_judgement', strict: true, schema: req.jsonSchema },
              },
            }
          : {}),
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter returned ${res.status}`);
    const body = (await res.json()) as {
      model?: unknown;
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('OpenRouter response had no text');
    return { text, model: typeof body.model === 'string' ? body.model : this.model };
  }
}
