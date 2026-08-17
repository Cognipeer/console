import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = {
  findTenantById: vi.fn(),
  switchToTenant: vi.fn().mockResolvedValue(undefined),
  assertTenantContext: vi.fn(),
  findUserById: vi.fn(),
};

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => db),
}));

const config = {
  support: {
    baseUrl: 'https://support.example.com',
    crmApiUrl: 'https://crm.example.com',
    handoffSecret: 'a'.repeat(32),
  },
  deployment: { mode: 'saas' as 'saas' | 'onprem', isOnPrem: false },
};

vi.mock('@/lib/core/config', () => ({
  getConfig: () => config,
}));

import {
  createSupportHandoff,
  isSupportEntryPointEnabled,
} from '@/lib/services/support/supportHandoff';

const input = {
  tenantId: '65f1c0ffee0000000000abcd',
  userId: 'user-1',
  userEmail: '  Ada@Example.COM ',
  locale: 'tr' as const,
};

function crmResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  config.support = {
    baseUrl: 'https://support.example.com',
    crmApiUrl: 'https://crm.example.com',
    handoffSecret: 'a'.repeat(32),
  };
  config.deployment = { mode: 'saas', isOnPrem: false };
  db.findTenantById.mockResolvedValue({
    _id: input.tenantId,
    companyName: 'Acme Inc',
    slug: 'acme',
    dbName: 'tenant_acme',
  });
  db.findUserById.mockResolvedValue({ name: 'Ada Lovelace', email: 'ada@example.com' });
});

describe('createSupportHandoff', () => {
  it('anchors support identity to the tenant id, not the renameable slug', async () => {
    const fetchMock = vi.fn().mockResolvedValue(crmResponse({ code: 'shc_x' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createSupportHandoff(input);

    expect(result.ok).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.issuer).toBe('console');
    expect(body.externalInstallationId).toBe(input.tenantId);
    // A null organizationId makes the CRM derive an issuer-scoped key, so a
    // slug rename can never orphan the customer's ticket history.
    expect(body.context.organizationId).toBeNull();
    expect(body.context.workspaceName).toBe('Acme Inc');
  });

  it('sends a display name so support does not address an email address', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(crmResponse({ code: 'shc_x' })));

    await createSupportHandoff(input);

    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.context.userName).toBe('Ada Lovelace');
    expect(body.email).toBe('ada@example.com');
  });

  it('falls back to the email when the user record cannot be read', async () => {
    db.findUserById.mockRejectedValue(new Error('tenant db unavailable'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(crmResponse({ code: 'shc_x' })));

    const result = await createSupportHandoff(input);

    expect(result.ok).toBe(true);
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.context.userName).toBe('ada@example.com');
  });

  it('returns the Support callback URL carrying the single-use code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(crmResponse({ code: 'shc_abc' })));

    const result = await createSupportHandoff(input);

    expect(result).toMatchObject({
      ok: true,
      url: 'https://support.example.com/api/auth/handoff?code=shc_abc&locale=tr',
    });
  });

  it('creates a diagnostic draft first and links it to the handoff', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(crmResponse({ id: 'draft-1' }))
      .mockResolvedValueOnce(crmResponse({ code: 'shc_abc' }));
    vi.stubGlobal('fetch', fetchMock);

    await createSupportHandoff({ ...input, summary: 'boom', diagnostics: { category: 'x' } });

    expect(fetchMock.mock.calls[0][0]).toContain('/api/internal-support/v1/diagnostic-drafts');
    const handoffBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(handoffBody.diagnosticDraftId).toBe('draft-1');
  });

  it('never leaks the CRM reason to the caller', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(crmResponse({ error: 'secret internal reason' }, 403)),
    );

    const result = await createSupportHandoff(input);

    expect(result).toEqual({ ok: false, status: 403, message: 'Support access denied.' });
  });

  it('sends an on-prem install to the Support login when CRM is unreachable', async () => {
    config.deployment = { mode: 'onprem', isOnPrem: true };
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await createSupportHandoff(input);

    expect(result).toMatchObject({
      ok: true,
      url: 'https://support.example.com/tr/login?diagnostics=unavailable',
      diagnosticsUnavailable: true,
    });
  });
});

describe('isSupportEntryPointEnabled', () => {
  it('hides the entry point when no handoff can be issued on SaaS', () => {
    config.support = { baseUrl: 'https://support.example.com', crmApiUrl: '', handoffSecret: '' };
    expect(isSupportEntryPointEnabled()).toBe(false);
  });

  it('keeps it on-prem, where the login fallback still helps', () => {
    config.support = { baseUrl: 'https://support.example.com', crmApiUrl: '', handoffSecret: '' };
    config.deployment = { mode: 'onprem', isOnPrem: true };
    expect(isSupportEntryPointEnabled()).toBe(true);
  });

  it('stays hidden without a Support URL', () => {
    config.support = { baseUrl: '', crmApiUrl: 'https://crm', handoffSecret: 'a'.repeat(32) };
    config.deployment = { mode: 'onprem', isOnPrem: true };
    expect(isSupportEntryPointEnabled()).toBe(false);
  });
});
