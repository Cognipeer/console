/**
 * What the native clients put on the wire for the limit / reasoning rules of limits-reasoning-followups.test.ts: the
 * REAL contract runtime and the REAL agent-sdk provider run, only the network is scripted.
 *
 * It also pins the guard rails of the SDK that the console mirrors (`SDK_THINKING_*`): a budget the console fits under a
 * caller's cap must be one the SDK leaves alone, or it would raise `max_tokens` above the cap behind our back.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AzureModelProviderContract,
  TogetherModelProviderContract,
  VertexModelProviderContract,
} from '@/lib/providers/contracts/modelContracts';
import type { ModelProviderRuntime, NativeChatRequest } from '@/lib/providers/domains/model';
import {
  anthropicRuntime,
  bedrockRuntime,
  compatibleRuntime,
  completion,
  json,
  openAiRuntime,
  sse,
  stubUpstream,
} from '../helpers/nativeGateway';

afterEach(() => vi.unstubAllGlobals());

const ASK = [{ role: 'user' as const, content: 'hi' }];
const logger = { info() {}, warn() {}, error() {}, debug() {} };

const messageBody = () => json({
  id: 'msg', model: 'claude', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
});
const converseBody = () => json({
  output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
});

async function runtimeOf(
  contract: { createRuntime: unknown },
  credentials: Record<string, unknown>,
  settings: Record<string, unknown> = {},
): Promise<ModelProviderRuntime> {
  return (contract.createRuntime as (ctx: unknown) => Promise<ModelProviderRuntime>)({
    tenantId: 't', projectId: 'p', providerKey: 'prov', credentials, settings, metadata: {}, logger,
  });
}

/** The body the native client of `runtime` puts on the wire for these model settings and this request. */
async function sent(
  runtime: ModelProviderRuntime,
  respond: () => Response,
  modelId: string,
  modelSettings: Record<string, unknown>,
  request: Partial<NativeChatRequest> = {},
) {
  const upstream = stubUpstream(respond);
  const client = await runtime.createNativeChatClient!({ modelId, category: 'llm', modelSettings, options: { maxRetries: 0 } });
  await client.complete({ messages: ASK, ...request });
  return upstream.calls[0].body;
}

describe('Messages API: thinking under a limit the caller set', () => {
  let anthropic: ModelProviderRuntime;
  beforeAll(async () => {
    anthropic = await anthropicRuntime();
  });
  const wire = (modelSettings: Record<string, unknown>, request: Partial<NativeChatRequest> = {}, modelId = 'claude-sonnet-4-5') =>
    sent(anthropic, messageBody, modelId, modelSettings, request);

  it.each([
    [8000, 6976],
    [6000, 4976],
    [5000, 3976],
    [4096, 3072], // the smallest cap the SDK takes without raising it: its floor is 4096 and its reserve 1024
  ])('a request cap of %i stays as it is; the budget is fitted under it (%i)', async (cap, budget) => {
    const body = await wire({ reasoning: { effort: 'high' } }, { maxTokens: cap });
    expect(body.max_tokens).toBe(cap);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: budget });
  });

  it.each([4095, 3000, 1500])('a request cap of %i leaves no room: the call runs without thinking, with its sampling', async (cap) => {
    const body = await wire({ temperature: 0.5, reasoning: { effort: 'high' } }, { maxTokens: cap });
    expect(body.max_tokens).toBe(cap);
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBe(0.5);
  });

  it('the limit the gateway marks as the caller\'s in the model settings is a cap too', async () => {
    const body = await wire({ maxTokens: 6000, requestMaxTokens: 6000, reasoning: { effort: 'high' } });
    expect(body.max_tokens).toBe(6000);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4976 });
    const small = await wire({ maxTokens: 3000, requestMaxTokens: 3000, reasoning: { effort: 'high' } });
    expect(small.max_tokens).toBe(3000);
    expect(small.thinking).toBeUndefined();
  });

  it('an exact budget from the request is fitted the same way', async () => {
    const body = await wire({}, { maxTokens: 6000, reasoning: { budgetTokens: 5000 } });
    expect(body.max_tokens).toBe(6000);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4976 });
  });

  it('the limit the model record sets is not a cap: it is raised to budget + the answer headroom', async () => {
    const small = await wire({ maxTokens: 2000, reasoning: { effort: 'high' } });
    expect(small.max_tokens).toBe(20480);
    expect(small.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
    // Only just above the budget: the answer would have 3616 tokens.
    const near = await wire({ maxTokens: 20000, reasoning: { effort: 'high' } });
    expect(near.max_tokens).toBe(20480);
    expect(near.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
    const roomy = await wire({ maxTokens: 30000, reasoning: { effort: 'high' } });
    expect(roomy.max_tokens).toBe(30000);
  });

  it('one client, one model default: every call is fitted to its own limit', async () => {
    const upstream = stubUpstream(messageBody);
    const client = await anthropic.createNativeChatClient!({
      modelId: 'claude-sonnet-4-5',
      category: 'llm',
      modelSettings: { maxTokens: 20000, reasoning: { effort: 'high' } },
      options: { maxRetries: 0 },
    });
    await client.complete({ messages: ASK });
    await client.complete({ messages: ASK, maxTokens: 6000 });
    await client.complete({ messages: ASK, maxTokens: 3000 });
    await client.complete({ messages: ASK });
    expect(upstream.calls.map((call) => [call.body.max_tokens, call.body.thinking?.budget_tokens])).toEqual([
      [20480, 16384],
      [6000, 4976],
      [3000, undefined],
      [20480, 16384],
    ]);
  });

  it('a tool loop whose signed thinking was lost runs without thinking, whatever the request asks', async () => {
    const client = await anthropic.createNativeChatClient!({
      modelId: 'claude-sonnet-4-5', category: 'llm', modelSettings: { reasoning: { effort: 'low' } }, options: { maxRetries: 0 },
    });
    const prepared = await client.prepare({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'lookup', arguments: '{}' }] },
        { role: 'tool', content: 'r', toolCallId: 't1' },
      ],
      reasoning: { effort: 'high' },
    });
    expect(prepared.reasoning).toBeUndefined();
  });

  it('adaptive thinking under a caller cap is unchanged: it fits itself into it', async () => {
    const body = await wire({ reasoning: { effort: 'high' } }, { maxTokens: 3000 }, 'claude-sonnet-5-5');
    expect(body.max_tokens).toBe(3000);
    expect(body.thinking).toMatchObject({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'high' });
  });

  it('an operator thinking block in the extra body is the whole instruction: no fitting, no dropping', async () => {
    const body = await wire(
      { reasoning: { effort: 'high' }, requestDefaults: { thinking: { type: 'enabled', budget_tokens: 1500 } } },
      { maxTokens: 3000 },
    );
    expect(body.max_tokens).toBe(3000);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1500 });
  });
});

describe('Messages API: effort none on an adaptive Claude', () => {
  it.each([
    // The SDK sends the rule's own off switch, or the lowest effort when the model cannot be switched off.
    ['claude-sonnet-5-5', { type: 'between_tools' }, undefined],
    ['claude-haiku-5-5', { type: 'disabled' }, undefined],
    ['claude-opus-5-5', { type: 'adaptive', display: 'summarized' }, { effort: 'low' }],
    ['claude-fable-1', { type: 'adaptive', display: 'summarized' }, { effort: 'low' }],
  ])('%s: the limit gets no headroom', async (modelId, thinking, outputConfig) => {
    const body = await sent(await anthropicRuntime(), messageBody, modelId, { maxTokens: 1000, reasoning: { effort: 'none' } });
    expect(body.max_tokens).toBe(1000);
    expect(body.thinking).toEqual(thinking);
    expect(body.output_config).toEqual(outputConfig);
  });
});

describe('Bedrock Converse', () => {
  let bedrock: ModelProviderRuntime;
  beforeAll(async () => {
    bedrock = await bedrockRuntime();
  });
  const claude = 'eu.anthropic.claude-sonnet-4-5-v1:0';
  const wire = (modelId: string, modelSettings: Record<string, unknown>, request: Partial<NativeChatRequest> = {}) =>
    sent(bedrock, converseBody, modelId, modelSettings, request);

  it.each([
    [8000, 6976],
    [5000, 3976],
    [4096, 3072],
  ])('Claude under a request cap of %i: the cap stays, the budget is fitted (%i)', async (cap, budget) => {
    const body = await wire(claude, { reasoning: { effort: 'high' } }, { maxTokens: cap });
    expect(body.inferenceConfig.maxTokens).toBe(cap);
    expect(body.additionalModelRequestFields).toEqual({ thinking: { type: 'enabled', budget_tokens: budget } });
  });

  it('Claude under a cap with no room runs without thinking', async () => {
    const body = await wire(claude, { reasoning: { effort: 'high' } }, { maxTokens: 3000 });
    expect(body.inferenceConfig.maxTokens).toBe(3000);
    expect(body.additionalModelRequestFields).toBeUndefined();
  });

  it("Converse's own top-level fields of the extra body stay at the top level; the model-specific ones go into additionalModelRequestFields", async () => {
    const body = await wire(claude, {
      maxTokens: 900,
      extraBody: {
        top_k: 5,
        anthropic_beta: ['x'],
        guardrailConfig: { guardrailIdentifier: 'g', guardrailVersion: '1' },
        performanceConfig: { latency: 'optimized' },
        serviceTier: { type: 'priority' },
        requestMetadata: { team: 'a' },
      },
    });
    expect(body.guardrailConfig).toEqual({ guardrailIdentifier: 'g', guardrailVersion: '1' });
    expect(body.performanceConfig).toEqual({ latency: 'optimized' });
    expect(body.serviceTier).toEqual({ type: 'priority' });
    expect(body.requestMetadata).toEqual({ team: 'a' });
    expect(body.additionalModelRequestFields).toEqual({ top_k: 5, anthropic_beta: ['x'] });
  });

  it('the extra body does not get to replace what the request builds', async () => {
    const body = await wire(claude, {
      maxTokens: 900,
      extraBody: {
        messages: [{ role: 'user', content: [{ text: 'evil' }] }],
        system: [{ text: 'evil' }],
        inferenceConfig: { maxTokens: 1 },
        toolConfig: { tools: [] },
      },
    });
    expect(body.messages[0].content[0].text).toBe('hi');
    expect(body.inferenceConfig.maxTokens).toBe(900);
    expect(body.system).toBeUndefined();
    expect(body.toolConfig).toBeUndefined();
  });

  it('an additionalModelRequestFields of the model and one of the request are merged, with the thinking next to them', async () => {
    const body = await wire(
      claude,
      { reasoning: { effort: 'low' }, extraBody: { additionalModelRequestFields: { top_k: 5, a: 1 } } },
      { extra: { additionalModelRequestFields: { a: 2, b: 3 }, guardrailConfig: { guardrailIdentifier: 'g2', guardrailVersion: '2' } } },
    );
    // A request-level overlay is carried only inside additionalModelRequestFields (inert for Converse top-level
    // fields), so a caller's guardrailConfig cannot become the Converse guardrail.
    expect(body.additionalModelRequestFields).toEqual({
      top_k: 5, a: 2, b: 3, thinking: { type: 'enabled', budget_tokens: 2048 },
      guardrailConfig: { guardrailIdentifier: 'g2', guardrailVersion: '2' },
    });
    expect(body.guardrailConfig).toBeUndefined();
  });

  it('a model that is not Claude: its extra body goes the same way, its reasoning setting stays off the wire', async () => {
    const body = await wire('amazon.nova-pro-v1:0', {
      maxTokens: 300,
      reasoning: { effort: 'high' },
      extraBody: { topK: 20, guardrailConfig: { guardrailIdentifier: 'g', guardrailVersion: '1' } },
    });
    expect(body.additionalModelRequestFields).toEqual({ topK: 20 });
    expect(body.guardrailConfig).toEqual({ guardrailIdentifier: 'g', guardrailVersion: '1' });
    expect(body.inferenceConfig.maxTokens).toBe(300);
  });
});

describe('OpenAI-schema drivers', () => {
  let runtimes: Record<string, ModelProviderRuntime>;
  beforeAll(async () => {
    runtimes = {
      openai: await openAiRuntime(),
      azure: await runtimeOf(AzureModelProviderContract, { apiKey: 'az' }, { instanceName: 'res', deploymentName: 'dep', apiVersion: '2024-10-21' }),
      'openai-compatible': await compatibleRuntime(),
      together: await runtimeOf(TogetherModelProviderContract, { apiKey: 'k' }),
    };
  });
  const wire = (driver: string, modelId: string, modelSettings: Record<string, unknown>, request: Partial<NativeChatRequest> = {}) =>
    sent(runtimes[driver], () => json(completion()), modelId, modelSettings, request);

  const TARGETS: Array<[string, string]> = [
    ['openai', 'gpt-5.2'],
    ['azure', 'gpt-5'],
    ['openai-compatible', 'gpt-5.6-luna'],
    ['together', 'openai/gpt-oss-120b'],
  ];

  describe('a token budget with no effort is sent as the effort it stands for', () => {
    it.each(TARGETS)('%s / %s', async (driver, modelId) => {
      for (const [budgetTokens, effort] of [[1500, 'low'], [5000, 'medium'], [20000, 'high']] as const) {
        const configured = await wire(driver, modelId, { reasoning: { budgetTokens } });
        expect(configured.reasoning_effort).toBe(effort);
        // The same for a budget the request carries.
        const requested = await wire(driver, modelId, {}, { reasoning: { budgetTokens } });
        expect(requested.reasoning_effort).toBe(effort);
      }
    });

    it.each(TARGETS)('%s / %s: an effort beats the budget next to it', async (driver, modelId) => {
      const body = await wire(driver, modelId, { reasoning: { effort: 'medium', budgetTokens: 20000 } });
      expect(body.reasoning_effort).toBe('medium');
    });

    it('effort none beats it too', async () => {
      expect((await wire('openai', 'gpt-5.2', { reasoning: { effort: 'none', budgetTokens: 20000 } })).reasoning_effort).toBe('none');
      expect((await wire('openai-compatible', 'gpt-5.6-luna', { reasoning: { effort: 'none', budgetTokens: 20000 } })).reasoning_effort).toBe('none');
    });
  });

  describe('the limit of a reasoning model is sized for its effort', () => {
    it("the model record's small limit is raised", async () => {
      const body = await wire('openai', 'gpt-5.2', { maxTokens: 400, reasoning: { effort: 'high' } });
      expect(body.max_completion_tokens).toBe(32768);
      expect(body.max_tokens).toBeUndefined();
      expect(body.reasoning_effort).toBe('high');
      // The model that keeps `max_tokens` keeps its name for it.
      const gptOss = await wire('openai-compatible', 'gpt-oss-120b', { maxTokens: 400, reasoning: { effort: 'medium' } });
      expect(gptOss.max_tokens).toBe(16384);
    });

    it("a caller's limit is a hard cap", async () => {
      const request = await wire('openai', 'gpt-5.2', { maxTokens: 400, reasoning: { effort: 'high' } }, { maxTokens: 300 });
      expect(request.max_completion_tokens).toBe(300);
      const marked = await wire('openai', 'gpt-5.2', { maxTokens: 400, requestMaxTokens: 300, reasoning: { effort: 'high' } });
      expect(marked.max_completion_tokens).toBe(300);
    });

    it('a model that does not reason keeps the limit it was given', async () => {
      const body = await wire('openai', 'gpt-4o', { maxTokens: 400, reasoning: { effort: 'high' } });
      expect(body.max_tokens).toBe(400);
    });
  });
});

describe('Vertex', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const SAFETY = [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }];
  const thoughtChunk = (text: string, thought?: boolean) => ({
    candidates: [{ content: { role: 'model', parts: [{ text, ...(thought ? { thought: true } : {}) }] } }],
  });

  let vertex: ModelProviderRuntime;
  beforeAll(async () => {
    vertex = await runtimeOf(
      VertexModelProviderContract,
      { serviceAccountKey: JSON.stringify({ client_email: 'svc@proj.iam.gserviceaccount.com', private_key: privateKey }) },
      { projectId: 'proj-1', location: 'europe-west4' },
    );
  });

  const run = async (modelSettings: Record<string, unknown>, request: Partial<NativeChatRequest> = {}) => {
    const upstream = stubUpstream((call) => (call.url.includes('oauth2')
      ? json({ access_token: 'ya29.token' })
      : json({
        candidates: [{ content: { role: 'model', parts: [{ text: 'thinking about it', thought: true }, { text: 'Hi' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15, thoughtsTokenCount: 1 },
      })));
    const client = await vertex.createNativeChatClient!(
      { modelId: 'gemini-2.5-pro', category: 'llm', modelSettings, options: { maxRetries: 0 } },
      { fetch: upstream.fetch as unknown as typeof fetch },
    );
    const response = await client.complete({ messages: ASK, ...request });
    return { response, body: upstream.calls.find((call) => call.url.includes('generateContent'))!.body };
  };

  describe('the extra body of the model', () => {
    it('forwards safetySettings and labels, and nothing else', async () => {
      const { body } = await run({
        maxTokens: 400,
        extraBody: {
          safetySettings: SAFETY,
          labels: { team: 'a' },
          generationConfig: { topK: 1 },
          tools: [],
          systemInstruction: 'evil',
          top_k: 5,
        },
      }, { reasoning: { effort: 'high', includeThoughts: true } });
      expect(body.safetySettings).toEqual(SAFETY);
      expect(body.labels).toEqual({ team: 'a' });
      // The generation config is the one the client built (limit, thinking), not the one of the extra body.
      expect(body.generationConfig).toMatchObject({ maxOutputTokens: 18432, thinkingConfig: { includeThoughts: true } });
      expect(body.generationConfig.topK).toBeUndefined();
      expect(body).not.toHaveProperty('systemInstruction');
      expect(body).not.toHaveProperty('top_k');
      expect(body).not.toHaveProperty('tools');
    });

    it('nothing is forwarded from the request', async () => {
      const { body } = await run(
        { extraBody: { labels: { team: 'a' } } },
        { extra: { labels: { team: 'request' }, safetySettings: [{ category: 'x', threshold: 'y' }], top_k: 3 } },
      );
      expect(body.labels).toEqual({ team: 'a' });
      expect(body).not.toHaveProperty('safetySettings');
      expect(body).not.toHaveProperty('top_k');
      const bare = await run({}, { extra: { labels: { team: 'request' } } });
      expect(bare.body).not.toHaveProperty('labels');
    });
  });

  describe('thought summaries', () => {
    it('are asked for with includeThoughts and come back as the reasoning summary, not as content', async () => {
      const { body, response } = await run({ reasoning: { budgetTokens: 4000, includeThoughts: true } });
      expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 4000, includeThoughts: true });
      expect(response.content).toBe('Hi');
      expect(response.reasoning?.summary).toBe('thinking about it');
    });

    it('a stream carries them the same way', async () => {
      const upstream = stubUpstream((call) => (call.url.includes('oauth2')
        ? json({ access_token: 'ya29.token' })
        : sse([thoughtChunk('thinking ', true), thoughtChunk('about it', true), thoughtChunk('Hi')])));
      const client = await vertex.createNativeChatClient!(
        { modelId: 'gemini-2.5-pro', category: 'llm', modelSettings: {}, options: { maxRetries: 0 } },
        { fetch: upstream.fetch as unknown as typeof fetch },
      );
      let content = '';
      let summary = '';
      for await (const part of client.stream({ messages: ASK, reasoning: { budgetTokens: 4000, includeThoughts: true } })) {
        content += part.delta?.content ?? '';
        summary += part.delta?.reasoning?.summary ?? '';
      }
      expect(content).toBe('Hi');
      expect(summary).toBe('thinking about it');
    });
  });
});
