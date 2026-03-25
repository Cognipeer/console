import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/alerts', () => ({
  AlertService: {
    listEvents: vi.fn(),
    countActive: vi.fn(),
    acknowledgeEvent: vi.fn(),
  },
}));

vi.mock('@/lib/services/projects/projectContext', () => {
  class ProjectContextError extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  }
  return { requireProjectContext: vi.fn(), ProjectContextError };
});

import { GET } from '@/server/api/routes/alerts/history/route';
import { PATCH } from '@/server/api/routes/alerts/history/[eventId]/acknowledge/route';
import { AlertService } from '@/lib/services/alerts';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

const HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-user-id': 'user-1',
};

function makeReq(path: string, method = 'GET', headers: Record<string, string> = HEADERS) {
  return new NextRequest(`http://localhost${path}`, { method, headers });
}

const MOCK_EVENTS = [
  { _id: 'evt-1', ruleId: 'rule-1', status: 'active', createdAt: new Date() },
];

const MOCK_PROJECT = { projectId: 'proj-1' };

beforeEach(() => {
  vi.clearAllMocks();
  (requireProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PROJECT);
  (AlertService.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_EVENTS);
  (AlertService.countActive as ReturnType<typeof vi.fn>).mockResolvedValue(1);
  (AlertService.acknowledgeEvent as ReturnType<typeof vi.fn>).mockResolvedValue({ ...MOCK_EVENTS[0], status: 'acknowledged' });
});

describe('GET /api/alerts/history', () => {
  it('returns events and activeCount 200', async () => {
    const req = makeReq('/api/alerts/history');
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.events).toHaveLength(1);
    expect(body.activeCount).toBe(1);
  });

  it('passes ruleId filter', async () => {
    const req = makeReq('/api/alerts/history?ruleId=rule-1');
    await GET(req);
    expect(AlertService.listEvents).toHaveBeenCalledWith('tenant_acme', 'tenant-1', expect.objectContaining({ ruleId: 'rule-1' }));
  });

  it('passes status filter', async () => {
    const req = makeReq('/api/alerts/history?status=active');
    await GET(req);
    expect(AlertService.listEvents).toHaveBeenCalledWith('tenant_acme', 'tenant-1', expect.objectContaining({ status: 'active' }));
  });

  it('passes pagination params', async () => {
    const req = makeReq('/api/alerts/history?limit=10&skip=5');
    await GET(req);
    expect(AlertService.listEvents).toHaveBeenCalledWith('tenant_acme', 'tenant-1', expect.objectContaining({ limit: 10, skip: 5 }));
  });

  it('returns 401 when headers missing', async () => {
    const req = makeReq('/api/alerts/history', 'GET', {});
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns ProjectContextError status', async () => {
    const e = new (ProjectContextError as any)('No project', 404);
    (requireProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(e);
    const req = makeReq('/api/alerts/history');
    const res = await GET(req);
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    (AlertService.listEvents as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const req = makeReq('/api/alerts/history');
    const res = await GET(req);
    expect(res.status).toBe(500);
  });
});

describe('PATCH /api/alerts/history/[eventId]/acknowledge', () => {
  it('acknowledges event and returns 200', async () => {
    const req = makeReq('/api/alerts/history/evt-1/acknowledge', 'PATCH');
    const res = await PATCH(req, { params: Promise.resolve({ eventId: 'evt-1' }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.event.status).toBe('acknowledged');
  });

  it('returns 401 when tenantDbName missing', async () => {
    const req = makeReq('/api/alerts/history/evt-1/acknowledge', 'PATCH', { 'x-user-id': 'user-1' });
    const res = await PATCH(req, { params: Promise.resolve({ eventId: 'evt-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 401 when userId missing', async () => {
    const req = makeReq('/api/alerts/history/evt-1/acknowledge', 'PATCH', { 'x-tenant-db-name': 'tenant_acme' });
    const res = await PATCH(req, { params: Promise.resolve({ eventId: 'evt-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 when event not found', async () => {
    (AlertService.acknowledgeEvent as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const req = makeReq('/api/alerts/history/nonexistent/acknowledge', 'PATCH');
    const res = await PATCH(req, { params: Promise.resolve({ eventId: 'nonexistent' }) });
    expect(res.status).toBe(404);
  });

  it('passes eventId and tenantDbName correctly', async () => {
    const req = makeReq('/api/alerts/history/evt-1/acknowledge', 'PATCH', {
      'x-tenant-db-name': 'tenant_acme',
      'x-user-id': 'user-1',
    });
    await PATCH(req, { params: Promise.resolve({ eventId: 'evt-1' }) });
    expect(AlertService.acknowledgeEvent).toHaveBeenCalledWith('tenant_acme', 'evt-1');
  });

  it('returns 500 on unexpected error', async () => {
    (AlertService.acknowledgeEvent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const req = makeReq('/api/alerts/history/evt-1/acknowledge', 'PATCH');
    const res = await PATCH(req, { params: Promise.resolve({ eventId: 'evt-1' }) });
    expect(res.status).toBe(500);
  });
});
