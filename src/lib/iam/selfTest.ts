/**
 * Self-test of the authorization engine, with no database.
 *
 * Every request of every workspace is decided by the engine, so a process that
 * cannot run it must not serve: the server runs `engineSelfTest()` while it
 * boots and exits when it fails (server/bootstrap.ts), and the readiness endpoint
 * reports `engineHealth()`.
 *
 * What it proves, in order:
 *   1. the Cedar WASM module loads;
 *   2. the schema generated from the action catalog and the resource registry
 *      parses and is preparsed;
 *   3. the managed policy set (the RBAC permits, the boundary forbids, the portal and
 *      approval rules) type-checks against that schema and is preparsed;
 *   4. canned decisions come out right: an admin reads, a plain member cannot
 *      change an administration service, a token with an empty scope reads
 *      nothing, a token limited to one service reaches only that one, a
 *      portal is opened (and its agents run) by the people its access list names
 *      and by nobody else, and a pending tool approval of an agent session is
 *      approved by the people the agent's `approvers` setting appoints and by nobody else
 *      (the generic Write permit leaves `agent.approve` out), a portal that lists its networks
 *      is reached from those only, a workspace owner or admin may open a portal in a marked
 *      test session while a member who sets the flag gains nothing, and a portal that takes
 *      every verified embedded person admits one only when the runtime marks the request,
 *      and looking at / acting on somebody else's session is governed by the level
 *      groups (a reader looks, a writer acts, nobody without `agents` does) -
 *      with no evaluation error from any managed rule.
 */

import { performance } from 'node:perf_hooks';
import { getCedarVersion, statefulIsAuthorized } from './cedar';
import { buildAuthorizeCall, ensureManagedPolicySet, getIamEngineStats } from './engine';
import { getEnforceStats } from './enforce';
import type { IamRequestContext } from './context';
import { tokenPrincipal, userPrincipal, type IamPrincipal, type IamResource } from './entities';
import { ALL_MANAGED_POLICIES } from './managedPolicies';
import { agentSessionResource, portalAgentSessionResource } from './agentEntities';
import { portalAgentResource, portalResource, type PortalSubject } from './portalEntities';
import { ensureSchemaPreparsed, validateAgainstSchema } from './schemaState';

export type EngineSelfTestResult =
  | { ok: true; durationMs: number; cedar: { sdk: string; language: string }; checks: number }
  | { ok: false; error: string };

const SELF_TEST_TENANT = 'iam-selftest';

interface CannedDecision {
  name: string;
  principal: IamPrincipal;
  action: string;
  /** The service a gate decision is about; ignored when `resource` is given. */
  service: string;
  resource?: IamResource;
  context?: IamRequestContext;
  expect: boolean;
}

/** A portal that admits one person and one group: what the portal rules are checked against. */
const CANNED_PORTAL: PortalSubject = {
  id: 'iam-selftest-portal',
  key: 'iam-selftest',
  access: { mode: 'selected', userIds: ['iam-selftest-listed'], groupIds: ['iam-selftest-group'] },
};

/** The same portal, usable from one network only. */
const CANNED_NETWORK_PORTAL: PortalSubject = {
  ...CANNED_PORTAL,
  id: 'iam-selftest-portal-net',
  access: { ...CANNED_PORTAL.access, networks: { mode: 'allow_list', cidrs: ['10.20.0.0/16', '2001:db8::/32'] } },
};

/** The same portal, open to every person its embed verified. */
const CANNED_EMBED_PORTAL: PortalSubject = {
  ...CANNED_PORTAL,
  id: 'iam-selftest-portal-embed',
  access: { ...CANNED_PORTAL.access, embedded: 'any_verified' },
};

function cannedDecisions(): CannedDecision[] {
  const admin = userPrincipal({ userId: 'iam-selftest-admin', user: { role: 'admin' } });
  const member = userPrincipal({ userId: 'iam-selftest-member', user: { role: 'user' } });
  const unscoped = tokenPrincipal({ tokenId: 'iam-selftest-token-open', owner: admin, scope: null });
  const emptyScope = tokenPrincipal({ tokenId: 'iam-selftest-token-empty', owner: admin, scope: {} });
  const oneService = tokenPrincipal({ tokenId: 'iam-selftest-token-models', owner: admin, scope: { models: 'read' } });
  const listed = userPrincipal({ userId: 'iam-selftest-listed', user: { role: 'user' } });
  const grouped = userPrincipal({ userId: 'iam-selftest-grouped', user: { role: 'user' }, groupIds: ['iam-selftest-group'] });
  const listedOwnersToken = tokenPrincipal({ tokenId: 'iam-selftest-token-listed', owner: { ...listed, role: 'owner' }, scope: null });
  const portal = portalResource(CANNED_PORTAL);
  const agent = portalAgentResource({ id: 'iam-selftest-agent', projectId: 'iam-selftest-project' }, CANNED_PORTAL);
  const inPortal: IamRequestContext = { channel: 'portal' };
  const netPortal = portalResource(CANNED_NETWORK_PORTAL);
  const netAgent = portalAgentResource({ id: 'iam-selftest-agent', projectId: 'iam-selftest-project' }, CANNED_NETWORK_PORTAL);
  const embedPortal = portalResource(CANNED_EMBED_PORTAL);
  const embedAgent = portalAgentResource({ id: 'iam-selftest-agent', projectId: 'iam-selftest-project' }, CANNED_EMBED_PORTAL);

  // A session of an agent, started by `starter`: who may answer its pending requests under each setting.
  const starter = userPrincipal({ userId: 'iam-selftest-starter', user: { role: 'user' }, projects: ['iam-selftest-project'] });
  const colleague = userPrincipal({ userId: 'iam-selftest-colleague', user: { role: 'user' }, projects: ['iam-selftest-project'] });
  const projectAdmin = userPrincipal({
    userId: 'iam-selftest-project-admin', user: { role: 'user' }, projects: ['iam-selftest-project'], adminProjects: ['iam-selftest-project'],
  });
  const elsewhere = userPrincipal({
    userId: 'iam-selftest-elsewhere', user: { role: 'user' }, projects: ['iam-selftest-other'], adminProjects: ['iam-selftest-other'],
  });
  const reader = userPrincipal({
    userId: 'iam-selftest-reader', user: { role: 'user', servicePermissions: { agents: 'read' } }, projects: ['iam-selftest-project'],
  });
  const startersToken = tokenPrincipal({ tokenId: 'iam-selftest-token-starter', owner: starter, scope: null });
  const readOnlyToken = tokenPrincipal({ tokenId: 'iam-selftest-token-read', owner: starter, scope: { agents: 'read' } });
  const session = (approvers: 'owner' | 'owner_or_admin' | 'project_members') => agentSessionResource({
    id: 'iam-selftest-agent', projectId: 'iam-selftest-project', ownerIds: [starter.userId], approvers,
  });
  const portalSession = portalAgentSessionResource(
    { id: 'iam-selftest-agent', projectId: 'iam-selftest-project', ownerIds: [listed.userId], approvers: 'owner_or_admin' },
    CANNED_PORTAL,
  );
  return [
    { name: 'admin reads models', principal: admin, action: 'models.read', service: 'models', expect: true },
    { name: 'member writes agents', principal: member, action: 'agents.write', service: 'agents', expect: true },
    { name: 'member cannot change members', principal: member, action: 'members.write', service: 'members', expect: false },
    { name: 'unscoped token acts as its owner', principal: unscoped, action: 'models.write', service: 'models', expect: true },
    { name: 'empty scope reads nothing', principal: emptyScope, action: 'models.read', service: 'models', expect: false },
    { name: 'scoped token reads its service', principal: oneService, action: 'models.read', service: 'models', expect: true },
    { name: 'scoped token stops at its scope', principal: oneService, action: 'agents.read', service: 'agents', expect: false },
    { name: 'a listed person opens a portal', principal: listed, action: 'portal.use', service: 'portals', resource: portal, context: inPortal, expect: true },
    { name: 'a member of a listed group opens a portal', principal: grouped, action: 'portal.use', service: 'portals', resource: portal, context: inPortal, expect: true },
    { name: 'an admin who is not listed does not', principal: admin, action: 'portal.use', service: 'portals', resource: portal, context: inPortal, expect: false },
    { name: 'a token does not, whoever owns it', principal: listedOwnersToken, action: 'portal.use', service: 'portals', resource: portal, context: inPortal, expect: false },
    { name: 'a listed person runs an agent in a portal', principal: listed, action: 'agent.invoke', service: 'agents', resource: agent, context: inPortal, expect: true },
    { name: 'an admin who is not listed does not run one', principal: admin, action: 'agent.invoke', service: 'agents', resource: agent, context: inPortal, expect: false },
    { name: 'whoever started a session answers it', principal: starter, action: 'agent.approve', service: 'agents', resource: session('owner'), expect: true },
    { name: 'a colleague does not, when only the starter may', principal: colleague, action: 'agent.approve', service: 'agents', resource: session('owner'), expect: false },
    { name: 'a colleague does not, when admins may', principal: colleague, action: 'agent.approve', service: 'agents', resource: session('owner_or_admin'), expect: false },
    { name: 'an admin of the project does, when admins may', principal: projectAdmin, action: 'agent.approve', service: 'agents', resource: session('owner_or_admin'), expect: true },
    { name: 'a workspace admin does, when admins may', principal: admin, action: 'agent.approve', service: 'agents', resource: session('owner_or_admin'), expect: true },
    { name: 'an admin of another project does not', principal: elsewhere, action: 'agent.approve', service: 'agents', resource: session('owner_or_admin'), expect: false },
    { name: 'a colleague does, when every member may', principal: colleague, action: 'agent.approve', service: 'agents', resource: session('project_members'), expect: true },
    { name: 'a token answers like its owner', principal: startersToken, action: 'agent.approve', service: 'agents', resource: session('owner'), expect: true },
    { name: 'a token scoped to viewing agents does not', principal: readOnlyToken, action: 'agent.approve', service: 'agents', resource: session('owner'), expect: false },
    { name: 'a reader looks at somebody else\'s session', principal: reader, action: 'agent.session_view_others', service: 'agents', resource: session('owner'), expect: true },
    { name: 'a reader does not act on it', principal: reader, action: 'agent.session_manage_others', service: 'agents', resource: session('owner'), expect: false },
    { name: 'a writer acts on it', principal: colleague, action: 'agent.session_manage_others', service: 'agents', resource: session('owner'), expect: true },
    { name: 'a listed person answers in a portal', principal: listed, action: 'agent.approve', service: 'agents', resource: portalSession, context: inPortal, expect: true },
    { name: 'an admin who is not listed does not, in a portal', principal: admin, action: 'agent.approve', service: 'agents', resource: portalSession, context: inPortal, expect: false },
    { name: 'a listed person opens a network-bound portal from its network', principal: listed, action: 'portal.use', service: 'portals', resource: netPortal, context: { channel: 'portal', ip: '10.20.30.40' }, expect: true },
    { name: 'a listed person runs an agent there from its network', principal: listed, action: 'agent.invoke', service: 'agents', resource: netAgent, context: { channel: 'portal', ip: '2001:db8:1::7' }, expect: true },
    { name: 'a listed person is refused from another network', principal: listed, action: 'portal.use', service: 'portals', resource: netPortal, context: { channel: 'portal', ip: '192.0.2.9' }, expect: false },
    { name: 'a listed person is refused its agents from another network', principal: listed, action: 'agent.invoke', service: 'agents', resource: netAgent, context: { channel: 'portal', ip: '192.0.2.9' }, expect: false },
    { name: 'and without a readable address', principal: listed, action: 'portal.use', service: 'portals', resource: netPortal, context: inPortal, expect: false },
    { name: 'an admin opens a portal in a test session', principal: admin, action: 'portal.use', service: 'portals', resource: portal, context: { channel: 'portal', test: true }, expect: true },
    { name: 'an admin runs its agents in a test session', principal: admin, action: 'agent.invoke', service: 'agents', resource: agent, context: { channel: 'portal', test: true }, expect: true },
    { name: 'a member who claims a test session gains nothing', principal: member, action: 'portal.use', service: 'portals', resource: portal, context: { channel: 'portal', test: true }, expect: false },
    { name: 'a test session does not cross the network boundary', principal: admin, action: 'portal.use', service: 'portals', resource: netPortal, context: { channel: 'portal', test: true, ip: '192.0.2.9' }, expect: false },
    { name: 'an embedded person is admitted when the portal takes every verified one', principal: member, action: 'portal.use', service: 'portals', resource: embedPortal, context: { channel: 'portal', embedded: true }, expect: true },
    { name: 'and runs its agents', principal: member, action: 'agent.invoke', service: 'agents', resource: embedAgent, context: { channel: 'portal', embedded: true }, expect: true },
    { name: 'but not when the request is not marked embedded', principal: member, action: 'portal.use', service: 'portals', resource: embedPortal, context: inPortal, expect: false },
    { name: 'nor in a portal that keeps the access list', principal: member, action: 'portal.use', service: 'portals', resource: portal, context: { channel: 'portal', embedded: true }, expect: false },
  ];
}

function runCanned(setId: string): string | null {
  for (const c of cannedDecisions()) {
    const { call } = buildAuthorizeCall(
      {
        tenant: SELF_TEST_TENANT,
        principal: c.principal,
        action: c.action,
        resource: c.resource ?? { kind: 'service', service: c.service },
        context: c.context ?? { channel: c.principal.kind === 'token' ? 'api' : 'dashboard' },
      },
      SELF_TEST_TENANT,
    );
    const decision = statefulIsAuthorized({ ...call, policySetId: setId });
    if (!decision.ok) return `${c.name}: ${decision.errors.join('; ') || 'the evaluation failed'}`;
    if (decision.errors.length > 0) return `${c.name}: ${decision.errors.join('; ')}`;
    if (decision.allowed !== c.expect) return `${c.name}: expected ${c.expect ? 'allow' : 'deny'}, got ${decision.allowed ? 'allow' : 'deny'}`;
  }
  return null;
}

/** The full check (steps 1-4). Never throws. */
export function engineSelfTest(): EngineSelfTestResult {
  const started = performance.now();
  try {
    const cedar = getCedarVersion(); // loads the WASM module

    const schema = ensureSchemaPreparsed();
    if (!schema.ok) return { ok: false, error: `the schema does not load: ${schema.errors.join('; ')}` };

    const typed = validateAgainstSchema({ ...ALL_MANAGED_POLICIES });
    if (!typed.valid) {
      return { ok: false, error: `the managed policies do not match the schema: ${typed.errors.map((e) => e.message).join('; ')}` };
    }
    const managed = ensureManagedPolicySet();
    if (!managed.ok) return { ok: false, error: managed.error };

    const wrong = runCanned(managed.setId);
    if (wrong) return { ok: false, error: `a canned decision is wrong - ${wrong}` };

    return { ok: true, durationMs: Math.round((performance.now() - started) * 10) / 10, cedar, checks: cannedDecisions().length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The canned decisions alone (microseconds): what the readiness probe re-checks on every call. */
export function engineProbe(): { ok: true } | { ok: false; error: string } {
  try {
    const managed = ensureManagedPolicySet();
    if (!managed.ok) return { ok: false, error: managed.error };
    const wrong = runCanned(managed.setId);
    return wrong ? { ok: false, error: `a canned decision is wrong - ${wrong}` } : { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Refusals ("authorization unavailable") younger than this make the engine `degraded` in the readiness report. */
const RECENT_UNAVAILABLE_MS = 60_000;

export interface EngineHealth {
  status: 'ok' | 'degraded' | 'down';
  message?: string;
  details: Record<string, unknown>;
}

/**
 * The engine's entry in the readiness report (`GET /api/health/ready` ->
 * `checks.authorization-engine`). That endpoint is public, so it carries the
 * status and a few facts about the process - no counters, no tenant data.
 */
export function engineHealth(): EngineHealth {
  const probe = engineProbe();
  const counters = getEnforceStats();
  const engine = getIamEngineStats();
  const unavailableRecently = counters.lastUnavailableAt !== null
    && Date.now() - Date.parse(counters.lastUnavailableAt) < RECENT_UNAVAILABLE_MS;
  const details: Record<string, unknown> = {
    cedar: engine.cedar,
    unavailableRecently,
    skippedStatements: engine.skippedStatements,
  };
  if (!probe.ok) return { status: 'down', message: probe.error, details };
  if (unavailableRecently) return { status: 'degraded', message: 'Requests were refused recently because authorization was unavailable', details };
  if (engine.skippedStatements > 0) return { status: 'degraded', message: 'Some custom policy statements could not be loaded and are not applied', details };
  return { status: 'ok', details };
}
