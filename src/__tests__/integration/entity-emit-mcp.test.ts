/**
 * Entity health emission — MCP servers. `executeMcpTool` is the single choke
 * point; a composite call must count once under the composite and once under
 * the member hop, never twice under the same key.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-mcp-emit-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'mcp_emit_main';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-emit-tests';

vi.mock('@/lib/services/entityMetrics/entityMetricsRollup', () => ({
  recordEntityMetric: vi.fn(),
}));

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import type { IMcpServer } from '@/lib/database';
import { createMcpServer } from '@/lib/services/mcp';
import { executeMcpTool } from '@/lib/services/mcp/mcpService';
import { recordEntityMetric } from '@/lib/services/entityMetrics/entityMetricsRollup';

const TENANT_DB_NAME = 'mcp_emit_tenant';
const USER_ID = 'user-1';
const PROJECT_ID = 'project-1';

let TENANT_ID: string;
let member: IMcpServer;
let composite: IMcpServer;

const calls = () => (recordEntityMetric as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);

/** The emission is fire-and-forget (it resolves the tenant database first). */
async function settle(expected: number): Promise<void> {
  for (let i = 0; i < 50 && calls().length < expected; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // give a stray double emission the chance to show up
  await new Promise((resolve) => setTimeout(resolve, 30));
}

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  const tenant = await db.createTenant({
    companyName: 'MCP Emit Test',
    slug: 'mcp-emit-test',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: 'owner-1',
  });
  TENANT_ID = String(tenant._id);
  await db.switchToTenant(TENANT_DB_NAME);

  member = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
    name: 'Emit Member',
    sourceType: 'internal',
    upstreamAuth: { type: 'none' },
    internalConfig: { provider: 'agent-observability', instanceKey: 'project' },
  });
  composite = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
    name: 'Emit Composite',
    sourceType: 'composite',
    upstreamAuth: { type: 'none' },
    compositeConfig: { members: [{ serverId: String(member._id) }] },
  });
});

beforeEach(() => {
  (recordEntityMetric as ReturnType<typeof vi.fn>).mockClear();
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('executeMcpTool -> recordEntityMetric', () => {
  it('records one ok observation for a direct call', async () => {
    const { latencyMs } = await executeMcpTool(member, 'list_agents', {});
    await settle(1);

    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({
      tenantDbName: TENANT_DB_NAME,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      entityType: 'mcp',
      entityKey: member.key,
      source: 'service',
      outcome: 'ok',
    });
    expect(typeof calls()[0].latencyMs).toBe('number');
    expect(latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('records an error observation and rethrows when the call fails', async () => {
    await expect(executeMcpTool(member, 'not_a_real_tool', {})).rejects.toBeDefined();
    await settle(1);

    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ entityKey: member.key, outcome: 'error' });
  });

  it('does not count a disabled tool as a server error', async () => {
    const disabled = { ...member, metadata: { disabledTools: ['list_agents'] } } as IMcpServer;
    await expect(executeMcpTool(disabled, 'list_agents', {})).rejects.toThrow(/is disabled on MCP server/);
    await settle(1);

    expect(calls()).toHaveLength(0);
  });

  it('counts a composite call once per server key: the composite and its member hop', async () => {
    const exposed = composite.tools.find((t) => t.origin?.realName === 'list_agents')!.name;
    await executeMcpTool(composite, exposed, {});
    await settle(2);

    const byKey = new Map<string, number>();
    for (const c of calls()) byKey.set(c.entityKey, (byKey.get(c.entityKey) ?? 0) + 1);
    expect(calls()).toHaveLength(2);
    expect(byKey.get(composite.key)).toBe(1);
    expect(byKey.get(member.key)).toBe(1);
    expect(calls().every((c) => c.outcome === 'ok')).toBe(true);
  });
});
