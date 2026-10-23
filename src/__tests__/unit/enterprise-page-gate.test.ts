/**
 * Which enterprise module owns a dashboard page: the shell shows that module's upsell in place of
 * the page when the tenant has no ENTERPRISE license, instead of a page whose requests all 402.
 */

import { describe, expect, it } from 'vitest';
import { enterpriseModuleForPath } from '@/lib/utils/dashboardServices';

describe('enterpriseModuleForPath', () => {
  it('names the module of an enterprise service page and the pages below it', () => {
    expect(enterpriseModuleForPath('/dashboard/gpu-fleet')).toBe('gpu-fleet');
    expect(enterpriseModuleForPath('/dashboard/gpu-fleet/pools/a100')).toBe('gpu-fleet');
    expect(enterpriseModuleForPath('/dashboard/cost/pricing')).toBe('cost');
    expect(enterpriseModuleForPath('/dashboard/sandbox/instances')).toBe('sandbox');
    expect(enterpriseModuleForPath('/dashboard/realtime/sessions/abc')).toBe('realtime');
    expect(enterpriseModuleForPath('/dashboard/sso')).toBe('sso');
  });

  it('covers the enterprise pages that live outside their service', () => {
    expect(enterpriseModuleForPath('/dashboard/abacus')).toBe('cost');
    expect(enterpriseModuleForPath('/dashboard/abacus/parity')).toBe('cost');
  });

  it('leaves community pages and look-alike paths alone', () => {
    expect(enterpriseModuleForPath('/dashboard/agents')).toBeUndefined();
    expect(enterpriseModuleForPath('/dashboard/models/abc')).toBeUndefined();
    expect(enterpriseModuleForPath('/dashboard/costly')).toBeUndefined();
    expect(enterpriseModuleForPath('/dashboard')).toBeUndefined();
  });
});
