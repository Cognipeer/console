/**
 * External authentication seam — COMMUNITY (open-source) edition.
 *
 * A single, dependency-light hook that lets the enterprise overlay (or any
 * pluggable identity backend — LDAP today, SAML/OIDC later) take over
 * credential verification during `/auth/login` WITHOUT the community core
 * depending on any enterprise code.
 *
 * Contract:
 *   • Nothing is registered in the community edition → `tryExternalAuthenticate`
 *     always returns `{ outcome: 'skip' }` and the login handler falls back to
 *     the normal email + bcrypt path. The FREE product is unchanged.
 *   • The enterprise overlay calls `registerExternalAuthenticator(fn)` at boot
 *     (from its `registry.ts`) to wire the real authenticator. It is a separate
 *     community file (NOT replaced by the overlay), so the `registry.ts` seam
 *     shape — and `ee/COMPAT.json.seamContractVersion` — stay unchanged.
 *
 * An authenticator returns one of three outcomes:
 *   • `pass` — the caller was authenticated externally; `user` is the local
 *     (just-in-time provisioned / synced) record to issue a session for.
 *   • `fail` — external auth was attempted for this tenant and REJECTED. The
 *     login handler must return 401 and NOT fall through to local password.
 *   • `skip` — no external provider applies (not configured / not licensed);
 *     fall back to the local email + bcrypt path.
 */

import type { ITenant, IUser } from '@/lib/database';

export interface ExternalAuthParams {
  /** Normalised (lower-cased, trimmed) login identifier — usually the email. */
  email: string;
  /** The raw password the user supplied (verified against the directory). */
  password: string;
  /** The tenant the login is scoped to. */
  tenant: ITenant;
}

export type ExternalAuthResult =
  | { outcome: 'pass'; user: IUser }
  | { outcome: 'fail'; reason?: string }
  | { outcome: 'skip' };

export type ExternalAuthenticator = (
  params: ExternalAuthParams,
) => Promise<ExternalAuthResult>;

let registered: ExternalAuthenticator | null = null;

/**
 * Register the external authenticator. Called once at boot by the enterprise
 * overlay. Passing `null` clears it (used by tests).
 */
export function registerExternalAuthenticator(fn: ExternalAuthenticator | null): void {
  registered = fn;
}

/** True when an external authenticator has been wired (enterprise build). */
export function hasExternalAuthenticator(): boolean {
  return registered !== null;
}

/**
 * Run the registered external authenticator, or return `skip` when none is
 * wired. Never throws for the "not configured" case — a thrown authenticator is
 * the caller's responsibility to catch and treat as a server error.
 */
export async function tryExternalAuthenticate(
  params: ExternalAuthParams,
): Promise<ExternalAuthResult> {
  if (!registered) return { outcome: 'skip' };
  return registered(params);
}
