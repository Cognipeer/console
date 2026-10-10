/**
 * Access check (`POST /api/iam/simulate`): "would this principal be allowed to do
 * this, and why?" - answered by the SAME engine the gate uses, with the same
 * principal construction (groups, project narrowing, token scope, the default
 * project of a token that has none), so the answer is what the gate would decide
 * for the request.
 *
 * Nothing is recorded: a simulation is not traffic, it never touches the
 * decision counters or the audit log.
 */

import { runWithTenantScope } from '@/lib/database';
import { isPermissionService } from '@/lib/security/rbac';
import type { ActionDefinition } from './actions';
import { IAM_CHANNELS, isIamChannel, normalizeIp, type IamChannel, type IamRequestContext } from './context';
import { authorize, type AuthorizeResult } from './engine';
import type { IamResource } from './entities';
import { loadEvaluationPrincipal, PrincipalError, type EvaluationPrincipal, type IamTenant } from './principals';
import { describeManagedPolicy, statementInfos } from './policyRows';
import { isSafeId, type PolicyIssue } from './policySpec';
import { getIamSchema } from './schemaState';
import { isManagedPolicyId } from './managedPolicies';
import { listPolicies, policyIdFromCedarId, type IIamPolicy } from './store';

// ── input ────────────────────────────────────────────────────────────────

export type SimulateResourceInput =
  | { kind: 'service'; service: string }
  | { kind: 'resource'; type: string; id: string }
  | { kind: 'project'; projectId: string };

export interface SimulateContextInput {
  projectId?: string;
  channel?: IamChannel;
  ip?: string;
  /** ISO timestamp the decision is evaluated at (default: now). */
  at?: string;
}

export interface SimulateInput {
  principal: { type: 'user' | 'token'; id: string };
  action: string;
  resource: SimulateResourceInput;
  context?: SimulateContextInput;
}

export class SimulateInputError extends Error {
  readonly code: 'validation' | 'principal_not_found' | 'resource_not_found' | 'engine_unavailable';
  readonly status: number;
  readonly details: PolicyIssue[];
  constructor(
    code: SimulateInputError['code'],
    message: string,
    status: number,
    details: PolicyIssue[] = [],
  ) {
    super(message);
    this.name = 'SimulateInputError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

interface ParsedInput {
  principal: SimulateInput['principal'];
  action: ActionDefinition;
  resource: SimulateResourceInput;
  projectId?: string;
  channel?: IamChannel;
  ip?: string;
  at?: Date;
}

export function parseSimulateInput(input: unknown): ParsedInput {
  const issues: PolicyIssue[] = [];
  if (!isRecord(input)) throw new SimulateInputError('validation', 'The request body must be an object', 400, [{ message: 'The request body must be an object' }]);

  const principal = input.principal;
  if (!isRecord(principal) || (principal.type !== 'user' && principal.type !== 'token') || typeof principal.id !== 'string' || !principal.id) {
    issues.push({ message: 'principal must be { type: "user" | "token", id }', field: 'principal' });
  }

  const catalog = getIamSchema().catalog;
  const action = typeof input.action === 'string' ? catalog.find((a) => a.id === input.action) : undefined;
  if (!action) issues.push({ message: 'action is not an action of the catalog', field: 'action' });
  else if (action.kind === 'group') issues.push({ message: 'Choose a concrete action; Read, Write and Admin are groups for policies only', field: 'action' });

  let resource: SimulateResourceInput | undefined;
  const r = input.resource;
  if (isRecord(r) && r.kind === 'service' && typeof r.service === 'string' && isPermissionService(r.service)) {
    resource = { kind: 'service', service: r.service };
  } else if (isRecord(r) && r.kind === 'resource' && typeof r.type === 'string' && isSafeId(r.id)) {
    resource = { kind: 'resource', type: r.type, id: r.id };
  } else if (isRecord(r) && r.kind === 'project' && isSafeId(r.projectId)) {
    resource = { kind: 'project', projectId: r.projectId };
  } else {
    issues.push({ message: 'resource must be { kind: "service", service } | { kind: "resource", type, id } | { kind: "project", projectId }', field: 'resource' });
  }

  let projectId: string | undefined;
  let channel: IamChannel | undefined;
  let ip: string | undefined;
  let at: Date | undefined;
  if (input.context !== undefined && input.context !== null) {
    const c = input.context;
    if (!isRecord(c)) {
      issues.push({ message: 'context must be an object', field: 'context' });
    } else {
      if (c.projectId !== undefined && c.projectId !== null && c.projectId !== '') {
        if (isSafeId(c.projectId)) projectId = c.projectId;
        else issues.push({ message: 'context.projectId is not a valid project id', field: 'context.projectId' });
      }
      if (c.channel !== undefined && c.channel !== null && c.channel !== '') {
        if (isIamChannel(c.channel)) channel = c.channel;
        else issues.push({ message: `context.channel must be one of ${IAM_CHANNELS.join(', ')}`, field: 'context.channel' });
      }
      if (c.ip !== undefined && c.ip !== null && c.ip !== '') {
        const normalized = normalizeIp(c.ip);
        if (normalized) ip = normalized;
        else issues.push({ message: 'context.ip is not a valid IP address', field: 'context.ip' });
      }
      if (c.at !== undefined && c.at !== null && c.at !== '') {
        const date = typeof c.at === 'string' ? new Date(c.at) : null;
        if (date && !Number.isNaN(date.getTime())) at = date;
        else issues.push({ message: 'context.at must be an ISO 8601 date-time', field: 'context.at' });
      }
    }
  }

  if (issues.length > 0 || !action || !resource) {
    throw new SimulateInputError('validation', issues.map((i) => i.message).join('; ') || 'Invalid request', 400, issues);
  }
  return {
    principal: { type: (principal as { type: 'user' | 'token' }).type, id: (principal as { id: string }).id },
    action,
    resource,
    projectId,
    channel,
    ip,
    at,
  };
}

// ── resource resolution ──────────────────────────────────────────────────

interface ResolvedResource {
  resource: IamResource;
  /** The project the request runs in, when the resource pins one. */
  projectId?: string;
}

async function resolveResource(tenant: IamTenant, action: ActionDefinition, input: SimulateResourceInput): Promise<ResolvedResource> {
  const bad = (message: string, field = 'resource'): never => {
    throw new SimulateInputError('validation', message, 400, [{ message, field }]);
  };

  if (input.kind === 'service') {
    if (action.kind !== 'service') bad('This action applies to a specific resource, not to a whole service');
    if (action.service !== input.service) bad(`The action belongs to the "${action.service}" service, not to "${input.service}"`);
    return { resource: { kind: 'service', service: input.service } };
  }

  if (input.kind === 'resource') {
    if (action.kind !== 'resource' || action.resourceType !== input.type) {
      return bad(`The action does not apply to a ${input.type}`);
    }
    const { getResource } = await import('@/lib/resources/service');
    const detail = await getResource({ tenantDbName: tenant.tenantDbName, tenantId: tenant.tenantId, type: input.type, id: input.id });
    if (!detail) throw new SimulateInputError('resource_not_found', `The ${input.type} "${input.id}" does not exist in this workspace`, 404);
    return {
      resource: {
        kind: 'resource',
        type: input.type,
        id: input.id,
        service: action.service ?? '',
        projectId: detail.projectId,
        key: detail.key ?? undefined,
      },
      projectId: detail.projectId ?? undefined,
    };
  }

  // kind: project - "something in this project": the service-level check made in its context, or a new resource in it.
  const project = await runWithTenantScope(tenant.tenantDbName, async (db) => {
    try {
      return await db.findProjectById(input.projectId);
    } catch {
      return null;
    }
  });
  if (!project || (project.tenantId && String(project.tenantId) !== tenant.tenantId)) {
    throw new SimulateInputError('resource_not_found', `The project "${input.projectId}" does not exist in this workspace`, 404);
  }
  if (action.kind === 'service') {
    return { resource: { kind: 'service', service: action.service ?? '' }, projectId: input.projectId };
  }
  return {
    resource: { kind: 'resource', type: action.resourceType ?? '', id: '(new)', service: action.service ?? '', projectId: input.projectId },
    projectId: input.projectId,
  };
}

// ── reasons ──────────────────────────────────────────────────────────────

export interface SimulateReason {
  cedarId: string;
  policyId: string | null;
  managed: boolean;
  name: string;
  effect: 'permit' | 'forbid';
}

function statementIndexOf(cedarId: string): number {
  const hash = cedarId.lastIndexOf('#');
  return hash === -1 ? 0 : Number.parseInt(cedarId.slice(hash + 1), 10) || 0;
}

/** Cedar ids -> names and effects an admin can read. */
export function explainReasons(cedarIds: string[], policies: ReadonlyArray<IIamPolicy>): SimulateReason[] {
  const byId = new Map(policies.map((p) => [p.policyId, p]));
  return cedarIds.map((cedarId): SimulateReason => {
    if (isManagedPolicyId(cedarId)) {
      const info = describeManagedPolicy(cedarId);
      return { cedarId, policyId: null, managed: true, name: info.name, effect: info.effect };
    }
    const policyId = policyIdFromCedarId(cedarId);
    const policy = policyId ? byId.get(policyId) : undefined;
    const infos = policy ? statementInfos(policy.cedar) : [];
    const effect = infos[statementIndexOf(cedarId)]?.effect ?? infos[0]?.effect ?? 'permit';
    return { cedarId, policyId, managed: false, name: policy?.name ?? policyId ?? cedarId, effect };
  });
}

// ── result ───────────────────────────────────────────────────────────────

export interface SimulateResult {
  allowed: boolean;
  reasons: SimulateReason[];
  /** Denied because nothing allowed it (no policy matched), not because a policy forbade it. */
  defaultDeny: boolean;
  principalSummary: {
    type: 'user' | 'token';
    id: string;
    label: string;
    role: string;
    groups: Array<{ id: string; name: string }>;
    tokenScope?: Record<string, string> | null;
    status?: string;
  };
  /** The project the check ran in (the one given, or the one a request without an active project would run in); null = none. */
  projectId: string | null;
  /** True when the workspace-owner rule (the owner always reaches the Authorization Engine) decided. */
  ownerSafety?: boolean;
  /**
   * False for a check about an individual resource (`agent.delete` on one agent): the
   * request gates only decide whole services, so this answer is what the policies say,
   * not what a real request would meet.
   */
  enforcedAtGate: boolean;
  /** Problems the engine met while evaluating (a policy that errored); the decision above already accounts for them. */
  errors?: string[];
}

export async function simulate(tenant: IamTenant, rawInput: unknown): Promise<SimulateResult> {
  const input = parseSimulateInput(rawInput);

  const resolved = await resolveResource(tenant, input.action, input.resource);
  const projectId = input.projectId ?? resolved.projectId ?? null;

  let evaluation: EvaluationPrincipal;
  try {
    evaluation = await loadEvaluationPrincipal(tenant, input.principal, projectId);
  } catch (error) {
    if (error instanceof PrincipalError) throw new SimulateInputError('principal_not_found', error.message, 404);
    throw error;
  }

  const context: IamRequestContext = {
    projectId: evaluation.principal.contextProjectId ?? projectId,
    channel: input.channel ?? (evaluation.type === 'token' ? 'api' : 'dashboard'),
    ip: input.ip,
    now: input.at,
  };
  const result: AuthorizeResult = await authorize({
    tenant: tenant.tenantDbName,
    principal: evaluation.principal,
    action: input.action.id,
    resource: resolved.resource,
    context,
  });
  if (result.failed) {
    throw new SimulateInputError('engine_unavailable', 'The policy engine is not available on this server', 503);
  }

  const policies = await listPolicies(tenant.tenantDbName);
  const reasons = explainReasons(result.reasons, policies);

  // The workspace owner can always reach the Authorization Engine, whatever policies say (enforce.ts).
  // (A session promise: a token owned by the owner is an ordinary principal.)
  const ownerSafety = evaluation.type === 'user' && evaluation.role === 'owner' && input.action.service === 'iam' && input.action.kind === 'service';
  const allowed = ownerSafety ? true : result.allowed;

  const out: SimulateResult = {
    allowed,
    reasons,
    defaultDeny: !allowed && result.reasons.length === 0,
    principalSummary: {
      type: evaluation.type,
      id: evaluation.id,
      label: evaluation.label,
      role: evaluation.role,
      groups: evaluation.groups,
      ...(evaluation.type === 'token'
        ? { tokenScope: evaluation.tokenScope == null ? null : (evaluation.tokenScope as Record<string, string>) }
        : {}),
      ...(evaluation.accountDisabled ? { status: 'disabled' } : {}),
    },
    projectId: typeof context.projectId === 'string' && context.projectId ? context.projectId : null,
    ...(ownerSafety ? { ownerSafety: true } : {}),
    enforcedAtGate: input.action.kind !== 'resource',
    ...(result.errors.length > 0 ? { errors: result.errors.slice(0, 10) } : {}),
  };
  return out;
}
