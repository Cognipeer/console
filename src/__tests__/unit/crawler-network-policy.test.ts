/**
 * Crawler network policy: literal/name pre-check and the deployment-gated
 * `allowPrivateNetwork` opt-in.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
  outboundHttp: { blockPrivateNetwork: true, allowedHosts: [] as string[], crawlerAllowPrivateOptIn: false,
    crawlerResolvedPrivatePolicy: 'refuse' as 'refuse' | 'warn',
  },
  deployment: { isOnPrem: false },
}));

vi.mock('@/lib/core/config', () => ({ getConfig: () => cfg }));

import {
  assertResolvedUrl,
  assertSafeUrl,
  crawlerResolvedPrivateAllowance,
  isPrivateHost,
  resolveAllowPrivate,
} from '@/lib/services/crawler/engine/ssrf';

beforeEach(() => {
  cfg.outboundHttp.blockPrivateNetwork = true;
  cfg.outboundHttp.allowedHosts = [];
  cfg.outboundHttp.crawlerAllowPrivateOptIn = false;
  cfg.outboundHttp.crawlerResolvedPrivatePolicy = 'refuse';
  cfg.deployment.isOnPrem = false;
});

describe('isPrivateHost', () => {
  it.each([
    'localhost',
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '[::1]',
    '[::ffff:7f00:1]',
    'kubernetes.default.svc',
    'vault.vault.svc.cluster.local',
    'metadata.google.internal',
    'printer.local',
    'intranet',
  ])('refuses %s', (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each(['example.com', '93.184.216.34', 'docs.example.org'])('accepts %s', (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });
});

describe('assertSafeUrl', () => {
  it('refuses internal names and addresses', () => {
    expect(() => assertSafeUrl('http://kubernetes.default.svc/')).toThrow(/Refusing/);
    expect(() => assertSafeUrl('http://[::ffff:7f00:1]/')).toThrow(/Refusing/);
    expect(() => assertSafeUrl('http://100.64.0.5/')).toThrow(/Refusing/);
  });

  it('accepts public hosts', () => {
    expect(() => assertSafeUrl('https://example.com/')).not.toThrow();
  });

  it('ignores the per-crawler flag where the deployment does not allow it', () => {
    expect(() => assertSafeUrl('http://10.0.0.5/', true)).toThrow(/Refusing/);
  });

  it('honours the flag where the deployment allows it', () => {
    cfg.outboundHttp.crawlerAllowPrivateOptIn = true;
    cfg.deployment.isOnPrem = true;
    expect(() => assertSafeUrl('http://10.0.0.5/', true)).not.toThrow();
    expect(() => assertSafeUrl('http://10.0.0.5/', false)).toThrow(/Refusing/);
  });

  it('lets allow-listed hosts through', () => {
    cfg.outboundHttp.allowedHosts = ['.svc.cluster.local'];
    expect(() => assertSafeUrl('http://docs.team.svc.cluster.local/')).not.toThrow();
  });
});

describe('resolveAllowPrivate', () => {
  it('is false when not requested', () => {
    cfg.outboundHttp.crawlerAllowPrivateOptIn = true;
    expect(resolveAllowPrivate(undefined)).toBe(false);
  });

  it('follows the deployment switch when requested', () => {
    expect(resolveAllowPrivate(true)).toBe(false);
    cfg.outboundHttp.crawlerAllowPrivateOptIn = true;
    expect(resolveAllowPrivate(true)).toBe(true);
  });
});

describe('resolved-private policy', () => {
  it('refuses internal-only names under refuse', () => {
    expect(() => assertSafeUrl('http://kubernetes.default.svc/')).toThrow(/Refusing/);
    expect(() => assertSafeUrl('http://intranet/')).toThrow(/Refusing/);
    expect(crawlerResolvedPrivateAllowance.hasRanges).toBe(false);
    expect(crawlerResolvedPrivateAllowance.permits('10.0.0.5', 'docs.corp.example')).toBe(false);
  });

  it('allows internal-only names and names resolving to private addresses under warn', () => {
    cfg.outboundHttp.crawlerResolvedPrivatePolicy = 'warn';
    expect(() => assertSafeUrl('http://kubernetes.default.svc/')).not.toThrow();
    expect(() => assertSafeUrl('http://intranet/')).not.toThrow();
    expect(crawlerResolvedPrivateAllowance.hasRanges).toBe(true);
    expect(crawlerResolvedPrivateAllowance.permits('10.0.0.5', 'docs.corp.example')).toBe(true);
  });

  it('keeps literal addresses and localhost refused under warn', () => {
    cfg.outboundHttp.crawlerResolvedPrivatePolicy = 'warn';
    expect(() => assertSafeUrl('http://10.0.0.5/')).toThrow(/Refusing/);
    expect(() => assertSafeUrl('http://[::1]/')).toThrow(/Refusing/);
    expect(() => assertSafeUrl('http://localhost/')).toThrow(/Refusing/);
    expect(() => assertSafeUrl('http://app.localhost/')).toThrow(/Refusing/);
    expect(crawlerResolvedPrivateAllowance.permits('10.0.0.5', '10.0.0.5')).toBe(false);
    expect(crawlerResolvedPrivateAllowance.permits('127.0.0.1', 'localhost')).toBe(false);
  });
});

describe('assertResolvedUrl through an egress proxy', () => {
  const routing = { server: 'http://proxy.corp.example:3128' };

  it('skips in-process resolution but keeps the literal pre-check', async () => {
    await expect(assertResolvedUrl('http://www.corp-e2e.test/', false, routing)).resolves.toBeUndefined();
    await expect(assertResolvedUrl('http://10.0.0.5/', false, routing)).rejects.toThrow(/Refusing/);
  });

  it('is not used for hosts the proxy is bypassed for (checked in-process)', async () => {
    const bypassed = { ...routing, bypass: '10.0.0.5' };
    await expect(assertResolvedUrl('http://10.0.0.5/', false, bypassed)).rejects.toThrow();
  });
});
