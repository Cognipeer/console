import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: { listUsers: vi.fn() }, sendEmail: vi.fn() }));

vi.mock('@/lib/email/mailer', () => ({ sendEmail: h.sendEmail }));
vi.mock('@/lib/database', () => ({ getTenantDatabase: vi.fn(async () => h.db) }));

import { EmailAlertChannel } from '@/lib/services/alerts/channels/emailChannel';

const event = {
  ruleName: 'Latency', metric: 'avg_latency_ms', threshold: 1, actualValue: 2, firedAt: new Date(),
} as never;
const ctx = {
  tenantDbName: 'tenant_acme', projectName: 'P', companyName: 'Acme', dashboardUrl: 'u', incidentUrl: 'i', incidentId: '1',
} as never;

const USERS = [
  { role: 'owner', email: 'owner@acme.test' },
  { role: 'admin', email: 'gone@acme.test', status: 'disabled' },
  { role: 'admin', email: 'admin@acme.test' },
  { role: 'user', email: 'dev@acme.test', status: 'disabled' },
  { role: 'user', email: 'dev2@acme.test' },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.sendEmail.mockResolvedValue(true);
  h.db.listUsers.mockResolvedValue(USERS);
});

describe('EmailAlertChannel and disabled users', () => {
  it('skips disabled admins in the owner/admin fallback', async () => {
    await new EmailAlertChannel().dispatch(event, { type: 'email', recipients: [] } as never, ctx);
    expect(h.sendEmail.mock.calls.map((c) => c[0]).sort()).toEqual(['admin@acme.test', 'owner@acme.test']);
  });

  it('skips explicit recipients that belong to a disabled user (case-insensitive)', async () => {
    await new EmailAlertChannel().dispatch(
      event,
      { type: 'email', recipients: ['DEV@acme.test', 'dev2@acme.test', 'external@else.test'] } as never,
      ctx,
    );
    expect(h.sendEmail.mock.calls.map((c) => c[0]).sort()).toEqual(['dev2@acme.test', 'external@else.test']);
  });

  it('reports no recipients when every one is disabled', async () => {
    const res = await new EmailAlertChannel().dispatch(
      event, { type: 'email', recipients: ['dev@acme.test'] } as never, ctx,
    );
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(res[0]).toMatchObject({ success: false, error: 'No recipients available' });
  });

  it('keeps explicit recipients when the user list cannot be read', async () => {
    h.db.listUsers.mockRejectedValue(new Error('db down'));
    await new EmailAlertChannel().dispatch(
      event, { type: 'email', recipients: ['dev@acme.test'] } as never, ctx,
    );
    expect(h.sendEmail).toHaveBeenCalledWith('dev@acme.test', 'alert-fired', expect.anything());
  });
});
