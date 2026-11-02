/**
 * What an agent keeps when a service it uses is switched off.
 *
 * The agent service itself is checked at the entry of a turn (`assertAgentsEnabled`):
 * a tenant without `agents` runs nothing. Everything an agent merely USES — a
 * knowledge engine, an MCP server, a tool, a browser, web search, memory, files, a
 * sandbox — is different: the run goes on without that binding, and the owner is
 * told once per build. The availability map is read once per build, never per
 * binding.
 */

import { createLogger } from '@/lib/core/logger';
import type { IAgentConfig, IAgentToolBinding } from '@/lib/database';
import {
  assertServiceEnabled,
  getDisabledServices,
  type ServiceOff,
  type ServiceScope,
} from '@/lib/services/availability/serviceAvailability';

const logger = createLogger('agent-service-availability');

export type DisabledServices = ReadonlyMap<string, ServiceOff>;

/** A turn, a queued run or a trigger fire of an agent: refused when the `agents` service is off for the tenant. */
export function assertAgentsEnabled(scope: ServiceScope): Promise<void> {
  return assertServiceEnabled(scope, 'agents');
}

/** The service a tool binding needs, or null for a binding no service switch governs. */
export function bindingServiceOf(binding: Pick<IAgentToolBinding, 'source' | 'sourceKey'>): string | null {
  if (binding.source === 'tool') return 'tools';
  if (binding.source === 'mcp') return 'mcp';
  if (binding.source === 'flow') return 'flows';
  if (binding.source === 'system') {
    if (binding.sourceKey === 'browser_use') return 'browser';
    if (binding.sourceKey === 'web_search') return 'websearch';
    if (binding.sourceKey === 'crawler') return 'crawler';
  }
  return null;
}

/** The bindings whose service is on, and the services that cost the rest. */
export function filterToolBindings<T extends Pick<IAgentToolBinding, 'source' | 'sourceKey'>>(
  bindings: T[] | undefined,
  off: DisabledServices,
  dropped?: Set<string>,
): T[] | undefined {
  if (!bindings || off.size === 0) return bindings;
  return bindings.filter((binding) => {
    const service = bindingServiceOf(binding);
    if (service && off.has(service)) {
      dropped?.add(service);
      return false;
    }
    return true;
  });
}

/** A child agent's (or a ref target's) own knowledge and tool bindings, without those of a service that is off. */
export function filterChildSources<K extends { knowledgeEngineKey?: string; knowledgeBindings?: unknown[] }, B extends Pick<IAgentToolBinding, 'source' | 'sourceKey'>>(
  knowledge: K,
  toolBindings: B[] | undefined,
  off: DisabledServices,
): { knowledge: K; toolBindings: B[] | undefined } {
  if (off.size === 0) return { knowledge, toolBindings };
  return {
    knowledge: off.has('rag') ? { ...knowledge, knowledgeEngineKey: undefined, knowledgeBindings: undefined } : knowledge,
    toolBindings: filterToolBindings(toolBindings, off),
  };
}

/**
 * The config a run executes, without what a switched-off service provided.
 * Pure: the same config comes back untouched when nothing it uses is off.
 */
export function dropUnavailableBindings(config: IAgentConfig, off: DisabledServices): { config: IAgentConfig; dropped: string[] } {
  if (off.size === 0) return { config, dropped: [] };
  const dropped = new Set<string>();
  const next: IAgentConfig = { ...config };

  if (off.has('rag') && (next.knowledgeEngineKey || (next.knowledgeBindings?.length ?? 0) > 0)) {
    delete next.knowledgeEngineKey;
    delete next.knowledgeBindings;
    dropped.add('rag');
  }
  const bindings = filterToolBindings(next.toolBindings, off, dropped);
  if (bindings !== next.toolBindings) next.toolBindings = bindings;
  if (off.has('memory') && next.memory) {
    delete next.memory;
    dropped.add('memory');
  }
  // Attachments and the files the agent writes both live in a bucket of the files service.
  if (off.has('files') && next.attachments) {
    delete next.attachments;
    dropped.add('files');
  }
  if (off.has('sandbox') && next.sandbox) {
    delete next.sandbox;
    dropped.add('sandbox');
  }
  return dropped.size === 0 ? { config, dropped: [] } : { config: next, dropped: [...dropped].sort() };
}

/**
 * The run's config for this tenant: one availability lookup, the bindings of an
 * off service dropped, one warning per build (the log) naming them.
 */
export async function applyServiceAvailability(
  tenantId: string,
  config: IAgentConfig,
  context: { agentKey?: string } = {},
): Promise<IAgentConfig> {
  const off = await getDisabledServices(tenantId);
  const { config: next, dropped } = dropUnavailableBindings(config, off);
  if (dropped.length > 0) {
    logger.warn('Agent bindings dropped: their service is switched off', { tenantId, agentKey: context.agentKey, services: dropped });
  }
  return next;
}
