import { afterEach, describe, expect, it } from 'vitest';
import {
  getConfig,
  getConfigSource,
  setConfigSource,
  validateConfig,
  type ConfigSource,
} from '@/lib/core/config';
import {
  isPortalHostApiPath,
  matchPortalHost,
  portalHostOfTenant,
  portalHostOrigin,
  portalHostPagePath,
  portalHostsEnabled,
  portalHostUrl,
  requestHostOf,
  shortPortalPath,
} from '@/lib/portalHost/host';

const originalSource = getConfigSource();

function useConfig(values: Record<string, string | undefined>) {
  const source: ConfigSource = { name: 'test', get: (key) => values[key] };
  setConfigSource(source);
  return getConfig();
}

const SAAS = { APP_URL: 'https://console.cognipeer.com', PORTAL_BASE_DOMAIN: 'portal.cognipeer.com' };

afterEach(() => {
  setConfigSource(originalSource);
});

describe('portal host settings', () => {
  it('reads the base domain and the fixed host as host names', () => {
    const cfg = useConfig({ ...SAAS, PORTAL_BASE_DOMAIN: ' *.Portal.Cognipeer.com. ', PORTAL_HOST: 'Asistan.Example.com', PORTAL_HOST_TENANT: 'Banka' });
    expect(cfg.portalHost).toEqual({ baseDomain: 'portal.cognipeer.com', fixedHost: 'asistan.example.com', fixedHostTenant: 'banka' });
    expect(portalHostsEnabled(cfg)).toBe(true);
  });

  it('is off when neither is set', () => {
    const cfg = useConfig({ APP_URL: 'https://console.cognipeer.com' });
    expect(portalHostsEnabled(cfg)).toBe(false);
    expect(matchPortalHost('acme.portal.cognipeer.com', cfg)).toBeNull();
  });

  it.each([
    ['a scheme', 'https://portal.cognipeer.com'],
    ['a port', 'portal.cognipeer.com:8443'],
    ['a path', 'portal.cognipeer.com/p'],
    ['one label', 'portal'],
    ['a bad label', 'portal_x.cognipeer.com'],
  ])('refuses a base domain with %s', (_what, value) => {
    const errors = validateConfig(useConfig({ ...SAAS, PORTAL_BASE_DOMAIN: value }));
    expect(errors.map((e) => e.key)).toContain('PORTAL_BASE_DOMAIN');
  });

  it('refuses a base domain that contains the Console host (it would be read as a workspace)', () => {
    const errors = validateConfig(useConfig({ ...SAAS, PORTAL_BASE_DOMAIN: 'cognipeer.com' }));
    expect(errors.find((e) => e.key === 'PORTAL_BASE_DOMAIN')?.message).toMatch(/Console host/);
  });

  it('refuses a fixed host that is the Console host, and a tenant without a fixed host', () => {
    expect(validateConfig(useConfig({ ...SAAS, PORTAL_HOST: 'console.cognipeer.com' })).map((e) => e.key)).toContain('PORTAL_HOST');
    expect(validateConfig(useConfig({ ...SAAS, PORTAL_HOST_TENANT: 'banka' })).map((e) => e.key)).toContain('PORTAL_HOST_TENANT');
  });

  it('accepts a good setup', () => {
    const errors = validateConfig(useConfig({ ...SAAS, PORTAL_HOST: 'asistan.example.com', PORTAL_HOST_TENANT: 'banka' }));
    expect(errors.filter((e) => e.key.startsWith('PORTAL_'))).toEqual([]);
  });
});

describe('matching a request host', () => {
  it('reads the forwarded host first, without the port, lower-case', () => {
    const headers: Record<string, string> = { 'x-forwarded-host': 'Acme.Portal.Cognipeer.com:443, proxy.internal', host: 'pod:3000' };
    expect(requestHostOf((name) => headers[name])).toBe('acme.portal.cognipeer.com');
    expect(requestHostOf((name) => ({ host: 'console.cognipeer.com:3000' } as Record<string, string>)[name])).toBe('console.cognipeer.com');
    expect(requestHostOf(() => undefined)).toBe('');
  });

  it('reads <slug>.<base> as that workspace', () => {
    const cfg = useConfig(SAAS);
    expect(matchPortalHost('acme.portal.cognipeer.com', cfg)).toEqual({ kind: 'tenant', host: 'acme.portal.cognipeer.com', slug: 'acme' });
  });

  it('is not the base domain itself, a deeper name, the Console host or another domain', () => {
    const cfg = useConfig(SAAS);
    expect(matchPortalHost('portal.cognipeer.com', cfg)).toBeNull();
    expect(matchPortalHost('a.b.portal.cognipeer.com', cfg)).toBeNull();
    expect(matchPortalHost('console.cognipeer.com', cfg)).toBeNull();
    expect(matchPortalHost('acme.portal.cognipeer.com.evil.example', cfg)).toBeNull();
    expect(matchPortalHost('evilportal.cognipeer.com', cfg)).toBeNull();
    expect(matchPortalHost('', cfg)).toBeNull();
  });

  it('reads the fixed host as its workspace (or none: the session names it), ahead of the wildcard', () => {
    const named = useConfig({ ...SAAS, PORTAL_HOST: 'x.portal.cognipeer.com', PORTAL_HOST_TENANT: 'banka' });
    expect(matchPortalHost('x.portal.cognipeer.com', named)).toEqual({ kind: 'fixed', host: 'x.portal.cognipeer.com', slug: 'banka' });
    const only = useConfig({ APP_URL: 'https://ai.banka.local', PORTAL_HOST: 'asistan.banka.local' });
    expect(matchPortalHost('asistan.banka.local', only)).toEqual({ kind: 'fixed', host: 'asistan.banka.local', slug: null });
  });
});

describe('addresses', () => {
  it('gives a workspace its fixed host when it serves it, else its wildcard name', () => {
    const cfg = useConfig({ ...SAAS, PORTAL_HOST: 'asistan.example.com', PORTAL_HOST_TENANT: 'banka' });
    expect(portalHostOfTenant('banka', cfg)).toBe('asistan.example.com');
    expect(portalHostOfTenant('Acme', cfg)).toBe('acme.portal.cognipeer.com');
    // A slug that cannot be a host label has no portal host: its portals stay on the Console host.
    expect(portalHostOfTenant('x'.repeat(64), cfg)).toBeNull();
    expect(portalHostOfTenant('-bad-', cfg)).toBeNull();
    expect(portalHostOfTenant('acme', useConfig({ APP_URL: 'https://console.cognipeer.com' }))).toBeNull();
  });

  it('gives every workspace a fixed host that names none, whatever its slug', () => {
    const cfg = useConfig({ APP_URL: 'https://ai.banka.local', PORTAL_HOST: 'asistan.banka.local' });
    expect(portalHostOfTenant('banka', cfg)).toBe('asistan.banka.local');
    expect(portalHostOfTenant('irket-a', cfg)).toBe('asistan.banka.local');
    expect(portalHostOfTenant('', cfg)).toBe('asistan.banka.local');
    // Named for another workspace, and no wildcard: this one stays on the Console host.
    expect(portalHostOfTenant('other', useConfig({ APP_URL: 'https://ai.banka.local', PORTAL_HOST: 'asistan.banka.local', PORTAL_HOST_TENANT: 'banka' }))).toBeNull();
  });

  it('keeps the Console scheme and port, so a local *.portal.localhost works', () => {
    const local = useConfig({ APP_URL: 'http://localhost:3000', PORTAL_BASE_DOMAIN: 'portal.localhost' });
    expect(portalHostOrigin('acme.portal.localhost', local)).toBe('http://acme.portal.localhost:3000');
    const saas = useConfig(SAAS);
    expect(portalHostUrl('acme.portal.cognipeer.com', 'hr-desk', saas)).toBe('https://acme.portal.cognipeer.com/hr-desk');
    expect(portalHostUrl('acme.portal.cognipeer.com', undefined, saas)).toBe('https://acme.portal.cognipeer.com/');
  });
});

describe('paths on a portal host', () => {
  it('shows the chooser at / and a portal at /{key}', () => {
    expect(portalHostPagePath('/')).toBe('/p');
    expect(portalHostPagePath('/hr-desk')).toBe('/p/hr-desk');
    expect(portalHostPagePath('/IK-Destek/')).toBe('/p/ik-destek');
    expect(portalHostPagePath('/api-desk')).toBe('/p/api-desk');
  });

  it('has no other page', () => {
    expect(portalHostPagePath('/dashboard/agents')).toBeNull();
    expect(portalHostPagePath('/hr-desk/extra')).toBeNull();
    // Portal keys are 3 to 48 characters.
    expect(portalHostPagePath('/ik')).toBeNull();
    expect(portalHostPagePath('/ab')).toBeNull();
    expect(portalHostPagePath('/robots.txt')).toBeNull();
    expect(portalHostPagePath('/_x')).toBeNull();
  });

  it('turns a Console portal path into its short form', () => {
    expect(shortPortalPath('/p')).toBe('/');
    expect(shortPortalPath('/p/')).toBe('/');
    expect(shortPortalPath('/p/HR-Desk')).toBe('/hr-desk');
    expect(shortPortalPath('/p/hr-desk/x')).toBeNull();
    expect(shortPortalPath('/pricing')).toBeNull();
  });

  it('answers only the portal runtime and its own sign-in of the API', () => {
    expect(isPortalHostApiPath('/api/portal/hr-desk/info')).toBe(true);
    expect(isPortalHostApiPath('/api/portal/my')).toBe(true);
    expect(isPortalHostApiPath('/api/portal-host/sign-in')).toBe(true);
    expect(isPortalHostApiPath('/api/portals')).toBe(false);
    expect(isPortalHostApiPath('/api/auth/session')).toBe(false);
    expect(isPortalHostApiPath('/api/portal')).toBe(false);
  });
});
