/**
 * Agent runtime lookups (config resolution, revision check, owning agent, idempotent-run lookup) for two
 * tenants at the same time, on the real data layer of both providers. Both tenants use the SAME agent key,
 * so a lookup bound to the wrong tenant would return the other tenant's agent.
 *
 * Two properties pin the explicit tenant scope, both deterministic:
 *  - the lookups never move the shared handle (`switchToTenant`);
 *  - each call lands in its own tenant even inside an enclosing scope bound to the other tenant.
 * Reverting these modules to a bare `switchToTenant` fails every case.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DatabaseProvider, IAgentConfig } from '@/lib/database';
import { describeForEachProvider } from './db-parity.helper';

const dbRef = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: vi.fn(async () => dbRef.current),
    runWithTenantScope: async (tenantDbName: string, fn: (db: DatabaseProvider) => unknown) => {
      const db = dbRef.current as DatabaseProvider;
      return db.runWithTenant!(tenantDbName, () => fn(db));
    },
  };
});

import { resolveAgentConfig } from '@/lib/services/agents/agentConfigResolution';
import { resolveOwningAgent } from '@/lib/services/agents/agentOwnedResources';
import { assertAgentRevisionRunnable } from '@/lib/services/agents/agentRevision';
import { lookupIdempotentAgentRun } from '@/lib/services/agents/agentRunService';

const AGENT_KEY = 'shared-agent';

interface Tenant {
  name: 'alpha' | 'beta';
  tenantId: string;
  dbName: string;
  projectId: string;
  agentId: string;
}

const configOf = (systemPrompt: string): IAgentConfig => ({ modelKey: 'echo-model', systemPrompt });

describeForEachProvider('agent runtime lookups under concurrent tenants', (getDb) => {
  let db: DatabaseProvider;
  let alpha: Tenant;
  let beta: Tenant;

  async function seedTenant(name: Tenant['name']): Promise<Tenant> {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const dbName = `tenant_agent_scope_${name}_${suffix}`;
    const tenant = await db.createTenant({ companyName: name, slug: `${name}-${suffix}`, dbName, licenseType: 'FREE', ownerId: 'pending' });
    const tenantId = String(tenant._id);
    return db.runWithTenant!(dbName, async () => {
      const project = await db.createProject({ tenantId, key: `${name}-project`, name: `${name} project`, createdBy: 'seed' });
      const projectId = String(project._id);
      const agent = await db.createAgent({
        tenantId, projectId, key: AGENT_KEY, name: `${name} agent`, config: configOf(`prompt of ${name}`), status: 'active', createdBy: 'seed',
      });
      return { name, tenantId, dbName, projectId, agentId: String(agent._id) };
    });
  }

  beforeEach(async () => {
    db = getDb();
    dbRef.current = db;
    alpha = await seedTenant('alpha');
    beta = await seedTenant('beta');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function work(t: Tenant, other: Tenant) {
    const [resolved, revisionCheck, own, foreign, idempotent] = await Promise.all([
      resolveAgentConfig(t.dbName, AGENT_KEY, t.projectId),
      assertAgentRevisionRunnable(t.dbName, AGENT_KEY, t.projectId, 'draft').then(() => 'ok', (error: unknown) => error),
      resolveOwningAgent(t.dbName, t.projectId, t.agentId),
      resolveOwningAgent(t.dbName, t.projectId, other.agentId),
      lookupIdempotentAgentRun({
        tenantDbName: t.dbName, tenantId: t.tenantId, projectId: t.projectId, agentKey: AGENT_KEY,
        userMessage: 'hi', idempotencyKey: `key-${t.name}`, idempotencyConversationScope: null,
      }),
    ]);
    return { resolved, revisionCheck, own, foreign, idempotent };
  }

  function expectOwnData(t: Tenant, result: Awaited<ReturnType<typeof work>>) {
    expect(result.resolved.agent.name).toBe(`${t.name} agent`);
    expect(result.resolved.config.systemPrompt).toBe(`prompt of ${t.name}`);
    expect(result.revisionCheck).toBe('ok');
    expect(result.own).toEqual({ kind: 'agent', agentId: t.agentId });
    expect(result.foreign).toBeNull();
    expect(result.idempotent).toEqual({ kind: 'none' });
  }

  it('resolves each tenant its own agent while the lookups interleave, without moving the shared handle', async () => {
    const switches = vi.spyOn(db, 'switchToTenant');
    const [a, b] = await Promise.all([work(alpha, beta), work(beta, alpha)]);
    expect(switches).not.toHaveBeenCalled();
    expectOwnData(alpha, a);
    expectOwnData(beta, b);
  });

  it('lands each lookup in its own tenant inside an enclosing scope bound to the other tenant', async () => {
    const switches = vi.spyOn(db, 'switchToTenant');
    const [a, b] = await Promise.all([
      db.runWithTenant!(beta.dbName, () => work(alpha, beta)),
      db.runWithTenant!(alpha.dbName, () => work(beta, alpha)),
    ]);
    expect(switches).not.toHaveBeenCalled();
    expectOwnData(alpha, a);
    expectOwnData(beta, b);
  });
});
