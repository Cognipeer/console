/**
 * A Dynamic LLM's fallback and the retry pinned to the child that ran (gatewayRouting.ts), with the
 * router called directly and the gateway core replaced by a script:
 *  - G4-8: the fallback is for anything but a caller that hung up or a guardrail's verdict (a 400 / 401 /
 *    403 / 404 included: credentials, deployment and config are the primary's own); the output limit is
 *    lowered to the fallback's own maximum.
 *  - G4-9: a call that names a child runs on it and makes no decision, and every attempt tells its
 *    caller which child it ran on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getModelByKey = vi.fn();
const logModelUsage = vi.fn();
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: (...a: unknown[]) => getModelByKey(...a) }));
vi.mock('@/lib/services/models/usageLogger', () => ({ logModelUsage: (...a: unknown[]) => logModelUsage(...a) }));
vi.mock('@/lib/services/models/dynamicRoutingState', () => ({
  getConversationState: vi.fn().mockResolvedValue({}),
  getConversationCostUsd: vi.fn().mockResolvedValue(0),
  getRouterSpendUsd: vi.fn().mockResolvedValue(0),
  getSegmentIoRatio: vi.fn().mockReturnValue(undefined),
  getModelProfiles: vi.fn().mockResolvedValue(new Map()),
  recordRoutedUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/guardrail/hooks/recordCache', () => ({ getCachedGuardrail: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/services/guardrail', () => ({ evaluateGuardrail: vi.fn(), createStreamGate: vi.fn() }));
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn(), runWithTenantScope: vi.fn() }));

import type { IDynamicRoutingConfig, IModel } from '@/lib/database';
import { resolveDynamicCompletion, withRouterHandoff } from '@/lib/services/models/gatewayRouting';
import { GuardrailBlockError } from '@/lib/services/models/gatewayGuardrails';
import { OutputTokenLimitError, UpstreamFinishError } from '@/lib/services/models/openaiErrors';
import { runWithRoutingCaller } from '@/lib/services/models/routingCallerContext';
import type { GatewayCallContext, ModelCallInput, ModelCallOutcome } from '@/lib/services/models/gatewayTypes';

const execute = vi.fn();
const models: Record<string, IModel> = {};

const llm = (key: string, extra: object = {}) => ({
  _id: `${key}-id`, tenantId: 't', projectId: 'p', name: key, key, providerKey: `prov-${key}`, providerDriver: 'openai',
  category: 'llm', modelId: key, settings: {}, pricing: { inputTokenPer1M: 10, outputTokenPer1M: 30 }, ...extra,
}) as unknown as IModel;

const config = (extra: Partial<IDynamicRoutingConfig> = {}): IDynamicRoutingConfig => ({
  strategy: 'rule-based', defaultModelKey: 'big', fallbackModelKey: 'small', rules: [], ...extra,
});
/** Sends every `portal` caller to the small model, whatever the default is. */
const portalToSmall = {
  label: 'portal', targetModelKey: 'small', matchType: 'all',
  conditions: [{ signal: 'channel', operator: 'in', value: ['portal'] }],
} as never;

const MESSAGES = [{ role: 'user', content: 'hi' }];
const failure = (message: string, status?: number) => Object.assign(new Error(message), status ? { status } : {});
const served = (key: string) => ({
  requestId: `req-${key}`,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  result: { response: { id: 'r', model: key, content: 'ok', toolCalls: [], usage: {}, finishReason: 'stop' } },
}) as unknown as ModelCallOutcome;

interface CallOptions {
  config?: IDynamicRoutingConfig;
  wire?: Record<string, unknown>;
  request?: Record<string, unknown>;
  context?: GatewayCallContext;
}
/** One call into the router; `execute` (the core) is the script. */
const call = (options: CallOptions = {}) => {
  const cfg = options.config ?? config();
  const wire = options.wire ?? { model: 'router', messages: MESSAGES, max_tokens: 100 };
  const input: ModelCallInput = {
    tenantDbName: 'tenant_x', tenantId: 't', projectId: 'p', modelKey: 'router',
    request: (options.request ?? { messages: MESSAGES }) as never,
    wire,
    ...(options.context ? { context: options.context } : {}),
  };
  return resolveDynamicCompletion({
    input, wire, router: llm('router', { settings: { dynamic: cfg } }), config: cfg, depth: 0, execute,
  });
};
const executed = (index: number) => execute.mock.calls[index][0] as ModelCallInput;
const routerRows = () => logModelUsage.mock.calls
  .map((args) => args[2] as { route: string; status: string; routing?: { chosenModelKey: string } })
  .filter((row) => row.route === 'chat.completions.router');

beforeEach(() => {
  execute.mockReset();
  getModelByKey.mockReset();
  logModelUsage.mockReset();
  logModelUsage.mockResolvedValue(undefined);
  for (const key of Object.keys(models)) delete models[key];
  for (const model of [llm('big'), llm('small')]) models[model.key] = model;
  getModelByKey.mockImplementation(async (_db: string, key: string) => models[key] ?? null);
});

describe('what the fallback is for (G4-8)', () => {
  const FALLS_BACK: Array<[string, Error]> = [
    ['a 503', failure('overloaded', 503)],
    ['a 500', failure('boom', 500)],
    ['a 429', failure('slow down', 429)],
    ['a dropped connection', failure('fetch failed')],
    ['an error that carries no status', new Error('something odd')],
    // The credentials, the deployment and the config are the primary's own: a second model may well answer.
    ['a 400', failure('bad request', 400)],
    ['a 401', failure('bad key', 401)],
    ['a 403', failure('forbidden', 403)],
    ['a 404', failure('no such deployment', 404)],
    ['a 400 the SDK nested under response', Object.assign(new Error('wrapped'), { response: { status: 400 } })],
    ['a 401 the SDK nested under cause', Object.assign(new Error('wrapped'), { cause: { statusCode: 401 } })],
  ];
  it.each(FALLS_BACK)('falls back when the primary fails with %s', async (_label, error) => {
    execute.mockRejectedValueOnce(error).mockResolvedValueOnce(served('small'));
    const outcome = await call();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(executed(1).modelKey).toBe('small');
    expect(outcome.routing).toMatchObject({ role: 'router', chosenModelKey: 'small', decision: 'fallback' });
  });

  const NO_FALLBACK: Array<[string, Error]> = [
    ['a guardrail block', new GuardrailBlockError('blocked', 'gr-1', 'block')],
    // The fallback runs under the same limit: it would most likely be cut off too, at double the cost.
    ['an output limit', new OutputTokenLimitError(100)],
  ];
  it.each(NO_FALLBACK)('does not fall back when the primary fails with %s: the error surfaces and the router logs it', async (_label, error) => {
    execute.mockRejectedValueOnce(error);
    await expect(call()).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(routerRows()).toEqual([expect.objectContaining({ status: 'error' })]);
  });

  it('does not fall back for a caller that hung up, whatever the error says', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = failure('aborted', 503);
    execute.mockRejectedValueOnce(error);
    await expect(call({ context: { signal: controller.signal } })).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('a caller that is still waiting is served by the fallback as before', async () => {
    execute.mockRejectedValueOnce(failure('overloaded', 503)).mockResolvedValueOnce(served('small'));
    const outcome = await call({ context: { signal: new AbortController().signal } });
    expect(outcome.routing?.decision).toBe('fallback');
  });

  it('no target at all is still what the fallback is for', async () => {
    execute.mockResolvedValueOnce(served('small'));
    const outcome = await call({ config: config({ defaultModelKey: '' }) });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(executed(0).modelKey).toBe('small');
    expect(outcome.routing).toMatchObject({ chosenModelKey: 'small', decision: 'fallback' });
    expect(outcome.routing?.reason).toContain('(none)');
  });

  it('without a fallback model the failure surfaces, whatever it is', async () => {
    const error = failure('overloaded', 503);
    execute.mockRejectedValueOnce(error);
    await expect(call({ config: config({ fallbackModelKey: undefined }) })).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('hands a primary\'s output-limit error, with what it burned, back to the caller instead of falling back', async () => {
    const usage = { inputTokens: 40, outputTokens: 64, totalTokens: 104 };
    const error = new OutputTokenLimitError(64, { usage });
    execute.mockRejectedValueOnce(error).mockResolvedValueOnce(served('small'));
    await expect(call()).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(error.usage).toEqual(usage);
  });

  it('keeps counting what a primary that ended in its own error finish burned', async () => {
    const usage = { inputTokens: 40, outputTokens: 64, totalTokens: 104 };
    execute
      .mockRejectedValueOnce(new UpstreamFinishError('MALFORMED_FUNCTION_CALL', { usage, usageBooked: true }))
      .mockResolvedValueOnce(served('small'));
    const outcome = await call();
    expect(outcome.burnedUsage).toEqual(usage);
  });

  it('a fallback that fails too surfaces its own error', async () => {
    const error = failure('also down', 503);
    execute.mockRejectedValueOnce(failure('overloaded', 503)).mockRejectedValueOnce(error);
    await expect(call()).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('the output limit on the fallback\'s leg (G4-8)', () => {
  const withMaxOnSmall = (maxOutputTokens: number) => {
    models.small = llm('small', { metadata: { capabilities: { maxOutputTokens } } });
  };
  const bigLimits = { model: 'router', messages: MESSAGES, max_tokens: 4000, max_completion_tokens: 4000, max_output_tokens: 4000 };

  it('lowers a limit above the fallback\'s maximum to it, in every spelling, and says so', async () => {
    withMaxOnSmall(1000);
    execute.mockRejectedValueOnce(failure('overloaded', 503)).mockResolvedValueOnce(served('small'));
    const outcome = await call({ wire: bigLimits, request: { messages: MESSAGES, maxTokens: 4000, maxCompletionTokens: 4000 } });

    // The primary ran with what the caller asked for ...
    expect(executed(0).wire).toMatchObject({ max_tokens: 4000, max_completion_tokens: 4000, max_output_tokens: 4000 });
    expect(executed(0).request).toMatchObject({ maxTokens: 4000 });
    // ... the fallback with what it can write.
    expect(executed(1).wire).toMatchObject({ max_tokens: 1000, max_completion_tokens: 1000, max_output_tokens: 1000 });
    expect(executed(1).request).toMatchObject({ maxTokens: 1000, maxCompletionTokens: 1000 });
    expect(outcome.routing?.reason).toContain('output limit lowered to the fallback\'s maximum (1000)');
    // The caller's own wire is a copy away from being changed.
    expect(bigLimits.max_tokens).toBe(4000);
  });

  it('uses the built-in table when the fallback declares nothing', async () => {
    models.small = llm('small', { modelId: 'claude-sonnet-4-5' });
    execute.mockRejectedValueOnce(failure('overloaded', 503)).mockResolvedValueOnce(served('small'));
    await call({ wire: { ...bigLimits, max_tokens: 100000, max_completion_tokens: undefined, max_output_tokens: undefined } });
    // Claude Sonnet 4.5 tops out at 64000 output tokens.
    expect(executed(1).wire).toMatchObject({ max_tokens: 64000 });
  });

  it('leaves a limit at or below the maximum alone', async () => {
    withMaxOnSmall(1000);
    execute.mockRejectedValueOnce(failure('overloaded', 503)).mockResolvedValueOnce(served('small'));
    const outcome = await call({ wire: { model: 'router', messages: MESSAGES, max_tokens: 800, max_completion_tokens: 1000 } });
    expect(executed(1).wire).toMatchObject({ max_tokens: 800, max_completion_tokens: 1000 });
    expect(outcome.routing?.reason).not.toContain('lowered');
  });

  it('leaves a limit alone when the fallback declares no maximum and the table has none', async () => {
    execute.mockRejectedValueOnce(failure('overloaded', 503)).mockResolvedValueOnce(served('small'));
    const outcome = await call({ wire: bigLimits });
    expect(executed(1).wire).toMatchObject({ max_tokens: 4000, max_completion_tokens: 4000 });
    expect(outcome.routing?.reason).not.toContain('lowered');
  });

  it('invents no limit for a call that sent none', async () => {
    withMaxOnSmall(1000);
    execute.mockRejectedValueOnce(failure('overloaded', 503)).mockResolvedValueOnce(served('small'));
    await call({ wire: { model: 'router', messages: MESSAGES } });
    expect(executed(1).wire).not.toHaveProperty('max_tokens');
    expect(executed(1).wire).not.toHaveProperty('max_completion_tokens');
  });

  it('lowers nothing on the primary\'s leg: only the fallback is fitted', async () => {
    models.big = llm('big', { metadata: { capabilities: { maxOutputTokens: 1000 } } });
    execute.mockResolvedValueOnce(served('big'));
    await call({ wire: bigLimits });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(executed(0).wire).toMatchObject({ max_tokens: 4000 });
  });

});

describe('a call pinned to the child that ran (G4-9)', () => {
  const childOf = (index: number) => executed(index).context as unknown as Record<string, unknown>;

  it('runs the named child and decides nothing: a rule that would route elsewhere is not consulted', async () => {
    execute.mockResolvedValueOnce(served('big'));
    const onChild = vi.fn();
    const context = withRouterHandoff({ route: 'agent.chat' }, { pin: 'big', onChild });
    const outcome = await runWithRoutingCaller({ channel: 'portal' }, () => call({ config: config({ rules: [portalToSmall] }), context }));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(executed(0).modelKey).toBe('big');
    expect(onChild).toHaveBeenCalledWith('big');
    expect(outcome.routing).toMatchObject({ role: 'router', chosenModelKey: 'big', decision: 'default' });
    expect(outcome.routing?.reason).toContain('pinned');
    expect(outcome.routing?.reason).toContain('"big"');
  });

  it('without the pin the same call is routed by its rule (the control)', async () => {
    execute.mockResolvedValueOnce(served('small'));
    const onChild = vi.fn();
    const context = withRouterHandoff({ route: 'agent.chat' }, { onChild });
    const outcome = await runWithRoutingCaller({ channel: 'portal' }, () => call({ config: config({ rules: [portalToSmall] }), context }));

    expect(executed(0).modelKey).toBe('small');
    // Told which child the decision chose, before the child answers.
    expect(onChild).toHaveBeenCalledTimes(1);
    expect(onChild).toHaveBeenCalledWith('small');
    expect(outcome.routing).toMatchObject({ chosenModelKey: 'small', decision: 'rule' });
  });

  it('a pin on the router itself is no pin: the decision is made as usual', async () => {
    execute.mockResolvedValueOnce(served('small'));
    const context = withRouterHandoff({}, { pin: 'router' });
    const outcome = await runWithRoutingCaller({ channel: 'portal' }, () => call({ config: config({ rules: [portalToSmall] }), context }));
    expect(executed(0).modelKey).toBe('small');
    expect(outcome.routing?.decision).toBe('rule');
  });

  it('the child does not inherit the hand-off, and keeps the rest of the caller\'s context', async () => {
    execute.mockResolvedValueOnce(served('big'));
    const handoff = { pin: 'big', onChild: vi.fn() };
    const context = withRouterHandoff({ route: 'agent.chat', requestTags: { agentKey: 'a1' } }, handoff);
    await call({ context });
    expect(Object.values(childOf(0))).not.toContain(handoff);
    expect(childOf(0)).toMatchObject({ route: 'agent.chat', requestTags: { agentKey: 'a1' }, routingDepth: 1 });
  });

  it('a pinned child that fails is still covered by the fallback, and the caller hears of both', async () => {
    execute.mockRejectedValueOnce(failure('overloaded', 503)).mockResolvedValueOnce(served('small'));
    const onChild = vi.fn();
    const context = withRouterHandoff({}, { pin: 'big', onChild });
    const outcome = await call({ context });
    expect(onChild.mock.calls.map((args) => args[0])).toEqual(['big', 'small']);
    expect(outcome.routing).toMatchObject({ chosenModelKey: 'small', decision: 'fallback' });
  });

  it('a child that fails at its output limit has still been reported, so a caller can retry on it', async () => {
    const error = new OutputTokenLimitError(100);
    execute.mockRejectedValueOnce(error);
    const onChild = vi.fn();
    const context = withRouterHandoff({}, { onChild });
    await expect(call({ config: config({ fallbackModelKey: undefined }), context })).rejects.toBe(error);
    expect(onChild).toHaveBeenCalledWith('big');
  });

  it('a note that throws never fails the call', async () => {
    execute.mockResolvedValueOnce(served('big'));
    const context = withRouterHandoff({}, { onChild: () => { throw new Error('the caller\'s note broke'); } });
    const outcome = await call({ context });
    expect(outcome.routing?.chosenModelKey).toBe('big');
  });

  it('a call with no hand-off is routed exactly as before', async () => {
    execute.mockResolvedValueOnce(served('big'));
    const outcome = await call();
    expect(executed(0).modelKey).toBe('big');
    expect(outcome.routing).toMatchObject({ chosenModelKey: 'big', decision: 'default' });
    expect(outcome.routing?.reason).not.toContain('pinned');
  });
});

describe('withRouterHandoff', () => {
  it('returns a copy and leaves the caller\'s own context as it was', () => {
    const base: GatewayCallContext = { route: 'agent.chat' };
    const handed = withRouterHandoff(base, { pin: 'big' });
    expect(handed).not.toBe(base);
    expect(handed).toMatchObject({ route: 'agent.chat' });
    expect(base).toEqual({ route: 'agent.chat' });
  });
});
