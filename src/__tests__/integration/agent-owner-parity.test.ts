/**
 * Agents owned by a flow node (`IAgent.owner`): the same list / count / lookup answers on SQLite and MongoDB.
 * A hidden agent is left out of every list and count unless the caller asks for it, and a plain update never
 * wipes the owner (Mongo `$set` of an undefined value stores null).
 */
import { beforeAll, beforeEach, expect, it } from 'vitest';
import type { DatabaseProvider } from '@/lib/database';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('Agent owner (flow-owned hidden agents)', (getDb) => {
  let db: DatabaseProvider;
  let tenantId: string;
  const PROJECT = 'proj-a';

  const agent = (key: string, owner?: { flowId: string; nodeId: string }) => ({
    tenantId,
    projectId: PROJECT,
    key,
    name: `Agent ${key}`,
    config: { modelKey: 'm' },
    status: 'active' as const,
    createdBy: 'u1',
    ...(owner ? { owner: { kind: 'flow' as const, ...owner } } : {}),
  });

  beforeAll(() => {
    db = getDb();
  });

  beforeEach(async () => {
    db = getDb();
    const slug = `owner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({ companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
    await db.createAgent(agent('plain'));
    await db.createAgent(agent('flow-f1-a', { flowId: 'f1', nodeId: 'n1' }));
    await db.createAgent(agent('flow-f1-b', { flowId: 'f1', nodeId: 'n2' }));
    await db.createAgent(agent('flow-f2-a', { flowId: 'f2', nodeId: 'n1' }));
  });

  const keys = (rows: Array<{ key: string }>) => rows.map((row) => row.key).sort();

  it('lists only ordinary agents unless asked', async () => {
    expect(keys(await db.listAgents({ projectId: PROJECT }))).toEqual(['plain']);
    expect(keys(await db.listAgents({ projectId: PROJECT, search: 'flow' }))).toEqual([]);
    expect(keys(await db.listAgents({ projectId: PROJECT, status: 'active' }))).toEqual(['plain']);
    expect(keys(await db.listAgents())).toEqual(['plain']);
  });

  it('lists owned agents on request, all or of one flow', async () => {
    expect(keys(await db.listAgents({ projectId: PROJECT, owned: 'include' }))).toEqual(['flow-f1-a', 'flow-f1-b', 'flow-f2-a', 'plain']);
    expect(keys(await db.listAgents({ projectId: PROJECT, owned: 'only' }))).toEqual(['flow-f1-a', 'flow-f1-b', 'flow-f2-a']);
    expect(keys(await db.listAgents({ projectId: PROJECT, ownerFlowId: 'f1' }))).toEqual(['flow-f1-a', 'flow-f1-b']);
    expect(keys(await db.listAgents({ projectId: PROJECT, ownerFlowId: 'f2' }))).toEqual(['flow-f2-a']);
    expect(keys(await db.listAgents({ projectId: PROJECT, ownerFlowId: 'nope' }))).toEqual([]);
  });

  it('counts only ordinary agents unless asked', async () => {
    expect(await db.countAgents(PROJECT)).toBe(1);
    expect(await db.countAgents(PROJECT, { owned: 'include' })).toBe(4);
    expect(await db.countAgents()).toBe(1);
  });

  it('a lookup by key still finds an owned agent (the service layer hides it) and returns its owner', async () => {
    const found = await db.findAgentByKey('flow-f1-b', PROJECT);
    expect(found?.owner).toEqual({ kind: 'flow', flowId: 'f1', nodeId: 'n2' });
    expect((await db.findAgentByKey('plain', PROJECT))?.owner ?? null).toBeNull();
  });

  it('an update never wipes the owner', async () => {
    const owned = await db.findAgentByKey('flow-f1-a', PROJECT);
    await db.updateAgent(String(owned!._id), { name: 'Renamed', status: 'inactive' });
    const after = await db.findAgentById(String(owned!._id));
    expect(after).toMatchObject({ name: 'Renamed', status: 'inactive', owner: { kind: 'flow', flowId: 'f1', nodeId: 'n1' } });
    // Still hidden, whatever its status.
    expect(keys(await db.listAgents({ projectId: PROJECT }))).toEqual(['plain']);
    expect(keys(await db.listAgents({ projectId: PROJECT, status: 'inactive' }))).toEqual([]);
    expect(keys(await db.listAgents({ projectId: PROJECT, ownerFlowId: 'f1' }))).toEqual(['flow-f1-a', 'flow-f1-b']);
  });

  it('names the hidden agents of a project', async () => {
    expect((await db.listOwnedAgentKeys(PROJECT)).sort()).toEqual(['flow-f1-a', 'flow-f1-b', 'flow-f2-a']);
    expect(await db.listOwnedAgentKeys('another-project')).toEqual([]);
    expect((await db.listOwnedAgentKeys()).sort()).toEqual(['flow-f1-a', 'flow-f1-b', 'flow-f2-a']);
  });

  it('leaves the sessions and runs of the hidden agents out of the lists that ask', async () => {
    for (const key of ['plain', 'flow-f1-a', 'flow-f2-a']) {
      const conversation = await db.createAgentConversation({ tenantId, projectId: PROJECT, agentKey: key, title: key, messages: [], createdBy: 'u1' });
      await db.createAgentRun({
        mode: 'background', tenantId, tenantDbName: 'x', projectId: PROJECT, agentKey: key,
        conversationId: String(conversation._id), userMessage: 'hi', status: 'queued', callbackAttempts: 0,
      });
    }
    const hidden = await db.listOwnedAgentKeys(PROJECT);

    expect((await db.listAgentConversationPage({ projectId: PROJECT, limit: 10 })).map((row) => row.agentKey).sort())
      .toEqual(['flow-f1-a', 'flow-f2-a', 'plain']);
    expect((await db.listAgentConversationPage({ projectId: PROJECT, limit: 10, excludeAgentKeys: hidden })).map((row) => row.agentKey))
      .toEqual(['plain']);
    // A named agent that is hidden yields nothing.
    expect(await db.listAgentConversationPage({ projectId: PROJECT, limit: 10, agentKey: 'flow-f1-a', excludeAgentKeys: hidden })).toEqual([]);

    expect((await db.listProjectAgentConversations({ projectId: PROJECT, limit: 10, excludeAgentKeys: hidden })).map((row) => row.agentKey))
      .toEqual(['plain']);

    expect((await db.listAgentRuns({ tenantId, projectId: PROJECT, limit: 10 })).map((run) => run.agentKey).sort())
      .toEqual(['flow-f1-a', 'flow-f2-a', 'plain']);
    expect((await db.listAgentRuns({ tenantId, projectId: PROJECT, limit: 10, excludeAgentKeys: hidden })).map((run) => run.agentKey))
      .toEqual(['plain']);
  });
});
