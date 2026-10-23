/**
 * An agent and the services it uses (agentServiceAvailability.ts).
 *
 *   - with `agents` off, no turn runs: the chat and playground entries, the
 *     resume, and a sub-agent build are refused with the service error;
 *   - with a service an agent merely USES off (rag, mcp, tools, browser, web
 *     search, memory, files, sandbox), the run goes on and only that binding is
 *     dropped, with one warning per build and one availability lookup.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAgentConfig } from '@/lib/database';

const hoisted = vi.hoisted(() => ({
  services: { disabled: [] as string[], enabled: [] as string[] },
  licenseLookups: 0,
  warn: vi.fn(),
}));

vi.mock('@/lib/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/config')>();
  return { ...actual, getConfig: () => ({ ...actual.getConfig(), services: hoisted.services }) };
});

vi.mock('@/lib/license/tenantLicense', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/license/tenantLicense')>();
  return {
    ...actual,
    resolveLiveLicenseForTenant: async () => {
      hoisted.licenseLookups += 1;
      return { licenseType: 'STARTER' };
    },
  };
});

vi.mock('@/lib/core/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/logger')>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const logger = actual.createLogger(name);
      return name === 'agent-service-availability' ? { ...logger, warn: hoisted.warn } : logger;
    },
  };
});

import { getDisabledServices, clearServiceAvailabilityMemo, isServiceDisabledError } from '@/lib/services/availability/serviceAvailability';
import {
  applyServiceAvailability,
  bindingServiceOf,
  dropUnavailableBindings,
  filterChildSources,
} from '@/lib/services/agents/agentServiceAvailability';
import {
  buildAgentSubagents,
  executeAgentChatLocal,
  executeAgentResumeLocal,
  executePlaygroundChatLocal,
} from '@/lib/services/agents/agentService';

function offFor(...services: string[]) {
  hoisted.services = { disabled: services, enabled: [] };
  clearServiceAvailabilityMemo();
  return getDisabledServices('tenant-1');
}

const FULL_CONFIG = {
  modelKey: 'gpt',
  knowledgeEngineKey: 'kb-1',
  knowledgeBindings: [{ key: 'kb-2' }],
  toolBindings: [
    { source: 'tool', sourceKey: 't1', toolNames: ['a'] },
    { source: 'mcp', sourceKey: 'm1', toolNames: ['b'] },
    { source: 'system', sourceKey: 'browser_use', toolNames: [], config: { browserId: 'b' } },
    { source: 'system', sourceKey: 'web_search', toolNames: [] },
    { source: 'system', sourceKey: 'crawler', toolNames: [], config: { crawlerKey: 'c' } },
  ],
  memory: { enabled: true },
  attachments: { enabled: true, bucketKey: 'bk' },
  sandbox: { enabled: true },
} as unknown as IAgentConfig;

const sources = (config: IAgentConfig) => (config.toolBindings ?? []).map((b) => b.sourceKey);

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.services = { disabled: [], enabled: [] };
  hoisted.licenseLookups = 0;
  clearServiceAvailabilityMemo();
});

describe('bindings of a switched-off service are dropped', () => {
  it('maps each binding to its service', () => {
    expect(bindingServiceOf({ source: 'tool', sourceKey: 'x' })).toBe('tools');
    expect(bindingServiceOf({ source: 'mcp', sourceKey: 'x' })).toBe('mcp');
    expect(bindingServiceOf({ source: 'system', sourceKey: 'browser_use' })).toBe('browser');
    expect(bindingServiceOf({ source: 'system', sourceKey: 'web_search' })).toBe('websearch');
    expect(bindingServiceOf({ source: 'system', sourceKey: 'crawler' })).toBe('crawler');
    expect(bindingServiceOf({ source: 'system', sourceKey: 'something_else' })).toBeNull();
  });

  it('keeps the config as it is while nothing is off', async () => {
    const off = await offFor();
    const { config, dropped } = dropUnavailableBindings(FULL_CONFIG, off);
    expect(config).toBe(FULL_CONFIG);
    expect(dropped).toEqual([]);
  });

  it.each([
    ['rag', (c: IAgentConfig) => expect(c.knowledgeEngineKey ?? c.knowledgeBindings).toBeUndefined()],
    ['mcp', (c: IAgentConfig) => expect(sources(c)).not.toContain('m1')],
    ['tools', (c: IAgentConfig) => expect(sources(c)).not.toContain('t1')],
    ['browser', (c: IAgentConfig) => expect(sources(c)).not.toContain('browser_use')],
    ['websearch', (c: IAgentConfig) => expect(sources(c)).not.toContain('web_search')],
    ['crawler', (c: IAgentConfig) => expect(sources(c)).not.toContain('crawler')],
    ['memory', (c: IAgentConfig) => expect(c.memory).toBeUndefined()],
    ['files', (c: IAgentConfig) => expect(c.attachments).toBeUndefined()],
    ['sandbox', (c: IAgentConfig) => expect(c.sandbox).toBeUndefined()],
  ])('%s off drops only what it provided', async (service, check) => {
    const { config, dropped } = dropUnavailableBindings(FULL_CONFIG, await offFor(service));
    expect(dropped).toContain(service);
    check(config);
    // The original is not touched, and the rest of the agent stays.
    expect(FULL_CONFIG.toolBindings).toHaveLength(5);
    expect(config.modelKey).toBe('gpt');
    expect(sources(config).length).toBeGreaterThanOrEqual(4);
  });

  it('a sub-agent loses the same knowledge and tool bindings', async () => {
    const off = await offFor('rag', 'mcp');
    const { knowledge, toolBindings } = filterChildSources(
      { knowledgeEngineKey: 'kb-1' },
      [{ source: 'mcp', sourceKey: 'm1', toolNames: [] }, { source: 'tool', sourceKey: 't1', toolNames: [] }],
      off,
    );
    expect(knowledge.knowledgeEngineKey).toBeUndefined();
    expect(toolBindings?.map((b) => b.sourceKey)).toEqual(['t1']);
  });

  it('one lookup and one warning per build, naming the services', async () => {
    hoisted.services = { disabled: ['rag', 'mcp'], enabled: [] };
    clearServiceAvailabilityMemo();
    const config = await applyServiceAvailability('tenant-1', FULL_CONFIG, { agentKey: 'bot' });
    expect(hoisted.licenseLookups).toBe(1);
    expect(hoisted.warn).toHaveBeenCalledTimes(1);
    expect(hoisted.warn.mock.calls[0][1]).toMatchObject({ agentKey: 'bot', services: ['mcp', 'rag'] });
    expect(sources(config)).not.toContain('m1');
    // Applying it again finds nothing more to drop and says nothing.
    await applyServiceAvailability('tenant-1', config, { agentKey: 'bot' });
    expect(hoisted.warn).toHaveBeenCalledTimes(1);
  });
});

describe('with the agents service off no turn runs', () => {
  const base = { tenantId: 'tenant-1', tenantDbName: 'tenant_acme', projectId: 'p', agentKey: 'bot', conversationId: 'c' };

  beforeEach(() => {
    hoisted.services = { disabled: ['agents'], enabled: [] };
  });

  it('refuses a chat turn, a playground turn and a resume with the service error', async () => {
    for (const run of [
      () => executeAgentChatLocal({ ...base, userMessage: 'hi' } as never),
      () => executePlaygroundChatLocal({ ...base, userMessage: 'hi' } as never),
      () => executeAgentResumeLocal({ ...base } as never),
    ]) {
      const error = await run().catch((e) => e);
      expect(isServiceDisabledError(error)).toBe(true);
      expect(error).toMatchObject({ status: 403, code: 'service_disabled', service: 'agents' });
    }
  });

  it('refuses a sub-agent build, also when only the models service is off (agents requires it)', async () => {
    const input = {
      tenantId: 'tenant-1', tenantDbName: 'tenant_acme', projectId: 'p',
      subagents: [{ kind: 'inline', name: 'helper' }],
    } as never;
    expect(isServiceDisabledError(await buildAgentSubagents(input).catch((e) => e))).toBe(true);

    hoisted.services = { disabled: ['models'], enabled: [] };
    clearServiceAvailabilityMemo();
    const error = await buildAgentSubagents(input).catch((e) => e);
    expect(error).toMatchObject({ code: 'service_disabled', service: 'agents', via: 'models' });
  });

  it('builds nothing and asks nothing for an agent without sub-agents', async () => {
    const built = await buildAgentSubagents({ tenantId: 'tenant-1', tenantDbName: 'x', projectId: 'p', subagents: [] } as never);
    expect(built.subagents).toEqual([]);
  });
});
