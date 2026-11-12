'use client';

/**
 * Where an agent's tools come from, as groups: the system tools, custom tools, MCP servers (the hub's and the agent's
 * own) and, where available, flows and channel tools. The agent's Tools list and the tool picker both read these, so
 * a source has the same name and the same tool count in both.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { IconBrowser, IconWorldDownload, IconWorldSearch } from '@tabler/icons-react';
import type { IAgentToolBinding } from '@/lib/database/provider/types.domain';
import { useFlowToolSource, type FlowToolSource } from '@/components/enterprise/EnterpriseFlowAgentUi';
import { useChannelToolGroup, type ChannelToolGroup } from '@/components/enterprise/EnterpriseChannelToolsUi';
import { apiGet } from '@/lib/api/client';

export type ToolBinding = IAgentToolBinding;

/** One source of tools: what a binding's `source` + `sourceKey` point at. */
export interface ToolSourceGroup {
  /** Discriminator – matches ToolBinding.source */
  source: ToolBinding['source'];
  /** Unique key of the source (e.g. tool key, MCP server key, or system tool key) */
  sourceKey: string;
  /** Human-readable name */
  name: string;
  description?: string;
  /** Source type label (OpenAPI / MCP / System / Flow) */
  typeLabel: string;
  /** A connector's tool (managed by another module): listed with a Connector badge. */
  managed?: boolean;
  /** An MCP server that belongs to this agent (created inside it). */
  ownedByAgent?: boolean;
  /** The record's id, for an MCP server: what its screen and DELETE take. */
  recordId?: string;
  /** Switched off: its bound tools are still listed, but it is not offered for new ones. */
  inactive?: boolean;
  /** Available tools within this source */
  tools: { name: string; description: string }[];
}

/**
 * System tools whose whole binding is one config field picked from a
 * `Select` (a browser, a web search instance, a crawler) rather than a checkbox list of
 * discrete tool names. Each renders as its own group, in this order.
 */
export const SYSTEM_TOOLS = [
  {
    sourceKey: 'browser_use',
    field: 'browserId',
    icon: IconBrowser,
    name: 'Browser Use',
    description: 'Drive a Playwright browser session: navigate, click, type, snapshot, screenshot, extract, close.',
    toolDescription: 'Bundle of browser_navigate, browser_click, browser_type, browser_snapshot, browser_screenshot, browser_extract and more.',
    label: 'Browser',
    placeholder: 'Select a browser to add Browser Use',
    emptyPlaceholder: 'No browsers available',
    hint: 'Selecting a browser adds the Browser Use system tool to this agent.',
    nothingFound: 'No browsers',
  },
  {
    sourceKey: 'web_search',
    field: 'providerKey',
    icon: IconWorldSearch,
    name: 'Web Search',
    description: 'Search the web through a configured Web Search instance and return ranked results, optionally with a synthesized answer.',
    toolDescription: 'Search the web and return ranked results (title, url, snippet), with an optional AI-synthesized answer.',
    label: 'Web Search instance',
    placeholder: 'Select an instance to add Web Search',
    emptyPlaceholder: 'No web search instances available',
    hint: 'Selecting an instance adds the Web Search system tool to this agent.',
    nothingFound: 'No web search instances',
  },
  {
    sourceKey: 'crawler',
    field: 'crawlerKey',
    icon: IconWorldDownload,
    name: 'Web Fetch',
    description: 'Fetch a single page in real time through a configured Crawler (its engine, headers and auth) and return it as markdown.',
    toolDescription: 'Fetch one web page live and return its content as markdown. Limited to the hosts the crawler is configured for.',
    label: 'Crawler',
    placeholder: 'Select a crawler to add Web Fetch',
    emptyPlaceholder: 'No crawlers available',
    hint: 'Selecting a crawler adds the Web Fetch system tool to this agent. Pages are limited to the crawler\'s seed hosts and allow list.',
    nothingFound: 'No crawlers',
  },
] as const;

export const systemToolFor = (source: string, sourceKey: string) =>
  source === 'system' ? SYSTEM_TOOLS.find((tool) => tool.sourceKey === sourceKey) : undefined;

/** `source::sourceKey`: one group, one binding. */
export const sourceIdOf = (ref: { source: string; sourceKey: string }) => `${ref.source}::${ref.sourceKey}`;

const isInactive = (status: unknown) => typeof status === 'string' && status !== 'active';

async function getJson<T>(url: string): Promise<T | null> {
  try {
    return await apiGet<T>(url);
  } catch {
    return null;
  }
}

interface LoadInput {
  /** The agent being edited: its own MCP servers are listed with the hub's. */
  agentId?: string;
  bindings: ToolBinding[];
  flowTools: FlowToolSource | null;
  channelToolGroup: ChannelToolGroup | null;
}

/**
 * Every source, switched-off ones included (marked `inactive`). A source that fails to load is left out; the others
 * still are listed.
 */
export async function loadToolSources({ agentId, bindings, flowTools, channelToolGroup }: LoadInput): Promise<{
  sources: ToolSourceGroup[];
  flowsByKey: Record<string, unknown>;
}> {
  type ToolRecord = {
    key: string; name: string; description?: string; type: string; status?: string; managedBy?: { id: string };
    actions?: { key: string; name: string; description: string }[];
  };
  type McpRecord = {
    id: string; key: string; name: string; description?: string; status?: string; owner?: unknown;
    tools?: { name: string; description: string }[]; disabledTools?: string[];
  };

  const [toolsData, mcpData] = await Promise.all([
    getJson<{ tools?: ToolRecord[] }>('/api/tools'),
    // The hub's servers and this agent's own ones.
    getJson<{ servers?: McpRecord[] }>(`/api/mcp${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`),
  ]);

  const groups: ToolSourceGroup[] = SYSTEM_TOOLS.map((tool) => ({
    source: 'system' as const,
    sourceKey: tool.sourceKey,
    name: tool.name,
    description: tool.description,
    typeLabel: 'System',
    tools: [{ name: tool.sourceKey, description: tool.toolDescription }],
  }));
  if (channelToolGroup) groups.push(channelToolGroup);

  for (const t of toolsData?.tools ?? []) {
    groups.push({
      source: 'tool',
      sourceKey: t.key,
      name: t.name,
      description: t.description,
      typeLabel: t.type === 'openapi' ? 'OpenAPI' : t.type === 'connector' ? 'Connector' : 'MCP',
      managed: Boolean(t.managedBy),
      inactive: isInactive(t.status),
      tools: (t.actions ?? []).map((a) => ({ name: a.key, description: a.description || a.name })),
    });
  }

  for (const s of mcpData?.servers ?? []) {
    const disabled = new Set(s.disabledTools ?? []);
    groups.push({
      source: 'mcp',
      sourceKey: s.key,
      name: s.name,
      description: s.description,
      typeLabel: 'MCP server',
      ownedByAgent: Boolean(s.owner),
      recordId: s.id,
      inactive: isInactive(s.status),
      tools: (s.tools ?? []).filter((t) => !disabled.has(t.name)),
    });
  }

  // Flows (headless ones, published or draft). A person without flows access, or an edition
  // without the service, simply gets no group.
  let flowsByKey: Record<string, unknown> = {};
  if (flowTools) {
    try {
      const loaded = await flowTools.load(bindings);
      flowsByKey = loaded.known;
      groups.push(...loaded.groups);
    } catch {
      /* the flows service is optional here */
    }
  }

  return { sources: groups, flowsByKey };
}

/**
 * The tool sources, loaded while `enabled` and again whenever `reloadKey` changes or `reload()` is called. A load
 * started later wins over one still running.
 */
export function useToolSources({
  agentId,
  bindings,
  enabled,
  reloadKey = '',
}: {
  agentId?: string;
  bindings: ToolBinding[];
  enabled: boolean;
  reloadKey?: string;
}) {
  const flowTools = useFlowToolSource();
  const channelToolGroup = useChannelToolGroup();
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  const requestRef = useRef(0);
  const [state, setState] = useState<{ sources: ToolSourceGroup[]; flowsByKey: Record<string, unknown>; loaded: boolean }>(
    { sources: [], flowsByKey: {}, loaded: false },
  );
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const loaded = await loadToolSources({ agentId, bindings: bindingsRef.current, flowTools, channelToolGroup });
      if (request === requestRef.current) setState({ ...loaded, loaded: true });
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [agentId, flowTools, channelToolGroup]);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload, reloadKey]);

  return { ...state, loading, reload };
}
