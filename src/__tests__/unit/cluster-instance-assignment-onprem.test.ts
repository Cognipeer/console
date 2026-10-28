import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';

const db = vi.hoisted(() => ({
  findInstanceAssignment: vi.fn(),
  listNodes: vi.fn(),
}));

vi.mock('@/lib/database', () => ({ getDatabase: async () => db }));

import {
  clearInstanceAssignmentCache,
  findInstanceAssignment,
  resolveInstancePlacement,
} from '@/lib/core/cluster/instanceAssignmentStore';

const original = getConfigSource();

function useMode(mode: 'saas' | 'onprem'): void {
  const overrides: Record<string, string> = {
    DEPLOYMENT_MODE: mode,
    CLUSTER_DEFAULT_NODE_NAME: 'node-default',
  };
  setConfigSource({ get: (key: string) => overrides[key] ?? process.env[key] } as ConfigSource);
}

const pinned = {
  entityType: 'agent' as const,
  entityId: 't1:a',
  nodeName: 'node-b',
  mode: 'strict' as const,
  updatedAt: new Date(),
  updatedBy: null,
};

describe('instance assignments by deployment mode', () => {
  beforeEach(() => {
    clearInstanceAssignmentCache();
    db.findInstanceAssignment.mockReset().mockResolvedValue(pinned);
  });

  afterEach(() => {
    setConfigSource(original);
  });

  it('honours a stored assignment on a self-hosted deployment', async () => {
    useMode('onprem');
    await expect(findInstanceAssignment('agent', 't1:a')).resolves.toEqual(pinned);
    await expect(resolveInstancePlacement('agent', 't1:a')).resolves.toEqual({
      nodeName: 'node-b',
      mode: 'strict',
      explicit: true,
    });
  });

  it('ignores a stored assignment on SaaS, so the instance takes the unassigned path', async () => {
    useMode('saas');
    await expect(findInstanceAssignment('agent', 't1:a')).resolves.toBeNull();
    await expect(resolveInstancePlacement('agent', 't1:a')).resolves.toEqual({
      nodeName: 'node-default',
      mode: 'preferred',
      explicit: false,
    });
    expect(db.findInstanceAssignment).not.toHaveBeenCalled();
  });
});
