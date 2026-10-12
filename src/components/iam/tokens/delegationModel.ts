/**
 * The form of "acting for users" on an API token, as data: what the server returns, what the screen edits, what it sends back.
 * Pure (no React, no fetch) so the rules a screen follows are tested without rendering it. The server checks everything again
 * (lib/iam/tokenDelegation.ts); these checks only keep the obvious mistakes off the wire and say what is wrong next to the field.
 */

export const DELEGATION_ALGORITHMS = ['HS256', 'RS256', 'ES256'] as const;
export type DelegationAlgorithm = (typeof DELEGATION_ALGORITHMS)[number];
export const DELEGATION_JIT_MODES = ['none', 'person', 'external'] as const;
export type DelegationJit = (typeof DELEGATION_JIT_MODES)[number];

/** Shared secrets are at least this long (the same bound the server enforces). */
export const MIN_SECRET_LENGTH = 32;
const KID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export interface DelegationGroupMapEntry {
  idpGroup: string;
  consoleGroupName: string;
}

/** `GET /api/tokens/:id/delegation` -> `delegation`. */
export interface DelegationView {
  tokenId: string;
  enabled: boolean;
  trust: {
    issuer: string;
    audience: string | string[];
    algorithms: DelegationAlgorithm[];
    keys: { hsSecrets?: Array<{ kid: string }>; pem?: string; jwksUrl?: string };
    maxTokenAgeSeconds?: number;
    clockSkewSeconds?: number;
  };
  mapping: { matchBy: Array<'externalId' | 'verifiedEmail'>; jit: DelegationJit; groupMap?: DelegationGroupMapEntry[] };
  allowPrivileged: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface DelegationSecretRow {
  kid: string;
  /** What was typed; empty keeps the stored secret of this key id. */
  secret: string;
  /** The server already holds a secret for this key id. */
  stored: boolean;
}

export interface DelegationForm {
  enabled: boolean;
  issuer: string;
  /** One audience per line or comma separated. */
  audience: string;
  algorithms: DelegationAlgorithm[];
  secrets: DelegationSecretRow[];
  jwksUrl: string;
  pem: string;
  maxTokenAgeSeconds: string;
  clockSkewSeconds: string;
  matchIdentity: boolean;
  matchEmail: boolean;
  jit: DelegationJit;
  /** `identity provider group => console group` per line. */
  groupMapText: string;
  allowPrivileged: boolean;
}

export function emptyDelegationForm(): DelegationForm {
  return {
    enabled: true,
    issuer: '',
    audience: '',
    algorithms: ['RS256'],
    secrets: [],
    jwksUrl: '',
    pem: '',
    maxTokenAgeSeconds: '',
    clockSkewSeconds: '',
    matchIdentity: true,
    matchEmail: true,
    jit: 'none',
    groupMapText: '',
    allowPrivileged: false,
  };
}

// ── group map text ───────────────────────────────────────────────────────

const GROUP_MAP_SEPARATOR = '=>';

export function formatGroupMap(entries: readonly DelegationGroupMapEntry[] | undefined): string {
  return (entries ?? []).map((entry) => `${entry.idpGroup} ${GROUP_MAP_SEPARATOR} ${entry.consoleGroupName}`).join('\n');
}

export interface ParsedGroupMap {
  entries: DelegationGroupMapEntry[];
  /** 1-based line numbers that are not `a => b`. */
  badLines: number[];
  duplicates: string[];
}

export function parseGroupMapText(text: string): ParsedGroupMap {
  const entries: DelegationGroupMapEntry[] = [];
  const badLines: number[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const at = line.indexOf(GROUP_MAP_SEPARATOR);
    const idpGroup = at < 0 ? '' : line.slice(0, at).trim();
    const consoleGroupName = at < 0 ? '' : line.slice(at + GROUP_MAP_SEPARATOR.length).trim();
    if (!idpGroup || !consoleGroupName) {
      badLines.push(index + 1);
      return;
    }
    if (seen.has(idpGroup)) duplicates.push(idpGroup);
    seen.add(idpGroup);
    entries.push({ idpGroup, consoleGroupName });
  });
  return { entries, badLines, duplicates };
}

export function parseAudience(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((part) => part.trim()).filter(Boolean))];
}

// ── view <-> form ────────────────────────────────────────────────────────

export function formFromView(view: DelegationView): DelegationForm {
  return {
    enabled: view.enabled,
    issuer: view.trust.issuer,
    audience: Array.isArray(view.trust.audience) ? view.trust.audience.join('\n') : view.trust.audience,
    algorithms: [...view.trust.algorithms],
    secrets: (view.trust.keys.hsSecrets ?? []).map((entry) => ({ kid: entry.kid, secret: '', stored: true })),
    jwksUrl: view.trust.keys.jwksUrl ?? '',
    pem: view.trust.keys.pem ?? '',
    maxTokenAgeSeconds: view.trust.maxTokenAgeSeconds !== undefined ? String(view.trust.maxTokenAgeSeconds) : '',
    clockSkewSeconds: view.trust.clockSkewSeconds !== undefined ? String(view.trust.clockSkewSeconds) : '',
    matchIdentity: view.mapping.matchBy.includes('externalId'),
    matchEmail: view.mapping.matchBy.includes('verifiedEmail'),
    jit: view.mapping.jit,
    groupMapText: formatGroupMap(view.mapping.groupMap),
    allowPrivileged: view.allowPrivileged,
  };
}

export const needsSecret = (form: Pick<DelegationForm, 'algorithms'>): boolean => form.algorithms.includes('HS256');
export const needsPublicKey = (form: Pick<DelegationForm, 'algorithms'>): boolean =>
  form.algorithms.includes('RS256') || form.algorithms.includes('ES256');

/** The body of the PUT: only the key material that belongs to a pinned algorithm is sent. */
export function formToPayload(form: DelegationForm): Record<string, unknown> {
  const audience = parseAudience(form.audience);
  const groupMap = parseGroupMapText(form.groupMapText).entries;
  const keys: Record<string, unknown> = {};
  if (needsSecret(form)) {
    keys.hsSecrets = form.secrets.map((row) => (row.secret ? { kid: row.kid.trim(), secret: row.secret } : { kid: row.kid.trim() }));
  }
  if (needsPublicKey(form)) {
    if (form.jwksUrl.trim()) keys.jwksUrl = form.jwksUrl.trim();
    if (form.pem.trim()) keys.pem = form.pem.trim();
  }
  const trust: Record<string, unknown> = {
    issuer: form.issuer.trim(),
    audience: audience.length === 1 ? audience[0] : audience,
    algorithms: form.algorithms,
    keys,
  };
  if (form.maxTokenAgeSeconds.trim()) trust.maxTokenAgeSeconds = Number(form.maxTokenAgeSeconds);
  if (form.clockSkewSeconds.trim()) trust.clockSkewSeconds = Number(form.clockSkewSeconds);
  const matchBy = [...(form.matchIdentity ? ['externalId'] : []), ...(form.matchEmail ? ['verifiedEmail'] : [])];
  return {
    enabled: form.enabled,
    trust,
    mapping: { matchBy, jit: form.jit, ...(groupMap.length > 0 ? { groupMap } : {}) },
    allowPrivileged: form.allowPrivileged,
  };
}

// ── hints ────────────────────────────────────────────────────────────────

export type DelegationProblemCode =
  | 'issuer_required'
  | 'audience_required'
  | 'algorithm_required'
  | 'secret_required'
  | 'secret_too_short'
  | 'secret_kid_invalid'
  | 'secret_kid_duplicate'
  | 'public_key_required'
  | 'jwks_url_invalid'
  | 'pem_invalid'
  | 'max_age_invalid'
  | 'skew_invalid'
  | 'match_required'
  | 'group_map_invalid';

export interface DelegationProblem {
  code: DelegationProblemCode;
  /** The row (secrets) or line (group map) the problem is about, 1-based. */
  at?: number;
}

const wholeNumber = (text: string, min: number, max: number): boolean => {
  if (!text.trim()) return true;
  const value = Number(text);
  return Number.isInteger(value) && value >= min && value <= max;
};

/** What is wrong with the form as it stands. */
export function delegationProblems(form: DelegationForm): DelegationProblem[] {
  const problems: DelegationProblem[] = [];
  if (!form.issuer.trim()) problems.push({ code: 'issuer_required' });
  if (parseAudience(form.audience).length === 0) problems.push({ code: 'audience_required' });
  if (form.algorithms.length === 0) problems.push({ code: 'algorithm_required' });

  if (needsSecret(form)) {
    if (form.secrets.length === 0) problems.push({ code: 'secret_required' });
    const seen = new Set<string>();
    form.secrets.forEach((row, index) => {
      const kid = row.kid.trim();
      if (!kid || kid.length > 64 || !KID_PATTERN.test(kid)) problems.push({ code: 'secret_kid_invalid', at: index + 1 });
      else if (seen.has(kid)) problems.push({ code: 'secret_kid_duplicate', at: index + 1 });
      seen.add(kid);
      if (!row.secret && !row.stored) problems.push({ code: 'secret_required', at: index + 1 });
      else if (row.secret && row.secret.length < MIN_SECRET_LENGTH) problems.push({ code: 'secret_too_short', at: index + 1 });
    });
  }
  if (needsPublicKey(form)) {
    if (!form.jwksUrl.trim() && !form.pem.trim()) problems.push({ code: 'public_key_required' });
    if (form.jwksUrl.trim()) {
      let ok = false;
      try {
        const url = new URL(form.jwksUrl.trim());
        ok = url.protocol === 'https:' || url.protocol === 'http:';
      } catch {
        ok = false;
      }
      if (!ok) problems.push({ code: 'jwks_url_invalid' });
    }
    if (form.pem.trim() && !/-----BEGIN (PUBLIC KEY|CERTIFICATE)-----/.test(form.pem)) problems.push({ code: 'pem_invalid' });
  }
  if (!wholeNumber(form.maxTokenAgeSeconds, 1, 86_400)) problems.push({ code: 'max_age_invalid' });
  if (!wholeNumber(form.clockSkewSeconds, 0, 300)) problems.push({ code: 'skew_invalid' });
  if (!form.matchIdentity && !form.matchEmail) problems.push({ code: 'match_required' });
  const map = parseGroupMapText(form.groupMapText);
  if (map.badLines.length > 0) problems.push({ code: 'group_map_invalid', at: map.badLines[0] });
  else if (map.duplicates.length > 0 || map.entries.length > 100) problems.push({ code: 'group_map_invalid' });
  return problems;
}

/** Whether the form differs from what the server holds (a typed secret always counts). */
export function delegationDirty(form: DelegationForm, view: DelegationView | null): boolean {
  if (!view) return true;
  const base = formFromView(view);
  if (form.secrets.some((row) => row.secret !== '')) return true;
  return JSON.stringify({ ...form, secrets: form.secrets.map((row) => [row.kid, row.stored]) })
    !== JSON.stringify({ ...base, secrets: base.secrets.map((row) => [row.kid, row.stored]) });
}
