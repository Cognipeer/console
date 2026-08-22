/**
 * Integration tests — composite MCP servers (sourceType 'composite').
 *
 * Uses two 'internal' Agent Observability members (no RAG/vector fixtures,
 * no network — `AgentTracingService` reads straight from the same SQLite
 * tenant DB) so tool-name collision, real routed execution, and the
 * member-scoped log all get exercised end to end without mocks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-mcp-composite-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'mcp_composite_main';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-composite-tests';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import type { IMcpServer } from '@/lib/database';
import {
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpRequestLogs,
} from '@/lib/services/mcp';
import { executeMcpToolLocal } from '@/lib/services/mcp/mcpService';

const TENANT_DB_NAME = 'mcp_composite_tenant';
const USER_ID = 'user-1';
const PROJECT_ID = 'project-1';
const OTHER_PROJECT_ID = 'project-2';

// Resolved in beforeAll — the 'internal' provider execute path looks the
// tenant up by _id (db.findTenantById) to get its dbName, so the test
// tenant must be a real row, not just a string id.
let TENANT_ID: string;

async function createAgentObsMember(name: string, projectId: string = PROJECT_ID): Promise<IMcpServer> {
  return createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, projectId, {
    name,
    sourceType: 'internal',
    upstreamAuth: { type: 'none' },
    internalConfig: { provider: 'agent-observability', instanceKey: 'project' },
  });
}

let memberA: IMcpServer;
let memberB: IMcpServer;

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  const tenant = await db.createTenant({
    companyName: 'MCP Composite Test',
    slug: 'mcp-composite-test',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: 'owner-1',
  });
  TENANT_ID = String(tenant._id);
  await db.switchToTenant(TENANT_DB_NAME);

  memberA = await createAgentObsMember('Agent Obs A');
  memberB = await createAgentObsMember('Agent Obs B');
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('composite create — naming, tool count, hasInternalMember', () => {
  it('builds a snapshot with origin, resolving the name collision between two identical providers', async () => {
    const composite = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'My Composite',
      sourceType: 'composite',
      upstreamAuth: { type: 'none' },
      compositeConfig: { members: [{ serverId: String(memberA._id) }, { serverId: String(memberB._id) }] },
    });

    expect(composite.tools.length).toBe(6); // 3 tools × 2 identical members
    const names = composite.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(6); // no collisions survive

    // Every tool carries an origin pointing back at one of the two members.
    for (const tool of composite.tools) {
      expect(tool.origin?.serverId).toBeDefined();
      expect([String(memberA._id), String(memberB._id)]).toContain(tool.origin!.serverId);
    }

    // Both providers publish "list_agents" — it must have collided and been prefixed.
    const listAgentsNames = composite.tools
      .filter((t) => t.origin?.realName === 'list_agents')
      .map((t) => t.name);
    expect(listAgentsNames).toHaveLength(2);
    expect(listAgentsNames[0]).not.toBe('list_agents');
    expect(listAgentsNames[1]).not.toBe('list_agents');
    expect(new Set(listAgentsNames).size).toBe(2);

    expect((composite.metadata as { composite?: { hasInternalMember?: boolean } })?.composite?.hasInternalMember)
      .toBe(true);
    const summaries = (composite.metadata as { composite?: { memberSummaries?: unknown[] } })?.composite
      ?.memberSummaries;
    expect(summaries).toHaveLength(2);
  });

  it('rejects an empty member list', async () => {
    await expect(createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Empty Composite',
      sourceType: 'composite',
      upstreamAuth: { type: 'none' },
      compositeConfig: { members: [] },
    })).rejects.toThrow(/compositeConfig\.members/i);
  });

  it('rejects nesting a composite as a member', async () => {
    const composite = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Composite For Nesting Check',
      sourceType: 'composite',
      upstreamAuth: { type: 'none' },
      compositeConfig: { members: [{ serverId: String(memberA._id) }] },
    });
    await expect(createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Outer Composite',
      sourceType: 'composite',
      upstreamAuth: { type: 'none' },
      compositeConfig: { members: [{ serverId: String(composite._id) }] },
    })).rejects.toThrow(/nested composites/i);
  });

  it('rejects a member from a different project', async () => {
    const otherProjectMember = await createAgentObsMember('Other Project Member', OTHER_PROJECT_ID);
    await expect(createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Cross Project Composite',
      sourceType: 'composite',
      upstreamAuth: { type: 'none' },
      compositeConfig: { members: [{ serverId: String(otherProjectMember._id) }] },
    })).rejects.toThrow(/different project/i);
  });

  it('allows public exposure when a member is internal-sourced (exposing tenant data is intentional)', async () => {
    const composite = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Public Composite Attempt',
      sourceType: 'composite',
      upstreamAuth: { type: 'none' },
      compositeConfig: { members: [{ serverId: String(memberA._id) }] },
      exposure: { protocols: ['streamable-http'], accessMode: 'public' },
    });
    expect(composite.exposure?.accessMode).toBe('public');
  });

  it('allows a direct internal server going public', async () => {
    const server = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Public Internal Attempt',
      sourceType: 'internal',
      upstreamAuth: { type: 'none' },
      internalConfig: { provider: 'agent-observability', instanceKey: 'project' },
      exposure: { protocols: ['streamable-http'], accessMode: 'public' },
    });
    expect(server.exposure?.accessMode).toBe('public');
  });
});

describe('custom endpoint slug — public-path override', () => {
  it('mints a random slug when none is requested', async () => {
    const server = await createAgentObsMember('Default Slug Server');
    expect(server.endpointSlug).toHaveLength(16);
  });

  it('accepts a caller-supplied path, normalized like a slug', async () => {
    const server = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Custom Slug Server',
      sourceType: 'internal',
      upstreamAuth: { type: 'none' },
      internalConfig: { provider: 'agent-observability', instanceKey: 'project' },
      endpointSlug: 'My Cool Webhook',
    });
    expect(server.endpointSlug).toBe('my-cool-webhook');
  });

  it('rejects a path already used by another server', async () => {
    await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Slug Owner',
      sourceType: 'internal',
      upstreamAuth: { type: 'none' },
      internalConfig: { provider: 'agent-observability', instanceKey: 'project' },
      endpointSlug: 'taken-path',
    });
    await expect(createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Slug Squatter',
      sourceType: 'internal',
      upstreamAuth: { type: 'none' },
      internalConfig: { provider: 'agent-observability', instanceKey: 'project' },
      endpointSlug: 'taken-path',
    })).rejects.toThrow(/already used/i);
  });

  it('rejects a path shorter than the minimum once normalized', async () => {
    await expect(createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Short Slug Attempt',
      sourceType: 'internal',
      upstreamAuth: { type: 'none' },
      internalConfig: { provider: 'agent-observability', instanceKey: 'project' },
      endpointSlug: 'ab',
    })).rejects.toThrow(/at least/i);
  });

  it('lets an update rename the path, and re-allows its own previous path', async () => {
    const server = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Renamable Slug Server',
      sourceType: 'internal',
      upstreamAuth: { type: 'none' },
      internalConfig: { provider: 'agent-observability', instanceKey: 'project' },
      endpointSlug: 'first-path',
    });

    const renamed = await updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      endpointSlug: 'second-path',
    });
    expect(renamed?.endpointSlug).toBe('second-path');

    // Re-submitting the server's own current path must not trip the
    // uniqueness check against itself (excludeId).
    const resaved = await updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      endpointSlug: 'second-path',
    });
    expect(resaved?.endpointSlug).toBe('second-path');
  });
});

describe('composite execution — real routed call, member-scoped log, self-reference', () => {
  let composite: IMcpServer;

  beforeAll(async () => {
    composite = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Exec Composite',
      sourceType: 'composite',
      upstreamAuth: { type: 'none' },
      compositeConfig: { members: [{ serverId: String(memberA._id) }] },
    });
  });

  it('routes a call through to the member and returns a real result', async () => {
    const toolName = composite.tools.find((t) => t.origin?.realName === 'list_agents')!.name;
    const { result } = await executeMcpToolLocal(composite, toolName, {});
    expect(result).toBeDefined();
  });

  it('writes a member-scoped log row tagged with the composite key, separate from the composite\'s own log', async () => {
    const memberLogs = await listMcpRequestLogs(TENANT_DB_NAME, memberA, { limit: 10 });
    const viaComposite = memberLogs.filter((l) => l.viaServerKey === composite.key);
    expect(viaComposite.length).toBeGreaterThan(0);
    expect(viaComposite[0].transport).toBe('internal');
    expect(viaComposite[0].toolName).toBe('list_agents'); // the member's real name, not the exposed one
  });

  it('rejects the composite referencing itself as a member', async () => {
    await expect(updateMcpServer(TENANT_DB_NAME, String(composite._id), USER_ID, {
      compositeConfig: { members: [{ serverId: String(composite._id) }] },
    })).rejects.toThrow(/itself/i);
  });

  it('rejects an unknown tool name (no origin mapping)', async () => {
    await expect(executeMcpToolLocal(composite, 'not_a_real_tool', {}))
      .rejects.toThrow(/no member mapping/i);
  });
});

describe('reconcile — member update, member delete, empty-members auto-disable', () => {
  it('rebuilds the composite snapshot automatically when a member disables one of its tools', async () => {
    const solo = await createAgentObsMember('Solo Member For Reconcile');
    const composite = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Reconcile-on-update Composite',
      sourceType: 'composite',
      upstreamAuth: { type: 'none' },
      compositeConfig: { members: [{ serverId: String(solo._id) }] },
    });
    expect(composite.tools.length).toBe(3);

    await updateMcpServer(TENANT_DB_NAME, String(solo._id), USER_ID, {
      disabledTools: ['list_agents'],
    });

    const refreshed = await getMcpServer(TENANT_DB_NAME, String(composite._id));
    expect(refreshed?.tools.length).toBe(2);
    expect(refreshed?.tools.some((t) => t.origin?.realName === 'list_agents')).toBe(false);
  });

  it('prunes a deleted member and rebuilds around the remaining ones', async () => {
    const keep = await createAgentObsMember('Keep Member');
    const drop = await createAgentObsMember('Drop Member');
    const composite = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Prune-on-delete Composite',
      sourceType: 'composite',
      upstreamAuth: { type: 'none' },
      compositeConfig: { members: [{ serverId: String(keep._id) }, { serverId: String(drop._id) }] },
    });
    expect(composite.tools.length).toBe(6);

    await deleteMcpServer(TENANT_DB_NAME, String(drop._id));

    const refreshed = await getMcpServer(TENANT_DB_NAME, String(composite._id));
    expect(refreshed?.tools.length).toBe(3);
    expect(refreshed?.tools.every((t) => t.origin?.serverId === String(keep._id))).toBe(true);
    const config = (refreshed?.metadata as { composite?: { members?: unknown[] } })?.composite;
    expect(config?.members).toHaveLength(1);
  });

  it('disables the composite when its last member is deleted', async () => {
    const onlyMember = await createAgentObsMember('Only Member');
    const composite = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Last-member Composite',
      sourceType: 'composite',
      upstreamAuth: { type: 'none' },
      compositeConfig: { members: [{ serverId: String(onlyMember._id) }] },
    });

    await deleteMcpServer(TENANT_DB_NAME, String(onlyMember._id));

    const refreshed = await getMcpServer(TENANT_DB_NAME, String(composite._id));
    expect(refreshed?.status).toBe('disabled');
    expect(refreshed?.tools).toHaveLength(0);
    expect(refreshed?.lastError?.message).toMatch(/members were removed/i);
  });
});

describe('composite disable does not affect the member\'s own endpoint', () => {
  it('disabling a tool on the composite leaves it callable directly on the member', async () => {
    const member = await createAgentObsMember('Independent Member');
    const composite = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Independent Composite',
      sourceType: 'composite',
      upstreamAuth: { type: 'none' },
      compositeConfig: { members: [{ serverId: String(member._id) }] },
    });
    const toolName = composite.tools.find((t) => t.origin?.realName === 'list_agents')!.name;

    const updatedComposite = await updateMcpServer(TENANT_DB_NAME, String(composite._id), USER_ID, {
      disabledTools: [toolName],
    });
    expect(updatedComposite).not.toBeNull();
    await expect(executeMcpToolLocal(updatedComposite!, toolName, {}))
      .rejects.toThrow(/disabled/i);

    // The member itself was never touched — its own endpoint still serves it.
    const { result } = await executeMcpToolLocal(member, 'list_agents', {});
    expect(result).toBeDefined();
  });
});

describe('sqlite viaServerKey column', () => {
  it('is persisted and queryable end to end', async () => {
    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);
    const logs = await db.listMcpRequestLogs({
      serverId: String(memberA._id),
      serverKey: memberA.key,
      projectId: memberA.projectId,
      createdAt: memberA.createdAt,
    }, { limit: 50 });
    expect(logs.some((l) => l.viaServerKey)).toBe(true);
  });
});
