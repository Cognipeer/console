import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    // The gate reads the caller (and the engine its policies) through the tenant scope.
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});

const mockListDescriptors = vi.hoisted(() => vi.fn().mockReturnValue([]));
const mockGetFormSchema = vi.hoisted(() => vi.fn().mockReturnValue({ sections: [] }));

vi.mock('@/lib/providers', () => ({
  providerRegistry: {
    listDescriptors: mockListDescriptors,
    getFormSchema: mockGetFormSchema,
  },
}));

import { modelsApiPlugin } from '@/server/api/plugins/models';
import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import {
  createFastifyApiTestApp,
  parseJsonBody,
} from '../helpers/fastify-api';

const mockDrivers = [
  { id: 'pinecone', label: 'Pinecone', domains: ['vector'] },
  { id: 'openai', label: 'OpenAI', domains: ['model'] },
];
const mockSchema = { sections: [{ fields: [{ name: 'api_key', type: 'password' }] }] };

describe('provider driver routes', () => {
  describe('GET /api/models/providers/drivers*', () => {
    let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

    beforeEach(async () => {
      vi.clearAllMocks();
      mockListDescriptors.mockReturnValue([mockDrivers[1]]);
      mockGetFormSchema.mockReturnValue(mockSchema);
      const rbacDb = createMockDb();
      rbacDb.findUserById.mockResolvedValue({ _id: 'user-1', role: 'owner', tenantId: 'tenant-1' } as never);
      (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(rbacDb);
      app = await createFastifyApiTestApp(modelsApiPlugin);
    });

    afterEach(async () => {
      await app.close();
    });

    const headers = {
      'x-license-type': 'FREE',
      'x-tenant-db-name': 'tenant_acme',
      'x-tenant-id': 'tenant-1',
      'x-tenant-slug': 'acme',
      'x-user-id': 'user-1',
      'x-user-role': 'owner',
    };

    it('returns model drivers', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/models/providers/drivers',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = parseJsonBody<{ drivers: Array<{ id: string }> }>(res.body);
      expect(body.drivers).toHaveLength(1);
      expect(body.drivers[0].id).toBe('openai');
    });

    it('returns form schema for a model driver', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/models/providers/drivers/openai/form',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = parseJsonBody<{ driverId: string }>(res.body);
      expect(body.driverId).toBe('openai');
    });

    it('returns 404-like response when driver throws', async () => {
      mockGetFormSchema.mockImplementationOnce(() => { throw new Error('Driver not found'); });
      const res = await app.inject({
        method: 'GET',
        url: '/api/models/providers/drivers/unknown/form',
        headers,
      });
      expect(res.statusCode).toBe(404);
    });
  });

});
