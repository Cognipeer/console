/**
 * The client API's "acting for a user" step: what a call that carries `X-Cognipeer-User-Token` becomes.
 *
 * An application authenticates with its API token as always, and says WHO the call is for by sending a signed
 * statement (an identity assertion) in the header. This module turns the pair into the person the rest of the request
 * runs as:
 *
 *   header absent                 not a delegated call: nothing here applies (null).
 *   header absent, token requires one
 *                                 401 `user_token_required`. A token flagged `requireUserToken` is only ever served on behalf of
 *                                 a verified person: with no statement the call is refused, never answered as the token's owner.
 *                                 A flagged token whose delegation is missing or switched off refuses every call
 *                                 (`delegation_not_enabled`) - the requirement outlives the configuration it depends on.
 *   header present, not enabled   401 `delegation_not_enabled` - the token has no delegation, or it is switched off.
 *                                 NEVER answered as the token's owner: a caller that sent a user token wants that
 *                                 user's access or none.
 *   assertion refused             401 with the code of `IdentityAssertionError` (`invalid_assertion`, `expired`,
 *                                 `untrusted_key`; `replayed` cannot occur: a user token is reused across calls).
 *   person not resolved           401 with the code of `DelegatedIdentityError` (`unknown_principal`, `disabled`,
 *                                 `seat_limit`, `conflict`).
 *   an owner, or an administrator the configuration does not admit
 *                                 403 `delegation_refused`. The workspace owner is never let in through a token; an
 *                                 owner-level or admin account (also by a group that grants the role) only when the
 *                                 administrator who set the delegation up said so (`allowPrivileged`). The rule is
 *                                 applied BEFORE anything is written for the account (no link to the statement's
 *                                 subject, no group changes), so a refused call leaves the account as it was.
 *   a person who could not open the token's project
 *                                 403 `project_not_accessible`. The call runs in the project the application token is
 *                                 bound to, and the person must be able to open that project themselves - the rule a
 *                                 dashboard session applies (`resolveProjectContext`): a project of their own or of one of
 *                                 their groups (for an external account, a delegated group that was given the project),
 *                                 any project for an owner or administrator. The token's own grant was checked for its
 *                                 owner when it was minted, which says nothing about the people it later acts for.
 *   the stores cannot answer      503 `delegation_unavailable` (retry later), never an allow.
 *
 * Every refusal carries a decision id (a fresh UUID, also in the audit row and in `X-Decision-Id`), so a caller can quote
 * it to the administrator who then finds the row.
 *
 * What the request becomes when it succeeds is decided by the caller (fastify-utils.ts): the person is the principal,
 * capped by the app token's scope and project, and the app token stays the actor.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope, type IUser } from '@/lib/database';
import { ProjectContextError, resolveProjectContext } from '@/lib/services/projects/projectContext';
import { getPrincipalContext } from './principalCache';
import { IdentityAssertionError, verifyIdentityAssertion, type IdentityAssertionErrorCode } from './identityAssertion';
import {
  DelegatedAccountRefusal,
  DelegatedIdentityError,
  resolveDelegatedPrincipal,
  type DelegatedIdentityErrorCode,
  type DelegatedPrincipalKind,
} from './delegatedIdentity';
import { getTokenDelegation } from './tokenDelegation';

const logger = createLogger('iam:delegation-gate');

/** The header an application sends the signed statement about the person in (compared lower-case). */
export const USER_TOKEN_HEADER = 'x-cognipeer-user-token';
export const USER_TOKEN_HEADER_NAME = 'X-Cognipeer-User-Token';

export type DelegationErrorCode =
  | 'delegation_not_enabled'
  | 'user_token_required'
  | IdentityAssertionErrorCode
  | DelegatedIdentityErrorCode
  | 'delegation_refused'
  | 'project_not_accessible'
  | 'delegation_unavailable';

export class DelegationError extends Error {
  readonly code: DelegationErrorCode;
  readonly status: 401 | 403 | 503;
  readonly decisionId: string;
  /** The issuer of the assertion, once it verified (for the audit row). */
  readonly issuer?: string;
  /** The subject of the assertion, once it verified (for the audit row). */
  readonly subject?: string;

  constructor(code: DelegationErrorCode, message: string, options: { status?: 401 | 403 | 503; issuer?: string; subject?: string } = {}) {
    super(message);
    this.name = 'DelegationError';
    this.code = code;
    this.status = options.status
      ?? (code === 'delegation_refused' || code === 'project_not_accessible' ? 403 : code === 'delegation_unavailable' ? 503 : 401);
    this.decisionId = randomUUID();
    this.issuer = options.issuer;
    this.subject = options.subject;
  }
}

/** The person a delegated call is for. */
export interface DelegatedCaller {
  user: IUser;
  kind: DelegatedPrincipalKind;
  issuer: string;
  subject: string;
  /** True when this call created the account. */
  created: boolean;
}

export type PrivilegeLevel = 'owner' | 'admin' | null;

/** The workspace-level power an account has: its role, and the role any of its groups grants. (Also asked by the portal embed's guard, portalIdentityGuard.ts.) */
export async function privilegeOf(user: IUser, tenantDbName: string, tenantId: string): Promise<PrivilegeLevel> {
  if (user.role === 'owner') return 'owner';
  let level: PrivilegeLevel = user.role === 'admin' ? 'admin' : null;
  const context = await getPrincipalContext({ tenantDbName, tenantId, userId: String(user._id), user });
  for (const grant of context.groupGrants) {
    if (grant.tenantRole === 'owner') return 'owner';
    if (grant.tenantRole === 'admin') level = 'admin';
  }
  return level;
}

/** What the project check throws for a person who cannot open the project of the call (answered as `project_not_accessible`). */
class DelegatedProjectRefusal extends Error {
  constructor() {
    super('This person has no access to the project this API token is bound to');
    this.name = 'DelegatedProjectRefusal';
  }
}

/** The compact token out of a header value (`Bearer ` in front is allowed, as for the API token). */
function tokenFromHeader(value: string): string {
  const trimmed = value.trim();
  return /^bearer\s+/i.test(trimmed) ? trimmed.replace(/^bearer\s+/i, '').trim() : trimmed;
}

export interface ResolveDelegatedCallerInput {
  /** The raw header (undefined = not sent). */
  headerValue: string | string[] | undefined;
  /** The API token that made the call. */
  tokenId: string | undefined;
  tenantDbName: string;
  tenantId: string;
  /** The project the call runs in: the one the API token is bound to (its default project when it names none). */
  projectId: string;
  /** The token's `requireUserToken`: a call without the header is refused instead of answered as the token's owner. */
  requireUserToken?: boolean;
}

/**
 * Who is a call FOR? `null` when it carries no user token. Throws {@link DelegationError} for every refusal, and for the
 * stores being unreadable (fail closed).
 */
export async function resolveDelegatedCaller(input: ResolveDelegatedCallerInput): Promise<DelegatedCaller | null> {
  if (input.headerValue === undefined) {
    if (input.requireUserToken === true) {
      throw new DelegationError('user_token_required', `This API token only acts for users: send the user token in ${USER_TOKEN_HEADER_NAME}, or as "<api token>~<user token>" in Authorization`);
    }
    return null;
  }
  const { tenantDbName, tenantId } = input;

  // One header, one statement. Two of them are ambiguous and are not guessed at.
  if (typeof input.headerValue !== 'string') {
    throw new DelegationError('invalid_assertion', `Send the user token in a single ${USER_TOKEN_HEADER_NAME} header`);
  }

  let stored: Awaited<ReturnType<typeof getTokenDelegation>>;
  try {
    stored = input.tokenId ? await getTokenDelegation(tenantDbName, input.tokenId) : null;
  } catch (error) {
    logger.error('The delegation of an API token could not be read; the call is refused', {
      tenantDbName, tokenId: input.tokenId, error: error instanceof Error ? error.message : String(error),
    });
    throw new DelegationError('delegation_unavailable', 'Acting for users is temporarily unavailable');
  }
  if (!stored || !stored.config.enabled) {
    throw new DelegationError('delegation_not_enabled', 'This API token is not set up to act for users');
  }
  const { config } = stored;

  let assertion: Awaited<ReturnType<typeof verifyIdentityAssertion>>;
  try {
    assertion = await verifyIdentityAssertion({ token: tokenFromHeader(input.headerValue), trust: config.trust });
  } catch (error) {
    if (error instanceof IdentityAssertionError) throw new DelegationError(error.code, error.message);
    logger.error('Unexpected error while verifying an identity assertion', { error: error instanceof Error ? error.message : String(error) });
    throw new DelegationError('delegation_unavailable', 'Acting for users is temporarily unavailable');
  }

  /** The workspace owner is never let in; an administrator (also through a group that grants the role) only when the configuration says so. */
  const refusePrivileged = async (account: IUser): Promise<void> => {
    const privilege = await privilegeOf(account, tenantDbName, tenantId);
    if (privilege === 'owner') throw new DelegatedAccountRefusal('An API token cannot act for the workspace owner');
    if (privilege === 'admin' && !config.allowPrivileged) throw new DelegatedAccountRefusal('This API token is not allowed to act for administrators');
  };

  /**
   * The call runs in the project of the application token, and the person must be able to open it themselves, as in the
   * dashboard. `resolveProjectContext` answers with ANOTHER project of theirs when the one asked for is not theirs (and throws
   * when they have none), so the project it returns is compared with the token's.
   */
  const requireProjectAccess = async (account: IUser): Promise<void> => {
    let opened: string;
    try {
      const context = await runWithTenantScope(tenantDbName, () => resolveProjectContext({
        tenantDbName, tenantId, userId: String(account._id), activeProjectId: input.projectId,
      }));
      opened = String(context.projectId);
    } catch (error) {
      // A 4xx says the person cannot open it (no project assigned, not theirs, no such project); anything else is the stores failing.
      if (error instanceof ProjectContextError && error.status < 500) throw new DelegatedProjectRefusal();
      throw error;
    }
    if (opened !== String(input.projectId)) throw new DelegatedProjectRefusal();
  };

  let principal: Awaited<ReturnType<typeof resolveDelegatedPrincipal>>;
  try {
    principal = await resolveDelegatedPrincipal({
      tenantDbName,
      tenantId,
      issuer: assertion.issuer,
      subject: assertion.subject,
      email: assertion.email,
      emailVerified: assertion.emailVerified,
      name: assertion.name,
      groups: assertion.groups,
      mapping: config.mapping,
      // Asked with every account that already existed, before anything is written for it (a link, its groups).
      accountGuard: { key: config.allowPrivileged ? 'privileged-allowed' : 'privileged-refused', check: refusePrivileged },
    });
    // The decision the call rests on, taken again on the account that is returned (one that was just created included).
    // The roles are cached by now, so this costs no read.
    await refusePrivileged(principal.user);
    // After the groups were brought in step with the statement: an external account reaches a project only through them.
    await requireProjectAccess(principal.user);
  } catch (error) {
    // (a new error per request: concurrent calls may have shared one resolution, but never a decision id)
    if (error instanceof DelegatedAccountRefusal) {
      throw new DelegationError('delegation_refused', error.message, { issuer: assertion.issuer, subject: assertion.subject });
    }
    if (error instanceof DelegatedProjectRefusal) {
      throw new DelegationError('project_not_accessible', error.message, { issuer: assertion.issuer, subject: assertion.subject });
    }
    if (error instanceof DelegatedIdentityError) {
      throw new DelegationError(error.code, error.message, { issuer: assertion.issuer, subject: assertion.subject });
    }
    logger.error('The person of an identity assertion could not be resolved; the call is refused', {
      tenantDbName, issuer: assertion.issuer, error: error instanceof Error ? error.message : String(error),
    });
    throw new DelegationError('delegation_unavailable', 'Acting for users is temporarily unavailable', { issuer: assertion.issuer, subject: assertion.subject });
  }

  return { user: principal.user, kind: principal.kind, issuer: assertion.issuer, subject: assertion.subject, created: principal.created };
}
