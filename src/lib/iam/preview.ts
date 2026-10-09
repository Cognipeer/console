/**
 * Impact preview (`POST /api/iam/policies/preview`): "what would change if this
 * policy were enforced?" - the tenant's CURRENT enforce-mode policy set against
 * the same set with the draft applied (replacing the stored version when
 * `policyId` is given), over
 *
 *   - the principals the draft targets x the actions it covers, and
 *   - the principals behind recent shadow findings x the gate action of their request.
 *
 * Bounded: at most MAX_EVALUATIONS decisions and DEADLINE_MS of wall clock; when
 * either runs out the result says `truncated: true`. The draft is evaluated as if
 * enforced whatever its mode (the point is to see the impact before enabling it),
 * under the conditions it declares (a channel / IP / time window it asks for is
 * assumed to hold - otherwise a conditional policy would always look like a no-op).
 *
 * The two sets are preparsed into the WASM instance under FIXED ids (Cedar has
 * no way to free a set, so a fresh id per preview would leak). There are
 * PREVIEW_SLOTS pairs of ids; a preview owns one pair for its whole run, so
 * previews cannot trample each other, and a workspace can have only one preview
 * queued or running at a time - one tenant flooding previews costs itself a 429,
 * not everybody else a wait.
 */

import { runWithTenantScope } from '@/lib/database';
import { gateActionId, type ActionDefinition } from './actions';
import { ALL_MANAGED_POLICIES } from './managedPolicies';
import { preparsePolicySet, statefulIsAuthorized } from './cedar';
import type { IamRequestContext } from './context';
import { buildAuthorizeCall, buildPolicyRecord } from './engine';
import type { IamResource } from './entities';
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
import { listShadowEntries } from './shadow/aggregate';
import { getPolicy, listPolicies } from './store';

export const MAX_EVALUATIONS = 2_000;
export const DEADLINE_MS = 3_000;
const MAX_SAMPLES = 50;
const MAX_SAMPLES_PER_PRINCIPAL = 4;
const MAX_PRINCIPALS = 40;
const MAX_SHADOW_SAMPLES = 150;
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
  /** Accepted for symmetry with the editor; the impact is always computed as if enforced. */
  mode?: string;
}

export interface PreviewSample {
  principal: { type: 'user' | 'token'; id: string; label: string };
  action: string;
  resource: { kind: 'service'; service: string } | { kind: 'resource'; type: string; id: string };
  before: boolean;
  after: boolean;
}

export interface PreviewResult {
  evaluated: number;
  /**
   * True when the numbers describe a SAMPLE of the people the policy reaches (or
   * the evaluation budget ran out): see `principals` for how big a sample.
   */
  truncated: boolean;
  /**
   * `evaluated`: people / tokens the draft was actually checked for. `targeted`: how
   * many the policy reaches (members of its groups, the users and tokens it names),
   * or null when it reaches "everyone" and the real number is the directory's.
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

async function samplePrincipals(
  tenant: IamTenant,
  spec: PolicySpec | null,
  cedar: string,
): Promise<{ principals: Array<{ type: 'user' | 'token'; id: string }>; targeted: number | null }> {
  const refs = policyReferences({ cedar, spec });
  const users = new Set<string>([...refs.users].slice(0, 20));
  const tokens = new Set<string>([...refs.tokens].slice(0, 10));
  const specific = refs.users.size + refs.groups.size + refs.tokens.size > 0;
  // A policy that names nobody in particular (conditions only, say) applies to everyone.
  const everyoneUsers = refs.any || refs.anyUser || !(specific || refs.anyToken);
  const everyoneTokens = refs.any || refs.anyToken || !(specific || refs.anyUser);

  let targeted: number | null = refs.any || everyoneUsers || everyoneTokens ? null : refs.users.size + refs.tokens.size;
  await runWithTenantScope(tenant.tenantDbName, async (db) => {
    if (targeted !== null && refs.groups.size > 0) {
      const counts = await db.iamCountGroupMembers([...refs.groups]);
      targeted += Object.values(counts).reduce((sum, n) => sum + n, 0);
    }
    // members of the targeted groups
    const groups = [...refs.groups].slice(0, 4);
    for (const groupId of groups) {
      const page = await db.iamListGroupMemberIds(groupId, { limit: Math.max(3, Math.floor(24 / groups.length)) });
      page.items.forEach((id) => users.add(id));
    }
    if (everyoneUsers) {
      // a spread of roles: the owner/admin paths and the ordinary ones differ
      for (const role of ['owner', 'admin', 'project_admin', 'user']) {
        const page = await db.iamListUsers({ tenantId: tenant.tenantId, roles: [role], status: 'active', limit: role === 'user' ? 8 : 3 });
        page.items.forEach((u) => users.add(String(u._id)));
      }
    }
    if (everyoneTokens) {
      const page = await db.iamListTokens({ tenantId: tenant.tenantId, limit: 8 });
      page.items.forEach((t) => tokens.add(String(t._id)));
    }
    // A user / group policy reaches the tokens its people own: include a few of them.
    for (const userId of [...users].slice(0, 5)) {
      const page = await db.iamListTokens({ tenantId: tenant.tenantId, userId, limit: 2 });
      page.items.forEach((t) => tokens.add(String(t._id)));
    }
  });

  return {
    principals: [
      ...[...users].map((id) => ({ type: 'user' as const, id })),
      ...[...tokens].map((id) => ({ type: 'token' as const, id })),
    ].slice(0, MAX_PRINCIPALS),
    targeted,
  };
}

/** An address inside the first range (the range's own base address). */
const firstAddress = (cidr: string | undefined): string | undefined => (cidr ? cidr.split('/')[0] : undefined);

function contextFor(spec: PolicySpec | null, type: 'user' | 'token'): IamRequestContext {
  const cond = spec?.conditions;
  const channel = cond?.channels?.[0] ?? (type === 'token' ? 'api' : 'dashboard');
  let now: Date | undefined;
  if (cond?.validFrom || cond?.validUntil) {
    const from = cond.validFrom ? new Date(cond.validFrom).getTime() : -Infinity;
    const until = cond.validUntil ? new Date(cond.validUntil).getTime() : Infinity;
    const t = Math.min(Math.max(Date.now(), from), until);
    now = new Date(t);
  }
  const projects = spec && 'projects' in spec.resources ? spec.resources.projects : undefined;
  return { channel, ip: firstAddress(cond?.ipRanges?.[0]), now, projectId: projects?.[0] };
}

function resourcesFor(action: ActionDefinition, spec: PolicySpec | null): IamResource[] {
  if (action.kind === 'service') return [{ kind: 'service', service: action.service ?? '' }];
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
    // The sets: live enforce policies, with and without the draft.
    const enforce = (await listPolicies(tenant.tenantDbName, { enabled: true })).filter((p) => p.mode === 'enforce');
    const before = buildPolicyRecord(enforce);
    const after = buildPolicyRecord([
      ...enforce.filter((p) => p.policyId !== input.policyId),
      { policyId: DRAFT_POLICY_ID, cedar: draft.cedar },
    ]);
    stop();
    const b = preparsePolicySet(BEFORE_SET, { ...ALL_MANAGED_POLICIES, ...before.record });
    const a = preparsePolicySet(AFTER_SET, { ...ALL_MANAGED_POLICIES, ...after.record });
    if (!b.ok || !a.ok) {
      const errors = (!a.ok ? a.errors : !b.ok ? b.errors : []).map((e) => ({ message: e.message }));
      throw new PreviewInputError('engine_unavailable', 'The policy set could not be prepared for the preview', 503, errors);
    }

    const catalog = getIamSchema().catalog;
    let truncated = false;

    // What to evaluate. An EDIT also changes the effect for whoever the stored version targeted.
    const replaced = input.policyId ? enforce.find((p) => p.policyId === input.policyId) : undefined;
    const sources = [draft, ...(replaced ? [{ cedar: replaced.cedar, spec: replaced.spec }] : [])];
    const actionMap = new Map<string, ActionDefinition>();
    for (const s of sources) for (const a of actionsOf(s.spec, s.cedar, catalog)) actionMap.set(a.id, a);
    let actions = [...actionMap.values()];
    const targetMap = new Map<string, { type: 'user' | 'token'; id: string }>();
    let targeted: number | null = 0;
    for (const s of sources) {
      const sampled = await samplePrincipals(tenant, s.spec, s.cedar);
      for (const t of sampled.principals) targetMap.set(`${t.type}:${t.id}`, t);
      targeted = targeted === null || sampled.targeted === null ? null : targeted + sampled.targeted;
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

    // Principals: built concurrently, but only while there is time.
    const loaded = new Map<string, EvaluationPrincipal>();
    const key = (t: { type: string; id: string }) => `${t.type}:${t.id}`;
    const load = async (ref: { type: 'user' | 'token'; id: string }) => {
      if (loaded.has(key(ref))) return;
      if (timeLeft() < deadlineMs * 0.4) {
        truncated = true; // people we had no time to look at
        return;
      }
      try {
        loaded.set(key(ref), await loadEvaluationPrincipal(tenant, ref, projects?.[0] ?? null));
      } catch (error) {
        if (!(error instanceof PrincipalError)) throw error;
      }
    };
    const pool = async (refs: Array<{ type: 'user' | 'token'; id: string }>) => {
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(6, refs.length) }, async () => {
        while (next < refs.length) await load(refs[next++]);
      }));
    };
    await pool(targets);
    stop();
    // Everybody the draft was checked for (the shadow findings below add real requests on top).
    const checkedPrincipals = targets.filter((t) => loaded.has(key(t))).length;
    // A preview of a policy that reaches more people than were checked is a sample, whatever the budget said.
    if (targeted === null || checkedPrincipals < targeted) truncated = true;

    const flips = { allowToDeny: 0, denyToAllow: 0 };
    const samples: PreviewSample[] = [];
    const perPrincipal = new Map<string, number>();
    let evaluated = 0;

    const evaluate = (ev: EvaluationPrincipal, action: ActionDefinition, resource: IamResource, context: IamRequestContext): void => {
      const built = buildAuthorizeCall(
        {
          tenant: tenant.tenantDbName,
          principal: ev.principal,
          action: action.id,
          resource,
          context: { ...context, projectId: context.projectId ?? ev.principal.contextProjectId },
        },
        tenant.tenantDbName,
      );
      const was = statefulIsAuthorized({ ...built.call, policySetId: BEFORE_SET });
      const now = statefulIsAuthorized({ ...built.call, policySetId: AFTER_SET });
      evaluated++;
      if (!was.ok || !now.ok || was.allowed === now.allowed) return;
      if (was.allowed) flips.allowToDeny++;
      else flips.denyToAllow++;
      const k = key(ev);
      const n = perPrincipal.get(k) ?? 0;
      if (samples.length < MAX_SAMPLES && n < MAX_SAMPLES_PER_PRINCIPAL) {
        perPrincipal.set(k, n + 1);
        samples.push({
          principal: { type: ev.type, id: ev.id, label: ev.label },
          action: action.id,
          resource: describeResource(resource),
          before: was.allowed,
          after: now.allowed,
        });
      }
    };

    // Targeted principals x the draft's actions.
    outer: for (const ev of loaded.values()) {
      const context = contextFor(draft.spec, ev.type);
      for (const action of actions) {
        for (const resource of resourcesFor(action, draft.spec)) {
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
    }

    // Recent shadow findings: the real requests of real principals.
    if (!truncated && timeLeft() > deadlineMs * 0.25) {
      const entries = await listShadowEntries(tenant.tenantDbName, { flush: false }).catch(() => []);
      const wanted: Array<{ ref: { type: 'user' | 'token'; id: string }; service: string; method: string }> = [];
      for (const entry of entries) {
        if (!entry.service || entry.service === '(none)') continue;
        for (const sample of entry.samples.slice(-3)) {
          const ref = sample.tokenId ? { type: 'token' as const, id: sample.tokenId } : { type: 'user' as const, id: sample.userId };
          wanted.push({ ref, service: entry.service, method: entry.method });
          if (wanted.length >= MAX_SHADOW_SAMPLES) break;
        }
        if (wanted.length >= MAX_SHADOW_SAMPLES) break;
      }
      await pool(wanted.map((w) => w.ref).filter((r, i, all) => all.findIndex((x) => key(x) === key(r)) === i));
      stop();
      for (const w of wanted) {
        const ev = loaded.get(key(w.ref));
        if (!ev) continue;
        if (evaluated >= maxEvaluations || timeLeft() <= 0) {
          truncated = true;
          break;
        }
        const action = catalog.find((c) => c.id === gateActionId(w.service, w.method));
        if (!action) continue;
        evaluate(ev, action, { kind: 'service', service: w.service }, contextFor(draft.spec, ev.type));
      }
    }

    // (The tokens a user policy reaches are checked too but not counted among the named people.)
    const reach = targeted === null ? null : Math.max(targeted, checkedPrincipals);
    return { evaluated, truncated, principals: { evaluated: checkedPrincipals, targeted: reach }, flips, samples };
  }, deadlineMs + PREVIEW_GRACE_MS);
}
