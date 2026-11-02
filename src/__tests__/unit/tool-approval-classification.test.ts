/**
 * One approval rule for every tool source: how a tool is classified from the markings on its action
 * (reads / writes / destructive / no hints), where the markings come from (MCP `tools/list`, the HTTP method,
 * a managed tool's owner), and how the agent's settings and the run decide from the class.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ remoteListTools: vi.fn() }));
vi.mock('@/lib/services/mcp/remoteMcpClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/mcp/remoteMcpClient')>()),
  remoteListTools: hoisted.remoteListTools,
}));

import {
  classifyAnnotations,
  effectiveActionAnnotations,
  httpMethodReadsOnly,
  mcpToolMarkings,
  sanitizeAnnotations,
} from '@/lib/services/tools/actionAnnotations';
import { discoverMcpTools, parseOpenApiToActions, serializeTool } from '@/lib/services/tools/toolService';
import {
  applyToolApprovals,
  classifyTool,
  clientApprovalConfig,
  denyUnattendedTools,
  gateChildTools,
  resolveHitlConfig,
  toolApprovalPolicy,
  toolApprovalPolicySource,
  toolCallDecision,
  validateHitlConfig,
} from '@/lib/services/agents/agentHumanInTheLoop';
import { withToolMedia } from '@/lib/services/agents/toolMedia';
import { boundToolKinds, hitlToolRows, setToolChoice } from '@/components/agents/studio/hitlSettings';
import type { ITool } from '@/lib/database';

beforeEach(() => vi.clearAllMocks());

describe('classifyTool', () => {
  it('reads: readOnlyHint true, whatever else is set', () => {
    expect(classifyTool('x', { readOnlyHint: true })).toBe('reads');
    expect(classifyTool('x', { readOnlyHint: true, destructiveHint: true })).toBe('reads');
  });

  it('writes: readOnlyHint false, destructive not set or false (the shape a connector write is stored with)', () => {
    expect(classifyTool('x', { readOnlyHint: false })).toBe('writes');
    expect(classifyTool('x', { readOnlyHint: false, destructiveHint: false })).toBe('writes');
  });

  it('destructive: not read-only and destructiveHint true (a connector destructive action)', () => {
    expect(classifyTool('x', { readOnlyHint: false, destructiveHint: true })).toBe('destructive');
    expect(classifyTool('x', { destructiveHint: true })).toBe('destructive');
  });

  it('no hints: a bound tool whose source says nothing (MCP without annotations) is not read-only', () => {
    expect(classifyTool('x', {})).toBe('nohints');
    expect(classifyTool('x', { title: 'Fetch', idempotentHint: true, openWorldHint: true })).toBe('nohints');
    expect(classifyAnnotations(undefined)).toBe('nohints');
  });

  it('a tool Console builds itself keeps the read-only list and prefixes', () => {
    expect(classifyTool('web_search')).toBe('reads');
    expect(classifyTool('knowledge_search_docs')).toBe('reads');
    expect(classifyTool('memory_search')).toBe('reads');
    expect(classifyTool('sandbox_exec')).toBe('writes');
    expect(classifyTool('reminder_set')).toBe('writes');
  });

  it('a bound tool is classified by its markings even when its name is on the read-only list', () => {
    expect(classifyTool('web_search', {})).toBe('nohints');
    expect(classifyTool('knowledge_search', { readOnlyHint: false })).toBe('writes');
  });
});

describe('where the markings come from', () => {
  it('OpenAPI: GET and HEAD read, every other method does not (at import)', () => {
    expect(['GET', 'head', ' get '].every(httpMethodReadsOnly)).toBe(true);
    expect(['POST', 'PUT', 'PATCH', 'DELETE', undefined].some((method) => httpMethodReadsOnly(method))).toBe(false);

    const spec = JSON.stringify({
      openapi: '3.0.0', servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/c': { get: { operationId: 'list_c' }, post: { operationId: 'make_c' }, delete: { operationId: 'drop_c' } },
      },
    });
    const { actions } = parseOpenApiToActions(spec);
    const byKey = Object.fromEntries(actions.map((a) => [a.name, a.annotations]));
    expect(byKey).toMatchObject({ list_c: { readOnlyHint: true }, make_c: { readOnlyHint: false }, drop_c: { readOnlyHint: false } });
  });

  it('OpenAPI record saved before the field existed: derived from the method when read, no migration', () => {
    const old = { executionType: 'openapi_http' as const, httpMethod: 'GET' };
    expect(effectiveActionAnnotations(old)).toEqual({ readOnlyHint: true });
    expect(effectiveActionAnnotations({ executionType: 'openapi_http', httpMethod: 'PATCH' })).toEqual({ readOnlyHint: false });
    // A marking the record carries is never overridden by the method.
    expect(effectiveActionAnnotations({ ...old, annotations: { readOnlyHint: false } })).toEqual({ readOnlyHint: false });
  });

  it('MCP and managed actions without markings stay without: nothing is invented', () => {
    expect(effectiveActionAnnotations({ executionType: 'mcp_call' })).toEqual({});
    expect(effectiveActionAnnotations({ executionType: 'connector_action' })).toEqual({});
    expect(effectiveActionAnnotations({ executionType: 'connector_action', annotations: { readOnlyHint: false, destructiveHint: true } }))
      .toEqual({ readOnlyHint: false, destructiveHint: true });
  });

  it('MCP tools/list: the server annotations and title are stored on the action; junk is dropped', async () => {
    hoisted.remoteListTools.mockResolvedValue([
      { name: 'search', description: 's', inputSchema: {}, title: 'Search', annotations: { readOnlyHint: true, openWorldHint: true, extra: 'x', destructiveHint: 'yes' } },
      { name: 'fetch', description: 'f', inputSchema: {} },
    ]);
    const actions = await discoverMcpTools('https://mcp.example.com/mcp', 'streamable-http');
    expect(actions[0].annotations).toEqual({ title: 'Search', readOnlyHint: true, openWorldHint: true });
    expect(actions[1]).not.toHaveProperty('annotations');
    expect(sanitizeAnnotations('nope')).toBeUndefined();
  });

  it('the API view carries the derived markings, so a client sees what the runtime decides by', () => {
    const view = serializeTool({
      _id: 't1', tenantId: 'x', key: 'k', name: 'K', type: 'openapi', status: 'active', createdBy: 'u',
      actions: [
        { key: 'a', name: 'a', description: '', inputSchema: {}, executionType: 'openapi_http', httpMethod: 'GET' },
        { key: 'b', name: 'b', description: '', inputSchema: {}, executionType: 'mcp_call' },
      ],
    } as unknown as ITool);
    expect(view.actions[0].annotations).toEqual({ readOnlyHint: true });
    expect(view.actions[1]).not.toHaveProperty('annotations');
  });
});

describe('the policy from the class', () => {
  const on = (hitl: Parameters<typeof resolveHitlConfig>[0] = {}) => resolveHitlConfig({ toolApproval: { enabled: true, ...hitl?.toolApproval }, ...hitl });

  it('not read-only asks by default; reads does not', () => {
    for (const kind of ['writes', 'destructive', 'nohints'] as const) expect(toolApprovalPolicy(on(), 'send', kind)).toBe('always');
    expect(toolApprovalPolicy(on(), 'search', 'reads')).toBe('never');
    expect(toolApprovalPolicySource(on(), 'search', 'reads')).toBe('read_only');
    expect(toolApprovalPolicySource(on(), 'send', 'writes')).toBe('default_policy');
  });

  it('an explicit per-tool setting wins in both directions', () => {
    const resolved = on({ toolApproval: { enabled: true, tools: { send: 'never', search: 'always' } } });
    expect(toolApprovalPolicy(resolved, 'send', 'destructive')).toBe('never');
    expect(toolApprovalPolicy(resolved, 'search', 'reads')).toBe('always');
    expect(toolApprovalPolicySource(resolved, 'send', 'writes')).toBe('tool_policy');
  });

  it('the default policy means what the owner set; a missing config means "ask"', () => {
    expect(toolApprovalPolicy(on({ toolApproval: { enabled: true, defaultPolicy: 'never' } }), 'send', 'writes')).toBe('never');
    expect(toolApprovalPolicy(resolveHitlConfig(undefined), 'send', 'nohints')).toBe('always');
    expect(resolveHitlConfig({ toolApproval: { enabled: false } }).toolApprovalEnabled).toBe(false);
  });

  const makeTool = (name: string, hitlKind?: string) => {
    const run = vi.fn(async () => 'ran');
    return { name, func: run, invoke: run, call: run, run, ...(hitlKind ? { hitlKind } : {}) };
  };

  it('applyToolApprovals gates by the kind the tool carries; the kind survives the wrappers that spread the tool', () => {
    const write = makeTool('send', 'writes');
    const read = makeTool('search', 'reads');
    const gated = applyToolApprovals([write, read], on(), new Set());
    expect(typeof (gated[0] as { needsApproval?: unknown }).needsApproval).toBe('function');
    expect(gated[1]).toBe(read);
    expect((gated[0] as { hitlKind?: string }).hitlKind).toBe('writes');
    expect(withToolMedia(gated[0] as never, { store: {} } as never)).toMatchObject({ hitlKind: 'writes' });
  });

  it('the session allow-list lets a write through without a pause, never an argument exception', () => {
    const resolved = on({ toolApproval: { enabled: true, exceptions: { send: [{ field: 'to', pattern: '*@rival.example', action: 'ask' }] } } });
    const [gated] = applyToolApprovals([makeTool('send', 'writes')], resolved, new Set(['send']));
    const asks = (gated as unknown as { needsApproval: (args: unknown) => boolean }).needsApproval;
    expect(asks({ to: 'a@example.com' })).toBe(false);
    expect(asks({ to: 'x@rival.example' })).toBe(true);
  });

  it('argument exceptions keep working on a bound tool: a deny blocks, an allow lets a write through', () => {
    const resolved = on({ toolApproval: { enabled: true, exceptions: { send: [
      { field: 'to', pattern: '*@example.com', action: 'allow' },
      { field: 'to', pattern: '*@rival.example', action: 'deny' },
    ] } } });
    expect(toolCallDecision(resolved, 'send', { to: 'a@example.com' }, 'writes')).toMatchObject({ action: 'allow', source: 'exception' });
    expect(toolCallDecision(resolved, 'send', { to: 'x@rival.example' }, 'writes')).toMatchObject({ action: 'deny' });
    expect(toolCallDecision(resolved, 'send', { to: 'x@other.test' }, 'writes')).toMatchObject({ action: 'ask', source: 'default_policy' });
    expect(toolCallDecision(resolved, 'send', { to: 'x@other.test' }, 'reads')).toMatchObject({ action: 'allow', source: 'read_only' });
  });

  it('unattended: a write is refused with the message that names the fix; a read runs; "never" runs', async () => {
    const [write, read, freed] = denyUnattendedTools(
      [makeTool('send', 'writes'), makeTool('search', 'reads'), makeTool('free', 'destructive')],
      on({ toolApproval: { enabled: true, tools: { free: 'never' } } }),
      new Set(),
    );
    await expect((write as { func: () => Promise<unknown> }).func()).rejects.toThrow(/no approver is available[\s\S]*Never ask[\s\S]*humanInTheLoop/);
    expect(await (read as { func: () => Promise<unknown> }).func()).toBe('ran');
    expect(await (freed as { func: () => Promise<unknown> }).func()).toBe('ran');
  });

  it('sub-agent sides: a write is gated when either side asks, refused when a side cannot ask', async () => {
    const asking = on();
    const lenient = on({ toolApproval: { enabled: true, defaultPolicy: 'never' } });
    const [both] = gateChildTools([makeTool('send', 'writes')], [{ hitl: lenient, mode: 'ask' }, { hitl: asking, mode: 'ask' }], new Set());
    expect(typeof (both as { needsApproval?: unknown }).needsApproval).toBe('function');
    const [refused] = gateChildTools([makeTool('send', 'writes')], [{ hitl: asking, mode: 'deny' }, { hitl: lenient, mode: 'ask' }], new Set());
    await expect((refused as { func: () => Promise<unknown> }).func()).rejects.toThrow(/no approver/);
  });
});

describe('the settings table', () => {
  const toolConfig = {
    toolBindings: [
      { source: 'tool', sourceKey: 'crm', toolNames: ['get_customer', 'create_customer', 'delete_customer'] },
      { source: 'tool', sourceKey: 'mail', toolNames: ['send_email'] },
      { source: 'mcp', sourceKey: 'web', toolNames: ['fetch', 'search'] },
    ],
    sandbox: { enabled: true },
  };
  const records = [
    {
      key: 'crm',
      actions: [
        { key: 'get_customer', name: 'get_customer', executionType: 'openapi_http' as const, httpMethod: 'GET' },
        { key: 'create_customer', name: 'create_customer', executionType: 'openapi_http' as const, httpMethod: 'POST' },
        { key: 'delete_customer', name: 'delete_customer', executionType: 'openapi_http' as const, httpMethod: 'DELETE', annotations: { readOnlyHint: false, destructiveHint: true } },
      ],
    },
    { key: 'mail', actions: [{ key: 'send_email', name: 'send_email', executionType: 'connector_action' as const, annotations: { readOnlyHint: false, destructiveHint: false } }] },
  ];
  const mcp = [{ key: 'web', tools: [{ name: 'fetch' }, { name: 'search', annotations: { readOnlyHint: true } }] }];

  it('boundToolKinds classifies every source the way the runtime does', () => {
    expect(boundToolKinds(toolConfig.toolBindings, records, mcp)).toEqual({
      get_customer: 'reads', create_customer: 'writes', delete_customer: 'destructive', send_email: 'writes', fetch: 'nohints', search: 'reads',
    });
  });

  it('rows carry the kind and what the runtime will do; a bound tool with no record counts as no hints and asks', () => {
    const kinds = boundToolKinds(toolConfig.toolBindings, records, mcp);
    const rows = Object.fromEntries(hitlToolRows(toolConfig, undefined, undefined, kinds).map((row) => [row.name, row]));
    expect(rows.get_customer).toMatchObject({ kind: 'reads', readOnly: true, effective: 'never' });
    expect(rows.create_customer).toMatchObject({ kind: 'writes', readOnly: false, effective: 'always' });
    expect(rows.delete_customer).toMatchObject({ kind: 'destructive', effective: 'always' });
    expect(rows.fetch).toMatchObject({ kind: 'nohints', effective: 'always' });
    // Console's own tools: by name.
    expect(rows.sandbox_exec).toMatchObject({ kind: 'writes', effective: 'always' });
    expect(rows.read).toMatchObject({ kind: 'reads', effective: 'never' });

    const unloaded = Object.fromEntries(hitlToolRows(toolConfig, undefined).map((row) => [row.name, row]));
    expect(unloaded.get_customer).toMatchObject({ kind: 'nohints', effective: 'always' });
  });

  it('"Never ask" is stored as the existing per-tool policy and shows as not asking', () => {
    const kinds = boundToolKinds(toolConfig.toolBindings, records, mcp);
    const hitl = setToolChoice(undefined, 'send_email', 'never');
    // A new block leaves `enabled` unset: approval stays on by default and client tools are not switched on.
    expect(hitl).toEqual({ toolApproval: { tools: { send_email: 'never' } } });
    const row = hitlToolRows(toolConfig, hitl, undefined, kinds).find((r) => r.name === 'send_email')!;
    expect(row).toMatchObject({ choice: 'never', effective: 'never' });
  });
});

describe('MCP markings: operator overrides, source defaults, proxied methods', () => {
  it('the operator override wins over what the server sent; the source default and the method fill gaps only', () => {
    expect(mcpToolMarkings({ annotations: { readOnlyHint: true } }, { readOnlyHint: false, destructiveHint: true }, undefined))
      .toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(classifyTool('t', mcpToolMarkings({}, undefined, { readOnlyHint: true, destructiveHint: false }))).toBe('reads');
    expect(classifyTool('t', mcpToolMarkings({ annotations: { readOnlyHint: false } }, undefined, { readOnlyHint: true }))).toBe('writes');
    expect(classifyTool('t', mcpToolMarkings({ httpMethod: 'get' }, undefined, undefined))).toBe('reads');
    expect(classifyTool('t', mcpToolMarkings({ httpMethod: 'POST' }, undefined, undefined))).toBe('writes');
    expect(classifyTool('t', mcpToolMarkings({ annotations: { readOnlyHint: false }, httpMethod: 'GET' }, undefined, undefined))).toBe('writes');
    expect(classifyTool('t', mcpToolMarkings({}, undefined, undefined))).toBe('nohints');
  });

  it('the settings table reads the same view the runtime does', () => {
    const bindings = [{ source: 'mcp', sourceKey: 'ext', toolNames: ['wipe', 'lookup'] }, { source: 'mcp', sourceKey: 'kb', toolNames: ['search_kb'] }, { source: 'mcp', sourceKey: 'api', toolNames: ['list_orders'] }];
    const servers = [
      { key: 'ext', sourceType: 'remote', tools: [{ name: 'wipe', annotations: { readOnlyHint: true } }, { name: 'lookup' }], toolAnnotations: { wipe: { readOnlyHint: false, destructiveHint: true } } },
      { key: 'kb', sourceType: 'internal', tools: [{ name: 'search_kb' }] },
      { key: 'api', sourceType: 'openapi', tools: [{ name: 'list_orders', httpMethod: 'GET' }] },
    ];
    expect(boundToolKinds(bindings, [], servers)).toEqual({ wipe: 'destructive', lookup: 'nohints', search_kb: 'reads', list_orders: 'reads' });
  });
});

describe('tool names that are object members', () => {
  it('a tool named like an Object member is looked up as a plain name, not as an inherited property', () => {
    const resolved = resolveHitlConfig({ toolApproval: { enabled: true } });
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(() => toolCallDecision(resolved, name, { a: 1 }, 'writes')).not.toThrow();
      expect(toolApprovalPolicy(resolved, name, 'writes')).toBe('always');
    }
    const tools = applyToolApprovals([{ name: 'constructor', hitlKind: 'writes' }], resolved, new Set());
    expect(tools).toHaveLength(1);
  });
});

describe('approval left unset', () => {
  it('validation warnings treat an unset switch as on', () => {
    const exceptions = validateHitlConfig({ humanInTheLoop: { toolApproval: { exceptions: { send: [{ pattern: '*@example.com', action: 'allow' }] } } } } as never);
    expect(exceptions.warnings.map((w) => w.field)).not.toContain('humanInTheLoop.toolApproval.exceptions');
    const off = validateHitlConfig({ humanInTheLoop: { toolApproval: { enabled: false, exceptions: { send: [{ pattern: '*@example.com', action: 'allow' }] } } } } as never);
    expect(off.warnings.map((w) => w.field)).toContain('humanInTheLoop.toolApproval.exceptions');
    const unattended = validateHitlConfig({ humanInTheLoop: { unattended: 'allow' } } as never);
    expect(unattended.warnings.map((w) => w.field)).toContain('humanInTheLoop.unattended');
  });

  it('client tools: only an explicit per-tool "always" asks until approval is switched on; the table shows the same', () => {
    expect(clientApprovalConfig(resolveHitlConfig(undefined)).defaultPolicy).toBe('never');
    expect(clientApprovalConfig(resolveHitlConfig({ toolApproval: { enabled: true } })).defaultPolicy).toBe('always');
    const client = [{ name: 'open_cart' }, { name: 'pay' }];
    const rows = (hitl: Parameters<typeof hitlToolRows>[1]) => Object.fromEntries(hitlToolRows({ toolBindings: [] }, hitl, client).map((row) => [row.name, row]));
    const unset = rows(setToolChoice(undefined, 'pay', 'always'));
    expect(unset.open_cart).toMatchObject({ effective: 'never', askChoice: 'always' });
    expect(unset.pay).toMatchObject({ choice: 'always', effective: 'always' });
    const chosen = rows({ toolApproval: { enabled: true } });
    expect(chosen.open_cart).toMatchObject({ effective: 'always', askChoice: 'default' });
    // Setting "Never ask" on another tool does not switch client tools on.
    const other = rows(setToolChoice(undefined, 'send_email', 'never'));
    expect(other.open_cart).toMatchObject({ effective: 'never' });
  });
});
