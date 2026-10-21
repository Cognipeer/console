/**
 * The names an agent's MCP and Tools-module tools reach the model under, and
 * the bound MCP servers' instructions in its system prompt.
 *
 * Two servers that both export `search` used to leave the model one of them;
 * a name with a dot failed the whole provider request; a bound tool named like
 * a read-only built-in skipped the approval that tool would have needed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IMcpServer } from '@/lib/database';

const hoisted = vi.hoisted(() => ({
  servers: new Map<string, unknown>(),
  instructions: new Map<string, string>(),
  executeMcpTool: vi.fn(),
}));

vi.mock('@/lib/services/guardrail/hooks/engine', () => ({
  runHook: vi.fn(async ({ hook }: { hook: string }) => ({ hook, decision: 'allow', findings: [] })),
  resolveGuardrail: vi.fn(async () => null),
  ensureDefaultToolGuardrail: vi.fn(async () => ({ key: 'tool-safety-default' })),
  DEFAULT_TOOL_GUARDRAIL_KEY: 'tool-safety-default',
  mergeVerdicts: vi.fn(),
  assertContractVersion: vi.fn(),
}));

vi.mock('@/lib/services/mcp', () => ({
  getMcpServerByKey: async (_db: string, key: string) => hoisted.servers.get(key) ?? null,
  executeMcpTool: hoisted.executeMcpTool,
  isMcpToolEnabled: () => true,
  resolveMcpInstructions: (server: { key: string }) => hoisted.instructions.get(server.key),
}));

vi.mock('@/lib/services/mcp/mcpService', () => ({
  resolveMcpGuardrailBinding: () => ({ mode: 'enforce', guardrailKey: 'gr-mcp' }),
}));

import {
  boundMcpInstructionsPrompt,
  buildBoundTools,
  createAgentToolGuard,
  finalizeBoundToolNames,
} from '@/lib/services/agents/agentService';
import { resolveHitlConfig, toolApprovalPolicy } from '@/lib/services/agents/agentHumanInTheLoop';
import {
  assignBoundToolNames,
  prefixedToolName,
  sanitizeToolName,
} from '@/lib/services/agents/boundToolNames';

function server(key: string, name: string, tools: string[]): IMcpServer {
  return {
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    key,
    name,
    status: 'active',
    tools: tools.map((tool) => ({ name: tool, description: `${tool} on ${name}`, inputSchema: { type: 'object' } })),
    upstreamAuth: { type: 'none' },
    endpointSlug: key,
    createdBy: 'user-1',
  } as IMcpServer;
}

async function build(bindings: Array<{ source: string; sourceKey: string; toolNames: string[] }>) {
  const { createTool } = await import('@cognipeer/agent-sdk');
  const { z } = await import('zod');
  const guard = createAgentToolGuard({
    tenantDbName: 't', tenantId: 'tenant-1', projectId: 'proj-1', agentKey: 'agent', config: {}, actorId: 'user-1', source: 'agent',
  });
  const built = await buildBoundTools('t', 'tenant-1', 'proj-1', bindings, createTool, z, guard);
  return built;
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.servers.clear();
  hoisted.instructions.clear();
  hoisted.executeMcpTool.mockResolvedValue({ result: 'ok', latencyMs: 1 });
});

describe('bound tool names', () => {
  it('keeps a name every provider accepts, and makes one that is not', () => {
    expect(sanitizeToolName('search_orders')).toBe('search_orders');
    expect(sanitizeToolName('files.read')).toBe('files_read');
    expect(sanitizeToolName('a'.repeat(80))).toHaveLength(64);
    expect(sanitizeToolName('a'.repeat(80))).not.toBe(sanitizeToolName(`${'a'.repeat(79)}b`));
    expect(prefixedToolName('my.server', 'x'.repeat(70))).toMatch(/^my_server__x+_[0-9a-f]{8}$/);
    expect(prefixedToolName('my.server', 'x'.repeat(70))).toHaveLength(64);
  });

  it('prefixes every tool that shares a name, and one a built-in owns', () => {
    const names = assignBoundToolNames(
      [
        { name: 'search', source: 'alpha' },
        { name: 'search', source: 'beta' },
        { name: 'fetch', source: 'alpha' },
        { name: 'web_search', source: 'beta' },
      ],
      new Set(['knowledge_search']),
      (name) => name === 'web_search',
    );
    expect(names).toEqual(['alpha__search', 'beta__search', 'fetch', 'beta__web_search']);
  });

  it('keeps the same tool bound twice apart', () => {
    const names = assignBoundToolNames(
      [{ name: 'search', source: 'alpha' }, { name: 'search', source: 'alpha' }],
      new Set(),
      () => false,
    );
    expect(names).toEqual(['alpha__search', 'alpha__search_2']);
  });

  it('gives two servers\' `search` each its own tool, calling the right server', async () => {
    hoisted.servers.set('alpha', server('alpha', 'Alpha', ['search', 'fetch']));
    hoisted.servers.set('beta', server('beta', 'Beta', ['search']));
    const built = await build([
      { source: 'mcp', sourceKey: 'alpha', toolNames: ['search', 'fetch'] },
      { source: 'mcp', sourceKey: 'beta', toolNames: ['search'] },
    ]);
    finalizeBoundToolNames(built.tools, built.naming);

    expect(built.tools.map((tool) => tool.name)).toEqual(['alpha__search', 'fetch', 'beta__search']);
    expect(built.definitions.map((definition) => definition.name)).toEqual(['alpha__search', 'fetch', 'beta__search']);
    expect(built.tools[2]!.description).toBe('[Beta] search on Beta');

    await (built.tools[2] as unknown as { invoke: (args: unknown) => Promise<unknown> }).invoke({ q: 'x' });
    const [calledServer, calledTool, calledArgs] = hoisted.executeMcpTool.mock.calls[0]!;
    expect([(calledServer as IMcpServer).key, calledTool, calledArgs]).toEqual(['beta', 'search', { q: 'x' }]);
  });

  it('takes a built-in\'s name away from a bound tool, and with it the read-only approval exemption', async () => {
    hoisted.servers.set('crm', server('crm', 'CRM', ['web_search', 'files.read']));
    const built = await build([{ source: 'mcp', sourceKey: 'crm', toolNames: ['web_search', 'files.read'] }]);
    finalizeBoundToolNames(built.tools, built.naming);
    const [spoof, dotted] = built.tools as Array<{ name: string; policyNames?: string[] }>;

    expect(spoof!.name).toBe('crm__web_search');
    expect(dotted!.name).toBe('files_read');

    const hitl = resolveHitlConfig({ toolApproval: { enabled: true, defaultPolicy: 'always', tools: { 'files.read': 'never' } } });
    // `web_search` is a read-only built-in: its exemption must not carry over to the server's tool.
    expect(toolApprovalPolicy(hitl, 'web_search')).toBe('never');
    expect(spoof!.policyNames).toBeUndefined();
    expect(toolApprovalPolicy(hitl, spoof!.name, spoof!.policyNames)).toBe('always');
    // A setting stored under the tool's own name still applies after the rename.
    expect(dotted!.policyNames).toEqual(['files.read']);
    expect(toolApprovalPolicy(hitl, dotted!.name, dotted!.policyNames)).toBe('never');
  });

  it('avoids the names of the run\'s other tools', async () => {
    hoisted.servers.set('alpha', server('alpha', 'Alpha', ['todo_write', 'lookup']));
    const built = await build([{ source: 'mcp', sourceKey: 'alpha', toolNames: ['todo_write', 'lookup'] }]);
    const { createTool } = await import('@cognipeer/agent-sdk');
    const { z } = await import('zod');
    const all = [createTool({ name: 'lookup', schema: z.object({}), func: async () => 'x' }), ...built.tools];
    finalizeBoundToolNames(all as typeof built.tools, built.naming, ['todo_write']);
    expect(all.map((tool) => tool.name)).toEqual(['lookup', 'alpha__todo_write', 'alpha__lookup']);
  });
});

describe('bound MCP servers\' instructions', () => {
  it('reach the system prompt under the server\'s name, naming its tools as the model sees them', async () => {
    hoisted.servers.set('alpha', server('alpha', 'Alpha', ['search']));
    hoisted.servers.set('beta', server('beta', 'Beta', ['search']));
    hoisted.servers.set('gamma', server('gamma', 'Gamma', ['ping']));
    hoisted.instructions.set('alpha', 'Call search before fetch.');
    hoisted.instructions.set('beta', 'Beta search is slow.');
    const built = await build([
      { source: 'mcp', sourceKey: 'alpha', toolNames: ['search'] },
      { source: 'mcp', sourceKey: 'beta', toolNames: ['search'] },
      { source: 'mcp', sourceKey: 'gamma', toolNames: ['ping'] },
    ]);
    finalizeBoundToolNames(built.tools, built.naming);
    const prompt = boundMcpInstructionsPrompt(built.mcpInstructions)!;

    expect(prompt).toContain('## Connected MCP servers');
    expect(prompt).toContain('<mcp_server_instructions server="Alpha" tools="alpha__search">\nCall search before fetch.\n</mcp_server_instructions>');
    expect(prompt).toContain('server="Beta" tools="beta__search"');
    // A server without instructions adds nothing.
    expect(prompt).not.toContain('Gamma');
  });

  it('add nothing when no bound server has instructions, or the server gave no tool', async () => {
    hoisted.servers.set('alpha', server('alpha', 'Alpha', ['search']));
    hoisted.instructions.set('alpha', 'Call search first.');
    const none = await build([{ source: 'mcp', sourceKey: 'alpha', toolNames: ['missing'] }]);
    expect(boundMcpInstructionsPrompt(none.mcpInstructions)).toBeUndefined();
    hoisted.instructions.clear();
    const silent = await build([{ source: 'mcp', sourceKey: 'alpha', toolNames: ['search'] }]);
    expect(boundMcpInstructionsPrompt(silent.mcpInstructions)).toBeUndefined();
  });

  it('speak once for a server bound twice, and stay bounded', async () => {
    hoisted.servers.set('alpha', server('alpha', 'Alpha', ['search', 'fetch']));
    hoisted.instructions.set('alpha', 'x'.repeat(5_000));
    const built = await build([
      { source: 'mcp', sourceKey: 'alpha', toolNames: ['search'] },
      { source: 'mcp', sourceKey: 'alpha', toolNames: ['fetch'] },
    ]);
    finalizeBoundToolNames(built.tools, built.naming);
    const prompt = boundMcpInstructionsPrompt(built.mcpInstructions)!;
    expect(prompt.match(/<mcp_server_instructions/g)).toHaveLength(1);
    expect(prompt).toContain('tools="search, fetch"');
    expect(prompt.length).toBeLessThan(2_500);
  });
});
