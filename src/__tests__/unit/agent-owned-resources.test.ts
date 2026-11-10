/**
 * MCP servers and skills created inside an agent (`IAgentResourceOwner`) are part of that agent. Against SQLite:
 *
 *   storage     the owner survives a round trip; a list without an owner filter has shared records only, and the
 *               filters give an agent its own records (alone, or with the shared ones)
 *   requests    `agentId` / `owned` / `ownerAgentId` are read strictly; an owner must be an agent of the project
 *   runtime     another agent's own server or skill does not resolve, for a run or for a config save
 *   composite   another agent's own server cannot be a member
 *   lifecycle   deleting the agent deletes its own servers and skills, and nothing else
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});

import { drainPendingTasks } from '@/lib/core/asyncTask';
import type { IAgentSkill, IMcpServer } from '@/lib/database';
import {
  deleteAgentOwnedResources,
  isUsableByAgent,
  ownedListFilterOf,
  readAgentIdInput,
  resolveOwningAgent,
} from '@/lib/services/agents/agentOwnedResources';
import { buildAgentSkills } from '@/lib/services/agents/agentSkillService';
import { validateAgentConfig } from '@/lib/services/agents/agentConfigValidation';
import { resolveAgentBindingMcpServer } from '@/lib/services/agents/bindingResolution';
import { deleteAgentRecord } from '@/lib/services/agents/agentService';
import { assertMemberUsable } from '@/lib/services/mcp/composite';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';

let env: IamTestDb;
const tenant = () => env.tenantDbName;
const PROJECT = 'proj-owned';
const agents: Record<'a' | 'b' | 'elsewhere', string> = { a: '', b: '', elsewhere: '' };

const inTenant = <T>(fn: () => Promise<T>) => env.db.runWithTenant(tenant(), fn);

function mcpServer(key: string, owner?: string): Omit<IMcpServer, '_id' | 'createdAt' | 'updatedAt'> {
  return {
    tenantId: env.tenantId,
    projectId: PROJECT,
    key,
    name: key,
    sourceType: 'openapi',
    tools: [{ name: 'lookup', description: 'Look up', inputSchema: { type: 'object', properties: {} } }],
    upstreamAuth: { type: 'none' },
    status: 'active',
    endpointSlug: `slug-${key}-0123456789`,
    createdBy: 'tester',
    ...(owner ? { owner: { kind: 'agent' as const, agentId: owner } } : {}),
  } as Omit<IMcpServer, '_id' | 'createdAt' | 'updatedAt'>;
}

function skill(key: string, owner?: string): Omit<IAgentSkill, '_id' | 'createdAt' | 'updatedAt'> {
  return {
    tenantId: env.tenantId,
    projectId: PROJECT,
    key,
    title: key,
    header: `${key} header`,
    body: `${key} body`,
    status: 'active',
    createdBy: 'tester',
    ...(owner ? { owner: { kind: 'agent' as const, agentId: owner } } : {}),
  };
}

beforeAll(async () => {
  env = await createIamTestDb('tenant_agent_owned');
  hoisted.getDatabase.mockResolvedValue(env.db);
  await inTenant(async () => {
    for (const [name, projectId] of [['a', PROJECT], ['b', PROJECT], ['elsewhere', 'proj-other']] as const) {
      const agent = await env.db.createAgent({
        tenantId: env.tenantId,
        projectId,
        key: `agent-${name}`,
        name: `Agent ${name}`,
        config: { modelKey: 'none' } as never,
        status: 'active',
        createdBy: 'tester',
      } as never);
      agents[name] = String(agent._id);
    }
    await env.db.createMcpServer(mcpServer('shared-crm'));
    await env.db.createMcpServer(mcpServer('a-jira', agents.a));
    await env.db.createMcpServer(mcpServer('b-billing', agents.b));
    await env.db.createSkill(skill('shared-tone'));
    await env.db.createSkill(skill('a-triage', agents.a));
    await env.db.createSkill(skill('b-refunds', agents.b));
  });
});
afterAll(async () => {
  await drainPendingTasks();
  await env.cleanup();
});

const keys = (records: Array<{ key: string }>) => records.map((record) => record.key).sort();

describe('storage', () => {
  it('keeps the owner of a server and of a skill, and leaves shared ones without one', async () => {
    await inTenant(async () => {
      expect((await env.db.findMcpServerByKey('a-jira', PROJECT))?.owner).toEqual({ kind: 'agent', agentId: agents.a });
      expect((await env.db.findMcpServerByKey('shared-crm', PROJECT))?.owner).toBeUndefined();
      expect((await env.db.findSkillByKey('b-refunds', PROJECT))?.owner).toEqual({ kind: 'agent', agentId: agents.b });
      expect((await env.db.findSkillByKey('shared-tone', PROJECT))?.owner).toBeUndefined();
    });
  });

  it('lists shared records only unless a list asks for owned ones', async () => {
    await inTenant(async () => {
      expect(keys(await env.db.listMcpServers({ projectId: PROJECT }))).toEqual(['shared-crm']);
      expect(keys(await env.db.listSkills({ projectId: PROJECT }))).toEqual(['shared-tone']);
    });
  });

  it('gives an agent its own records, alone or with the shared ones, never another agent\'s', async () => {
    await inTenant(async () => {
      expect(keys(await env.db.listMcpServers({ projectId: PROJECT, ownerAgentId: agents.a, owned: 'only' }))).toEqual(['a-jira']);
      expect(keys(await env.db.listMcpServers({ projectId: PROJECT, ownerAgentId: agents.a }))).toEqual(['a-jira']);
      expect(keys(await env.db.listMcpServers({ projectId: PROJECT, ownerAgentId: agents.a, owned: 'include' }))).toEqual(['a-jira', 'shared-crm']);
      expect(keys(await env.db.listSkills({ projectId: PROJECT, ownerAgentId: agents.b, owned: 'include' }))).toEqual(['b-refunds', 'shared-tone']);
    });
  });

  it('lists every record for the internal scans that must see them all', async () => {
    await inTenant(async () => {
      expect(keys(await env.db.listMcpServers({ projectId: PROJECT, owned: 'include' }))).toEqual(['a-jira', 'b-billing', 'shared-crm']);
      expect(keys(await env.db.listMcpServers({ projectId: PROJECT, owned: 'only' }))).toEqual(['a-jira', 'b-billing']);
    });
  });
});

describe('what a request may ask for', () => {
  it('reads a list filter strictly', () => {
    expect(ownedListFilterOf({})).toEqual({ ok: true, filter: {} });
    expect(ownedListFilterOf({ agentId: 'ag-1' })).toEqual({ ok: true, filter: { ownerAgentId: 'ag-1', owned: 'include' } });
    expect(ownedListFilterOf({ agentId: 'ag-1', owned: 'only' })).toEqual({ ok: true, filter: { ownerAgentId: 'ag-1', owned: 'only' } });
    // Every agent's own records are never listed in one go from a request.
    expect(ownedListFilterOf({ owned: 'only' }).ok).toBe(false);
    expect(ownedListFilterOf({ agentId: 'ag-1', owned: 'include' }).ok).toBe(false);
    expect(ownedListFilterOf({ agentId: ['a', 'b'] }).ok).toBe(false);
    expect(ownedListFilterOf({ agentId: 'x'.repeat(129) }).ok).toBe(false);
  });

  it('reads an owner id strictly, and an absent one as none', () => {
    expect(readAgentIdInput(undefined, 'ownerAgentId')).toEqual({ ok: true });
    expect(readAgentIdInput('', 'ownerAgentId')).toEqual({ ok: true });
    expect(readAgentIdInput(' ag-1 ', 'ownerAgentId')).toEqual({ ok: true, agentId: 'ag-1' });
    expect(readAgentIdInput(42, 'ownerAgentId')).toEqual({ ok: false, error: 'ownerAgentId must be an agent id' });
  });

  it('lets a record belong only to an agent of the same project', async () => {
    expect(await resolveOwningAgent(tenant(), PROJECT, agents.a)).toEqual({ kind: 'agent', agentId: agents.a });
    expect(await resolveOwningAgent(tenant(), PROJECT, agents.elsewhere)).toBeNull();
    expect(await resolveOwningAgent(tenant(), PROJECT, 'no-such-agent')).toBeNull();
  });
});

describe('who may use an owned record', () => {
  it('is its own agent only; a shared record is usable by every agent', () => {
    const owned = { owner: { kind: 'agent' as const, agentId: 'ag-1' } };
    expect(isUsableByAgent(owned, 'ag-1')).toBe(true);
    expect(isUsableByAgent(owned, 'ag-2')).toBe(false);
    expect(isUsableByAgent(owned, undefined)).toBe(false);
    expect(isUsableByAgent({}, undefined)).toBe(true);
    expect(isUsableByAgent(null, 'ag-1')).toBe(false);
  });

  it('resolves a binding to an agent\'s own server for that agent only', async () => {
    expect((await resolveAgentBindingMcpServer(tenant(), 'a-jira', PROJECT, agents.a))?.key).toBe('a-jira');
    expect(await resolveAgentBindingMcpServer(tenant(), 'a-jira', PROJECT, agents.b)).toBeNull();
    expect(await resolveAgentBindingMcpServer(tenant(), 'a-jira', PROJECT)).toBeNull();
    expect((await resolveAgentBindingMcpServer(tenant(), 'shared-crm', PROJECT, agents.b))?.key).toBe('shared-crm');
  });

  it('loads an agent\'s own skill into that agent\'s run only', async () => {
    const run = { tenantDbName: tenant(), tenantId: env.tenantId, source: 'dashboard' };
    const loaded = async (agentId?: string) =>
      (await buildAgentSkills(tenant(), PROJECT, ['shared-tone', 'a-triage', 'b-refunds'], run, agentId)).map((s) => s.key);
    expect(await loaded(agents.a)).toEqual(['shared-tone', 'a-triage']);
    expect(await loaded(agents.b)).toEqual(['shared-tone', 'b-refunds']);
    expect(await loaded(undefined)).toEqual(['shared-tone']);
  });

  it('refuses to save another agent\'s own server or skill into an agent\'s config', async () => {
    const config = {
      modelKey: 'none',
      toolBindings: [{ source: 'mcp', sourceKey: 'b-billing', toolNames: ['lookup'] }],
      skills: ['b-refunds'],
    } as never;
    const forA = await validateAgentConfig({ tenantDbName: tenant(), projectId: PROJECT, config, agentKey: 'agent-a' });
    expect(forA.errors.map((e) => e.message)).toEqual(expect.arrayContaining([
      'MCP server "b-billing" does not exist in this project',
      'Skill "b-refunds" does not exist',
    ]));
    const forB = await validateAgentConfig({ tenantDbName: tenant(), projectId: PROJECT, config, agentKey: 'agent-b' });
    expect(forB.errors.map((e) => e.message)).not.toEqual(expect.arrayContaining([
      expect.stringContaining('b-billing'),
      expect.stringContaining('b-refunds'),
    ]));
  });
});

describe('a composite server', () => {
  it('cannot take another agent\'s own server as a member', async () => {
    const member = await inTenant(() => env.db.findMcpServerByKey('a-jira', PROJECT));
    const self = { tenantId: env.tenantId, projectId: PROJECT };
    expect(() => assertMemberUsable(self, member, 'm-1')).toThrow('no longer exists');
    expect(() => assertMemberUsable({ ...self, ownerAgentId: agents.b }, member, 'm-1')).toThrow('no longer exists');
    expect(() => assertMemberUsable({ ...self, ownerAgentId: agents.a }, member, 'm-1')).not.toThrow();
  });
});

describe('deleting the agent', () => {
  it('deletes its own servers and skills, and leaves the shared ones and other agents\' alone', async () => {
    await inTenant(async () => {
      await env.db.createMcpServer(mcpServer('gone-tools', agents.b));
      await env.db.createSkill(skill('gone-skill', agents.b));
    });
    expect(await deleteAgentOwnedResources(tenant(), agents.b)).toEqual({ mcpServers: 2, skills: 2 });
    await inTenant(async () => {
      expect(keys(await env.db.listMcpServers({ projectId: PROJECT, owned: 'include' }))).toEqual(['a-jira', 'shared-crm']);
      expect(keys(await env.db.listSkills({ projectId: PROJECT, owned: 'include' }))).toEqual(['a-triage', 'shared-tone']);
    });
  });

  it('happens as part of deleting the agent record', async () => {
    expect(await deleteAgentRecord(tenant(), agents.a)).toBe(true);
    await inTenant(async () => {
      expect(keys(await env.db.listMcpServers({ projectId: PROJECT, owned: 'include' }))).toEqual(['shared-crm']);
      expect(keys(await env.db.listSkills({ projectId: PROJECT, owned: 'include' }))).toEqual(['shared-tone']);
    });
  });
});
