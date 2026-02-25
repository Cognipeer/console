/**
 * Tests for all provider driver listing and form routes.
 * These routes share the same pattern: no auth, just providerRegistry.listDescriptors/getFormSchema
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockListDescriptors = vi.hoisted(() => vi.fn().mockReturnValue([]));
const mockGetFormSchema = vi.hoisted(() => vi.fn().mockReturnValue({ sections: [] }));

vi.mock('@/lib/providers', () => ({
  providerRegistry: {
    listDescriptors: mockListDescriptors,
    getFormSchema: mockGetFormSchema,
  },
}));

import { GET as providersDriversGET } from '@/app/api/providers/drivers/route';
import { GET as providerDriverFormGET } from '@/app/api/providers/drivers/[driverId]/form/route';
import { GET as vectorDriversGET } from '@/app/api/vector/providers/drivers/route';
import { GET as vectorDriverFormGET } from '@/app/api/vector/providers/drivers/[driverId]/form/route';
import { GET as modelsDriversGET } from '@/app/api/models/providers/drivers/route';
import { GET as modelDriverFormGET } from '@/app/api/models/providers/drivers/[driverId]/form/route';
import { GET as filesDriversGET } from '@/app/api/files/providers/drivers/route';

const mockDrivers = [
  { id: 'pinecone', label: 'Pinecone', domains: ['vector'] },
  { id: 'openai', label: 'OpenAI', domains: ['model'] },
];
const mockSchema = { sections: [{ fields: [{ name: 'api_key', type: 'password' }] }] };

function makeReq(path: string, query?: string) {
  const url = `http://localhost${path}${query ? `?${query}` : ''}`;
  return new NextRequest(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
}

// ─── providers/drivers ───────────────────────────────────────────────────────

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

  it('filters by domain when passed', async () => {
    mockListDescriptors.mockReturnValue([mockDrivers[0]]);
    const res = await providersDriversGET(makeReq('/api/providers/drivers', 'domain=vector'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drivers).toHaveLength(1);
  });
});

// ─── providers/drivers/[driverId]/form ───────────────────────────────────────

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
    const body = await res.json();
    expect(body.driverId).toBe('pinecone');
    expect(body.schema).toBeDefined();
  });

  it('returns descriptor in response', async () => {
    const res = await providerDriverFormGET(
      makeReq('/api/providers/drivers/pinecone/form'),
      { params: Promise.resolve({ driverId: 'pinecone' }) },
    );
    const body = await res.json();
    expect(body.descriptor).toBeDefined();
    expect(body.descriptor.id).toBe('pinecone');
  });
});

// ─── vector/providers/drivers ────────────────────────────────────────────────

describe('GET /api/vector/providers/drivers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListDescriptors.mockReturnValue([mockDrivers[0]]);
  });

  it('returns vector drivers', async () => {
    const res = await vectorDriversGET(makeReq('/api/vector/providers/drivers'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drivers).toHaveLength(1);
  });

  it('handles empty driver list', async () => {
    mockListDescriptors.mockReturnValue([]);
    const res = await vectorDriversGET(makeReq('/api/vector/providers/drivers'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drivers).toHaveLength(0);
  });
});

// ─── vector/providers/drivers/[driverId]/form ────────────────────────────────

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
    const body = await res.json();
    expect(body.driverId).toBe('pinecone');
    expect(body.schema).toBeDefined();
  });
});

// ─── models/providers/drivers ────────────────────────────────────────────────

describe('GET /api/models/providers/drivers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListDescriptors.mockReturnValue([mockDrivers[1]]);
  });

  it('returns model drivers', async () => {
    const res = await modelsDriversGET(makeReq('/api/models/providers/drivers'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drivers).toHaveLength(1);
  });
});

// ─── models/providers/drivers/[driverId]/form ────────────────────────────────

describe('GET /api/models/providers/drivers/[driverId]/form', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListDescriptors.mockReturnValue([mockDrivers[1]]);
    mockGetFormSchema.mockReturnValue(mockSchema);
  });

  it('returns form schema for a model driver', async () => {
    const res = await modelDriverFormGET(
      makeReq('/api/models/providers/drivers/openai/form'),
      { params: Promise.resolve({ driverId: 'openai' }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.driverId).toBe('openai');
  });

  it('returns 404-like response when driver throws', async () => {
    mockGetFormSchema.mockImplementationOnce(() => { throw new Error('Driver not found'); });
    const res = await modelDriverFormGET(
      makeReq('/api/models/providers/drivers/unknown/form'),
      { params: Promise.resolve({ driverId: 'unknown' }) },
    );
    expect(res.status).toBe(404);
  });
});

// ─── files/providers/drivers ─────────────────────────────────────────────────

describe('GET /api/files/providers/drivers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListDescriptors.mockReturnValue([{ id: 's3', label: 'Amazon S3' }]);
  });

  it('returns file provider drivers', async () => {
    const res = await filesDriversGET(makeReq('/api/files/providers/drivers'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drivers).toHaveLength(1);
    expect(body.drivers[0].id).toBe('s3');
  });

  it('handles error from providerRegistry', async () => {
    mockListDescriptors.mockImplementationOnce(() => { throw new Error('Registry error'); });
    const res = await filesDriversGET(makeReq('/api/files/providers/drivers'));
    expect(res.status).toBe(500);
  });
});
