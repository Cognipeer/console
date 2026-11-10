import { afterEach, describe, expect, it } from 'vitest';
import { getConfig, getConfigSource, setConfigSource } from '@/lib/core/config';

const originalSource = getConfigSource();

const policy = (values: Record<string, string | undefined>) => {
  setConfigSource({ name: 'test', get: (key) => values[key] });
  return getConfig().outboundHttp.crawlerResolvedPrivatePolicy;
};

afterEach(() => {
  setConfigSource(originalSource);
});

describe('crawlerResolvedPrivatePolicy', () => {
  it('defaults to warn on self-hosted and refuse on hosted', () => {
    expect(policy({ DEPLOYMENT_MODE: 'onprem' })).toBe('warn');
    expect(policy({ DEPLOYMENT_MODE: 'saas' })).toBe('refuse');
  });

  it('follows CRAWLER_RESOLVED_PRIVATE_POLICY and ignores unknown values', () => {
    expect(policy({ DEPLOYMENT_MODE: 'onprem', CRAWLER_RESOLVED_PRIVATE_POLICY: 'refuse' })).toBe('refuse');
    expect(policy({ DEPLOYMENT_MODE: 'saas', CRAWLER_RESOLVED_PRIVATE_POLICY: 'warn' })).toBe('warn');
    expect(policy({ DEPLOYMENT_MODE: 'onprem', CRAWLER_RESOLVED_PRIVATE_POLICY: 'maybe' })).toBe('warn');
  });
});
