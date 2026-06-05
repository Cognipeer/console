import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/alerts', () => ({
  AlertService: {
    acknowledgeEvent: vi.fn(),
  },
}));

import { PATCH } from '@/server/api/routes/alerts/history/[eventId]/acknowledge/route';
import { AlertService } from '@/lib/services/alerts';

const mockAcknowledgeEvent = vi.mocked(AlertService.acknowledgeEvent);

const mockParams = { params: Promise.resolve({ eventId: 'evt-1' }) };

function makeRequest(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/alerts/history/evt-1/acknowledge', {
    method: 'PATCH',
    headers: {
      'x-tenant-db-name': 'tenant_test',
      'x-user-id': 'user-1',
      ...headers,
    },
  });
}

const mockEvent = {
  _id: 'evt-1',
  ruleId: 'rule-1',
  acknowledgedAt: new Date(),
  acknowledgedBy: 'user-1',
};

describe('PATCH /api/alerts/history/[eventId]/acknowledge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockAcknowledgeEvent.mockResolvedValue(mockEvent as any);
  });

  it('acknowledges an alert event and returns it', async () => {
    const res = await PATCH(makeRequest(), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.event).toBeDefined();
    expect(body.event._id).toBe('evt-1');
  });

  it('calls acknowledgeEvent with correct args', async () => {
    await PATCH(makeRequest(), mockParams);
    expect(mockAcknowledgeEvent).toHaveBeenCalledWith('tenant_test', 'evt-1');
  });

  it('returns 401 when x-tenant-db-name is missing', async () => {
    const res = await PATCH(makeRequest({ 'x-tenant-db-name': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-user-id is missing', async () => {
    const res = await PATCH(makeRequest({ 'x-user-id': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 404 when event not found', async () => {
    mockAcknowledgeEvent.mockResolvedValueOnce(null);
    const res = await PATCH(makeRequest(), mockParams);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('not found');
  });

  it('returns 500 on unexpected error', async () => {
    mockAcknowledgeEvent.mockRejectedValueOnce(new Error('DB failure'));
    const res = await PATCH(makeRequest(), mockParams);
    expect(res.status).toBe(500);
  });
});
