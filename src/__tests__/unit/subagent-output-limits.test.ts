/**
 * A sub-agent's own model call carries the parent's output settings, as the main agent's model does:
 * the per-call `max_tokens` (an override of the call) and the run's `maxTotalOutputTokens` (a raised
 * retry's budget). A sub-agent without a model of its own runs on the parent's model object, which
 * already has both.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  buildGatewayChatModel: vi.fn(),
  getModelByKey: vi.fn(),
}));

vi.mock('@/lib/license/tenantLicense', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/license/tenantLicense')>();
  return { ...actual, resolveLiveLicenseForTenant: async () => ({ licenseType: 'STARTER' }) };
});
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: hoisted.getModelByKey }));
vi.mock('@/lib/services/agents/gatewayChatModel', () => ({
  buildGatewayChatModel: hoisted.buildGatewayChatModel,
  isDynamicModel: () => false,
}));

import { buildAgentSubagents, buildSubagentModel } from '@/lib/services/agents/agentService';

const childModel = { key: 'big', modelId: 'big-1', category: 'llm', providerDriver: 'openai', settings: {}, metadata: {}, pricing: null };

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.getModelByKey.mockResolvedValue(childModel);
  hoisted.buildGatewayChatModel.mockResolvedValue({ built: true });
});

const lastBuild = () => hoisted.buildGatewayChatModel.mock.calls[hoisted.buildGatewayChatModel.mock.calls.length - 1][0] as Record<string, any>;

describe('buildSubagentModel', () => {
  it('passes the output settings it is given: max_tokens as the call override, the budget as maxTotalOutputTokens', async () => {
    const built = await buildSubagentModel('db', 't', 'p', 'big', undefined, undefined, undefined, undefined, { maxTokens: 321, maxTotalOutputTokens: 5000 });
    expect(built.ok).toBe(true);
    expect(lastBuild()).toMatchObject({ route: 'agent.subagent', overrides: { max_tokens: 321 }, maxTotalOutputTokens: 5000 });
  });

  it('sends nothing extra when the parent set nothing (no undefined keys)', async () => {
    await buildSubagentModel('db', 't', 'p', 'big');
    expect('overrides' in lastBuild()).toBe(false);
    expect('maxTotalOutputTokens' in lastBuild()).toBe(false);
    await buildSubagentModel('db', 't', 'p', 'big', undefined, undefined, undefined, undefined, { maxTotalOutputTokens: 0 });
    expect('maxTotalOutputTokens' in lastBuild()).toBe(false);
  });
});

describe('buildAgentSubagents', () => {
  const entry = (name: string, extra: object = {}) => ({
    kind: 'inline', name, header: `${name} header`, systemPrompt: `You are ${name}.`, modelKey: 'big', ...extra,
  });
  const run = (subagents: unknown[], output?: object) => buildAgentSubagents({
    tenantId: 'tenant-1', tenantDbName: 'tenant_acme', projectId: 'p',
    subagents,
    prompt: { parent: { config: {}, variables: {} } },
    ...(output ? { output } : {}),
  } as never);

  it('hands every child model the parent\'s max_tokens and output budget', async () => {
    const built = await run([entry('writer')], { maxTokens: 400, maxTotalOutputTokens: 5000 });
    expect(built.subagents).toHaveLength(1);
    expect(lastBuild()).toMatchObject({ overrides: { max_tokens: 400 }, maxTotalOutputTokens: 5000 });
  });

  it('a child that states its own output budget keeps it over the parent\'s', async () => {
    await run([entry('writer', { limits: { maxTotalOutputTokens: 900 } })], { maxTokens: 400, maxTotalOutputTokens: 5000 });
    expect(lastBuild()).toMatchObject({ overrides: { max_tokens: 400 }, maxTotalOutputTokens: 900 });
  });

  it('a parent with no output settings leaves the child on the model\'s own defaults', async () => {
    await run([entry('writer')]);
    expect('overrides' in lastBuild()).toBe(false);
    expect('maxTotalOutputTokens' in lastBuild()).toBe(false);
  });
});
