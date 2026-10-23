import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SignJWT, decodeJwt } from 'jose';
import { getConfigSource, setConfigSource } from '@/lib/core/config';
import { TokenManager } from '@/lib/license/token-manager';
import {
  hashPortalHostState,
  portalHostSessionCookieName,
  portalHostStateCookieName,
  randomPortalHostToken,
  sameText,
  signPortalHostCode,
  signPortalHostSession,
  signPortalHostSignOut,
  verifyPortalHostCode,
  verifyPortalHostSession,
  verifyPortalHostSignOut,
} from '@/lib/portalHost/token';

const originalSource = getConfigSource();
const SECRET = 's'.repeat(40);

function useEnv(values: Record<string, string>) {
  setConfigSource({ name: 'test', get: (key) => values[key] });
}

const session = {
  userId: 'u1',
  email: 'user@acme.test',
  tenantId: 't1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  host: 'acme.portal.cognipeer.com',
};

beforeEach(() => {
  useEnv({ JWT_SECRET: SECRET, JWT_EXPIRES_IN: '7d' });
});

afterEach(() => {
  setConfigSource(originalSource);
});

describe('the session of a portal host', () => {
  it('round-trips on its own host', async () => {
    const token = await signPortalHostSession(session);
    expect(await verifyPortalHostSession(token, session.host)).toEqual(session);
    const claims = decodeJwt(token);
    expect(claims.aud).toBe('portal-host:session');
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(7 * 24 * 3600);
  });

  it('is refused on any other host', async () => {
    const token = await signPortalHostSession(session);
    expect(await verifyPortalHostSession(token, 'other.portal.cognipeer.com')).toBeNull();
    expect(await verifyPortalHostSession(token, '')).toBeNull();
  });

  it('is never a Console session, and a Console session is never one', async () => {
    const portalToken = await signPortalHostSession(session);
    expect(await TokenManager.verifyToken(portalToken)).toBeNull();

    const consoleToken = await TokenManager.generateToken({
      userId: 'u1', email: 'user@acme.test', tenantId: 't1', tenantSlug: 'acme', tenantDbName: 'tenant_acme',
      role: 'user', licenseId: 'FREE', licenseType: 'FREE' as never, features: [],
    });
    expect(await verifyPortalHostSession(consoleToken, session.host)).toBeNull();
  });

  it('is refused when signed with the base secret even with the right claims', async () => {
    const forged = await new SignJWT({ sub: 'u1', tid: 't1', tdb: 'tenant_acme', hst: session.host })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('cognipeer-console')
      .setAudience('portal-host:session')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET));
    expect(await verifyPortalHostSession(forged, session.host)).toBeNull();
  });

  it('is refused under another secret, and when garbage or missing', async () => {
    const token = await signPortalHostSession(session);
    useEnv({ JWT_SECRET: 'z'.repeat(40), JWT_EXPIRES_IN: '7d' });
    expect(await verifyPortalHostSession(token, session.host)).toBeNull();
    expect(await verifyPortalHostSession('not-a-jwt', session.host)).toBeNull();
    expect(await verifyPortalHostSession(undefined, session.host)).toBeNull();
  });
});

describe('the sign-in code', () => {
  it('round-trips on its host only, and is not a session', async () => {
    const code = await signPortalHostCode({ id: 'jti-1', userId: 'u1', tenantId: 't1', host: session.host, path: '/ik?agent=a', stateHash: 'abc' });
    const read = await verifyPortalHostCode(code, session.host);
    expect(read).toMatchObject({ id: 'jti-1', userId: 'u1', tenantId: 't1', host: session.host, path: '/ik?agent=a', stateHash: 'abc' });
    expect((read?.expiresAt ?? 0) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60);
    expect(await verifyPortalHostCode(code, 'other.portal.cognipeer.com')).toBeNull();
    expect(await verifyPortalHostSession(code, session.host)).toBeNull();
  });

  it('cannot be read as a code when it is a session', async () => {
    expect(await verifyPortalHostCode(await signPortalHostSession(session), session.host)).toBeNull();
  });
});

describe('the way back to end the Console session', () => {
  it('round-trips and is neither a session nor a code', async () => {
    const proof = await signPortalHostSignOut({ userId: 'u1', host: session.host });
    expect(await verifyPortalHostSignOut(proof)).toEqual({ userId: 'u1', host: session.host });
    expect(await verifyPortalHostSession(proof, session.host)).toBeNull();
    expect(await verifyPortalHostCode(proof, session.host)).toBeNull();
    expect(await verifyPortalHostSignOut(await signPortalHostSession(session))).toBeNull();
  });
});

describe('state and cookies', () => {
  it('makes 256-bit url-safe tokens and hashes them', async () => {
    const a = randomPortalHostToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomPortalHostToken()).not.toBe(a);
    expect(await hashPortalHostState('x')).toBe('2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
    expect(sameText('abc', 'abc')).toBe(true);
    expect(sameText('abc', 'abd')).toBe(false);
    expect(sameText('abc', 'ab')).toBe(false);
  });

  it('reads a bare JWT_EXPIRES_IN as seconds from now (jose would read a number as an absolute exp)', async () => {
    useEnv({ JWT_SECRET: SECRET, JWT_EXPIRES_IN: '3600' });
    const claims = decodeJwt(await signPortalHostSession(session));
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(3600);
  });

  it('uses __Host- cookies in production only', () => {
    expect(portalHostSessionCookieName()).toBe('cp_portal_session');
    expect(portalHostStateCookieName()).toBe('cp_portal_state');
    useEnv({ JWT_SECRET: SECRET, NODE_ENV: 'production' });
    expect(portalHostSessionCookieName()).toBe('__Host-cp_portal_session');
    expect(portalHostStateCookieName()).toBe('__Host-cp_portal_state');
  });
});
