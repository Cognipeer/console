'use client';

import { useEffect, useState } from 'react';

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

/**
 * The published versions of an agent, for pickers that run a test against one
 * (evaluation targets, red-team campaigns). Takes the agent KEY, as targets and
 * campaigns store it, and maps it to the agent id the versions endpoint needs.
 *
 * Non-fatal on purpose: a user without access to Agents just gets an empty
 * list, and the picker falls back to "published" and "draft".
 */
export function useAgentVersionOptions(agentKey: string | null | undefined, enabled: boolean): AgentVersionOptions {
  const [state, setState] = useState<Omit<AgentVersionOptions, 'loading'>>({ versions: [], publishedVersion: null });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !agentKey) {
      setState({ versions: [], publishedVersion: null });
      setLoading(false);
      return;
    }

    let cancelled = false;
    // Another agent's versions must not linger while this one loads.
    setState({ versions: [], publishedVersion: null });
    setLoading(true);
    void (async () => {
      try {
        const listRes = await fetch('/api/agents', { cache: 'no-store' });
        if (!listRes.ok) return;
        const agents = ((await listRes.json()).agents ?? []) as Array<{ _id: string; key: string }>;
        const agentId = agents.find((a) => a.key === agentKey)?._id;
        if (!agentId) return;

        // Fetched per agent rather than bundled into the list: an agent's
        // history can run to dozens of entries.
        const res = await fetch(`/api/agents/${agentId}/versions?limit=100`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const publishedVersion: number | null = data.publishedVersion ?? null;
        setState({
          publishedVersion,
          versions: ((data.versions ?? []) as Array<{ version: number }>).map((entry) => ({
            version: entry.version,
            published: entry.version === publishedVersion,
          })),
        });
      } catch {
        /* non-fatal — the picker keeps "published" and "draft" */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentKey, enabled]);

  return { ...state, loading };
}
