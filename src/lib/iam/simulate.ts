/**
 * Access check (`POST /api/iam/simulate`): "would this principal be allowed to do
 * this, and why?" - answered by the SAME engine the gate uses, with the same
 * principal construction (groups, project narrowing, token scope, the default
 * project of a token that has none), so the answer is what the gate would decide
 * for the request.
 *
 * Nothing is recorded: a simulation is not traffic, it never touches the
 * decision counters or the audit log.
 *
 * Portals: `portal.use` is checked on a portal and `agent.invoke` on an agent run
 * through one (`context.portalId`), in the `portal` channel, with the portal's access
 * list read through the portal seam (@/enterprise/iam-portal). The person is built
 * the way the portal runtime builds them: no project narrowing, because a portal has
 * no active project.
 *
 * Sessions: `agent.approve`, `agent.session_view_others` and `agent.session_manage_others`
 * are checked on the agent of a SESSION - who started it (`context.ownerId`) and which
 * answerers the agent accepts (`context.approvers`, default `owner_or_admin`) are what the
 * answer depends on, so they are inputs of the check. In the dashboard and API channels the
 * person is built the way the gate builds them (project narrowing included).
 */

import { runWithTenantScope } from '@/lib/database';
import { resolveIamPortal, type IamPortalFacts } from '@/enterprise/iam-portal';
import { isPermissionService } from '@/lib/security/rbac';
import { isSessionResourceAction, RUNTIME_ENFORCED_ACTIONS, type ActionDefinition } from './actions';
import { agentSessionResource, DEFAULT_AGENT_APPROVERS, isAgentApprovers, portalAgentSessionResource, type AgentApprovers } from './agentEntities';
import { IAM_CHANNELS, isIamChannel, normalizeIp, type IamChannel, type IamRequestContext } from './context';
import { authorize, type AuthorizeResult } from './engine';
import type { IamResource } from './entities';
import { loadEvaluationPrincipal, PrincipalError, type EvaluationPrincipal, type IamTenant } from './principals';
import { describeManagedPolicy, statementInfos } from './policyRows';
import { isSafeId, type PolicyIssue } from './policySpec';
import { getIamSchema } from './schemaState';
import { isManagedPolicyId } from './managedPolicies';
import { portalAgentResource, portalResource } from './portalEntities';
import { isRuntimeEnforced } from './runtimeEnforced';
import { listPolicies, policyIdFromCedarId, type IIamPolicy } from './store';

// ── input ────────────────────────────────────────────────────────────────

export type SimulateResourceInput =
  | { kind: 'service'; service: string }
  | { kind: 'resource'; type: string; id: string }
  | { kind: 'project'; projectId: string };

export interface SimulateContextInput {
  projectId?: string;
  channel?: IamChannel;
  /** The portal an agent is run through, or answered through (`agent.invoke` / `agent.approve` in the portal channel). */
  portalId?: string;
  /** A session action: the person who started the session (a user id). Absent = nobody in particular. */
  ownerId?: string;
  /** A session action: which answerers the agent accepts (default `owner_or_admin`). */
  approvers?: AgentApprovers;
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
  portalId?: string;
  ownerId?: string;
  approvers?: AgentApprovers;
  ip?: string;
  at?: Date;
}

/** Actions the PORTAL runtime asks about (`portal.use`, `agent.invoke`, and `agent.approve` in its own channel): decided without any project. */
const isRuntimeAction = (id: string): boolean => RUNTIME_ENFORCED_ACTIONS[id]?.includes('portal') ?? false;

/** Actions that ask about an agent together with the session it concerns. */
const needsPortalAgent = (id: string): boolean => id === 'agent.invoke' || id === 'agent.approve';

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
  let portalId: string | undefined;
  let ownerId: string | undefined;
  let approvers: AgentApprovers | undefined;
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
      if (c.portalId !== undefined && c.portalId !== null && c.portalId !== '') {
        if (isSafeId(c.portalId)) portalId = c.portalId;
        else issues.push({ message: 'context.portalId is not a valid portal id', field: 'context.portalId' });
      }
      if (c.ownerId !== undefined && c.ownerId !== null && c.ownerId !== '') {
        if (isSafeId(c.ownerId)) ownerId = c.ownerId;
        else issues.push({ message: 'context.ownerId is not a valid user id', field: 'context.ownerId' });
      }
      if (c.approvers !== undefined && c.approvers !== null && c.approvers !== '') {
        if (isAgentApprovers(c.approvers)) approvers = c.approvers;
        else issues.push({ message: 'context.approvers must be one of owner, owner_or_admin, project_members', field: 'context.approvers' });
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

  const principalType = isRecord(principal) && principal.type === 'token' ? 'token' : 'user';
  // Opening a portal is only ever asked in the portal channel, by a person: that is the channel to check it in.
  if (action && !channel && action.id === 'portal.use' && principalType === 'user') channel = 'portal';
  if (action && channel === 'portal' && isRuntimeAction(action.id)) {
    if (principalType === 'token') {
      issues.push({ message: 'API tokens cannot open portals or run agents through them; choose a person', field: 'context.channel' });
    }
    if (needsPortalAgent(action.id) && !portalId) {
      issues.push({ message: 'Choose the portal the agent is run through (context.portalId)', field: 'context.portalId' });
    }
  }
  if (portalId && !(action && needsPortalAgent(action.id) && channel === 'portal')) {
    issues.push({ message: 'context.portalId applies to agent.invoke and agent.approve in the portal channel only', field: 'context.portalId' });
  }
  if ((ownerId || approvers) && !(action && isSessionResourceAction(action.id))) {
    issues.push({ message: 'context.ownerId and context.approvers apply to the session actions (agent.approve, agent.session_view_others, agent.session_manage_others) only', field: ownerId ? 'context.ownerId' : 'context.approvers' });
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
    portalId,
    ownerId,
    approvers,
    ip,
    at,
  };
}

// ── resource resolution ──────────────────────────────────────────────────

interface ResolvedResource {
  resource: IamResource;
  /** The project the request runs in, when the resource pins one. */
  projectId?: string;
  /** The portal the check is about (opened, or run through), with its access list. */
  portal?: IamPortalFacts;
}

async function portalOf(tenant: IamTenant, portalId: string): Promise<IamPortalFacts> {
  const facts = await resolveIamPortal(tenant, portalId);
  if (!facts) throw new SimulateInputError('resource_not_found', `The portal "${portalId}" does not exist in this workspace`, 404);
  return facts;
}

/** The session a check about an agent is made for (who started it, which answerers the agent accepts). */
interface SessionFacts {
  ownerId?: string;
  approvers: AgentApprovers;
}

async function resolveResource(
  tenant: IamTenant,
  action: ActionDefinition,
  input: SimulateResourceInput,
  portalId?: string,
  session: SessionFacts = { approvers: DEFAULT_AGENT_APPROVERS },
): Promise<ResolvedResource> {
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
    if (input.type === 'portal') {
      // The registry knows a portal exists; only the portal seam knows who its access list admits.
      const facts = await portalOf(tenant, input.id);
      return { resource: portalResource({ id: facts.id, key: facts.key, access: facts.access }), portal: facts };
    }
    const { getResource } = await import('@/lib/resources/service');
    const detail = await getResource({ tenantDbName: tenant.tenantDbName, tenantId: tenant.tenantId, type: input.type, id: input.id });
    if (!detail) throw new SimulateInputError('resource_not_found', `The ${input.type} "${input.id}" does not exist in this workspace`, 404);
    if (portalId && needsPortalAgent(action.id)) {
      const facts = await portalOf(tenant, portalId);
      if (!facts.agentIds.includes(input.id)) bad(`The portal "${facts.name}" does not offer this agent`, 'context.portalId');
      const agent = { id: input.id, key: detail.key ?? undefined, projectId: detail.projectId };
      return {
        resource: action.id === 'agent.approve'
          ? portalAgentSessionResource({ ...agent, ownerIds: [session.ownerId], approvers: session.approvers }, { id: facts.id, access: facts.access })
          : portalAgentResource(agent, { id: facts.id, access: facts.access }),
        projectId: detail.projectId ?? undefined,
        portal: facts,
      };
    }
    if (isSessionResourceAction(action.id)) {
      return {
        resource: agentSessionResource({ id: input.id, key: detail.key ?? undefined, projectId: detail.projectId, ownerIds: [session.ownerId], approvers: session.approvers }),
        projectId: detail.projectId ?? undefined,
      };
    }
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
  if (isSessionResourceAction(action.id)) {
    return {
      resource: agentSessionResource({ id: '(new)', projectId: input.projectId, ownerIds: [session.ownerId], approvers: session.approvers }),
      projectId: input.projectId,
    };
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
  /**
   * The session a session action was checked for: who started it (null = nobody in particular) and which
   * answerers the agent was assumed to accept.
   */
  session?: { ownerId: string | null; approvers: AgentApprovers };
  /**
   * The portal a `portal.use` / `agent.invoke` check was about: what its access list is (counts only, never the
   * names - the Access check explains a decision, it does not publish the list).
   */
  portal?: {
    id: string;
    key: string;
    name: string;
    status: 'enabled' | 'disabled';
    mode: 'all' | 'selected';
    userCount: number;
    groupCount: number;
  };
}

export async function simulate(tenant: IamTenant, rawInput: unknown): Promise<SimulateResult> {
  const input = parseSimulateInput(rawInput);

  const session: SessionFacts = { ownerId: input.ownerId, approvers: input.approvers ?? DEFAULT_AGENT_APPROVERS };
  const resolved = await resolveResource(tenant, input.action, input.resource, input.portalId, session);
  // The portal runtime builds the person without any project (a portal has none): no narrowing, no project context.
  const inPortal = input.channel === 'portal' && isRuntimeAction(input.action.id);
  // (A session action asked in the dashboard or the API runs in a project like any request: the person is narrowed by it.)
  const projectId = inPortal ? null : input.projectId ?? resolved.projectId ?? null;

  let evaluation: EvaluationPrincipal;
  try {
    evaluation = await loadEvaluationPrincipal(tenant, input.principal, projectId, inPortal ? { workspaceLevel: true } : {});
  } catch (error) {
    if (error instanceof PrincipalError) throw new SimulateInputError('principal_not_found', error.message, 404);
    throw error;
  }

  const context: IamRequestContext = {
    projectId: inPortal ? undefined : evaluation.principal.contextProjectId ?? projectId,
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
    // Service actions are decided by the request gates; portal.use / agent.invoke by the portal runtime in its channel.
    enforcedAtGate: input.action.kind === 'service' || (input.action.kind === 'resource' && isRuntimeEnforced(input.action.id, context.channel as IamChannel)),
    ...(result.errors.length > 0 ? { errors: result.errors.slice(0, 10) } : {}),
    ...(isSessionResourceAction(input.action.id) ? { session: { ownerId: session.ownerId ?? null, approvers: session.approvers } } : {}),
    ...(resolved.portal
      ? {
          portal: {
            id: resolved.portal.id,
            key: resolved.portal.key,
            name: resolved.portal.name,
            status: resolved.portal.status,
            mode: resolved.portal.access.mode,
            userCount: resolved.portal.access.userIds.length,
            groupCount: resolved.portal.access.groupIds.length,
          },
        }
      : {}),
  };
  return out;
}
