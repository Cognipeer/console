/**
 * The one place an EXTERNAL account is made: a person of a host application, known only by the identity a trusted issuer
 * vouches for (`externalIds[issuer] = subject`). It cannot sign in to the dashboard (no password, `canLogin: false`), owns
 * no API tokens, is always the User role and belongs to no project.
 *
 * Two callers make one - the just-in-time path of `delegatedIdentity.ts` (first verified assertion of an unknown person)
 * and an administrator adding one by hand (`POST /api/users/external`) - and they must produce the same account, so both go
 * through `createExternalAccount`. Quota, duplicate and audit handling stay with the callers: they differ per path.
 */

import type { DatabaseProvider, IUser } from '@/lib/database';

/** Not a hash of anything: no password can ever match it, so the account cannot sign in by password. */
export const DELEGATED_PASSWORD_PLACEHOLDER = '!delegated-identity';

/** What an account created for a verified identity has in common, whatever its kind. */
export function delegatedAccountBase(input: { tenantId: string; issuer: string; subject: string; licenseId?: string }) {
  return {
    tenantId: input.tenantId,
    password: DELEGATED_PASSWORD_PLACEHOLDER,
    role: 'user' as const,
    licenseId: input.licenseId ?? 'FREE',
    features: [] as string[],
    mustChangePassword: false,
    externalIds: { [input.issuer]: input.subject },
  };
}

export interface CreateExternalAccountInput {
  tenantId: string;
  issuer: string;
  subject: string;
  /** The workspace's licence type (the account carries it like every other account of the workspace). */
  licenseId?: string;
  email?: string;
  name?: string;
}

export async function createExternalAccount(db: DatabaseProvider, input: CreateExternalAccountInput): Promise<IUser> {
  const { subject, email, name } = input;
  return db.createUser({
    ...delegatedAccountBase(input),
    email: email ?? '',
    name: name ?? email ?? subject,
    authProvider: 'local',
    canLogin: false,
    kind: 'external',
  });
}
