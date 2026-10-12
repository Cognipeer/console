/**
 * The tags an agent run's trace carries: where the call came from and, for a call an application made for a person,
 * that and who vouched for the person - so the Traces views can filter calls made on someone's behalf.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

import { buildTracingMetadata } from '@/lib/services/agents/agentService';

describe('buildTracingMetadata', () => {
  it('tags a call made for a person with how it came about and the issuer', () => {
    expect(buildTracingMetadata({
      userId: 'person-1',
      tokenId: 'app-token',
      source: 'api',
      via: { kind: 'delegated', issuer: 'https://idp.bank.example' },
    })).toEqual({ source: 'api', via: 'delegated', viaIssuer: 'https://idp.bank.example' });
  });

  it('adds nothing for a call nobody acted for, and keeps the scheduler tags', () => {
    expect(buildTracingMetadata({ userId: 'u', tokenId: 't', source: 'api' })).toEqual({ source: 'api' });
    expect(buildTracingMetadata({ source: 'api', metadata: { trigger: 'schedule', scheduleId: 's1', other: 'ignored' } }))
      .toEqual({ source: 'api', trigger: 'schedule', scheduleId: 's1' });
    expect(buildTracingMetadata(undefined)).toBeUndefined();
  });
});
