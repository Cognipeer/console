/**
 * Actions a connector package offers as tools (`executionType: 'connector_action'`):
 * the call goes to the executor the Connectors module registers, never touches
 * the credential resolver, and fails closed when no executor is registered.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ITool } from '@/lib/database';

import { __resetToolActionExecutorForTests, registerToolActionExecutor } from '@/enterprise/tool-actions';
import { __resetToolCredentialResolverForTests, registerToolCredentialResolver } from '@/enterprise/tool-credentials';
import { createTool, executeToolAction, isManagedTool, serializeTool, syncToolActions } from '@/lib/services/tools/toolService';
import { collectManifestResources } from '@/lib/services/agents/manifestResources';

const getDatabaseMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/database')>()),
  getDatabase: getDatabaseMock,
}));

// The tool service asks whether the tools service is on; with no database in a
// unit test that lookup would try to reach one on every call.
vi.mock('@/lib/services/availability/serviceAvailability', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/services/availability/serviceAvailability')>()),
  assertServiceEnabled: async () => undefined,
}));

function connectorTool(): ITool {
  return {
    _id: 'tool-9',
    tenantId: 't1',
    projectId: 'p1',
    key: 'github',
    name: 'GitHub',
    type: 'connector',
    status: 'active',
    upstreamAuth: { type: 'connector', connectorId: 'con-9' },
    actions: [{
      key: 'list_issues',
      name: 'list_issues',
      description: 'List issues',
      inputSchema: { type: 'object', properties: { repo: { type: 'string' } } },
      executionType: 'connector_action',
    }],
    createdBy: 'u1',
  } as unknown as ITool;
}

afterEach(() => {
  __resetToolActionExecutorForTests();
  __resetToolCredentialResolverForTests();
  getDatabaseMock.mockReset();
});

describe('connector_action tool actions', () => {
  it('dispatch to the registered executor with the tool, action and arguments', async () => {
    const calls: unknown[] = [];
    registerToolActionExecutor(async (call) => {
      calls.push(call);
      return { result: '[{"number":1}]' };
    });
    const tool = connectorTool();

    const out = await executeToolAction(tool, 'list_issues', { repo: 'acme/app' });

    expect(out.result).toBe('[{"number":1}]');
    expect(out.isError).toBeUndefined();
    expect(typeof out.latencyMs).toBe('number');
    expect(calls).toEqual([{ tool, action: tool.actions[0], args: { repo: 'acme/app' } }]);
  });

  it('never ask the credential resolver for one', async () => {
    const resolver = vi.fn(async () => ({ auth: { type: 'token' as const, token: 'test-token' } }));
    registerToolCredentialResolver(resolver);
    registerToolActionExecutor(async () => ({ result: 'ok' }));
    const secrets: string[][] = [];

    await executeToolAction(connectorTool(), 'list_issues', {}, undefined, { onSecrets: (values) => secrets.push(values) });

    expect(resolver).not.toHaveBeenCalled();
    expect(secrets).toEqual([]);
  });

  it('carry the error flag of a vendor error back to the caller', async () => {
    registerToolActionExecutor(async () => ({ result: '{"error":"RATE_LIMITED"}', isError: true }));
    const out = await executeToolAction(connectorTool(), 'list_issues', {});
    expect(out).toMatchObject({ result: '{"error":"RATE_LIMITED"}', isError: true });
  });

  it('let a precondition failure of the executor reach the caller', async () => {
    registerToolActionExecutor(async () => { throw new Error('The connector is not connected.'); });
    await expect(executeToolAction(connectorTool(), 'list_issues', {})).rejects.toThrow('not connected');
  });

  it('fail closed when no executor is registered', async () => {
    // The community build, or an enterprise build before its registry loads: nothing is registered.
    await expect(executeToolAction(connectorTool(), 'list_issues', {})).rejects.toThrow(
      'This tool is managed by a connector, and the Connectors module is not available',
    );
  });

  it('are still refused for an unknown action key', async () => {
    registerToolActionExecutor(async () => ({ result: 'ok' }));
    await expect(executeToolAction(connectorTool(), 'nope', {})).rejects.toThrow('not found');
  });
});

describe('a connector type tool', () => {
  it('is a managed tool the Tools API shows as managed by its connector', () => {
    expect(isManagedTool(connectorTool())).toBe(true);
    expect(serializeTool(connectorTool())).toMatchObject({ type: 'connector', managedBy: { kind: 'connector', id: 'con-9' } });
  });

  it('cannot be created through the Tools API path', async () => {
    await expect(createTool('tenant_db', 't1', 'u1', 'p1', { name: 'Native', type: 'connector' } as never)).rejects.toThrow(
      'Tool type must be "openapi" or "mcp"',
    );
  });

  it('keeps its actions when asked to sync them (only the connector changes them)', async () => {
    const tool = connectorTool();
    const updateTool = vi.fn();
    getDatabaseMock.mockResolvedValue({ switchToTenant: async () => undefined, findToolById: async () => tool, updateTool });

    expect(await syncToolActions('tenant_db', 'tool-9', 'u1')).toBe(tool);
    expect(updateTool).not.toHaveBeenCalled();
  });

  it('is left out of an agent export instead of being exported without an endpoint', async () => {
    const tool = connectorTool();
    getDatabaseMock.mockResolvedValue({ switchToTenant: async () => undefined, findToolByKey: async () => tool });
    const spec = { toolBindings: [{ source: 'tool', sourceKey: 'github', toolNames: ['list_issues'] }] } as never;

    const out = await collectManifestResources('tenant_db', 'p1', spec, new Set(['tools']));

    expect(out.resources.tools).toBeUndefined();
    expect(out.skipped).toEqual([{ type: 'tools', key: 'github', reason: 'managed by a connector' }]);
  });
});
