/**
 * The throttle in front of the IP-refusal audit rows: one row per token and
 * address per minute, bounded memory, and a new address is never swallowed by
 * an old one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/core/asyncTask', () => ({
  criticalFireAndForget: (_label: string, fn: () => Promise<void>) => { fn().catch(() => undefined); },
}));
vi.mock('@/lib/services/audit', () => ({ recordAuditLog: vi.fn().mockResolvedValue(undefined) }));

import { recordAuditLog } from '@/lib/services/audit';
import {
  recordTokenIpDenial,
  resetTokenIpDenialThrottleForTests,
  shouldRecordTokenIpDenial,
} from '@/lib/services/apiTokens/ipDenialAudit';

const key = (n: number) => ({ tenantId: 't1', tokenId: 'tok-1', clientIp: `10.0.${Math.floor(n / 256)}.${n % 256}` });

beforeEach(() => {
  vi.clearAllMocks();
  resetTokenIpDenialThrottleForTests();
});

describe('shouldRecordTokenIpDenial', () => {
  it('lets the first refusal through and holds the repeats for a minute', () => {
    const t0 = 1_000_000;
    expect(shouldRecordTokenIpDenial(key(1), t0)).toBe(true);
    expect(shouldRecordTokenIpDenial(key(1), t0 + 1_000)).toBe(false);
    expect(shouldRecordTokenIpDenial(key(1), t0 + 59_999)).toBe(false);
    expect(shouldRecordTokenIpDenial(key(1), t0 + 60_000)).toBe(true);
  });

  it('tracks token, tenant and address separately', () => {
    const t0 = 2_000_000;
    expect(shouldRecordTokenIpDenial({ tenantId: 't1', tokenId: 'a', clientIp: '1.1.1.1' }, t0)).toBe(true);
    expect(shouldRecordTokenIpDenial({ tenantId: 't1', tokenId: 'b', clientIp: '1.1.1.1' }, t0)).toBe(true);
    expect(shouldRecordTokenIpDenial({ tenantId: 't2', tokenId: 'a', clientIp: '1.1.1.1' }, t0)).toBe(true);
    expect(shouldRecordTokenIpDenial({ tenantId: 't1', tokenId: 'a', clientIp: '1.1.1.2' }, t0)).toBe(true);
    expect(shouldRecordTokenIpDenial({ tenantId: 't1', tokenId: 'a', clientIp: '1.1.1.1' }, t0 + 1)).toBe(false);
  });

  it('stays bounded under a flood of distinct addresses and still records new ones', () => {
    const t0 = 3_000_000;
    // Far more distinct addresses than the table holds, all inside the window.
    let recorded = 0;
    for (let i = 0; i < 12_000; i++) {
      if (shouldRecordTokenIpDenial(key(i), t0 + i)) recorded++;
    }
    expect(recorded).toBe(12_000); // every new address is recorded, none is swallowed by the cap
    // After the flood a brand-new address is still recorded...
    expect(shouldRecordTokenIpDenial({ tenantId: 't1', tokenId: 'tok-1', clientIp: '192.0.2.250' }, t0 + 12_001)).toBe(true);
    // ...and a recent one is still throttled.
    expect(shouldRecordTokenIpDenial(key(11_999), t0 + 12_002)).toBe(false);
  });

  it('forgets expired entries so the table can be reused', () => {
    const t0 = 4_000_000;
    for (let i = 0; i < 5_000; i++) shouldRecordTokenIpDenial(key(i), t0);
    // A minute later everything is stale; recording a new key evicts them rather than dropping live ones.
    expect(shouldRecordTokenIpDenial(key(99_999), t0 + 61_000)).toBe(true);
    expect(shouldRecordTokenIpDenial(key(1), t0 + 61_001)).toBe(true);
  });
});

describe('recordTokenIpDenial', () => {
  const input = {
    tenantId: 't1',
    tenantDbName: 'tenant_acme',
    tokenId: 'tok-1',
    userId: 'u1',
    projectId: 'p1',
    clientIp: '198.51.100.7',
    requestId: 'req-1',
    method: 'POST',
    path: '/api/client/v1/chat/completions',
    userAgent: 'curl/8',
  };

  it('writes one denied security row for the tenant', async () => {
    recordTokenIpDenial(input);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(recordAuditLog).toHaveBeenCalledTimes(1);
    const [context, row] = vi.mocked(recordAuditLog).mock.calls[0];
    expect(context).toEqual({ tenantDbName: 'tenant_acme', tenantId: 't1' });
    expect(row).toMatchObject({
      actorType: 'api_token',
      service: 'tokens',
      action: 'security',
      outcome: 'denied',
      statusCode: 403,
      ipAddress: '198.51.100.7',
      event: 'POST /api/client/v1/chat/completions',
      metadata: { code: 'ip_not_allowed' },
    });
  });

  it('a repeat from the same token and address within the minute writes nothing more', async () => {
    recordTokenIpDenial(input);
    recordTokenIpDenial(input);
    recordTokenIpDenial(input);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(recordAuditLog).toHaveBeenCalledTimes(1);
  });
});
