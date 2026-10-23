/**
 * The Browser internal MCP provider: the tool list is derived from the agent
 * browser tools with an explicit `sessionKey`, `browser_open_session` opens a
 * session stamped with the MCP server that opened it, and a page tool only
 * drives a live session that this server opened on this server's browser —
 * any other key is reported as not found, before a tool runs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => {
  const toolFuncs: Record<string, ReturnType<typeof vi.fn>> = {};
  const toolNames = ['browser_navigate', 'browser_snapshot', 'browser_list_flows', 'browser_run_flow', 'browser_close'];
  for (const name of toolNames) toolFuncs[name] = vi.fn(async () => ({ ok: true, tool: name }));
  return {
    toolFuncs,
    buildBrowserAgentTools: vi.fn(() => toolNames.map((name) => ({
      name,
      description: `${name} description`,
      schema: name === 'browser_navigate'
        ? { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
        : undefined,
      func: toolFuncs[name],
    }))),
    createBrowserSession: vi.fn(),
    getBrowserSessionByKey: vi.fn(),
    listBrowsers: vi.fn(),
    resolveBrowser: vi.fn(),
    toolInputJsonSchema: (schema: unknown) => (schema as Record<string, unknown>) ?? { type: 'object', properties: {} },
  };
});

vi.mock('@/lib/services/browser', () => browser);

import { McpToolInputError } from '@/lib/services/mcp/errors';
import { browserProvider } from '@/lib/services/mcp/internal/browserProvider';
import { getInternalMcpProvider } from '@/lib/services/mcp/internal/registry';

const CTX = { tenantDbName: 'tenant_db', tenantId: 'tenant-1', projectId: 'project-a', serverKey: 'mcp-shop' };
const BROWSER = { _id: 'browser-id-1', key: 'shop', name: 'Shop', status: 'active' };

function liveSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionKey: 'bs_live',
    browserId: 'browser-id-1',
    status: 'idle',
    metadata: { source: 'browser-mcp', mcpServerKey: 'mcp-shop' },
    ...overrides,
  };
}

const run = (tool: string, args: Record<string, unknown>, ctx: typeof CTX | Omit<typeof CTX, 'serverKey'> = CTX) =>
  browserProvider.execute(ctx, 'shop', {}, tool, args);

beforeEach(() => {
  vi.clearAllMocks();
  browser.resolveBrowser.mockResolvedValue(BROWSER);
  browser.getBrowserSessionByKey.mockResolvedValue(liveSession());
  browser.createBrowserSession.mockResolvedValue({ sessionKey: 'bs_new', status: 'idle' });
});

describe('Browser provider', () => {
  it('is registered as an internal MCP provider', () => {
    expect(getInternalMcpProvider('browser')).toBe(browserProvider);
  });

  it('lists the project\'s active browsers as instances', async () => {
    browser.listBrowsers.mockResolvedValueOnce([{ key: 'shop', name: 'Shop', description: 'Storefront' }]);
    await expect(browserProvider.listInstances(CTX)).resolves.toEqual([
      { key: 'shop', label: 'Shop', description: 'Storefront' },
    ]);
    expect(browser.listBrowsers).toHaveBeenCalledWith(CTX, { status: 'active' });
  });

  it('refuses an instance that is not one of the project\'s browsers', async () => {
    browser.resolveBrowser.mockResolvedValueOnce(null);
    await expect(browserProvider.validateInstance(CTX, 'gone', {})).rejects.toThrow('Browser "gone" not found');
  });

  describe('the tool list', () => {
    it('leads with browser_open_session, then every agent browser tool', async () => {
      const { tools } = await browserProvider.buildTools(CTX, 'shop', {});
      expect(tools.map((tool) => tool.name)).toEqual([
        'browser_open_session',
        'browser_navigate',
        'browser_snapshot',
        'browser_list_flows',
        'browser_run_flow',
        'browser_close',
      ]);
    });

    it('requires a sessionKey on page tools, keeping their own arguments', async () => {
      const { tools } = await browserProvider.buildTools(CTX, 'shop', {});
      const navigate = tools.find((tool) => tool.name === 'browser_navigate')!;
      expect(navigate.inputSchema).toMatchObject({
        properties: { sessionKey: { type: 'string' }, url: { type: 'string' } },
        required: ['sessionKey', 'url'],
      });
      const close = tools.find((tool) => tool.name === 'browser_close')!;
      expect(close.inputSchema).toMatchObject({ required: ['sessionKey'] });
    });

    it('does not ask for a sessionKey where no session is used', async () => {
      const { tools } = await browserProvider.buildTools(CTX, 'shop', {});
      for (const name of ['browser_open_session', 'browser_list_flows', 'browser_run_flow']) {
        const tool = tools.find((candidate) => candidate.name === name)!;
        expect(tool.inputSchema.properties, name).not.toHaveProperty('sessionKey');
      }
    });

    it('marks observing tools read-only and the rest as changing state', async () => {
      const { tools } = await browserProvider.buildTools(CTX, 'shop', {});
      const hints = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint]));
      expect(hints).toMatchObject({ browser_snapshot: true, browser_list_flows: true, browser_navigate: false, browser_close: false });
    });
  });

  describe('browser_open_session', () => {
    it('opens a session on this browser, stamped with the MCP server that opened it', async () => {
      await expect(run('browser_open_session', {})).resolves.toMatchObject({ ok: true, sessionKey: 'bs_new' });
      expect(browser.createBrowserSession).toHaveBeenCalledWith(CTX, {
        browserId: 'browser-id-1',
        createdBy: 'mcp:mcp-shop',
        metadata: { source: 'browser-mcp', mcpServerKey: 'mcp-shop' },
      });
    });

    it('refuses a disabled browser', async () => {
      browser.resolveBrowser.mockResolvedValueOnce({ ...BROWSER, status: 'disabled' });
      const error = await run('browser_open_session', {}).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(McpToolInputError);
      expect(browser.createBrowserSession).not.toHaveBeenCalled();
    });

    it('refuses a call that did not come through an MCP server', async () => {
      const noServer = { tenantDbName: CTX.tenantDbName, tenantId: CTX.tenantId, projectId: CTX.projectId };
      await expect(run('browser_open_session', {}, noServer)).rejects.toThrow(/through an MCP server/);
      expect(browser.createBrowserSession).not.toHaveBeenCalled();
    });
  });

  describe('a page tool', () => {
    it('drives the named session with the remaining arguments', async () => {
      await expect(run('browser_navigate', { sessionKey: 'bs_live', url: 'https://example.test' }))
        .resolves.toEqual({ ok: true, tool: 'browser_navigate' });
      expect(browser.getBrowserSessionByKey).toHaveBeenCalledWith(CTX, 'bs_live');
      expect(browser.buildBrowserAgentTools).toHaveBeenLastCalledWith(expect.objectContaining({
        tenantDbName: 'tenant_db',
        tenantId: 'tenant-1',
        projectId: 'project-a',
        sessionKey: 'bs_live',
        createdBy: 'mcp:mcp-shop',
      }));
      expect(browser.toolFuncs.browser_navigate).toHaveBeenCalledWith({ url: 'https://example.test' });
    });

    it.each([
      ['no sessionKey', {}],
      ['a blank sessionKey', { sessionKey: '  ' }],
      ['a non-string sessionKey', { sessionKey: 7 }],
    ])('reports %s as an input error', async (_label, args) => {
      const error = await run('browser_navigate', args).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(McpToolInputError);
      expect((error as Error).message).toMatch(/"sessionKey" is required/);
      expect(browser.toolFuncs.browser_navigate).not.toHaveBeenCalled();
    });

    it.each([
      ['an unknown key', null],
      ['a session on another browser', liveSession({ browserId: 'browser-id-2' })],
      ['a session another MCP server opened', liveSession({ metadata: { source: 'browser-mcp', mcpServerKey: 'mcp-other' } })],
      ['a dashboard or agent session', liveSession({ metadata: { source: 'agent', mcpServerKey: 'mcp-shop' } })],
      ['a session with no metadata', liveSession({ metadata: undefined })],
    ])('reports %s exactly like an unknown key, and runs nothing', async (_label, session) => {
      browser.getBrowserSessionByKey.mockResolvedValueOnce(session);
      const error = await run('browser_snapshot', { sessionKey: 'bs_other' }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(McpToolInputError);
      expect((error as Error).message).toBe('Browser session "bs_other" not found');
      expect(browser.toolFuncs.browser_snapshot).not.toHaveBeenCalled();
    });

    it.each(['closed', 'expired', 'errored'])('reports a %s session as ended', async (status) => {
      browser.getBrowserSessionByKey.mockResolvedValueOnce(liveSession({ status }));
      const error = await run('browser_snapshot', { sessionKey: 'bs_live' }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(McpToolInputError);
      expect((error as Error).message).toMatch(/has ended .*browser_open_session/);
      expect(browser.toolFuncs.browser_snapshot).not.toHaveBeenCalled();
    });

    it('repeats only the first 100 characters of a session key', async () => {
      browser.getBrowserSessionByKey.mockResolvedValueOnce(null);
      const error = await run('browser_snapshot', { sessionKey: 'x'.repeat(5000) }).catch((caught: unknown) => caught);
      expect((error as Error).message.length).toBeLessThan(200);
    });
  });

  it('runs a flow tool without a session', async () => {
    await expect(run('browser_list_flows', { search: 'checkout' })).resolves.toEqual({ ok: true, tool: 'browser_list_flows' });
    expect(browser.getBrowserSessionByKey).not.toHaveBeenCalled();
    expect(browser.toolFuncs.browser_list_flows).toHaveBeenCalledWith({ search: 'checkout' });
  });

  it('keeps a plain error for a tool it does not serve', async () => {
    const error = await run('browser_drop_everything', { sessionKey: 'bs_live' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(McpToolInputError);
  });
});
