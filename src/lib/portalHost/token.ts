/**
 * The credentials of a portal host (see `./host`): its session, the one-time sign-in code the Console
 * host hands it, and the proof that sends the person back to the Console to end the Console session too.
 *
 * Each is a JWT signed with its own key, DERIVED from JWT_SECRET (HMAC-SHA256 over a fixed label), so
 * none of them is a Console session token: `TokenManager.verifyToken` refuses them, and a Console token
 * is refused here. Each names the host it was made for, and a request on another host is refused.
 *
 * Edge-safe (the middleware imports it): `jose` and Web Crypto only.
 */
import { SignJWT, jwtVerify } from 'jose';
import { getConfig } from '@/lib/core/config';

type Purpose = 'session' | 'code' | 'sign-out';

const ISSUER = 'cognipeer-console';
const audienceOf = (purpose: Purpose) => `portal-host:${purpose}`;

/** A sign-in code is spent by a redirect the browser follows at once. */
export const PORTAL_HOST_CODE_TTL_SECONDS = 60;
/** The way back to the Console to end its session is followed at once too. */
export const PORTAL_HOST_SIGN_OUT_TTL_SECONDS = 120;
/** The sign-in state cookie outlives a slow sign-in (password manager, SSO, a password change). */
export const PORTAL_HOST_STATE_TTL_SECONDS = 15 * 60;

const keys = new Map<string, Promise<Uint8Array>>();

async function deriveKey(secret: string, purpose: Purpose): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const hmac = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived = await crypto.subtle.sign('HMAC', hmac, encoder.encode(`cognipeer/portal-host/${purpose}/v1`));
  return new Uint8Array(derived);
}

function keyFor(purpose: Purpose): Promise<Uint8Array> {
  const secret = getConfig().auth.jwtSecret;
  if (!secret) return Promise.reject(new Error('JWT_SECRET is not defined in environment variables'));
  const cacheKey = `${purpose}\u0000${secret}`;
  let key = keys.get(cacheKey);
  if (!key) {
    key = deriveKey(secret, purpose);
    keys.set(cacheKey, key);
  }
  return key;
}

/** `expiresIn`: seconds from now, or a duration jose reads ("7d"). (A bare number is an absolute `exp` to jose.) */
async function sign(purpose: Purpose, claims: Record<string, unknown>, expiresIn: string | number, jti?: string): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(audienceOf(purpose))
    .setIssuedAt()
    .setExpirationTime(typeof expiresIn === 'number' ? `${expiresIn}s` : expiresIn);
  if (jti) jwt.setJti(jti);
  return jwt.sign(await keyFor(purpose));
}

async function verify(purpose: Purpose, token: string | null | undefined): Promise<Record<string, unknown> | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, await keyFor(purpose), {
      issuer: ISSUER,
      audience: audienceOf(purpose),
      algorithms: ['HS256'],
    });
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** JWT_EXPIRES_IN: a bare number of seconds, or a duration with a unit. */
function sessionLifetime(): string | number {
  const value = getConfig().auth.jwtExpiresIn.trim();
  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : value;
}

// ── The session of a portal host ─────────────────────────────────────────────

export interface PortalHostSession {
  userId: string;
  email: string;
  tenantId: string;
  tenantSlug: string;
  tenantDbName: string;
  /** The portal host the session belongs to. */
  host: string;
}

/** A session for one portal host, as long-lived as a Console session (JWT_EXPIRES_IN). */
export function signPortalHostSession(session: PortalHostSession): Promise<string> {
  return sign('session', {
    sub: session.userId,
    em: session.email,
    tid: session.tenantId,
    tsl: session.tenantSlug,
    tdb: session.tenantDbName,
    hst: session.host,
  }, sessionLifetime());
}

/** The session the cookie carries, when it is good and made for this very host; null otherwise. */
export async function verifyPortalHostSession(token: string | null | undefined, host: string): Promise<PortalHostSession | null> {
  const claims = await verify('session', token);
  if (!claims || !host || text(claims.hst) !== host) return null;
  const session: PortalHostSession = {
    userId: text(claims.sub),
    email: text(claims.em),
    tenantId: text(claims.tid),
    tenantSlug: text(claims.tsl),
    tenantDbName: text(claims.tdb),
    host,
  };
  return session.userId && session.tenantId && session.tenantDbName ? session : null;
}

// ── The one-time sign-in code ────────────────────────────────────────────────

export interface PortalHostCode {
  /** Single use: the redeemer takes it (see the portal host's callback). */
  id: string;
  userId: string;
  tenantId: string;
  /** The portal host it may be redeemed on. */
  host: string;
  /** Where the person was going on that host (a path). */
  path: string;
  /** SHA-256 of the sign-in state the portal host keeps in its own cookie (`hashPortalHostState`). */
  stateHash: string;
  /** Seconds since the epoch. */
  expiresAt: number;
}

export function signPortalHostCode(code: Omit<PortalHostCode, 'expiresAt'>): Promise<string> {
  return sign('code', {
    sub: code.userId,
    tid: code.tenantId,
    hst: code.host,
    pth: code.path,
    sth: code.stateHash,
  }, PORTAL_HOST_CODE_TTL_SECONDS, code.id);
}

export async function verifyPortalHostCode(token: string | null | undefined, host: string): Promise<PortalHostCode | null> {
  const claims = await verify('code', token);
  if (!claims || !host || text(claims.hst) !== host) return null;
  const code: PortalHostCode = {
    id: text(claims.jti),
    userId: text(claims.sub),
    tenantId: text(claims.tid),
    host,
    path: text(claims.pth),
    stateHash: text(claims.sth),
    expiresAt: typeof claims.exp === 'number' ? claims.exp : 0,
  };
  return code.id && code.userId && code.tenantId && code.stateHash && code.expiresAt ? code : null;
}

// ── Ending the Console session after the portal host's ───────────────────────

export interface PortalHostSignOut {
  /** Only this person's Console session is ended. */
  userId: string;
  /** The portal host the person comes back to. */
  host: string;
}

export function signPortalHostSignOut(signOut: PortalHostSignOut): Promise<string> {
  return sign('sign-out', { sub: signOut.userId, hst: signOut.host }, PORTAL_HOST_SIGN_OUT_TTL_SECONDS);
}

/** The sign-out proof, when it is good (the Console host checks the host it names is a portal host). */
export async function verifyPortalHostSignOut(token: string | null | undefined): Promise<PortalHostSignOut | null> {
  const claims = await verify('sign-out', token);
  if (!claims) return null;
  const signOut = { userId: text(claims.sub), host: text(claims.hst) };
  return signOut.userId && signOut.host ? signOut : null;
}

// ── State and cookies ────────────────────────────────────────────────────────

/** 256 random bits, base64url: the sign-in state and a code's id. */
export function randomPortalHostToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 of the sign-in state, hex: the code carries this, never the state itself. */
export async function hashPortalHostState(state: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison of two strings of the same alphabet. */
export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Whether the portal host's cookies are Secure (production, like the Console's own). Secure cookies
 * also take the `__Host-` prefix: no Domain attribute, path `/`, so a sibling host cannot plant one.
 */
export function portalHostCookiesSecure(): boolean {
  return getConfig().nodeEnv === 'production';
}

export function portalHostSessionCookieName(): string {
  return portalHostCookiesSecure() ? '__Host-cp_portal_session' : 'cp_portal_session';
}

export function portalHostStateCookieName(): string {
  return portalHostCookiesSecure() ? '__Host-cp_portal_state' : 'cp_portal_state';
}
