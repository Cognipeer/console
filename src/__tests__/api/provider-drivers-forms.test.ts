import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockListDescriptors = vi.hoisted(() => vi.fn().mockReturnValue([]));
const mockGetFormSchema = vi.hoisted(() => vi.fn().mockReturnValue({ sections: [] }));

vi.mock('@/lib/providers', () => ({
  providerRegistry: {
    listDescriptors: mockListDescriptors,
    getFormSchema: mockGetFormSchema,
  },
}));

import { GET as providersDriversGET } from '@/server/api/routes/providers/drivers/route';
import { GET as providerDriverFormGET } from '@/server/api/routes/providers/drivers/[driverId]/form/route';
import { GET as vectorDriversGET } from '@/server/api/routes/vector/providers/drivers/route';
import { GET as vectorDriverFormGET } from '@/server/api/routes/vector/providers/drivers/[driverId]/form/route';
import { GET as filesDriversGET } from '@/server/api/routes/files/providers/drivers/route';
import { modelsApiPlugin } from '@/server/api/plugins/models';
import {
  createFastifyApiTestApp,
  parseJsonBody,
} from '../helpers/fastify-api';

const mockDrivers = [
  { id: 'pinecone', label: 'Pinecone', domains: ['vector'] },
  { id: 'openai', label: 'OpenAI', domains: ['model'] },
];
const mockSchema = { sections: [{ fields: [{ name: 'api_key', type: 'password' }] }] };

function makeReq(path: string, query?: string) {
  const url = `http://localhost${path}${query ? `?${query}` : ''}`;
  return new NextRequest(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
}

describe('provider driver routes', () => {
  describe('GET /api/providers/drivers', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockListDescriptors.mockReturnValue(mockDrivers);
    });

    it('returns all provider drivers', async () => {
      const res = await providersDriversGET(makeReq('/api/providers/drivers'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.drivers).toHaveLength(2);
    });
  });

  describe('GET /api/providers/drivers/[driverId]/form', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockListDescriptors.mockReturnValue(mockDrivers);
      mockGetFormSchema.mockReturnValue(mockSchema);
    });

    it('returns form schema for a driver', async () => {
      const res = await providerDriverFormGET(
        makeReq('/api/providers/drivers/pinecone/form'),
        { params: Promise.resolve({ driverId: 'pinecone' }) },
      );
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/vector/providers/drivers', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockListDescriptors.mockReturnValue([mockDrivers[0]]);
    });

    it('returns vector drivers', async () => {
      const res = await vectorDriversGET(makeReq('/api/vector/providers/drivers'));
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/vector/providers/drivers/[driverId]/form', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockListDescriptors.mockReturnValue([mockDrivers[0]]);
      mockGetFormSchema.mockReturnValue(mockSchema);
    });

    it('returns form schema for a vector driver', async () => {
      const res = await vectorDriverFormGET(
        makeReq('/api/vector/providers/drivers/pinecone/form'),
        { params: Promise.resolve({ driverId: 'pinecone' }) },
      );
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/models/providers/drivers*', () => {
    let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

    beforeEach(async () => {
      vi.clearAllMocks();
      mockListDescriptors.mockReturnValue([mockDrivers[1]]);
      mockGetFormSchema.mockReturnValue(mockSchema);
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

  describe('GET /api/files/providers/drivers', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockListDescriptors.mockReturnValue([{ id: 's3', label: 'Amazon S3' }]);
    });

    it('returns file provider drivers', async () => {
      const res = await filesDriversGET(makeReq('/api/files/providers/drivers'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.drivers[0].id).toBe('s3');
    });
  });
});
