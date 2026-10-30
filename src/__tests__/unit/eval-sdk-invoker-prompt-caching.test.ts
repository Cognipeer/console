/**
 * The evaluation SDK path builds its Bedrock / Vertex provider with the same "Cache prompts" resolution as
 * the gateway, so an evaluation of a Claude model runs the way production does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// TRAP: factories must be synchronous; shared fns via vi.hoisted.
const h = vi.hoisted(() => ({
  loadProviderRuntimeData: vi.fn(),
  getDynamicRoutingConfig: vi.fn((): unknown => null),
}));

vi.mock('@cognipeer/agent-sdk', () => ({ createProvider: vi.fn() }));
vi.mock('@/lib/services/providers/providerService', () => ({
  loadProviderRuntimeData: h.loadProviderRuntimeData,
  assertProviderEnabled: () => undefined,
}));
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: vi.fn() }));
vi.mock('@/lib/services/models/dynamicRouting', () => ({ getDynamicRoutingConfig: h.getDynamicRoutingConfig }));
vi.mock('@/lib/services/models/inferenceService', () => ({ handleChatCompletion: vi.fn(), handleEmbeddingRequest: vi.fn() }));
vi.mock('@/lib/services/models/usageLogger', () => ({ calculateCost: vi.fn(() => ({ totalCost: 0 })) }));
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

import { resolveSdkProviderConfig } from '@/lib/services/evaluation/sdkInvoker';
import type { IModel } from '@/lib/database';

const model = (modelId: string, settings: Record<string, unknown> = {}): IModel => ({
  tenantId: 't1', projectId: 'p1', name: 'm', key: 'm', providerKey: 'prov', providerDriver: 'bedrock',
  category: 'llm', modelId, settings, pricing: { inputTokenPer1M: 1, outputTokenPer1M: 1 },
}) as IModel;

const bedrock = () => h.loadProviderRuntimeData.mockResolvedValue({
  record: { key: 'prov', type: 'model', driver: 'bedrock', settings: { region: 'us-east-1' }, tenantId: 't1' },
  credentials: { accessKeyId: 'AKIA', secretAccessKey: 'shh' },
});
const vertex = () => h.loadProviderRuntimeData.mockResolvedValue({
  record: { key: 'prov', type: 'model', driver: 'vertex', settings: { projectId: 'p', location: 'global' }, tenantId: 't1' },
  credentials: {},
});

describe('evaluation provider config and prompt caching', () => {
  beforeEach(() => {
    h.loadProviderRuntimeData.mockReset();
    h.getDynamicRoutingConfig.mockReturnValue(null);
  });

  it('Bedrock Claude: prompt_caching on by default, with the model strategy, no ttl', async () => {
    bedrock();
    expect(await resolveSdkProviderConfig('db', model('us.anthropic.claude-sonnet-4-5-v1:0'))).toMatchObject({ prompt_caching: { enabled: true, strategy: 'auto' } });
    const withStatic = await resolveSdkProviderConfig('db', model('us.anthropic.claude-sonnet-4-5-v1:0', { promptCaching: { strategy: 'static' } }));
    expect(withStatic).toMatchObject({ prompt_caching: { enabled: true, strategy: 'static' } });
    expect((withStatic as { prompt_caching: object }).prompt_caching).not.toHaveProperty('ttl');
  });

  it('Bedrock Claude switched off, Nova by default, Llama even when asked: nothing is sent', async () => {
    bedrock();
    expect(await resolveSdkProviderConfig('db', model('us.anthropic.claude-sonnet-4-5-v1:0', { promptCaching: { enabled: false } }))).not.toHaveProperty('prompt_caching');
    expect(await resolveSdkProviderConfig('db', model('amazon.nova-pro-v1:0'))).not.toHaveProperty('prompt_caching');
    expect(await resolveSdkProviderConfig('db', model('amazon.nova-pro-v1:0', { promptCaching: { enabled: true } }))).toMatchObject({ prompt_caching: { enabled: true } });
    expect(await resolveSdkProviderConfig('db', model('meta.llama3-1-70b-instruct-v1:0', { promptCaching: { enabled: true } }))).not.toHaveProperty('prompt_caching');
  });

  it('Vertex: Claude gets it, Gemini does not', async () => {
    vertex();
    expect(await resolveSdkProviderConfig('db', model('claude-sonnet-4-5@20250929'))).toMatchObject({ prompt_caching: { enabled: true, strategy: 'auto' } });
    expect(await resolveSdkProviderConfig('db', model('gemini-2.5-pro'))).not.toHaveProperty('prompt_caching');
  });
});
