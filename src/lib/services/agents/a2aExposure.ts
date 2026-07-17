/**
 * A2A exposure config — how an agent is published to external A2A clients.
 *
 * Rides in `agent.metadata.a2a` (same no-migration pattern as MCP's
 * `metadata.disabledTools`):
 *
 *   { enabled: boolean, accessMode: 'token' | 'public', endpointSlug: string }
 *
 * - 'token'  → callers authenticate with a `cpeer_` API token at
 *              /api/client/v1/a2a/:agentKey
 * - 'public' → additionally reachable unauthenticated at
 *              /api/public/a2a/:tenantId/:endpointSlug (webhook-style
 *              unguessable URL, mirroring public MCP exposure)
 *
 * The endpoint slug is server-generated and immutable: PATCH normalization
 * always preserves an existing slug and never accepts a client-chosen one.
 */

import { randomUUID } from 'node:crypto';
import type { IAgent } from '@/lib/database';

export type A2aAccessMode = 'token' | 'public';

export interface A2aExposureConfig {
  enabled: boolean;
  accessMode: A2aAccessMode;
  endpointSlug?: string;
}

export function generateA2aEndpointSlug(): string {
  return randomUUID().replace(/-/g, '').substring(0, 16);
}

export function resolveA2aExposure(agent: Pick<IAgent, 'metadata'>): A2aExposureConfig {
  const raw = agent.metadata?.a2a;
  if (!raw || typeof raw !== 'object') {
    return { enabled: false, accessMode: 'token' };
  }
  const a2a = raw as Record<string, unknown>;
  return {
    enabled: a2a.enabled === true,
    accessMode: a2a.accessMode === 'public' ? 'public' : 'token',
    endpointSlug: typeof a2a.endpointSlug === 'string' && a2a.endpointSlug.length >= 8
      ? a2a.endpointSlug
      : undefined,
  };
}

/** A2A exposure is opt-in per agent: `metadata.a2a.enabled === true`. */
export function isA2aEnabled(agent: Pick<IAgent, 'metadata'>): boolean {
  return resolveA2aExposure(agent).enabled;
}

export function isA2aPublic(agent: Pick<IAgent, 'metadata'>): boolean {
  const exposure = resolveA2aExposure(agent);
  return exposure.enabled && exposure.accessMode === 'public' && Boolean(exposure.endpointSlug);
}

/**
 * Normalize an incoming `metadata.a2a` update from the dashboard: whitelist
 * fields, coerce types, and keep the endpoint slug server-owned (existing
 * slug wins; one is minted the first time the agent is exposed).
 */
export function normalizeA2aMetadataUpdate(
  incoming: unknown,
  existing: Pick<IAgent, 'metadata'> | null | undefined,
): { enabled: boolean; accessMode: A2aAccessMode; endpointSlug: string } {
  const patch = incoming && typeof incoming === 'object'
    ? incoming as Record<string, unknown>
    : {};
  const current = existing ? resolveA2aExposure(existing) : undefined;

  return {
    enabled: patch.enabled === true,
    accessMode: patch.accessMode === 'public' ? 'public' : 'token',
    endpointSlug: current?.endpointSlug ?? generateA2aEndpointSlug(),
  };
}
