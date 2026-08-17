import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/support/supportHandoff', () => ({
  createSupportHandoff: vi.fn(),
  isSupportEntryPointEnabled: vi.fn(),
}));

import {
  createSupportHandoff,
  isSupportEntryPointEnabled,
} from '@/lib/services/support/supportHandoff';
import { supportApiPlugin } from '@/server/api/plugins/support';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const SESSION_HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-email': 'ada@example.com',
  'x-user-id': 'user-1',
  'x-user-role': 'owner',
  'x-license-type': 'FREE',
};

const mockedHandoff = vi.mocked(createSupportHandoff);
const mockedEnabled = vi.mocked(isSupportEntryPointEnabled);

async function app() {
  return createFastifyApiTestApp(supportApiPlugin);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedEnabled.mockReturnValue(true);
  mockedHandoff.mockResolvedValue({ ok: true, url: 'https://support.example.com/api/auth/handoff?code=shc_x' });
});

describe('GET /api/support/status', () => {
  it('reports whether an entry point should be shown', async () => {
    const response = await (await app()).inject({
      method: 'GET',
      url: '/api/support/status',
      headers: SESSION_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(parseJsonBody<{ enabled: boolean }>(response.body).enabled).toBe(true);
  });

  it('rejects an unauthenticated caller', async () => {
    const response = await (await app()).inject({ method: 'GET', url: '/api/support/status' });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /api/support/handoff', () => {
  it('passes the session identity to the handoff service', async () => {
    await (await app()).inject({
      method: 'POST',
      url: '/api/support/handoff',
      headers: SESSION_HEADERS,
      payload: { locale: 'en' },
    });

    expect(mockedHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        userId: 'user-1',
        userEmail: 'ada@example.com',
        locale: 'en',
      }),
    );
  });

  it('forwards diagnostics collected by an error surface', async () => {
    await (await app()).inject({
      method: 'POST',
      url: '/api/support/handoff',
      headers: SESSION_HEADERS,
      payload: {
        locale: 'tr',
        summary: 'boom',
        diagnostics: { category: 'dashboard_error', page: '/dashboard' },
      },
    });

    expect(mockedHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: 'boom',
        diagnostics: { category: 'dashboard_error', page: '/dashboard' },
      }),
    );
  });

  it('defaults to Turkish when no locale is sent', async () => {
    await (await app()).inject({
      method: 'POST',
      url: '/api/support/handoff',
      headers: SESSION_HEADERS,
      payload: {},
    });

    expect(mockedHandoff).toHaveBeenCalledWith(expect.objectContaining({ locale: 'tr' }));
  });

  it('rejects an unknown locale instead of guessing', async () => {
    const response = await (await app()).inject({
      method: 'POST',
      url: '/api/support/handoff',
      headers: SESSION_HEADERS,
      payload: { locale: 'de' },
    });

    expect(response.statusCode).toBe(400);
    expect(mockedHandoff).not.toHaveBeenCalled();
  });

  it('rejects diagnostics that are not an object', async () => {
    const response = await (await app()).inject({
      method: 'POST',
      url: '/api/support/handoff',
      headers: SESSION_HEADERS,
      payload: { diagnostics: ['not', 'an', 'object'] },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects an unauthenticated caller', async () => {
    const response = await (await app()).inject({
      method: 'POST',
      url: '/api/support/handoff',
      payload: { locale: 'tr' },
    });

    expect(response.statusCode).toBe(401);
    expect(mockedHandoff).not.toHaveBeenCalled();
  });

  it('surfaces the service status and keeps the response uncacheable', async () => {
    mockedHandoff.mockResolvedValue({
      ok: false,
      status: 503,
      message: 'Support integration is not configured.',
    });

    const response = await (await app()).inject({
      method: 'POST',
      url: '/api/support/handoff',
      headers: SESSION_HEADERS,
      payload: { locale: 'tr' },
    });

    expect(response.statusCode).toBe(503);
  });

  it('marks a login fallback so the caller can explain the missing diagnostics', async () => {
    mockedHandoff.mockResolvedValue({
      ok: true,
      url: 'https://support.example.com/tr/login?diagnostics=unavailable',
      diagnosticsUnavailable: true,
    });

    const response = await (await app()).inject({
      method: 'POST',
      url: '/api/support/handoff',
      headers: SESSION_HEADERS,
      payload: { locale: 'tr' },
    });

    expect(response.headers['cache-control']).toBe('no-store');
    expect(parseJsonBody<{ diagnosticsUnavailable?: boolean }>(response.body).diagnosticsUnavailable)
      .toBe(true);
  });
});
