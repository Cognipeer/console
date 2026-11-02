/**
 * Principal keys of Knowledge Engine permissions.
 *
 * A permission entry names WHO may read a node (the module root, a folder, a
 * document) as one canonical string, so a lookup is a plain equality match on
 * an indexed field and nothing has to be resolved while a query runs:
 *
 *   everyone                 anyone who passed the module-level gate
 *   user:<consoleUserId>     a console user
 *   group:<consoleGroupId>   a console group (any source)
 *   token:<apiTokenId>       an API token, for calls without a person
 *   email:<address>          a console person whose stored e-mail is this (lower-cased)
 *   x:<domain>:u:<id>        a user of an external identity domain
 *   x:<domain>:g:<id>        a group of an external identity domain
 *   x:<domain>:all           every member (not guest) user of an external identity domain
 *
 * A caller's principal set (identity.ts) is built from the same functions, so a
 * key written by an integration and a key derived from a person always agree.
 */

export const EVERYONE_PRINCIPAL = 'everyone';
export const MAX_PRINCIPAL_LENGTH = 512;
export const MAX_ACL_ENTRIES_PER_NODE = 1000;
export const MAX_ACL_LABEL_LENGTH = 200;

const DOMAIN_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type RagPrincipal =
  | { kind: 'everyone' }
  | { kind: 'user'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'token'; id: string }
  | { kind: 'email'; email: string }
  | { kind: 'external_user'; domain: string; id: string }
  | { kind: 'external_group'; domain: string; id: string }
  | { kind: 'external_all'; domain: string };

export type RagPrincipalKind = RagPrincipal['kind'];

/** Whether `key` can name an identity domain (it appears inside principal keys). */
export function isValidIdentityDomainKey(key: unknown): key is string {
  return typeof key === 'string' && DOMAIN_KEY_RE.test(key);
}

function cleanId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value || CONTROL_RE.test(trimmed)) return null;
  return trimmed;
}

/** The canonical (lower-cased) form of an e-mail address, or null when it does not look like one. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  if (!lower || CONTROL_RE.test(lower) || !EMAIL_RE.test(lower)) return null;
  return lower;
}

function bounded(key: string): string | null {
  return key.length <= MAX_PRINCIPAL_LENGTH ? key : null;
}

export function userPrincipal(userId: string): string {
  return `user:${userId}`;
}

export function groupPrincipal(groupId: string): string {
  return `group:${groupId}`;
}

export function tokenPrincipal(tokenId: string): string {
  return `token:${tokenId}`;
}

/** `email:<address>`; the address is lower-cased. Null when it is not an e-mail address. */
export function emailPrincipal(email: string): string | null {
  const normalized = normalizeEmail(email);
  return normalized ? bounded(`email:${normalized}`) : null;
}

export function externalUserPrincipal(domain: string, externalId: string): string {
  return `x:${domain}:u:${externalId}`;
}

export function externalGroupPrincipal(domain: string, externalId: string): string {
  return `x:${domain}:g:${externalId}`;
}

export function externalAllPrincipal(domain: string): string {
  return `x:${domain}:all`;
}

/** The canonical key of a principal, or null when one of its parts is not acceptable. */
export function formatPrincipal(principal: RagPrincipal): string | null {
  switch (principal.kind) {
    case 'everyone':
      return EVERYONE_PRINCIPAL;
    case 'email':
      return emailPrincipal(principal.email);
    case 'user':
    case 'group':
    case 'token': {
      const id = cleanId(principal.id);
      if (!id) return null;
      return bounded(`${principal.kind}:${id}`);
    }
    case 'external_user':
    case 'external_group': {
      if (!isValidIdentityDomainKey(principal.domain)) return null;
      const id = cleanId(principal.id);
      if (!id) return null;
      return bounded(principal.kind === 'external_user'
        ? externalUserPrincipal(principal.domain, id)
        : externalGroupPrincipal(principal.domain, id));
    }
    case 'external_all':
      return isValidIdentityDomainKey(principal.domain) ? externalAllPrincipal(principal.domain) : null;
    default:
      return null;
  }
}

/**
 * Parse a stored or submitted key. Strict: anything that is not exactly one of
 * the shapes above (wrong prefix, bad domain, blank or padded id, too long) is
 * null. E-mail keys are accepted in any case and come back lower-cased by
 * `normalizePrincipal`.
 */
export function parsePrincipal(key: unknown): RagPrincipal | null {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_PRINCIPAL_LENGTH) return null;
  if (key === EVERYONE_PRINCIPAL) return { kind: 'everyone' };

  const colon = key.indexOf(':');
  if (colon <= 0) return null;
  const prefix = key.slice(0, colon);
  const rest = key.slice(colon + 1);

  switch (prefix) {
    case 'user':
    case 'group':
    case 'token': {
      const id = cleanId(rest);
      return id ? { kind: prefix, id } : null;
    }
    case 'email': {
      const email = normalizeEmail(rest);
      return email ? { kind: 'email', email } : null;
    }
    case 'x': {
      // A domain key has no ':', so the first one ends it; the external id may contain any.
      const sep = rest.indexOf(':');
      if (sep <= 0) return null;
      const domain = rest.slice(0, sep);
      if (!isValidIdentityDomainKey(domain)) return null;
      const tail = rest.slice(sep + 1);
      if (tail === 'all') return { kind: 'external_all', domain };
      if (tail.startsWith('u:') || tail.startsWith('g:')) {
        const id = cleanId(tail.slice(2));
        if (!id) return null;
        return tail[0] === 'u' ? { kind: 'external_user', domain, id } : { kind: 'external_group', domain, id };
      }
      return null;
    }
    default:
      return null;
  }
}

/** The canonical form of a key (e-mail lower-cased), or null when it is not a valid key. */
export function normalizePrincipal(key: unknown): string | null {
  const parsed = parsePrincipal(key);
  return parsed ? formatPrincipal(parsed) : null;
}

/** The identity domain a key belongs to, when it is an external key. */
export function principalDomain(principal: RagPrincipal): string | undefined {
  return principal.kind === 'external_user' || principal.kind === 'external_group' || principal.kind === 'external_all'
    ? principal.domain
    : undefined;
}

/** Trim a display label to what an entry stores; empty means none. */
export function cleanAclLabel(label: unknown): string | undefined {
  if (typeof label !== 'string') return undefined;
  const flat = label.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > MAX_ACL_LABEL_LENGTH ? flat.slice(0, MAX_ACL_LABEL_LENGTH) : flat;
}
