/**
 * Model of the account page ("My account"): the signed-in person as
 * `GET /api/auth/me` describes them, what they may change themselves, and the
 * client-side hints of the password rules (the server enforces the same rules).
 *
 * Pure: no React, no Next, no server imports beyond the shared identity facts.
 */

import { isDirectoryManaged, providerOf } from '@/lib/iam/identity';

export interface AccountMe {
  userId: string;
  name: string;
  email: string;
  role: string;
  /** local, ldap, oidc or saml. */
  authProvider: string;
  /** A service account cannot sign in (it never reaches this page, but the payload says it). */
  canLogin: boolean;
  /** The person can change their own password here (a local account that can sign in). */
  canChangePassword: boolean;
  /** Fields a directory keeps: name, email, password. */
  managedFields: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The payload of `GET /api/auth/me`; null when it is not one. */
export function parseMe(raw: unknown): AccountMe | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const userId = str(r.userId);
  if (!userId) return null;
  const authProvider = providerOf({ authProvider: r.authProvider });
  const managed = isDirectoryManaged({ authProvider });
  const canLogin = r.canLogin !== false;
  return {
    userId,
    name: str(r.name),
    email: str(r.email),
    role: str(r.role) || 'user',
    authProvider,
    canLogin,
    // Trust the server's word; without one, a local account that can sign in may change its password.
    canChangePassword: typeof r.canChangePassword === 'boolean' ? r.canChangePassword : !managed && canLogin,
    managedFields: Array.isArray(r.managedFields)
      ? r.managedFields.filter((x): x is string => typeof x === 'string')
      : managed
        ? ['name', 'email', 'password']
        : [],
  };
}

/** The account's name and email are kept in a directory (LDAP, SSO): read-only. */
export function isManaged(me: AccountMe): boolean {
  return isDirectoryManaged({ authProvider: me.authProvider }) || me.managedFields.includes('name');
}

export const NAME_MIN = 2;
export const NAME_MAX = 120;

export function nameProblem(name: string): 'length' | null {
  const n = name.trim().length;
  return n >= NAME_MIN && n <= NAME_MAX ? null : 'length';
}

/** What the person may save: the trimmed name when it changed and is valid, else null. */
export function profileChange(me: AccountMe, draftName: string): { name: string } | null {
  const name = draftName.trim();
  return nameProblem(name) === null && name !== me.name ? { name } : null;
}

// ── password ──────────────────────────────────────────────────────────────

export const PASSWORD_RULES = ['length', 'upper', 'lower', 'digit', 'special'] as const;
export type PasswordRule = (typeof PASSWORD_RULES)[number];

/** The rules of `services/auth/passwordPolicy.ts`, as the ones the candidate does not meet yet. */
export function passwordProblems(candidate: string): PasswordRule[] {
  const missing: PasswordRule[] = [];
  if (candidate.length < 8) missing.push('length');
  if (!/[A-Z]/.test(candidate)) missing.push('upper');
  if (!/[a-z]/.test(candidate)) missing.push('lower');
  if (!/[0-9]/.test(candidate)) missing.push('digit');
  if (!/[^A-Za-z0-9]/.test(candidate)) missing.push('special');
  return missing;
}

export interface PasswordForm {
  current: string;
  next: string;
  confirm: string;
}

export type PasswordIssue = 'currentRequired' | 'weak' | 'mismatch';

/** The first thing wrong with the form, or null when it can be sent. */
export function passwordIssue(form: PasswordForm): PasswordIssue | null {
  if (!form.current) return 'currentRequired';
  if (passwordProblems(form.next).length > 0) return 'weak';
  if (form.next !== form.confirm) return 'mismatch';
  return null;
}

/** Why the password form is not offered (null = it is). */
export function passwordUnavailable(me: AccountMe): 'managed' | 'service' | null {
  if (!me.canLogin) return 'service';
  if (me.canChangePassword) return null;
  return 'managed';
}
