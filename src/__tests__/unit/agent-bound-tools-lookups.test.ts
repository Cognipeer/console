/**
 * `buildBoundTools` reads the records of all bindings at once and builds from them in binding order
 * (agentBoundTools.ts). What must not change: the tools come out in binding order whichever read returns first, a
 * binding that is inactive / missing / not open to the caller is skipped, the failure of the FIRST failing binding
 * (in binding order) is the one thrown, and a binding that opens something (a browser session) still runs one after
 * the other.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  resolveTool: vi.fn(),
  resolveServer: vi.fn(),
  mayUse: vi.fn(),
  resolveBrowser: vi.fn(),
  createBrowserSession: vi.fn(),
  closeBrowserSession: vi.fn(),
  buildBrowserAgentTools: vi.fn(),
}));

vi.mock('@/lib/services/agents/bindingResolution', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveAgentBindingTool: hoisted.resolveTool,
  resolveAgentBindingMcpServer: hoisted.resolveServer,
}));
vi.mock('@/lib/services/agents/sharedResourceAccess', () => ({ mayUseSharedResource: hoisted.mayUse }));
vi.mock('@/lib/services/browser', () => ({
  resolveBrowser: hoisted.resolveBrowser,
  createBrowserSession: hoisted.createBrowserSession,
  closeBrowserSession: hoisted.closeBrowserSession,
  buildBrowserAgentTools: hoisted.buildBrowserAgentTools,
}));

import { buildBoundTools } from '@/lib/services/agents/agentBoundTools';
import { createAgentToolGuard } from '@/lib/services/agents/agentToolGuard';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const inputSchema = { type: 'object', properties: {} };
const toolRecord = (key: string, extra: Record<string, unknown> = {}) => ({
  key, name: key, projectId: 'proj-1', status: 'active', metadata: {},
  actions: [{ key: `${key}_action`, name: `${key}_action`, inputSchema }],
  ...extra,
});
const serverRecord = (key: string, extra: Record<string, unknown> = {}) => ({
  _id: `id-${key}`, key, name: key, projectId: 'proj-1', status: 'active', metadata: {},
  tools: [{ name: `${key}_tool`, inputSchema }],
  ...extra,
});

const toolBinding = (key: string) => ({ source: 'tool', sourceKey: key, toolNames: [`${key}_action`] });
const mcpBinding = (key: string) => ({ source: 'mcp', sourceKey: key, toolNames: [`${key}_tool`] });
const browserBinding = (browserId: string) => ({ source: 'system', sourceKey: 'browser_use', toolNames: [], config: { browserId } });

const guard = createAgentToolGuard({
  tenantDbName: 'tenant_acme', tenantId: 'tenant-acme', projectId: 'proj-1', agentKey: 'agent-1', config: {}, actorId: 'user-1', source: 'agent',
});

function build(bindings: Array<Record<string, unknown>>) {
  return buildBoundTools(
    'tenant_acme', 'tenant-acme', 'proj-1', bindings as never,
    ((spec: unknown) => spec) as never, {} as never, guard,
  );
}

const names = (built: { tools: Array<{ name: string }> }) => built.tools.map((tool) => tool.name);

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.resolveTool.mockImplementation(async (_db: string, key: string) => toolRecord(key));
  hoisted.resolveServer.mockImplementation(async (_db: string, key: string) => serverRecord(key));
  hoisted.mayUse.mockResolvedValue(true);
  hoisted.resolveBrowser.mockResolvedValue({ _id: 'browser-1', status: 'active' });
  hoisted.createBrowserSession.mockResolvedValue({ sessionKey: 'session-1' });
  hoisted.closeBrowserSession.mockResolvedValue(undefined);
  hoisted.buildBrowserAgentTools.mockReturnValue([]);
});

describe('the records are read together', () => {
  it('starts every binding\'s read before the first one has answered', async () => {
    const log: string[] = [];
    hoisted.resolveTool.mockImplementation(async (_db: string, key: string) => {
      log.push(`start:${key}`);
      await sleep(key === 'slow' ? 40 : 1);
      log.push(`end:${key}`);
      return toolRecord(key);
    });

    await build([toolBinding('slow'), toolBinding('quick_a'), toolBinding('quick_b')]);

    expect(log.slice(0, 3)).toEqual(['start:slow', 'start:quick_a', 'start:quick_b']);
    expect(log.indexOf('start:quick_b')).toBeLessThan(log.indexOf('end:slow'));
  });

  it('builds the tools in binding order, tools and MCP servers alike, whichever read returns first', async () => {
    hoisted.resolveTool.mockImplementation(async (_db: string, key: string) => {
      await sleep(key === 'first' ? 40 : 1);
      return toolRecord(key);
    });
    hoisted.resolveServer.mockImplementation(async (_db: string, key: string) => {
      await sleep(key === 'server' ? 20 : 1);
      return serverRecord(key);
    });

    const built = await build([toolBinding('first'), mcpBinding('server'), toolBinding('last')]);

    expect(names(built)).toEqual(['first_action', 'server_tool', 'last_action']);
    expect(built.definitions.map((definition) => definition.name)).toEqual(['first_action', 'server_tool', 'last_action']);
  });
});

describe('what is left out stays left out', () => {
  it('skips an inactive tool, a missing tool, a missing server, an inactive server and a server closed to the caller', async () => {
    hoisted.resolveTool.mockImplementation(async (_db: string, key: string) => {
      if (key === 'missing_tool') return null;
      return toolRecord(key, key === 'off_tool' ? { status: 'inactive' } : {});
    });
    hoisted.resolveServer.mockImplementation(async (_db: string, key: string) => {
      if (key === 'missing_server') return null;
      return serverRecord(key, key === 'off_server' ? { status: 'inactive' } : {});
    });
    hoisted.mayUse.mockImplementation(async (_run: unknown, record: { key: string }) => record.key !== 'closed_server');

    const built = await build([
      toolBinding('ok_tool'), toolBinding('off_tool'), toolBinding('missing_tool'),
      mcpBinding('missing_server'), mcpBinding('off_server'), mcpBinding('closed_server'), mcpBinding('ok_server'),
    ]);

    expect(names(built)).toEqual(['ok_tool_action', 'ok_server_tool']);
  });

  it('asks the access list only about servers that exist and are active', async () => {
    hoisted.resolveServer.mockImplementation(async (_db: string, key: string) => (
      key === 'gone' ? null : serverRecord(key, key === 'off' ? { status: 'inactive' } : {})
    ));

    await build([mcpBinding('gone'), mcpBinding('off'), mcpBinding('live')]);

    expect(hoisted.mayUse).toHaveBeenCalledTimes(1);
    expect(hoisted.mayUse.mock.calls[0][1]).toMatchObject({ key: 'live' });
  });
});

describe('a read that fails', () => {
  it('throws the failure of the first failing binding, not of the first to fail in time', async () => {
    hoisted.resolveTool.mockImplementation(async (_db: string, key: string) => {
      if (key === 'broken_early') { await sleep(30); throw new Error('tool store unavailable'); }
      return toolRecord(key);
    });
    hoisted.resolveServer.mockImplementation(async (_db: string, key: string) => {
      if (key === 'broken_late') throw new Error('mcp store unavailable');
      return serverRecord(key);
    });

    await expect(build([toolBinding('fine'), toolBinding('broken_early'), mcpBinding('broken_late')]))
      .rejects.toThrow('tool store unavailable');
  });

  it('does not leave an unhandled rejection behind for the bindings after the failed one', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      hoisted.resolveTool.mockImplementation(async (_db: string, key: string) => {
        if (key === 'broken') throw new Error('tool store unavailable');
        await sleep(5);
        throw new Error(`late failure of ${key}`);
      });

      await expect(build([toolBinding('broken'), toolBinding('later_a'), toolBinding('later_b')])).rejects.toThrow('tool store unavailable');
      await sleep(30);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('a binding that opens a session stays serial', () => {
  it('opens browser sessions one after the other and cleans each up', async () => {
    const log: string[] = [];
    hoisted.createBrowserSession.mockImplementation(async (_scope: unknown, input: { browserId: string }) => {
      log.push(`open:${input.browserId}`);
      await sleep(15);
      log.push(`opened:${input.browserId}`);
      return { sessionKey: `session-${input.browserId}` };
    });
    hoisted.resolveBrowser.mockImplementation(async (_scope: unknown, id: string) => ({ _id: id, status: 'active' }));

    const built = await build([browserBinding('b1'), toolBinding('between'), browserBinding('b2')]);

    expect(log).toEqual(['open:b1', 'opened:b1', 'open:b2', 'opened:b2']);
    expect(names(built)).toEqual(['between_action']);
    expect(built.cleanupTasks).toHaveLength(2);
    await Promise.all(built.cleanupTasks.map((task) => task()));
    expect(hoisted.closeBrowserSession.mock.calls.map((call) => call[1])).toEqual(['session-b1', 'session-b2']);
  });
});
