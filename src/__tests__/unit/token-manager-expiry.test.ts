/**
 * Regression test for F-08 (finance-institution assessment, 2026-09-05):
 * TokenManager.generateToken hardcoded a {'1d','7d','30d'} lookup and fell
 * back to 7 days for anything else -- an operator setting JWT_EXPIRES_IN to
 * e.g. "12h" silently got a week-long token instead, with nothing to notice
 * it by.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { TokenManager } from '@/lib/license/token-manager';
import type { LicenseType } from '@/lib/license/license-manager';

const original = getConfigSource();

function sourceWith(overrides: Record<string, string>): ConfigSource {
  return {
    get: (key: string) => overrides[key] ?? process.env[key],
  } as ConfigSource;
}

afterEach(() => {
  setConfigSource(original);
});

const BASE_PAYLOAD = {
  userId: 'user-1',
  email: 'a@b.com',
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  role: 'user' as const,
  licenseId: 'lic-1',
  licenseType: 'community' as LicenseType,
  features: [],
};

async function issueAndGetLifetimeSeconds(jwtExpiresIn: string): Promise<number> {
  setConfigSource(sourceWith({ JWT_EXPIRES_IN: jwtExpiresIn }));
  const token = await TokenManager.generateToken(BASE_PAYLOAD);
  const decoded = TokenManager.decodeToken(token);
  if (!decoded?.exp || !decoded.iat) throw new Error('token missing exp/iat');
  return decoded.exp - decoded.iat;
}

describe('TokenManager.generateToken — JWT_EXPIRES_IN parsing', () => {
  it('still issues exactly 1/7/30 days for the previously hardcoded values', async () => {
    expect(await issueAndGetLifetimeSeconds('1d')).toBe(86400);
    expect(await issueAndGetLifetimeSeconds('7d')).toBe(604800);
    expect(await issueAndGetLifetimeSeconds('30d')).toBe(2592000);
  });

  it('honours a value the old hardcoded map did not know, instead of silently defaulting to 7 days', async () => {
    expect(await issueAndGetLifetimeSeconds('12h')).toBe(12 * 3600);
    expect(await issueAndGetLifetimeSeconds('45m')).toBe(45 * 60);
    expect(await issueAndGetLifetimeSeconds('2w')).toBe(2 * 7 * 86400);
  });

  it('fails loudly instead of silently issuing a 7-day token for an unparseable value', async () => {
    setConfigSource(sourceWith({ JWT_EXPIRES_IN: 'seven days please' }));
    await expect(TokenManager.generateToken(BASE_PAYLOAD)).rejects.toThrow();
  });
});
