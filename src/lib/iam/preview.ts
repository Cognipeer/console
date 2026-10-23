/**
 * Impact preview (`POST /api/iam/policies/preview`): "what would change if this
 * policy were enabled?" - the tenant's CURRENT policy set (its enabled policies)
 * against the same set with the draft applied (replacing the stored version when
 * `policyId` is given), over the principals the draft reaches x the actions it
 * covers.
 *
 * The principals come from the directory, not from traffic: the people and tokens
 * the draft names, the members of the groups it names, and - when it names nobody
 * in particular - a spread over the workspace (owners and admins first: their
 * paths differ from an ordinary member's), up to MAX_PRINCIPALS. When the whole
 * audience was enumerated and checked, `principals.targeted` says how many it is;
 * when it is a sample, `truncated` says so.
 *
 * Bounded: at most MAX_PRINCIPALS people and tokens, MAX_EVALUATIONS decisions
 * and DEADLINE_MS of wall clock; when any runs out the result says
 * `truncated: true`. The draft is evaluated as if enabled whatever its state (the
 * point is to see the impact before enabling it), under the conditions it
 * declares (a channel / IP / time window it asks for is assumed to hold -
 * otherwise a conditional policy would always look like a no-op). The principals
 * are read without filling the principal cache: a preview must not push the hot
 * entries of live traffic out.
 *
 * The two sets are preparsed into the WASM instance under FIXED ids (Cedar has
 * no way to free a set, so a fresh id per preview would leak). There are
 * PREVIEW_SLOTS pairs of ids; a preview owns one pair for its whole run, so
 * previews cannot trample each other, and a workspace can have only one preview
 * queued or running at a time - one tenant flooding previews costs itself a 429,
 * not everybody else a wait.
 */

import { runWithTenantScope } from '@/lib/database';
import { hasIamPortalResolver, resolveIamPortal, type IamPortalFacts } from '@/enterprise/iam-portal';
import { isSessionResourceAction, RUNTIME_ENFORCED_ACTIONS, type ActionDefinition } from './actions';
import { agentSessionResource, DEFAULT_AGENT_APPROVERS, portalAgentSessionResource } from './agentEntities';
import { ALL_MANAGED_POLICIES } from './managedPolicies';
import { preparsePolicySet, statefulIsAuthorized, type CedarDecision } from './cedar';
import { isRuntimeIamChannel, type IamRequestContext } from './context';
import { buildAuthorizeCall, buildPolicyRecord, forbidsOf } from './engine';
import type { IamPrincipal, IamResource } from './entities';
import { guardForbidErrors } from './forbidGuard';
import { portalAgentResource, portalResource, type PortalRequester } from './portalEntities';
import { isRuntimeEnforced } from './runtimeEnforced';
import {
  loadEvaluationPrincipal,
  PrincipalError,
  type EvaluationPrincipal,
  type IamTenant,
} from './principals';
import {
  cedarIssues,
  compileSpec,
  type PolicyIssue,
  type PolicySpec,
  type PolicySpecResourceSelection,
} from './policySpec';
import { policyReferences } from './policyRows';
import { validateCustomPolicyText } from './policyText';
import { getIamSchema } from './schemaState';
import { getPolicy, listPolicies } from './store';

export const MAX_EVALUATIONS = 20_000;
export const DEADLINE_MS = 5_000;
/** People and tokens a preview looks at. */
export const MAX_PRINCIPALS = 1_000;
const MAX_SAMPLES = 50;
const MAX_SAMPLES_PER_PRINCIPAL = 4;
/** Principals built at the same time (each is a few directory reads). */
const LOAD_CONCURRENCY = 16;
/** Directory pages are read this many rows at a time (the directory serves at most 200). */
const PAGE = 200;
/** How many previews (of different workspaces) may hold a pair of preparsed sets at once. */
const PREVIEW_SLOTS = 4;
const DRAFT_POLICY_ID = '__draft__';
/** What the lock allows beyond the evaluation deadline (reading the policies, building the sets). */
const PREVIEW_GRACE_MS = 5_000;

export class PreviewInputError extends Error {
  readonly code: 'validation' | 'not_found' | 'engine_unavailable' | 'rate_limited';
  readonly status: number;
  readonly details: PolicyIssue[];
  constructor(code: PreviewInputError['code'], message: string, status: number, details: PolicyIssue[] = []) {
    super(message);
    this.name = 'PreviewInputError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface PreviewInput {
  policyId?: string;
  spec?: unknown;
  cedar?: string;
}

export interface PreviewSample {
  principal: { type: 'user' | 'token'; id: string; label: string };
  action: string;
  resource: { kind: 'service'; service: string } | { kind: 'resource'; type: string; id: string };
  before: boolean;
  after: boolean;
}

export interface PreviewResult {
  /** Decisions compared (one per principal x action x resource). */
  evaluated: number;
  /**
   * True when the numbers describe a SAMPLE of the people the policy reaches (or
   * the budget ran out): see `principals` for how big a sample.
   */
  truncated: boolean;
  /**
   * `evaluated`: people / tokens the draft was fully checked for. `targeted`: how
   * many the policy reaches - the users and tokens it names plus the members of its
   * groups, or, for a policy that reaches everybody, the size of the directory when
   * it was listed completely - or null when that number is not known (a directory
   * larger than the preview looks at).
   */
  principals: { evaluated: number; targeted: number | null };
  flips: { allowToDeny: number; denyToAllow: number };
  samples: PreviewSample[];
}

export interface PreviewOptions {
  maxEvaluations?: number;
  deadlineMs?: number;
}

// ── slots ────────────────────────────────────────────────────────────────

const freeSlots: number[] = Array.from({ length: PREVIEW_SLOTS }, (_, i) => i);
const slotWaiters: Array<(slot: number) => void> = [];
/** Workspaces with a preview queued or running. */
const busyTenants = new Set<string>();

const beforeSet = (slot: number) => `preview:before:${slot}`;
const afterSet = (slot: number) => `preview:after:${slot}`;

function takeSlot(maxMs: number): Promise<number> {
  const free = freeSlots.pop();
  if (free !== undefined) return Promise.resolve(free);
  return new Promise<number>((resolve, reject) => {
    const waiter = (slot: number) => {
      clearTimeout(timer);
      resolve(slot);
    };
    const timer = setTimeout(() => {
      const i = slotWaiters.indexOf(waiter);
      if (i !== -1) slotWaiters.splice(i, 1);
      reject(new PreviewInputError('engine_unavailable', 'The preview service is busy, try again in a moment', 503));
    }, maxMs);
    timer.unref?.();
    slotWaiters.push(waiter);
  });
}

function giveSlot(slot: number): void {
  const next = slotWaiters.shift();
  if (next) next(slot);
  else freeSlots.push(slot);
}

/** Test hook: marks a workspace as having a preview running, so an overlap can be set up deterministically. Returns the release. */
export function holdPreviewForTests(tenantDbName: string): () => void {
  busyTenants.add(tenantDbName);
  return () => {
    busyTenants.delete(tenantDbName);
  };
}

/**
 * Run `fn` with a pair of set ids to itself. One preview per workspace (a second
 * one is refused with 429 instead of queueing behind the first). A preview that
 * has not finished after `maxMs` (a stuck database read) is told it was
 * cancelled and gives its slot back, so it can neither hold the slot forever nor
 * write into the sets the next preview uses.
 */
async function withPreviewSlot<T>(
  tenantDbName: string,
  fn: (slot: number, cancelled: () => boolean) => Promise<T>,
  maxMs: number,
): Promise<T> {
  if (busyTenants.has(tenantDbName)) {
    throw new PreviewInputError('rate_limited', 'A preview for this workspace is already running. Wait for it to finish.', 429);
  }
  busyTenants.add(tenantDbName);
  let slot: number | null = null;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    slot = await takeSlot(maxMs);
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        cancelled = true;
        reject(new PreviewInputError('engine_unavailable', 'The preview took too long', 503));
      }, maxMs);
      timer.unref?.();
    });
    const run = fn(slot, () => cancelled);
    // A run that loses the race keeps running in the background until its next
    // cancellation check; its rejection must not become an unhandled one.
    run.catch(() => undefined);
    return await Promise.race([run, limit]);
  } finally {
    if (timer) clearTimeout(timer);
    busyTenants.delete(tenantDbName);
    if (slot !== null) giveSlot(slot);
  }
}

// ── draft ────────────────────────────────────────────────────────────────

async function resolveDraft(tenant: IamTenant, input: PreviewInput): Promise<{ cedar: string; spec: PolicySpec | null }> {
  const hasSpec = input.spec !== undefined && input.spec !== null;
  const hasCedar = typeof input.cedar === 'string';
  if (hasSpec && hasCedar) {
    throw new PreviewInputError('validation', 'Send either a spec or Cedar text, not both', 400, [{ message: 'Send either a spec or Cedar text, not both' }]);
  }
  if (hasSpec) {
    const out = await compileSpec(input.spec, tenant);
    if (!out.ok || !out.spec) throw new PreviewInputError('validation', out.errors.map((e) => e.message).join('; ') || 'Invalid policy', 400, out.errors);
    return { cedar: out.cedar, spec: out.spec };
  }
  if (hasCedar) {
    const validation = validateCustomPolicyText(input.cedar);
    if (!validation.valid) {
      throw new PreviewInputError('validation', validation.errors.map((e) => e.message).join('; '), 400, cedarIssues(validation.errors, input.cedar as string, validation.statements));
    }
    return { cedar: input.cedar as string, spec: null };
  }
  if (input.policyId) {
    const stored = await getPolicy(tenant.tenantDbName, input.policyId);
    if (!stored) throw new PreviewInputError('not_found', `Policy "${input.policyId}" not found`, 404);
    return { cedar: stored.cedar, spec: stored.spec };
  }
  throw new PreviewInputError('validation', 'Provide a spec, Cedar text or a policyId', 400, [{ message: 'Provide a spec, Cedar text or a policyId' }]);
}

// ── targets ──────────────────────────────────────────────────────────────

const LEVEL_GROUP_IDS = new Set(['Read', 'Write', 'Admin']);
const ACTION_LITERAL_RE = /Action::"((?:[^"\\]|\\.)*)"/g;

function actionsOf(spec: PolicySpec | null, cedar: string, catalog: readonly ActionDefinition[]): ActionDefinition[] {
  const byId = new Map(catalog.map((a) => [a.id, a]));
  const wanted: string[] = spec ? spec.actions : [...cedar.matchAll(ACTION_LITERAL_RE)].map((m) => m[1].replace(/\\(.)/g, '$1'));
  const services = spec && 'services' in spec.resources && spec.resources.services?.length ? new Set(spec.resources.services) : null;

  const out = new Map<string, ActionDefinition>();
  const add = (a: ActionDefinition) => {
    if (a.kind !== 'group') out.set(a.id, a);
  };
  for (const id of wanted) {
    const action = byId.get(id);
    if (!action) continue;
    if (action.kind === 'group' && LEVEL_GROUP_IDS.has(action.id)) {
      // A level group stands for the service-level action of that level of every (selected) service.
      for (const a of catalog) {
        if (a.kind === 'service' && a.group === action.id && (!services || (a.service && services.has(a.service)))) add(a);
      }
    } else {
      add(action);
    }
  }
  if (out.size === 0) {
    // A policy that does not name an action applies to all of them: probe the service-level ones.
    for (const a of catalog) if (a.kind === 'service' && !a.id.startsWith('aegis.')) add(a);
  }
  return [...out.values()];
}

interface PrincipalRef { type: 'user' | 'token'; id: string }

interface Audience {
  /** Who to check, most relevant first. */
  principals: PrincipalRef[];
  /** How many people / tokens the policy reaches when that is known; null when it is not. */
  targeted: number | null;
}

/**
 * The people and tokens in scope of a draft, read through the directory queries
 * (paged, tenant-scoped), most relevant first:
 *
 *  1. the users and tokens it names;
 *  2. the members of the groups it names;
 *  3. when it names nobody in particular: a spread over the workspace, owners
 *     and admins first (their paths through the managed rules differ from a
 *     member's), then project admins, then members, then tokens;
 *  4. a few tokens owned by the first people: a policy about a person reaches
 *     their tokens too.
 *
 * `targeted` is exact when the audience is named, or when everybody was listed
 * to the end within MAX_PRINCIPALS; otherwise null.
 */
async function enumeratePrincipals(tenant: IamTenant, spec: PolicySpec | null, cedar: string): Promise<Audience> {
  const refs = policyReferences({ cedar, spec });
  const named = refs.users.size + refs.groups.size + refs.tokens.size > 0;
  // A policy that names nobody in particular (conditions only, say) applies to everyone.
  const everyoneUsers = refs.any || refs.anyUser || !(named || refs.anyToken);
  const everyoneTokens = refs.any || refs.anyToken || !(named || refs.anyUser);

  const users = new Set<string>();
  const tokens = new Set<string>();
  const room = () => MAX_PRINCIPALS - users.size - tokens.size;

  /** Members of the named groups (counted, not listed: the list is capped). */
  let groupMembers = 0;
  /** Every directory list that fed an "everybody" audience was read to its end. */
  let usersComplete = true;
  let tokensComplete = true;

  await runWithTenantScope(tenant.tenantDbName, async (db) => {
    for (const id of refs.users) if (room() > 0) users.add(id);
    for (const id of refs.tokens) if (room() > 0) tokens.add(id);

    if (refs.groups.size > 0) {
      const counts = await db.iamCountGroupMembers([...refs.groups]);
      groupMembers = Object.values(counts).reduce((sum, n) => sum + n, 0);
      const groups = [...refs.groups];
      for (let g = 0; g < groups.length && room() > 0; g++) {
        // each remaining group gets an equal share of what is left
        let share = Math.max(25, Math.floor(room() / (groups.length - g)));
        for (let offset = 0; share > 0 && room() > 0; offset += PAGE) {
          const page = await db.iamListGroupMemberIds(groups[g], { limit: Math.min(PAGE, share), offset });
          for (const id of page.items) if (room() > 0) users.add(id);
          share -= page.items.length;
          if (!page.hasMore) break;
        }
      }
    }

    if (everyoneUsers) {
      // owners and admins first: they are few, and each takes a different path through the rules
      const roles: Array<{ role: string; cap: number }> = [
        { role: 'owner', cap: 10 },
        { role: 'admin', cap: 100 },
        { role: 'project_admin', cap: 200 },
        { role: 'user', cap: MAX_PRINCIPALS },
      ];
      for (const { role, cap } of roles) {
        let taken = 0;
        let more = true;
        for (let offset = 0; more && taken < cap && room() > 0; offset += PAGE) {
          const page = await db.iamListUsers({
            tenantId: tenant.tenantId,
            roles: [role],
            status: 'active',
            limit: Math.min(PAGE, cap - taken, room()),
            offset,
          });
          for (const u of page.items) {
            users.add(String(u._id));
            taken++;
          }
          more = page.hasMore;
        }
        if (more) usersComplete = false;
      }
    }

    if (everyoneTokens) {
      let more = true;
      for (let offset = 0; more && room() > 0; offset += PAGE) {
        const page = await db.iamListTokens({ tenantId: tenant.tenantId, limit: Math.min(PAGE, room()), offset });
        for (const t of page.items) tokens.add(String(t._id));
        more = page.hasMore;
      }
      if (more) tokensComplete = false;
    }

    // A user / group policy reaches the tokens its people own: include a few of them.
    for (const userId of [...users].slice(0, 25)) {
      if (room() <= 0) break;
      const page = await db.iamListTokens({ tenantId: tenant.tenantId, userId, limit: Math.min(2, room()) });
      for (const t of page.items) tokens.add(String(t._id));
    }
  });

  // The audience size, when it is known: named people plus group members, or the whole directory when it was listed to its end.
  const reachUsers = everyoneUsers ? (usersComplete ? users.size : null) : refs.users.size + groupMembers;
  const reachTokens = everyoneTokens ? (tokensComplete ? tokens.size : null) : refs.tokens.size;

  return {
    principals: [
      ...[...users].map((id) => ({ type: 'user' as const, id })),
      ...[...tokens].map((id) => ({ type: 'token' as const, id })),
    ].slice(0, MAX_PRINCIPALS),
    targeted: reachUsers === null || reachTokens === null ? null : reachUsers + reachTokens,
  };
}

/** An address inside the first range (the range's own base address). */
const firstAddress = (cidr: string | undefined): string | undefined => (cidr ? cidr.split('/')[0] : undefined);

/** The actions only a runtime asks (`portal.use`, `agent.invoke`): asked in the portal or messaging channel and nowhere else. */
const isPortalOnlyAction = (id: string): boolean => {
  const channels = RUNTIME_ENFORCED_ACTIONS[id];
  return !!channels && channels.length > 0 && channels.every(isRuntimeIamChannel);
};

function contextFor(spec: PolicySpec | null, type: 'user' | 'token', action?: ActionDefinition): IamRequestContext {
  const cond = spec?.conditions;
  // The portal runtime asks its two actions in the portal channel (unless the draft says it only concerns others).
  const portalAsked = !!action && isPortalOnlyAction(action.id) && isRuntimeEnforced(action.id, 'portal') && (!cond?.channels?.length || cond.channels.includes('portal'));
  const channel = portalAsked ? 'portal' : cond?.channels?.[0] ?? (type === 'token' ? 'api' : 'dashboard');
  let now: Date | undefined;
  if (cond?.validFrom || cond?.validUntil) {
    const from = cond.validFrom ? new Date(cond.validFrom).getTime() : -Infinity;
    const until = cond.validUntil ? new Date(cond.validUntil).getTime() : Infinity;
    const t = Math.min(Math.max(Date.now(), from), until);
    now = new Date(t);
  }
  const projects = spec && 'projects' in spec.resources ? spec.resources.projects : undefined;
  // A portal has no project: the portal runtime never sends one.
  return { channel, ip: firstAddress(cond?.ipRanges?.[0]), now, projectId: portalAsked ? undefined : projects?.[0] };
}

/** The portals a preview evaluates the portal actions on: the ones the draft names, else a few of the workspace's. */
async function portalsFor(tenant: IamTenant, spec: PolicySpec | null, actions: readonly ActionDefinition[]): Promise<IamPortalFacts[]> {
  if (!hasIamPortalResolver() || !actions.some((a) => isRuntimeEnforced(a.id, 'portal'))) return [];
  const sel = spec && !('any' in spec.resources) ? (spec.resources as PolicySpecResourceSelection) : null;
  const named = sel?.resources?.filter((r) => r.type === 'portal').map((r) => r.id) ?? [];
  let ids = named.slice(0, 3);
  if (ids.length === 0) {
    try {
      const { searchResources } = await import('@/lib/resources/service');
      const found = await searchResources({ tenantDbName: tenant.tenantDbName, tenantId: tenant.tenantId, types: ['portal'], limit: 3 });
      ids = found.items.map((item) => item.id);
    } catch {
      return [];
    }
  }
  const facts = await Promise.all(ids.map((id) => resolveIamPortal(tenant, id)));
  return facts.filter((f): f is IamPortalFacts => !!f);
}

/** Who the sessions of a preview belong to when it is not the person being previewed. */
const SOMEONE_ELSE = '(someone-else)';

/**
 * The agent sessions a preview asks a session action about: one the person started themselves (an approval is
 * theirs to answer; the other two actions do not even ask) and one somebody else started, in a project the person
 * belongs to - the draft's own, else the first they have.
 */
function sessionResourcesFor(
  action: ActionDefinition,
  sel: PolicySpecResourceSelection | null,
  principal: IamPrincipal | undefined,
  channel: string | null | undefined,
  portals: readonly IamPortalFacts[],
  requester?: PortalRequester,
): IamResource[] {
  const projectId = sel?.projects?.[0] ?? principal?.projects[0] ?? null;
  const me = requester?.userId ?? principal?.userId;
  const owners = action.id === 'agent.approve' && me ? [[me], [SOMEONE_ELSE]] : [[SOMEONE_ELSE]];
  const named = sel?.resources?.filter((r) => r.type === 'agent').map((r) => r.id).slice(0, 3) ?? [];
  if (channel === 'portal') {
    // Answering through a portal: the agent a portal offers, `in` the portal.
    return portals.filter((p) => p.agentIds.length > 0).flatMap((p) => owners.map((ownerIds) => portalAgentSessionResource(
      { id: p.agentIds[0], projectId, ownerIds, approvers: DEFAULT_AGENT_APPROVERS },
      { id: p.id, access: p.access },
      requester,
    )));
  }
  if (!projectId) return [];
  return (named.length > 0 ? named : ['(preview)']).flatMap((id) => owners.map((ownerIds) => agentSessionResource(
    { id, projectId, ownerIds, approvers: DEFAULT_AGENT_APPROVERS },
  )));
}

function resourcesFor(
  action: ActionDefinition,
  spec: PolicySpec | null,
  portals: readonly IamPortalFacts[] = [],
  requester?: PortalRequester,
  principal?: IamPrincipal,
  channel?: string | null,
): IamResource[] {
  if (action.kind === 'service') return [{ kind: 'service', service: action.service ?? '' }];
  if (isSessionResourceAction(action.id)) {
    const picked = spec && !('any' in spec.resources) ? (spec.resources as PolicySpecResourceSelection) : null;
    return sessionResourcesFor(action, picked, principal, channel, portals, requester);
  }
  if (action.id === 'portal.use' && portals.length > 0) {
    return portals.map((p) => portalResource({ id: p.id, key: p.key, access: p.access }, requester));
  }
  if (action.id === 'agent.invoke' && portals.some((p) => p.agentIds.length > 0)) {
    return portals
      .filter((p) => p.agentIds.length > 0)
      .map((p) => portalAgentResource({ id: p.agentIds[0] }, { id: p.id, access: p.access }, requester));
  }
  const sel = spec && !('any' in spec.resources) ? (spec.resources as PolicySpecResourceSelection) : null;
  const named = sel?.resources?.filter((r) => r.type === action.resourceType) ?? [];
  const projectId = sel?.projects?.[0];
  if (named.length > 0) {
    return named.slice(0, 3).map((r) => ({ kind: 'resource', type: r.type, id: r.id, service: action.service ?? '', projectId }));
  }
  return [{ kind: 'resource', type: action.resourceType ?? '', id: '(preview)', service: action.service ?? '', projectId }];
}

const describeResource = (r: IamResource): PreviewSample['resource'] =>
  r.kind === 'service' ? { kind: 'service', service: String(r.service) } : { kind: 'resource', type: r.type, id: r.id };

// ── the preview ──────────────────────────────────────────────────────────

/** Allowed / denied, or null when the engine could not decide (such a pair is not compared). A forbid that errored is not skipped. */
function verdictOf(decision: CedarDecision, forbids: ReadonlySet<string>): boolean | null {
  if (!decision.ok) return null;
  const guarded = guardForbidErrors(decision, forbids);
  return guarded.kind === 'failed' ? null : guarded.allowed;
}

export async function previewPolicy(tenant: IamTenant, input: PreviewInput, options: PreviewOptions = {}): Promise<PreviewResult> {
  const maxEvaluations = options.maxEvaluations ?? MAX_EVALUATIONS;
  const deadlineMs = options.deadlineMs ?? DEADLINE_MS;
  const started = Date.now();
  const timeLeft = () => deadlineMs - (Date.now() - started);

  return withPreviewSlot(tenant.tenantDbName, async (slot, cancelled) => {
    const stop = () => {
      if (cancelled()) throw new PreviewInputError('engine_unavailable', 'The preview took too long', 503);
    };
    const BEFORE_SET = beforeSet(slot);
    const AFTER_SET = afterSet(slot);
    // Cheapest possible exit for a preview whose caller has already been told it timed out.
    stop();
    // Inside the slot: compiling a draft reads the directory, so it is bounded like the rest of the preview.
    const draft = await resolveDraft(tenant, input);
    stop();
    // The sets: the live (enabled) policies, with and without the draft.
    const enabled = await listPolicies(tenant.tenantDbName, { enabled: true });
    const before = buildPolicyRecord(enabled);
    const after = buildPolicyRecord([
      ...enabled.filter((p) => p.policyId !== input.policyId),
      { policyId: DRAFT_POLICY_ID, cedar: draft.cedar },
    ]);
    stop();
    const b = preparsePolicySet(BEFORE_SET, { ...ALL_MANAGED_POLICIES, ...before.record });
    const a = preparsePolicySet(AFTER_SET, { ...ALL_MANAGED_POLICIES, ...after.record });
    // A forbid that errors must not be skipped here either: the preview judges a request the way the engine will (forbidGuard.ts).
    const beforeForbids = forbidsOf(before.forbids);
    const afterForbids = forbidsOf(after.forbids);
    if (!b.ok || !a.ok) {
      const errors = (!a.ok ? a.errors : !b.ok ? b.errors : []).map((e) => ({ message: e.message }));
      throw new PreviewInputError('engine_unavailable', 'The policy set could not be prepared for the preview', 503, errors);
    }

    const catalog = getIamSchema().catalog;
    let truncated = false;

    // What to evaluate. An EDIT also changes the effect for whoever the stored version targeted.
    const replaced = input.policyId ? enabled.find((p) => p.policyId === input.policyId) : undefined;
    const sources = [draft, ...(replaced ? [{ cedar: replaced.cedar, spec: replaced.spec }] : [])];
    const actionMap = new Map<string, ActionDefinition>();
    for (const s of sources) for (const a of actionsOf(s.spec, s.cedar, catalog)) actionMap.set(a.id, a);
    let actions = [...actionMap.values()];
    const targetMap = new Map<string, PrincipalRef>();
    let targeted: number | null = 0;
    for (const s of sources) {
      const audience = await enumeratePrincipals(tenant, s.spec, s.cedar);
      for (const t of audience.principals) targetMap.set(`${t.type}:${t.id}`, t);
      targeted = targeted === null || audience.targeted === null ? null : targeted + audience.targeted;
    }
    let targets = [...targetMap.values()].slice(0, MAX_PRINCIPALS);
    if (actions.length > maxEvaluations) {
      actions = actions.slice(0, maxEvaluations);
      truncated = true;
    }
    // Prefer every action for fewer people over a few actions for everyone: the budget is people x actions.
    const affordable = Math.max(4, Math.floor(maxEvaluations / Math.max(1, actions.length)));
    if (targets.length > affordable) {
      targets = targets.slice(0, affordable);
      truncated = true;
    }
    const projects = draft.spec && 'projects' in draft.spec.resources ? draft.spec.resources.projects : undefined;
    const portals = await portalsFor(tenant, draft.spec, actions);
    stop();

    // Principals: built concurrently, but only while there is time.
    const loaded = new Map<string, EvaluationPrincipal>();
    const key = (t: { type: string; id: string }) => `${t.type}:${t.id}`;
    const load = async (ref: PrincipalRef) => {
      if (loaded.has(key(ref))) return;
      if (timeLeft() < deadlineMs * 0.4) {
        truncated = true; // people we had no time to look at
        return;
      }
      try {
        loaded.set(key(ref), await loadEvaluationPrincipal(tenant, ref, projects?.[0] ?? null, { noStore: true }));
      } catch (error) {
        if (!(error instanceof PrincipalError)) throw error;
      }
    };
    const pool = async (refs: PrincipalRef[]) => {
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, refs.length) }, async () => {
        while (next < refs.length) await load(refs[next++]);
      }));
    };
    await pool(targets);
    stop();

    const flips = { allowToDeny: 0, denyToAllow: 0 };
    const samples: PreviewSample[] = [];
    const perPrincipal = new Map<string, number>();
    let evaluated = 0;
    /** People / tokens every action of the draft was compared for. */
    let checkedPrincipals = 0;

    const evaluate = (ev: EvaluationPrincipal, action: ActionDefinition, resource: IamResource, context: IamRequestContext): void => {
      // Owner safety (enforce.ts): the workspace owner's own session always reaches `iam`, whatever a rule says, so a
      // rule on it changes nothing for them. (An API token of the owner is an ordinary principal.)
      if (ev.type === 'user' && ev.role === 'owner' && resource.kind === 'service' && resource.service === 'iam') {
        evaluated++;
        return;
      }
      const built = buildAuthorizeCall(
        {
          tenant: tenant.tenantDbName,
          principal: ev.principal,
          action: action.id,
          resource,
          // The portal runtime never sends a project; everything else runs in the one the person would be in.
          context: { ...context, projectId: isRuntimeIamChannel(context.channel) && isRuntimeEnforced(action.id, context.channel) ? undefined : context.projectId ?? ev.principal.contextProjectId },
        },
        tenant.tenantDbName,
      );
      const was = verdictOf(statefulIsAuthorized({ ...built.call, policySetId: BEFORE_SET }), beforeForbids);
      const now = verdictOf(statefulIsAuthorized({ ...built.call, policySetId: AFTER_SET }), afterForbids);
      evaluated++;
      if (was === null || now === null || was === now) return;
      if (was) flips.allowToDeny++;
      else flips.denyToAllow++;
      const k = key(ev);
      const n = perPrincipal.get(k) ?? 0;
      if (samples.length < MAX_SAMPLES && n < MAX_SAMPLES_PER_PRINCIPAL) {
        perPrincipal.set(k, n + 1);
        samples.push({
          principal: { type: ev.type, id: ev.id, label: ev.label },
          action: action.id,
          resource: describeResource(resource),
          before: was,
          after: now,
        });
      }
    };

    // Targeted principals x the draft's actions.
    // In the order the audience was enumerated (people first, then tokens), not the order the concurrent loads
    // finished in: the samples a preview shows must not depend on which lookup was quicker.
    const inOrder = targets.map((ref) => loaded.get(key(ref))).filter((ev): ev is EvaluationPrincipal => ev !== undefined);
    outer: for (const ev of inOrder) {
      const requester: PortalRequester = { userId: ev.principal.userId, groupIds: ev.principal.groupIds };
      for (const action of actions) {
        const context = contextFor(draft.spec, ev.type, action);
        for (const resource of resourcesFor(action, draft.spec, portals, requester, ev.principal, context.channel)) {
          if (evaluated >= maxEvaluations || timeLeft() <= 0) {
            truncated = true;
            break outer;
          }
          evaluate(ev, action, resource, context);
          if (evaluated % 100 === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            stop();
          }
        }
      }
      checkedPrincipals++;
    }

    // A preview of a policy that reaches more people than were checked is a sample, whatever the budget said.
    if (targeted === null || checkedPrincipals < targeted) truncated = true;
    // (The tokens a user policy reaches are checked too but not counted among the named people.)
    const reach = targeted === null ? null : Math.max(targeted, checkedPrincipals);
    return { evaluated, truncated, principals: { evaluated: checkedPrincipals, targeted: reach }, flips, samples };
  }, deadlineMs + PREVIEW_GRACE_MS);
}
