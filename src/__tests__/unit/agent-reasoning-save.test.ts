/**
 * Saving and reading an agent passes the reasoning fields through untouched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    // The fallback of the real `runWithTenantScope` for a database without `runWithTenant`.
    runWithTenantScope: async (tenantDbName: string, fn: (db: unknown) => unknown) => {
      const db = (await getDatabase()) as { switchToTenant: (name: string) => Promise<unknown> };
      await db.switchToTenant(tenantDbName);
      return fn(db);
    },
  };
});

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { createAgentRecord, getAgentById, getAgentByKey, updateAgentRecord } from '@/lib/services/agents/agentService';

let db: ReturnType<typeof createMockDb>;
beforeEach(() => {
  db = createMockDb();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.findAgentByKey.mockResolvedValue(null);
  db.createAgent.mockImplementation((async (data: unknown) => data) as never);
  db.updateAgent.mockImplementation((async (_id: string, data: unknown) => data) as never);
});

describe('on save', () => {
  it('create stores the config as it is', async () => {
    const config = { modelKey: 'm', reasoningEffort: 'low', runtime: { profile: 'deep', reasoning: { reflection: false } } };
    await createAgentRecord('t_db', 't', 'p', 'u', { name: 'New', config: config as never });
    expect((db.createAgent.mock.calls[0][0] as { config: unknown }).config).toEqual(config);
  });

  it('update stores the config as it is', async () => {
    const config = { modelKey: 'm', reasoningEffort: 'low', showReasoning: false };
    await updateAgentRecord('t_db', 'a1', { config: config as never }, 'u');
    expect((db.updateAgent.mock.calls[0][1] as { config: unknown }).config).toEqual(config);
  });
});

describe('on read', () => {
  it('an agent reads back as stored, by id and by key', async () => {
    const config = { modelKey: 'm', reasoningEffort: 'medium', runtime: { reasoning: { reflection: true } } };
    db.findAgentById.mockResolvedValue({ key: 'k', config } as never);
    db.findAgentByKey.mockResolvedValue({ key: 'k', config } as never);
    for (const agent of [await getAgentById('t_db', 'a1'), await getAgentByKey('t_db', 'k')]) {
      expect(agent?.config).toEqual(config);
    }
  });

  it('a missing agent stays missing', async () => {
    db.findAgentById.mockResolvedValue(null);
    expect(await getAgentById('t_db', 'nope')).toBeNull();
  });
});
