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
 *   3. the managed policy set (the RBAC permits and the boundary forbids)
 *      type-checks against that schema and is preparsed;
 *   4. canned decisions come out right: an admin reads, a plain member cannot
 *      change an administration service, a token with an empty scope reads
 *      nothing, a token limited to one service reaches only that one, and a
 *      portal is opened (and its agents run) by the people its access list names
 *      and by nobody else - with no evaluation error from any managed rule.
 */

import { performance } from 'node:perf_hooks';
import { getCedarVersion, statefulIsAuthorized } from './cedar';
import { buildAuthorizeCall, ensureManagedPolicySet, getIamEngineStats } from './engine';
import { getEnforceStats } from './enforce';
import type { IamRequestContext } from './context';
import { tokenPrincipal, userPrincipal, type IamPrincipal, type IamResource } from './entities';
import { ALL_MANAGED_POLICIES } from './managedPolicies';
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
