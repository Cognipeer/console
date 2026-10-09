/**
 * Policy spec (A1): the structured form of a custom policy that the visual
 * editor produces, and the compiler that turns it into Cedar.
 *
 *   PolicySpec = {
 *     effect:     'permit' | 'forbid'
 *     principals: { any: true } | { users?, groups?, tokens?, anyUser?, anyToken? }   (union)
 *     actions:    catalog action ids (level groups Read / Write / Admin included), >= 1
 *     resources:  { any: true } | { services?, projects?, resources?: [{ type, id }] } (union)
 *     conditions: { validFrom?, validUntil?, ipRanges?, channels? }                     (all must hold)
 *   }
 *
 * Why a compiler and not text templates: every id that reaches the Cedar text
 * has been (1) checked for a safe charset, (2) verified to exist in THIS tenant
 * (users, groups, tokens, projects, registry resources), and (3) written through
 * one escaping function. There is no way for a spec to inject Cedar. The result
 * is then validated against the generated schema like any hand-written policy,
 * so what is stored is always something the engine can load.
 *
 * Token ownership: a user / group principal ALSO matches the API tokens that user
 * (or a member of that group) owns, `principal is ApiToken && principal.owner in ...`.
 * A forbid on a group therefore cannot be walked around with a token, and a permit
 * for a group reaches its members' tokens - which stay capped by their scope and by
 * the project narrowing (the managed boundary forbids, managedPolicies.ts).
 *
 * Project-scoped specs match both a resource inside the project and a
 * service-level request made in that project's context (`context.projectId`);
 * the HTTP gate only knows the second.
 *
 * Pure except `verifySpecReferences` / `compileSpec` with a tenant, which read the
 * tenant database.
 */

import { runWithTenantScope } from '@/lib/database';
import { isPermissionService, RBAC_SERVICE_DEFINITIONS } from '@/lib/security/rbac';
import { isIamChannel, IAM_CHANNELS, parseCidr, toCedarDatetime, type IamChannel } from './context';
import type { ActionDefinition } from './actions';
import type { CedarMessage } from './cedar';
import { trustsEveryHop } from '@/lib/security/trustedProxy';
import { getIamSchema } from './schemaState';
import { validateCustomPolicyText } from './policyText';

// ── types ────────────────────────────────────────────────────────────────

export type PolicyEffect = 'permit' | 'forbid';

export interface PolicySpecPrincipalSelection {
  users?: string[];
  groups?: string[];
  tokens?: string[];
  anyUser?: boolean;
  anyToken?: boolean;
}
export type PolicySpecPrincipals = { any: true } | PolicySpecPrincipalSelection;

export interface PolicySpecResourceRef {
  type: string;
  id: string;
}
export interface PolicySpecResourceSelection {
  services?: string[];
  projects?: string[];
  resources?: PolicySpecResourceRef[];
}
export type PolicySpecResources = { any: true } | PolicySpecResourceSelection;

export interface PolicySpecConditions {
  validFrom?: string;
  validUntil?: string;
  ipRanges?: string[];
  channels?: IamChannel[];
}

export interface PolicySpec {
  effect: PolicyEffect;
  principals: PolicySpecPrincipals;
  actions: string[];
  resources: PolicySpecResources;
  conditions?: PolicySpecConditions;
}

/** A problem (or warning) the editor can show: a message and, for Cedar text, where. */
export interface PolicyIssue {
  message: string;
  /** Machine-readable kind for issues the editor explains in its own words (`not_enforced_actions`, `admin_checked_as_write`...). */
  code?: string;
  /** Values for the editor's wording of `code` (the English `message` already has them filled in). */
  params?: Record<string, string>;
  help?: string;
  line?: number;
  col?: number;
  /** Which spec field it is about (`principals.users`, `conditions.ipRanges`...). */
  field?: string;
}

// ── limits ───────────────────────────────────────────────────────────────

export const SPEC_LIMITS = {
  users: 500,
  groups: 200,
  tokens: 200,
  actions: 600,
  services: 100,
  projects: 200,
  resources: 200,
  ipRanges: 50,
} as const;

/** Ids of users, groups, tokens, projects and registry resources: ObjectIds, UUIDs, slugs, keys. */
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;

export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID_RE.test(value);
}

// ── Cedar text ───────────────────────────────────────────────────────────

/**
 * A Cedar string literal. The ONLY way any caller-supplied text enters a
 * compiled policy. Everything outside printable ASCII is refused outright (ids
 * and enum values never need it); quote and backslash are escaped.
 */
export function cedarString(value: string): string {
  if (typeof value !== 'string' || !/^[\x20-\x7e]*$/.test(value)) {
    throw new Error('refusing to write a non-printable or non-ASCII value into a policy');
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const entity = (type: string, id: string): string => `${type}::${cedarString(id)}`;
const stringSet = (values: readonly string[]): string => `[${values.map(cedarString).join(', ')}]`;
const entitySet = (type: string, ids: readonly string[]): string => `[${ids.map((id) => entity(type, id)).join(', ')}]`;

// ── shape validation ─────────────────────────────────────────────────────

export interface SpecCatalogView {
  actions: ReadonlyMap<string, ActionDefinition>;
  /** registry resource type id -> Cedar entity type name */
  resourceEntityTypes: Readonly<Record<string, string>>;
}

export function currentCatalogView(): SpecCatalogView {
  const schema = getIamSchema();
  return {
    actions: new Map(schema.catalog.map((a) => [a.id, a])),
    resourceEntityTypes: schema.resourceEntityTypes,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], field: string, issues: PolicyIssue[]): void {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) continue;
    if (!allowed.includes(key)) issues.push({ message: `Unknown field "${key}"`, field: `${field}.${key}` });
  }
}

function idList(raw: unknown, field: string, max: number, issues: PolicyIssue[]): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    issues.push({ message: 'Must be a list of ids', field });
    return undefined;
  }
  if (raw.length > max) issues.push({ message: `At most ${max} entries are allowed`, field });
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, max)) {
    if (!isSafeId(item)) {
      issues.push({ message: `"${String(item).slice(0, 60)}" is not a valid id`, field });
      continue;
    }
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function parseInstant(raw: unknown, field: string, issues: PolicyIssue[]): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') {
    issues.push({ message: 'Must be an ISO 8601 date-time', field });
    return undefined;
  }
  // Only real ISO 8601 date(-time) text: Date.parse alone accepts "March 5" style strings.
  const text = raw.trim();
  const match = /^\d{4}-\d{2}-\d{2}(?:([T ])\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
  if (!match) {
    issues.push({ message: `"${raw.slice(0, 40)}" is not an ISO 8601 date-time`, field });
    return undefined;
  }
  // A time of day without a zone would be read in the SERVER's timezone, so the same
  // policy would mean a different instant on two hosts. A bare date is UTC midnight.
  if (match[1] && !match[2]) {
    issues.push({ message: `"${raw.slice(0, 40)}" needs a time zone, e.g. ${text.slice(0, 16).replace(' ', 'T')}:00Z or ${text.slice(0, 16).replace(' ', 'T')}:00+03:00`, field });
    return undefined;
  }
  const iso = toCedarDatetime(Date.parse(text.replace(' ', 'T')));
  if (!iso) {
    issues.push({ message: `"${raw.slice(0, 40)}" is not a valid date-time`, field });
    return undefined;
  }
  return iso;
}

export type SpecParse = { ok: true; spec: PolicySpec } | { ok: false; errors: PolicyIssue[] };

/**
 * Structural validation of a spec from the API: types, enums, charsets, limits,
 * that every action / service / resource type exists. Returns the normalised
 * spec (deduplicated lists, dates in canonical form). Does NOT touch the
 * database - see `verifySpecReferences` for "exists in this tenant".
 */
export function parsePolicySpec(input: unknown, view: SpecCatalogView = currentCatalogView()): SpecParse {
  const issues: PolicyIssue[] = [];
  if (!isRecord(input)) return { ok: false, errors: [{ message: 'The policy spec must be an object' }] };
  onlyKeys(input, ['effect', 'principals', 'actions', 'resources', 'conditions'], '', issues);

  // effect
  const effect = input.effect;
  if (effect !== 'permit' && effect !== 'forbid') issues.push({ message: 'effect must be "permit" or "forbid"', field: 'effect' });

  // principals
  let principals: PolicySpecPrincipals = { any: true };
  if (!isRecord(input.principals)) {
    issues.push({ message: 'Choose who the policy applies to', field: 'principals' });
  } else {
    const p = input.principals;
    onlyKeys(p, ['any', 'users', 'groups', 'tokens', 'anyUser', 'anyToken'], 'principals', issues);
    if (p.any !== undefined && p.any !== true) issues.push({ message: '"any" can only be true', field: 'principals.any' });
    if (p.any === true) {
      const others = ['users', 'groups', 'tokens', 'anyUser', 'anyToken'].filter((k) => p[k] !== undefined && p[k] !== false && !(Array.isArray(p[k]) && (p[k] as unknown[]).length === 0));
      if (others.length > 0) issues.push({ message: '"any" cannot be combined with a more specific selection', field: 'principals' });
      principals = { any: true };
    } else {
      const sel: PolicySpecPrincipalSelection = {};
      const users = idList(p.users, 'principals.users', SPEC_LIMITS.users, issues);
      const groups = idList(p.groups, 'principals.groups', SPEC_LIMITS.groups, issues);
      const tokens = idList(p.tokens, 'principals.tokens', SPEC_LIMITS.tokens, issues);
      if (users?.length) sel.users = users;
      if (groups?.length) sel.groups = groups;
      if (tokens?.length) sel.tokens = tokens;
      for (const key of ['anyUser', 'anyToken'] as const) {
        if (p[key] !== undefined && typeof p[key] !== 'boolean') issues.push({ message: `${key} must be true or false`, field: `principals.${key}` });
        else if (p[key] === true) sel[key] = true;
      }
      if (!sel.users && !sel.groups && !sel.tokens && !sel.anyUser && !sel.anyToken) {
        issues.push({ message: 'Choose at least one user, group or token (or everyone)', field: 'principals' });
      }
      principals = sel;
    }
  }

  // actions
  const actions: string[] = [];
  if (!Array.isArray(input.actions) || input.actions.length === 0) {
    issues.push({ message: 'Choose at least one action', field: 'actions' });
  } else {
    if (input.actions.length > SPEC_LIMITS.actions) issues.push({ message: `At most ${SPEC_LIMITS.actions} actions are allowed`, field: 'actions' });
    const seen = new Set<string>();
    for (const a of input.actions.slice(0, SPEC_LIMITS.actions)) {
      if (typeof a !== 'string' || !view.actions.has(a)) {
        issues.push({ message: `"${String(a).slice(0, 60)}" is not an action of the catalog`, field: 'actions' });
        continue;
      }
      if (!seen.has(a)) {
        seen.add(a);
        actions.push(a);
      }
    }
  }

  // resources
  let resources: PolicySpecResources = { any: true };
  if (!isRecord(input.resources)) {
    issues.push({ message: 'Choose what the policy applies to', field: 'resources' });
  } else {
    const r = input.resources;
    onlyKeys(r, ['any', 'services', 'projects', 'resources'], 'resources', issues);
    if (r.any !== undefined && r.any !== true) issues.push({ message: '"any" can only be true', field: 'resources.any' });
    if (r.any === true) {
      const others = ['services', 'projects', 'resources'].filter((k) => Array.isArray(r[k]) ? (r[k] as unknown[]).length > 0 : r[k] !== undefined);
      if (others.length > 0) issues.push({ message: '"any" cannot be combined with a more specific selection', field: 'resources' });
      resources = { any: true };
    } else {
      const sel: PolicySpecResourceSelection = {};
      if (r.services !== undefined) {
        if (!Array.isArray(r.services)) issues.push({ message: 'Must be a list of services', field: 'resources.services' });
        else {
          if (r.services.length > SPEC_LIMITS.services) issues.push({ message: `At most ${SPEC_LIMITS.services} services are allowed`, field: 'resources.services' });
          const services: string[] = [];
          for (const s of r.services.slice(0, SPEC_LIMITS.services)) {
            if (!isPermissionService(s)) issues.push({ message: `"${String(s).slice(0, 60)}" is not a service`, field: 'resources.services' });
            else if (!services.includes(s)) services.push(s);
          }
          if (services.length) sel.services = services;
        }
      }
      const projects = idList(r.projects, 'resources.projects', SPEC_LIMITS.projects, issues);
      if (projects?.length) sel.projects = projects;
      if (r.resources !== undefined) {
        if (!Array.isArray(r.resources)) issues.push({ message: 'Must be a list of resources', field: 'resources.resources' });
        else {
          if (r.resources.length > SPEC_LIMITS.resources) issues.push({ message: `At most ${SPEC_LIMITS.resources} resources are allowed`, field: 'resources.resources' });
          const refs: PolicySpecResourceRef[] = [];
          const seen = new Set<string>();
          for (const ref of r.resources.slice(0, SPEC_LIMITS.resources)) {
            if (!isRecord(ref) || typeof ref.type !== 'string' || !isSafeId(ref.id)) {
              issues.push({ message: 'Each resource needs a type and an id', field: 'resources.resources' });
              continue;
            }
            if (!Object.hasOwn(view.resourceEntityTypes, ref.type)) {
              issues.push({ message: `"${ref.type.slice(0, 60)}" is not a resource type`, field: 'resources.resources' });
              continue;
            }
            const key = `${ref.type}\u0000${ref.id}`;
            if (!seen.has(key)) {
              seen.add(key);
              refs.push({ type: ref.type, id: ref.id });
            }
          }
          if (refs.length) sel.resources = refs;
        }
      }
      if (!sel.services && !sel.projects && !sel.resources) {
        issues.push({ message: 'Choose where the policy applies (or everywhere)', field: 'resources' });
      }
      resources = sel;
    }
  }

  // conditions
  let conditions: PolicySpecConditions | undefined;
  if (input.conditions !== undefined && input.conditions !== null) {
    if (!isRecord(input.conditions)) {
      issues.push({ message: 'conditions must be an object', field: 'conditions' });
    } else {
      const c = input.conditions;
      onlyKeys(c, ['validFrom', 'validUntil', 'ipRanges', 'channels'], 'conditions', issues);
      const out: PolicySpecConditions = {};
      const from = parseInstant(c.validFrom, 'conditions.validFrom', issues);
      const until = parseInstant(c.validUntil, 'conditions.validUntil', issues);
      if (from) out.validFrom = from;
      if (until) out.validUntil = until;
      if (from && until && Date.parse(from) > Date.parse(until)) {
        issues.push({ message: 'validFrom must not be later than validUntil', field: 'conditions.validFrom' });
      }
      if (c.ipRanges !== undefined && c.ipRanges !== null) {
        if (!Array.isArray(c.ipRanges)) issues.push({ message: 'ipRanges must be a list', field: 'conditions.ipRanges' });
        else {
          if (c.ipRanges.length > SPEC_LIMITS.ipRanges) issues.push({ message: `At most ${SPEC_LIMITS.ipRanges} IP ranges are allowed`, field: 'conditions.ipRanges' });
          const ranges: string[] = [];
          for (const raw of c.ipRanges.slice(0, SPEC_LIMITS.ipRanges)) {
            const parsed = parseCidr(raw);
            if (!parsed.ok) issues.push({ message: parsed.error, field: 'conditions.ipRanges' });
            else if (!ranges.includes(parsed.cidr)) ranges.push(parsed.cidr);
          }
          if (ranges.length) out.ipRanges = ranges;
        }
      }
      if (c.channels !== undefined && c.channels !== null) {
        if (!Array.isArray(c.channels)) issues.push({ message: 'channels must be a list', field: 'conditions.channels' });
        else {
          const channels: IamChannel[] = [];
          for (const ch of c.channels) {
            if (!isIamChannel(ch)) issues.push({ message: `"${String(ch).slice(0, 40)}" is not a channel (use ${IAM_CHANNELS.join(', ')})`, field: 'conditions.channels' });
            else if (!channels.includes(ch)) channels.push(ch);
          }
          if (channels.length) out.channels = channels;
        }
      }
      if (Object.keys(out).length > 0) conditions = out;
    }
  }

  if (issues.length > 0) return { ok: false, errors: issues };
  const spec: PolicySpec = {
    effect: effect as PolicyEffect,
    principals,
    actions,
    resources,
    ...(conditions ? { conditions } : {}),
  };
  return { ok: true, spec };
}

// ── references ───────────────────────────────────────────────────────────

export interface SpecTenant {
  tenantDbName: string;
  tenantId: string;
}

const REFERENCE_CONCURRENCY = 8;

async function mapLimited<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(REFERENCE_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** True when the record claims a different tenant (defence in depth; the DB handle is the real boundary). */
const foreign = (record: { tenantId?: unknown } | null | undefined, tenantId: string): boolean =>
  !!record?.tenantId && String(record.tenantId) !== String(tenantId);

/** Ids per directory query (the directory layer pages at 200). */
const REFERENCE_CHUNK = 200;

/**
 * Every id of the spec must exist IN THIS TENANT. Resolved with a handful of
 * set queries (users, groups and tokens in chunks of 200, the projects in one
 * listing) instead of one point read per id: the editor compiles on every
 * pause, and a spec may name hundreds of people. A genuine infrastructure error
 * is rethrown so the caller can answer 503 rather than blaming the admin's input;
 * an id the provider cannot even represent (not an ObjectId) simply does not match.
 */
export async function verifySpecReferences(spec: PolicySpec, tenant: SpecTenant): Promise<PolicyIssue[]> {
  const issues: PolicyIssue[] = [];
  const p = spec.principals;
  const r = spec.resources;
  const users = 'users' in p ? p.users ?? [] : [];
  const groups = 'groups' in p ? p.groups ?? [] : [];
  const tokens = 'tokens' in p ? p.tokens ?? [] : [];
  const projects = 'projects' in r ? r.projects ?? [] : [];
  const resources = 'resources' in r ? r.resources ?? [] : [];

  const report = (ids: readonly string[], found: ReadonlySet<string>, field: string, noun: string) => {
    for (const id of ids) {
      if (!found.has(id)) issues.push({ message: `The ${noun} "${id}" does not exist in this workspace`, field });
    }
  };
  const lookup = async (
    ids: readonly string[],
    page: (chunk: string[]) => Promise<ReadonlyArray<{ _id?: unknown; tenantId?: unknown }>>,
  ): Promise<Set<string>> => {
    const found = new Set<string>();
    for (let i = 0; i < ids.length; i += REFERENCE_CHUNK) {
      for (const record of await page(ids.slice(i, i + REFERENCE_CHUNK))) {
        if (record._id !== undefined && !foreign(record, tenant.tenantId)) found.add(String(record._id));
      }
    }
    return found;
  };

  if (users.length + groups.length + tokens.length + projects.length > 0) {
    await runWithTenantScope(tenant.tenantDbName, async (db) => {
      if (users.length) {
        report(users, await lookup(users, async (ids) => (await db.iamListUsers({ tenantId: tenant.tenantId, ids, limit: REFERENCE_CHUNK })).items), 'principals.users', 'user');
      }
      if (groups.length) {
        report(groups, await lookup(groups, async (ids) => (await db.iamListGroups({ tenantId: tenant.tenantId, ids, limit: REFERENCE_CHUNK })).items), 'principals.groups', 'group');
      }
      if (tokens.length) {
        report(tokens, await lookup(tokens, async (ids) => (await db.iamListTokens({ tenantId: tenant.tenantId, ids, limit: REFERENCE_CHUNK })).items), 'principals.tokens', 'token');
      }
      if (projects.length) {
        // A tenant has few projects: one listing beats a point read per id.
        const all = await db.listProjects(tenant.tenantId);
        report(projects, new Set(all.filter((x) => !foreign(x, tenant.tenantId)).map((x) => String(x._id))), 'resources.projects', 'project');
      }
    });
  }

  if (resources.length > 0) {
    // Loaded on demand: the registry pulls in every resource provider.
    const { getResource } = await import('@/lib/resources/service');
    const found = await mapLimited(resources, async (ref) => {
      const detail = await getResource({ tenantDbName: tenant.tenantDbName, tenantId: tenant.tenantId, type: ref.type, id: ref.id });
      return !!detail;
    });
    resources.forEach((ref, i) => {
      if (!found[i]) issues.push({ message: `The ${ref.type} "${ref.id}" does not exist in this workspace`, field: 'resources.resources' });
    });
  }
  return issues;
}

// ── compiler ─────────────────────────────────────────────────────────────

function principalExpression(p: PolicySpecPrincipals): string | null {
  if ('any' in p && p.any === true) return null;
  const sel = p as PolicySpecPrincipalSelection;
  const parts: string[] = [];
  if (sel.anyUser) parts.push('principal is User');
  if (sel.anyToken) parts.push('principal is ApiToken');
  if (sel.users?.length) {
    const set = entitySet('User', sel.users);
    parts.push(`principal in ${set}`, `(principal is ApiToken && principal.owner in ${set})`);
  }
  if (sel.groups?.length) {
    const set = entitySet('Group', sel.groups);
    parts.push(`principal in ${set}`, `(principal is ApiToken && principal.owner in ${set})`);
  }
  if (sel.tokens?.length) parts.push(`principal in ${entitySet('ApiToken', sel.tokens)}`);
  if (parts.length === 0) throw new Error('a spec must select at least one principal');
  return parts.length === 1 ? parts[0] : `\n    ${parts.join('\n    || ')}\n  `;
}

function resourceExpression(r: PolicySpecResources, view: SpecCatalogView): string | null {
  if ('any' in r && r.any === true) return null;
  const sel = r as PolicySpecResourceSelection;
  const parts: string[] = [];
  if (sel.services?.length) parts.push(`${stringSet(sel.services)}.contains(resource.service)`);
  if (sel.projects?.length) {
    parts.push(`resource in ${entitySet('Project', sel.projects)}`);
    // The HTTP gate checks a whole service, which has no project; it carries the project in the context.
    parts.push(`(resource is Service && context has projectId && ${stringSet(sel.projects)}.contains(context.projectId))`);
  }
  if (sel.resources?.length) {
    const byType = new Map<string, string[]>();
    for (const ref of sel.resources) byType.set(ref.type, [...(byType.get(ref.type) ?? []), ref.id]);
    for (const [type, ids] of byType) {
      const entityType = Object.hasOwn(view.resourceEntityTypes, type) ? view.resourceEntityTypes[type] : undefined;
      if (!entityType) throw new Error(`unknown resource type "${type}"`);
      parts.push(`resource in ${entitySet(entityType, ids)}`);
    }
  }
  if (parts.length === 0) throw new Error('a spec must select at least one resource');
  return parts.length === 1 ? parts[0] : `\n    ${parts.join('\n    || ')}\n  `;
}

function conditionExpressions(c: PolicySpecConditions | undefined): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (c.validFrom) out.push(`context has now && context.now >= datetime(${cedarString(c.validFrom)})`);
  if (c.validUntil) out.push(`context has now && context.now <= datetime(${cedarString(c.validUntil)})`);
  if (c.ipRanges?.length) {
    out.push(`context has ip && (${c.ipRanges.map((cidr) => `context.ip.isInRange(ip(${cedarString(cidr)}))`).join(' || ')})`);
  }
  if (c.channels?.length) out.push(`context has channel && ${stringSet(c.channels)}.contains(context.channel)`);
  return out;
}

/**
 * Cedar text of an already validated spec (one statement). Throws only on a
 * spec that `parsePolicySpec` would have rejected.
 */
export function compileSpecToCedar(spec: PolicySpec, view: SpecCatalogView = currentCatalogView()): string {
  const actionScope = spec.actions.length === 1
    ? (view.actions.get(spec.actions[0])?.kind === 'group'
        ? `action in ${entity('Action', spec.actions[0])}`
        : `action == ${entity('Action', spec.actions[0])}`)
    : `action in [${spec.actions.map((a) => entity('Action', a)).join(', ')}]`;

  const clauses = [principalExpression(spec.principals), resourceExpression(spec.resources, view), ...conditionExpressions(spec.conditions)]
    .filter((c): c is string => c !== null);

  const head = `${spec.effect} (\n  principal,\n  ${actionScope},\n  resource\n)`;
  if (clauses.length === 0) return `${head};`;
  return `${head}\nwhen {\n${clauses.map((c, i) => `${i === 0 ? '  ' : '  && '}(${c})`).join('\n')}\n};`;
}

// ── what the request gates can reach ────────────────────────────────────

/**
 * Which parts of a spec can ever match a decision the server actually takes.
 *
 * The HTTP gates (and the handler-level checks) ask one question: may this
 * principal do `<service>.read|write` on `Service::"<service>"`, in this project
 * and channel? They never ask about an individual resource (`agent.delete` on
 * one agent), and no request runs in the `portal` channel yet. A rule built only
 * from those parts is accepted by the schema, evaluates in the Access check and
 * the preview, and still never changes a real request - which, for a forbid, is a
 * false assurance. The compiler therefore refuses such a forbid and warns about
 * every rule that is only partly reachable.
 */
export interface GateReach {
  /** Level groups and service-level actions: what the gates evaluate. */
  gateActions: number;
  /** Resource-level actions (`agent.delete`...): evaluated by the Access check only. */
  resourceActions: string[];
  /** The only resource selector is "specific resources" (no services, no projects). */
  specificOnly: boolean;
  hasSpecific: boolean;
  /** The only channel is `portal`. */
  portalOnly: boolean;
  hasPortal: boolean;
}

export function gateReach(spec: PolicySpec, view: SpecCatalogView = currentCatalogView()): GateReach {
  const defs = spec.actions.map((a) => view.actions.get(a)).filter((a): a is ActionDefinition => !!a);
  const resourceActions = defs.filter((a) => a.kind === 'resource').map((a) => a.id);
  const sel = 'any' in spec.resources ? null : (spec.resources as PolicySpecResourceSelection);
  const hasSpecific = !!sel?.resources?.length;
  const channels = spec.conditions?.channels ?? [];
  return {
    gateActions: defs.length - resourceActions.length,
    resourceActions,
    specificOnly: hasSpecific && !sel?.services?.length && !sel?.projects?.length,
    hasSpecific,
    portalOnly: channels.length > 0 && channels.every((c) => c === 'portal'),
    hasPortal: channels.includes('portal'),
  };
}

/** Why a spec can never match a gate decision (empty = it can). */
export function inertReasons(reach: GateReach): PolicyIssue[] {
  const reasons: PolicyIssue[] = [];
  if (reach.gateActions === 0) {
    reasons.push({
      code: 'not_enforced_actions',
      field: 'actions',
      message: 'Rules about individual resources (such as "delete agent") are not checked by the request gates yet, so this rule would never apply. Choose service actions (Read, Write, Admin) instead.',
    });
  }
  if (reach.specificOnly) {
    reasons.push({
      code: 'not_enforced_resources',
      field: 'resources',
      message: 'Rules limited to individual resources are not checked by the request gates yet, so this rule would never apply. Limit it to services or projects instead.',
    });
  }
  if (reach.portalOnly) {
    reasons.push({
      code: 'not_enforced_channel',
      field: 'conditions.channels',
      message: 'No request uses the portal channel yet, so a rule limited to it would never apply.',
    });
  }
  return reasons;
}

// ── warnings ─────────────────────────────────────────────────────────────

/** Shown next to every rule that conditions on the caller's address while the server trusts no proxy. */
export function trustedProxiesWarning(): PolicyIssue {
  return {
    code: 'trusted_proxies_unset',
    field: 'conditions.ipRanges',
    message: 'TRUSTED_PROXIES is not set on this server, so IP rules use the direct connection address and ignore forwarded-for headers. That cannot be spoofed, but behind a reverse proxy or load balancer every caller looks like the proxy. Set TRUSTED_PROXIES to your proxy address so the real client address is used.',
  };
}

const ADMIN_SERVICE_IDS: ReadonlySet<string> = new Set(RBAC_SERVICE_DEFINITIONS.filter((d) => d.adminService).map((d) => d.id));

function warningsFor(spec: PolicySpec, view: SpecCatalogView): PolicyIssue[] {
  const warnings: PolicyIssue[] = [];
  const actions = spec.actions.map((a) => view.actions.get(a)).filter((a): a is ActionDefinition => !!a);
  const hasGroup = actions.some((a) => a.kind === 'group');

  // Reachability (see gateReach): a fully unreachable forbid is an error in compileSpec; everything else is said here.
  const reach = gateReach(spec, view);
  const inert = inertReasons(reach);
  if (spec.effect === 'permit') {
    for (const reason of inert) warnings.push({ ...reason, message: reason.message.replace('would never apply', 'would never grant anything') });
  } else if (inert.length === 0) {
    if (reach.resourceActions.length > 0) {
      warnings.push({
        code: 'partly_enforced_actions',
        field: 'actions',
        message: 'Some of the selected actions concern individual resources. The request gates do not check those yet, so only the service-level actions of this rule take effect.',
      });
    }
    if (reach.hasSpecific) {
      warnings.push({
        code: 'partly_enforced_resources',
        field: 'resources',
        message: 'The specific resources you selected are not checked by the request gates yet. The services and projects of this rule still apply.',
      });
    }
    if (reach.hasPortal) {
      warnings.push({
        code: 'partly_enforced_channel',
        field: 'conditions.channels',
        message: 'No request uses the portal channel yet. The other channels of this rule still apply.',
      });
    }
  }

  // An address rule is only as useful as the address the server can vouch for.
  if (spec.conditions?.ipRanges?.length && trustsEveryHop()) warnings.push(trustedProxiesWarning());

  // Administration services (members, iam, ...) are changed with a WRITE request that additionally needs the Admin level.
  // Blocking "Admin" alone therefore stops nothing; "Write" is what a change is checked as.
  if (spec.effect === 'forbid') {
    const writeAll = actions.some((a) => a.id === 'Write');
    const scoped = 'any' in spec.resources ? null : (spec.resources as PolicySpecResourceSelection).services ?? null;
    const named = new Set<string>();
    for (const a of actions) {
      if (a.kind === 'service' && a.level === 'admin' && a.service && ADMIN_SERVICE_IDS.has(a.service)
        && !writeAll && !actions.some((o) => o.id === `${a.service}.write`)) named.add(a.service);
    }
    if (actions.some((a) => a.id === 'Admin') && !writeAll) {
      for (const service of ADMIN_SERVICE_IDS) {
        if ((!scoped || scoped.includes(service)) && !actions.some((o) => o.id === `${service}.write`)) named.add(service);
      }
    }
    if (named.size > 0) {
      const list = [...named].slice(0, 6).join(', ') + (named.size > 6 ? ', ...' : '');
      warnings.push({
        code: 'admin_checked_as_write',
        params: { services: list },
        field: 'actions',
        message: `Changes to ${list} are checked as Write (which additionally needs the Admin level), so blocking Admin alone does not stop them. Choose Write to block changes.`,
      });
    }
  }

  // The selectors of `resources` are a union: only when one is the ONLY selector can it make the policy a no-op.
  const sel = 'any' in spec.resources ? null : (spec.resources as PolicySpecResourceSelection);
  if (sel && sel.services?.length && !sel.projects?.length && !sel.resources?.length && !hasGroup) {
    const wanted = new Set(sel.services);
    if (!actions.some((a) => a.service && wanted.has(a.service))) {
      warnings.push({ message: 'None of the selected actions belongs to the selected services, so this policy will never apply.', field: 'actions' });
    }
  }
  if (sel && sel.resources?.length && !sel.services?.length && !sel.projects?.length && !hasGroup) {
    const types = new Set(sel.resources.map((r) => r.type));
    if (!actions.some((a) => a.resourceType && types.has(a.resourceType))) {
      warnings.push({ message: 'None of the selected actions applies to the selected resources, so this policy will never apply.', field: 'actions' });
    }
  }
  if (spec.effect === 'forbid') {
    const touchesIam = actions.some((a) => a.service === 'iam') || hasGroup;
    const iamInScope = 'any' in spec.resources || (spec.resources as PolicySpecResourceSelection).services?.includes('iam') !== false;
    if (touchesIam && iamInScope) {
      warnings.push({
        message: 'The workspace owner can always reach the Authorization Engine, so this policy never locks the owner out of it.',
        field: 'actions',
      });
    }
  }
  return warnings;
}

// ── public API ───────────────────────────────────────────────────────────

export interface CompileOutcome {
  ok: boolean;
  /** The Cedar text ('' when the spec could not be compiled). */
  cedar: string;
  errors: PolicyIssue[];
  warnings: PolicyIssue[];
  /** The normalised spec (only when ok). */
  spec?: PolicySpec;
}

/** Cedar's byte offset -> 1-based line / column of `text`. */
export function locate(text: string, offset: number): { line: number; col: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let last = -1;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, col: clamped - last };
}

/**
 * Turn Cedar parse / validation messages into editor issues with line / column.
 * `statements` are the parsed statements: a validation error's offset is relative
 * to its statement (`candidate#i`), which is found in the full text to place it.
 */
export function cedarIssues(messages: CedarMessage[], fullText: string, statements: readonly string[] = []): PolicyIssue[] {
  return messages.map((m) => {
    const issue: PolicyIssue = { message: m.message };
    if (m.help) issue.help = m.help;
    if (typeof m.start === 'number') {
      const match = m.policyId ? /^candidate#(\d+)$/.exec(m.policyId) : null;
      const statement = match ? statements[Number(match[1])] : undefined;
      if (statement) {
        const base = fullText.indexOf(statement);
        const where = base >= 0 ? locate(fullText, base + m.start) : locate(statement, m.start);
        issue.line = where.line;
        issue.col = where.col;
      } else if (!m.policyId) {
        const where = locate(fullText, m.start);
        issue.line = where.line;
        issue.col = where.col;
      }
    }
    return issue;
  });
}

/**
 * Compile a spec to Cedar, strictly: shape -> (references exist in the tenant)
 * -> Cedar -> schema validation. Never throws for bad input; a failure of the
 * tenant lookups themselves is the only thing that propagates.
 */
export async function compileSpec(input: unknown, tenant?: SpecTenant, view: SpecCatalogView = currentCatalogView()): Promise<CompileOutcome> {
  const parsed = parsePolicySpec(input, view);
  if (!parsed.ok) return { ok: false, cedar: '', errors: parsed.errors, warnings: [] };

  if (tenant) {
    const missing = await verifySpecReferences(parsed.spec, tenant);
    if (missing.length > 0) return { ok: false, cedar: '', errors: missing, warnings: [] };
  }

  let cedar: string;
  try {
    cedar = compileSpecToCedar(parsed.spec, view);
  } catch (error) {
    return { ok: false, cedar: '', errors: [{ message: error instanceof Error ? error.message : String(error) }], warnings: [] };
  }

  // Reachability is judged on the spec below, in the editor's words; the Cedar-level check would repeat it.
  const validation = validateCustomPolicyText(cedar, { reachability: false });
  if (!validation.valid) {
    // A spec that passed the shape checks must always compile to something valid; surface the Cedar message if not.
    return { ok: false, cedar, errors: cedarIssues(validation.errors, cedar, validation.statements), warnings: [] };
  }
  const warnings = [...warningsFor(parsed.spec, view), ...cedarIssues(validation.warnings, cedar, validation.statements)];
  if (parsed.spec.effect === 'forbid') {
    // A deny rule that can never match a real request would look like protection and be none.
    const unreachable = inertReasons(gateReach(parsed.spec, view));
    if (unreachable.length > 0) return { ok: false, cedar, errors: unreachable, warnings };
  }
  return {
    ok: true,
    cedar,
    errors: [],
    warnings,
    spec: parsed.spec,
  };
}

/** Canonical JSON (object keys sorted), for comparing two specs structurally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * True when `incoming` is the same policy as `stored` once normalised (list order
 * of the selectors does not matter to the compiler, which sorts nothing but
 * deduplicates, so only exact structural equality counts as "unchanged").
 */
export function isSameSpec(incoming: unknown, stored: PolicySpec | null | undefined, view: SpecCatalogView = currentCatalogView()): boolean {
  if (!stored) return false;
  const parsed = parsePolicySpec(incoming, view);
  return parsed.ok && canonicalJson(parsed.spec) === canonicalJson(stored);
}

export const SPEC_SERVICE_IDS: readonly string[] = RBAC_SERVICE_DEFINITIONS.map((d) => d.id);
