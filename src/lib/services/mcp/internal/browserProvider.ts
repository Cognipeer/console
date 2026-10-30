/**
 * Internal MCP provider: Browser.
 *
 * Serves one of the project's browsers as MCP tools — the same tool set the
 * Browser Use system binding gives an agent (navigate, click, type, snapshot,
 * run a recorded flow, …), derived from `buildBrowserAgentTools` so the two
 * surfaces cannot drift.
 *
 * SESSIONS ARE EXPLICIT. An MCP tool call carries no transport session (it may
 * arrive over streamable HTTP, SSE, a composite, an agent binding or the
 * playground, and may be routed to another node), so a browser session cannot
 * be tied to the caller's connection. Instead `browser_open_session` returns a
 * `sessionKey` and every page tool takes it as an argument. A session is only
 * usable through the MCP server that opened it, on this server's browser; one
 * the caller forgets to close is reaped by the browser's idle timeout.
 */

import { McpToolInputError } from '../errors';
import {
  buildBrowserAgentTools,
  createBrowserSession,
  getBrowserSessionByKey,
  listBrowsers,
  resolveBrowser,
  toolInputJsonSchema,
} from '@/lib/services/browser';
import type { IMcpTool } from '@/lib/database';
import type {
  InternalMcpInstanceOption,
  InternalMcpProvider,
  InternalMcpProviderContext,
} from './types';

/** Session `metadata.source` — the sessions list badges these as "mcp". */
const SESSION_SOURCE = 'browser-mcp';

const TOOL_OPEN_SESSION = 'browser_open_session';

/** Longest piece of a caller-supplied key an error repeats back. */
const ECHOED_KEY_MAX_CHARS = 100;

/** Tools that never touch the caller's session: flows run in a session of their own. */
const SESSIONLESS_TOOLS = new Set(['browser_list_flows', 'browser_run_flow']);

/** Tools that only observe the page; everything else mutates page or session state. */
const READ_ONLY_TOOLS = new Set([
  'browser_wait',
  'browser_snapshot',
  'browser_find',
  'browser_extract',
  'browser_diagnostics',
  'browser_screenshot',
  'browser_pdf',
  'browser_list_flows',
]);

const ENDED_SESSION_STATUSES = new Set(['closed', 'errored', 'expired']);

const SESSION_KEY_PROPERTY = {
  type: 'string',
  description: 'The sessionKey returned by browser_open_session.',
};

/**
 * The agent tools, bound to `sessionKey`. With an empty context only `name`,
 * `description` and `schema` are meaningful — that is how the tool list is
 * built without opening anything.
 */
function bindAgentTools(ctx: InternalMcpProviderContext, sessionKey: string, createdBy: string) {
  return buildBrowserAgentTools({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    sessionKey,
    createdBy,
  }) as Array<{ name: string; description?: string; schema?: unknown; func: (input: never) => Promise<unknown> }>;
}

function withSessionKey(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema.properties as Record<string, unknown> | undefined) ?? {};
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return {
    ...schema,
    properties: { sessionKey: SESSION_KEY_PROPERTY, ...properties },
    required: ['sessionKey', ...required],
  };
}

function buildToolList(): IMcpTool[] {
  const agentTools = bindAgentTools({ tenantDbName: '', tenantId: '' }, '', 'schema-probe').map((tool) => {
    const readOnly = READ_ONLY_TOOLS.has(tool.name);
    const inputSchema = toolInputJsonSchema(tool.schema);
    return {
      name: tool.name,
      description: tool.description ?? tool.name,
      inputSchema: SESSIONLESS_TOOLS.has(tool.name) ? inputSchema : withSessionKey(inputSchema),
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: !readOnly,
        idempotentHint: readOnly,
        openWorldHint: true,
      },
    };
  });

  return [
    {
      name: TOOL_OPEN_SESSION,
      description:
        'Open a new session on this browser and return its `sessionKey`. Pass that key to every other '
        + 'browser_* tool, and call browser_close when the task is done — an idle session is closed '
        + 'automatically after a few minutes.',
      inputSchema: { type: 'object', properties: {} },
      annotations: {
        title: 'Open browser session',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ...agentTools,
  ];
}

function requireServerKey(ctx: InternalMcpProviderContext): string {
  if (!ctx.serverKey) {
    throw new Error('Browser tools must be called through an MCP server');
  }
  return ctx.serverKey;
}

async function requireActiveBrowser(ctx: InternalMcpProviderContext, instanceKey: string) {
  const browser = await resolveBrowser(ctx, instanceKey);
  if (!browser) {
    throw new Error(`Browser "${instanceKey}" not found`);
  }
  if (browser.status !== 'active') {
    throw new Error(`Browser "${browser.key}" is disabled`);
  }
  return browser;
}

export const browserProvider: InternalMcpProvider = {
  id: 'browser',
  label: 'Browser',
  description:
    'Drive one of this project\'s browsers: open a session, navigate, click, type, read the page and replay recorded flows.',
  configFields: [],
  // A browser reaches whatever address the console can.
  tokenOnly: true,

  async listInstances(ctx): Promise<InternalMcpInstanceOption[]> {
    const browsers = await listBrowsers(ctx, { status: 'active' });
    return browsers.map((browser) => ({
      key: browser.key,
      label: browser.name,
      description: browser.description,
    }));
  },

  async validateInstance(ctx, instanceKey) {
    if (!(await resolveBrowser(ctx, instanceKey))) {
      throw new Error(`Browser "${instanceKey}" not found`);
    }
  },

  async buildTools(ctx, instanceKey) {
    const browser = await resolveBrowser(ctx, instanceKey);
    return {
      tools: buildToolList(),
      suggestedName: browser?.name ? `${browser.name} (browser)` : 'Browser',
      suggestedDescription: `Browser automation tools for the "${browser?.name ?? instanceKey}" browser.`,
      instructions:
        `Every page tool works inside a session: call "${TOOL_OPEN_SESSION}" first and pass the sessionKey `
        + 'it returns to each browser_* tool, then call browser_close when the task is done (an idle '
        + 'session closes on its own after a few minutes). browser_list_flows and browser_run_flow need no '
        + 'session — a flow runs in one of its own.',
    };
  },

  async execute(ctx, instanceKey, _config, toolName, args) {
    const serverKey = requireServerKey(ctx);
    const browser = await requireActiveBrowser(ctx, instanceKey);
    const createdBy = `mcp:${serverKey}`;

    if (toolName === TOOL_OPEN_SESSION) {
      const session = await createBrowserSession(ctx, {
        browserId: String(browser._id ?? ''),
        createdBy,
        metadata: { source: SESSION_SOURCE, mcpServerKey: serverKey },
      });
      return {
        ok: true,
        sessionKey: session.sessionKey,
        status: session.status,
        hint: 'Pass sessionKey to the other browser_* tools; call browser_close when done.',
      };
    }

    let sessionKey = '';
    const { sessionKey: rawSessionKey, ...toolArgs } = args;
    if (!SESSIONLESS_TOOLS.has(toolName)) {
      if (typeof rawSessionKey !== 'string' || rawSessionKey.trim() === '') {
        throw new McpToolInputError('"sessionKey" is required — open one with browser_open_session');
      }
      sessionKey = rawSessionKey.trim();
      const echoed = sessionKey.slice(0, ECHOED_KEY_MAX_CHARS);
      const session = await getBrowserSessionByKey(ctx, sessionKey);
      // A session opened anywhere else — the dashboard, an agent run, another
      // MCP server, another browser — is reported exactly like an unknown key.
      if (
        !session
        || session.browserId !== String(browser._id ?? '')
        || session.metadata?.source !== SESSION_SOURCE
        || session.metadata?.mcpServerKey !== serverKey
      ) {
        throw new McpToolInputError(`Browser session "${echoed}" not found`);
      }
      if (ENDED_SESSION_STATUSES.has(session.status)) {
        throw new McpToolInputError(
          `Browser session "${echoed}" has ended (${session.status}) — open a new one with browser_open_session`,
        );
      }
    }

    const tool = bindAgentTools(ctx, sessionKey, createdBy).find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new Error(`Unknown Browser tool "${toolName}"`);
    }
    return tool.func(toolArgs as never);
  },
};
