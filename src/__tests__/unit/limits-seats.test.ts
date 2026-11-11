/**
 * Seat limits at the places a seat is taken: the refusal is 402 `seat_limit_reached` with the plan-limit envelope,
 * off mode counts nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  plan: { tenantId: 't1', mode: 'on', limits: null } as any,
  db: { iamCountUsers: vi.fn(async (_f: unknown) => 0) },
  events: [] as any[],
}));

vi.mock('@/lib/limits/tenantLimits', () => ({ resolveTenantPlan: async () => h.plan }));
vi.mock('@/lib/database', () => ({ getDatabase: async () => h.db }));
vi.mock('@/lib/limits/events', () => ({
  outcomeEventFor: (d: unknown, c: unknown) => h.events.push({ d, c }),
  recordLimitEvent: vi.fn(),
}));

import { assertSeats } from '@/lib/limits/seats';
import { sendPlanLimitRefusal } from '@/server/api/planLimitReply';

function setPlan(mode: 'on' | 'off', seats: { console?: number; portal?: number }) {
  h.plan = { tenantId: 't1', mode, limits: { concurrency: {}, monthly: {}, seats, credits: {} } };
}

function fakeReply() {
  const sent: { status?: number; headers: Record<string, string>; body?: unknown } = { headers: {} };
  const reply: any = {
    headers(values: Record<string, string>) {
      Object.assign(sent.headers, values);
      return reply;
    },
    code(status: number) {
      sent.status = status;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
  };
  return { reply, sent };
}

beforeEach(() => {
  h.events.length = 0;
  h.db.iamCountUsers.mockReset();
  h.db.iamCountUsers.mockResolvedValue(0);
});

describe('seats at invitation, user creation and role change', () => {
  it('refuses a console seat when all are in use (on), counting console roles only', async () => {
    setPlan('on', { console: 3, portal: 10 });
    h.db.iamCountUsers.mockResolvedValue(3);
    await expect(assertSeats({ tenantId: 't1', kind: 'console' })).rejects.toMatchObject({ code: 'seat_limit_reached', status: 402 });
    expect(h.db.iamCountUsers).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', canLogin: true, roles: ['owner', 'admin', 'project_admin', 'user'] }),
    );
  });

  it('checks portal seats separately, against portal_user', async () => {
    setPlan('on', { console: 1, portal: 5 });
    h.db.iamCountUsers.mockResolvedValue(4);
    await expect(assertSeats({ tenantId: 't1', kind: 'portal' })).resolves.toBeUndefined();
    expect(h.db.iamCountUsers).toHaveBeenCalledWith(expect.objectContaining({ roles: ['portal_user'] }));
    h.db.iamCountUsers.mockResolvedValue(5);
    await expect(assertSeats({ tenantId: 't1', kind: 'portal' })).rejects.toMatchObject({ code: 'seat_limit_reached' });
  });

  it('does not count anything when off or without a seat limit', async () => {
    setPlan('off', { console: 1 });
    h.db.iamCountUsers.mockResolvedValue(9);
    await expect(assertSeats({ tenantId: 't1', kind: 'console' })).resolves.toBeUndefined();
    setPlan('on', {});
    await expect(assertSeats({ tenantId: 't1', kind: 'console' })).resolves.toBeUndefined();
    expect(h.db.iamCountUsers).not.toHaveBeenCalled();
  });
});

describe('sendPlanLimitRefusal', () => {
  it('answers a seat refusal with its status and envelope, and ignores other errors', async () => {
    setPlan('on', { console: 1 });
    h.db.iamCountUsers.mockResolvedValue(1);
    const error = await assertSeats({ tenantId: 't1', kind: 'console' }).catch((e) => e);
    const { reply, sent } = fakeReply();
    expect(sendPlanLimitRefusal(reply, error)).toBe(reply);
    expect(sent.status).toBe(402);
    expect(sent.headers['x-cognipeer-error-code']).toBe('seat_limit_reached');
    expect(sent.body).toMatchObject({ code: 'seat_limit_reached', kind: 'seats', dimension: 'console', limit: 1, used: 1 });
    expect(sendPlanLimitRefusal(fakeReply().reply, new Error('x'))).toBeNull();
  });
});
