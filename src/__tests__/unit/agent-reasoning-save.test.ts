/**
 * Saving and reading an agent migrates the old Advanced-tab reasoning block
 * (`runtime.reasoning`) into the model's own fields, on both sides.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { createAgentRecord, getAgentById, getAgentByKey, updateAgentRecord } from '@/lib/services/agents/agentService';

const OLD: Record<string, unknown> = { modelKey: 'm', runtime: { profile: 'deep', reasoning: { enabled: true, effort: 'medium', budgetTokens: 3000, reflection: false } } };

let db: ReturnType<typeof createMockDb>;
beforeEach(() => {
  db = createMockDb();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.findAgentByKey.mockResolvedValue(null);
  db.createAgent.mockImplementation((async (data: unknown) => data) as never);
  db.updateAgent.mockImplementation((async (_id: string, data: unknown) => data) as never);
});

describe('on save', () => {
  it('create migrates', async () => {
    await createAgentRecord('t_db', 't', 'p', 'u', { name: 'Old', config: OLD as never });
    const saved = db.createAgent.mock.calls[0][0] as unknown as { config: Record<string, unknown> };
    expect(saved.config).toMatchObject({ reasoningEffort: 'medium', reasoningBudgetTokens: 3000 });
    expect(saved.config.runtime).toEqual({ profile: 'deep', reasoning: { reflection: false } });
  });

  it('update migrates', async () => {
    await updateAgentRecord('t_db', 'a1', { config: OLD as never }, 'u');
    const saved = db.updateAgent.mock.calls[0][1] as { config: Record<string, unknown> };
    expect(saved.config).toMatchObject({ reasoningEffort: 'medium', reasoningBudgetTokens: 3000 });
    expect(JSON.stringify(saved.config.runtime)).not.toContain('budgetTokens');
  });

  it('a new-style config is saved as it is', async () => {
    const config = { modelKey: 'm', reasoningEffort: 'low', showReasoning: false };
    await updateAgentRecord('t_db', 'a1', { config: config as never }, 'u');
    expect((db.updateAgent.mock.calls[0][1] as { config: unknown }).config).toEqual(config);
  });
});

describe('on read', () => {
  it('an agent stored before the move reads back migrated, by id and by key', async () => {
    db.findAgentById.mockResolvedValue({ key: 'k', config: OLD } as never);
    db.findAgentByKey.mockResolvedValue({ key: 'k', config: OLD } as never);
    for (const agent of [await getAgentById('t_db', 'a1'), await getAgentByKey('t_db', 'k')]) {
      expect(agent?.config).toMatchObject({ reasoningEffort: 'medium', reasoningBudgetTokens: 3000 });
      expect(agent?.config.runtime).toEqual({ profile: 'deep', reasoning: { reflection: false } });
    }
  });

  it('a missing agent stays missing', async () => {
    db.findAgentById.mockResolvedValue(null);
    expect(await getAgentById('t_db', 'nope')).toBeNull();
  });
});
