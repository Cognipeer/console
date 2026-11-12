'use client';

import { useAgentVersionOptionsQuery } from '@/lib/api/queries/agents';

export interface AgentVersionOption {
  version: number;
  /** True for the version that is live right now. */
  published: boolean;
}

export interface AgentVersionOptions {
  versions: AgentVersionOption[];
  publishedVersion: number | null;
  loading: boolean;
}

const NONE: Omit<AgentVersionOptions, 'loading'> = { versions: [], publishedVersion: null };

/**
 * The published versions of an agent, for pickers that run a test against one
 * (evaluation targets, red-team campaigns). Takes the agent KEY, as targets and
 * campaigns store it, and maps it to the agent id the versions endpoint needs.
 *
 * Non-fatal on purpose: a user without access to Agents just gets an empty
 * list, and the picker falls back to "published" and "draft".
 */
export function useAgentVersionOptions(agentKey: string | null | undefined, enabled: boolean): AgentVersionOptions {
  const query = useAgentVersionOptionsQuery(agentKey, enabled);
  const active = enabled && Boolean(agentKey);
  const loading = active && query.isPending;
  // A failed read, or another agent's key still loading, shows no versions.
  return { ...(active ? query.data : undefined) ?? NONE, loading };
}
