/**
 * Editor model of a custom policy.
 *
 * `PolicyDraft` is what the visual editor edits (flat, with display labels for
 * the people it references); `PolicySpec` is what the API stores and compiles to
 * Cedar. This module converts between them, validates a draft before it is sent
 * and summarizes a spec for tables. Pure (no React), covered by unit tests.
 *
 * Semantics worth knowing (they come from the compiler, not from here):
 *  - principals: a user or group principal also matches the API tokens that
 *    user (or a group member) owns, so a deny on a group cannot be bypassed with
 *    a token. A token's scope and the project settings still cap every allow.
 *  - resources: the editor offers ONE restriction kind at a time (services OR
 *    projects OR specific resources); a stored spec that combines several is kept
 *    as is ('multiple') and shown with all of its restrictions.
 *  - conditions: every condition that is set must hold for the policy to apply.
 */

import type {
  IamChannel,
  IamEffect,
  IamPrincipalType,
  PolicyRow,
  PolicySpec,
  PolicySpecConditions,
  PolicySpecPrincipals,
  PolicySpecResources,
} from '../api';
import { parseCidr } from '../ipRanges';

export interface PrincipalRef {
  id: string;
  label: string;
}

export interface ResourceRef {
  type: string;
  id: string;
  label: string;
}

export type WhereMode = 'any' | 'services' | 'projects' | 'resources' | 'multiple';

export interface PolicyDraft {
  name: string;
  description: string;
  /** A policy is enabled or disabled; a disabled one is kept but never applied. */
  enabled: boolean;
  effect: IamEffect;
  /** Principals `{ any: true }`: every user and every token. */
  whoAny: boolean;
  anyUser: boolean;
  anyToken: boolean;
  users: PrincipalRef[];
  groups: PrincipalRef[];
  tokens: PrincipalRef[];
  actions: string[];
  whereMode: WhereMode;
  services: string[];
  projects: string[];
  resources: ResourceRef[];
  /** ISO timestamps. */
  validFrom: string | null;
  validUntil: string | null;
  ipRanges: string[];
  channels: IamChannel[];
}

export const NAME_MAX_LENGTH = 120;
export const DESCRIPTION_MAX_LENGTH = 500;

/** A new policy starts enabled: the editor previews its impact before it is saved, and asks before enabling it. */
export function emptyDraft(): PolicyDraft {
  return {
    name: '',
    description: '',
    enabled: true,
    effect: 'permit',
    whoAny: false,
    anyUser: false,
    anyToken: false,
    users: [],
    groups: [],
    tokens: [],
    actions: [],
    whereMode: 'any',
    services: [],
    projects: [],
    resources: [],
    validFrom: null,
    validUntil: null,
    ipRanges: [],
    channels: [],
  };
}

// ── spec -> draft ────────────────────────────────────────────────────────

export interface SpecSummary {
  whoAny: boolean;
  anyUser: boolean;
  anyToken: boolean;
  userIds: string[];
  groupIds: string[];
  tokenIds: string[];
  actions: string[];
  whereMode: WhereMode;
  services: string[];
  projects: string[];
  resources: Array<{ type: string; id: string }>;
  validFrom: string | null;
  validUntil: string | null;
  ipRanges: string[];
  channels: IamChannel[];
}

export function summarizeSpec(spec: PolicySpec): SpecSummary {
  const p = spec.principals as Exclude<PolicySpecPrincipals, { any: true }> & { any?: true };
  const r = spec.resources as Exclude<PolicySpecResources, { any: true }> & { any?: true };
  const whoAny = p.any === true;

  const services = r.any === true ? [] : [...(r.services ?? [])];
  const projects = r.any === true ? [] : [...(r.projects ?? [])];
  const resources = r.any === true ? [] : [...(r.resources ?? [])];
  const kinds = [services.length > 0, projects.length > 0, resources.length > 0].filter(Boolean).length;
  const whereMode: WhereMode =
    kinds === 0
      ? 'any'
      : kinds > 1
        ? 'multiple'
        : services.length > 0
          ? 'services'
          : projects.length > 0
            ? 'projects'
            : 'resources';

  const c: PolicySpecConditions = spec.conditions ?? {};
  return {
    whoAny,
    anyUser: !whoAny && p.anyUser === true,
    anyToken: !whoAny && p.anyToken === true,
    userIds: whoAny ? [] : [...(p.users ?? [])],
    groupIds: whoAny ? [] : [...(p.groups ?? [])],
    tokenIds: whoAny ? [] : [...(p.tokens ?? [])],
    actions: [...spec.actions],
    whereMode,
    services,
    projects,
    resources,
    validFrom: c.validFrom ?? null,
    validUntil: c.validUntil ?? null,
    ipRanges: [...(c.ipRanges ?? [])],
    channels: [...(c.channels ?? [])],
  };
}

const ref = (id: string, labels?: ReadonlyMap<string, string>): PrincipalRef => ({
  id,
  label: labels?.get(id) ?? id,
});

/**
 * Labels are optional display names for ids (the spec stores ids only). Missing
 * labels fall back to the id, so a half-resolved draft is still editable.
 */
export interface DraftLabels {
  users?: ReadonlyMap<string, string>;
  groups?: ReadonlyMap<string, string>;
  tokens?: ReadonlyMap<string, string>;
  resources?: ReadonlyMap<string, string>;
}

export function specToDraft(
  spec: PolicySpec,
  meta: { name: string; description: string; enabled: boolean },
  labels: DraftLabels = {},
): PolicyDraft {
  const s = summarizeSpec(spec);
  return {
    name: meta.name,
    description: meta.description,
    enabled: meta.enabled,
    effect: spec.effect,
    whoAny: s.whoAny,
    anyUser: s.anyUser,
    anyToken: s.anyToken,
    users: s.userIds.map((id) => ref(id, labels.users)),
    groups: s.groupIds.map((id) => ref(id, labels.groups)),
    tokens: s.tokenIds.map((id) => ref(id, labels.tokens)),
    actions: s.actions,
    whereMode: s.whereMode,
    services: s.services,
    projects: s.projects,
    resources: s.resources.map((x) => ({
      type: x.type,
      id: x.id,
      label: labels.resources?.get(resourceKey(x)) ?? x.id,
    })),
    validFrom: s.validFrom,
    validUntil: s.validUntil,
    ipRanges: s.ipRanges,
    channels: s.channels,
  };
}

/** A draft for a raw-Cedar policy or a new copy: only the basics carry over. */
export function draftFromRow(row: PolicyRow, labels: DraftLabels = {}): PolicyDraft {
  const meta = { name: row.name, description: row.description, enabled: row.enabled };
  if (row.spec) return specToDraft(row.spec, meta, labels);
  return { ...emptyDraft(), ...meta };
}

export function resourceKey(r: { type: string; id: string }): string {
  return `${r.type}:${r.id}`;
}

/** Prefill from a deep link (`?new=1&principalType=&principalId=`): the principal becomes the policy's subject. */
export function withPrincipal(draft: PolicyDraft, type: IamPrincipalType, principal: PrincipalRef): PolicyDraft {
  const next: PolicyDraft = { ...draft, whoAny: false };
  if (type === 'user') next.users = [principal];
  else if (type === 'group') next.groups = [principal];
  else next.tokens = [principal];
  return next;
}

/**
 * Prefill from a deep link (`?new=1&resourceType=&resourceId=`): a rule about this
 * one resource. For a portal it is "block someone from this portal": a deny rule
 * for opening it, in the portal channel; the editor still asks who.
 */
export function withResource(draft: PolicyDraft, resource: ResourceRef): PolicyDraft {
  const next: PolicyDraft = { ...draft, whereMode: 'resources', resources: [resource] };
  if (resource.type !== 'portal') return next;
  return { ...next, effect: 'forbid', actions: ['portal.use'], channels: ['portal'] };
}

// ── draft -> spec ────────────────────────────────────────────────────────

function uniq<T>(items: readonly T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export function draftToSpec(draft: PolicyDraft): PolicySpec {
  let principals: PolicySpecPrincipals;
  if (draft.whoAny) {
    principals = { any: true };
  } else {
    const users = uniq(draft.users, (x) => x.id).map((x) => x.id);
    const groups = uniq(draft.groups, (x) => x.id).map((x) => x.id);
    const tokens = uniq(draft.tokens, (x) => x.id).map((x) => x.id);
    principals = {
      ...(draft.anyUser ? { anyUser: true } : {}),
      ...(draft.anyToken ? { anyToken: true } : {}),
      ...(users.length ? { users } : {}),
      ...(groups.length ? { groups } : {}),
      ...(tokens.length ? { tokens } : {}),
    };
  }

  const useServices = draft.whereMode === 'services' || draft.whereMode === 'multiple';
  const useProjects = draft.whereMode === 'projects' || draft.whereMode === 'multiple';
  const useResources = draft.whereMode === 'resources' || draft.whereMode === 'multiple';
  const services = useServices ? [...new Set(draft.services)] : [];
  const projects = useProjects ? [...new Set(draft.projects)] : [];
  const resources = useResources ? uniq(draft.resources, resourceKey).map((x) => ({ type: x.type, id: x.id })) : [];
  const resourceSpec: PolicySpecResources =
    draft.whereMode === 'any' || (!services.length && !projects.length && !resources.length)
      ? { any: true }
      : {
          ...(services.length ? { services } : {}),
          ...(projects.length ? { projects } : {}),
          ...(resources.length ? { resources } : {}),
        };

  const ipRanges = draft.ipRanges.map((x) => x.trim()).filter(Boolean);
  const conditions: PolicySpecConditions = {
    ...(draft.validFrom ? { validFrom: draft.validFrom } : {}),
    ...(draft.validUntil ? { validUntil: draft.validUntil } : {}),
    ...(ipRanges.length ? { ipRanges } : {}),
    ...(draft.channels.length ? { channels: [...new Set(draft.channels)] } : {}),
  };

  return {
    effect: draft.effect,
    principals,
    actions: [...new Set(draft.actions)],
    resources: resourceSpec,
    ...(Object.keys(conditions).length ? { conditions } : {}),
  };
}

// ── validation ───────────────────────────────────────────────────────────

export type DraftIssueCode =
  | 'name'
  | 'actions'
  | 'who'
  | 'services'
  | 'projects'
  | 'resources'
  | 'timeOrder'
  | 'ip';

export interface DraftIssue {
  code: DraftIssueCode;
  /** The offending value (an IP entry). */
  value?: string;
}

/** What the editor refuses to send. The server validates again (ids exist, Cedar schema...). */
export function validateDraft(draft: PolicyDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (draft.name.trim() === '') issues.push({ code: 'name' });
  if (draft.actions.length === 0) issues.push({ code: 'actions' });

  const hasWho =
    draft.whoAny ||
    draft.anyUser ||
    draft.anyToken ||
    draft.users.length > 0 ||
    draft.groups.length > 0 ||
    draft.tokens.length > 0;
  if (!hasWho) issues.push({ code: 'who' });

  if (draft.whereMode === 'services' && draft.services.length === 0) issues.push({ code: 'services' });
  if (draft.whereMode === 'projects' && draft.projects.length === 0) issues.push({ code: 'projects' });
  if (draft.whereMode === 'resources' && draft.resources.length === 0) issues.push({ code: 'resources' });
  if (
    draft.whereMode === 'multiple' &&
    draft.services.length === 0 &&
    draft.projects.length === 0 &&
    draft.resources.length === 0
  ) {
    issues.push({ code: 'resources' });
  }

  if (draft.validFrom && draft.validUntil) {
    const from = Date.parse(draft.validFrom);
    const until = Date.parse(draft.validUntil);
    if (Number.isFinite(from) && Number.isFinite(until) && from >= until) issues.push({ code: 'timeOrder' });
  }
  for (const range of draft.ipRanges) {
    if (!parseCidr(range).ok) issues.push({ code: 'ip', value: range });
  }
  return issues;
}

export function hasIssue(issues: readonly DraftIssue[], code: DraftIssueCode): boolean {
  return issues.some((i) => i.code === code);
}

// ── dirty tracking ───────────────────────────────────────────────────────

/** Order-insensitive fingerprint of everything the user can change. */
export function draftSignature(draft: PolicyDraft): string {
  const sorted = (xs: readonly string[]) => [...xs].sort();
  return JSON.stringify({
    n: draft.name.trim(),
    d: draft.description.trim(),
    e: draft.enabled,
    f: draft.effect,
    wa: draft.whoAny,
    au: draft.anyUser,
    at: draft.anyToken,
    u: sorted(draft.users.map((x) => x.id)),
    g: sorted(draft.groups.map((x) => x.id)),
    t: sorted(draft.tokens.map((x) => x.id)),
    a: sorted(draft.actions),
    w: draft.whereMode,
    s: sorted(draft.services),
    p: sorted(draft.projects),
    r: sorted(draft.resources.map(resourceKey)),
    vf: draft.validFrom,
    vu: draft.validUntil,
    ip: sorted(draft.ipRanges),
    c: sorted(draft.channels),
  });
}

/** A short human title for a copy: "Name (copy)". */
export function copyName(name: string, suffix: string): string {
  const base = name.trim();
  const full = `${base} (${suffix})`;
  return full.length > NAME_MAX_LENGTH ? `${base.slice(0, NAME_MAX_LENGTH - suffix.length - 4)}… (${suffix})` : full;
}
