/**
 * Decision lookup (`GET /api/iam/decisions/:decisionId`): the id a caller saw in a
 * 403 `{ code: 'forbidden', decisionId }` resolves to the audit row the gate
 * wrote, and from it to a ready-to-run access check (`simulateInput`) that
 * reproduces the decision.
 *
 * The same goes for a refusal the portal runtime made (resourceAuthz.ts): its row
 * says which action on which portal or agent, in the portal channel, and replays as
 * that check.
 *
 * A replay runs against the policies as they are NOW. So the record also says what
 * became of the policies that decided: each one with its name and whether it is
 * still in force, disabled, or deleted (a deleted policy's name is read back from the
 * audit trail of policy changes when the denial itself did not keep it).
 */

import { RBAC_SERVICE_DEFINITIONS } from '@/lib/security/rbac';
import { runWithTenantScope } from '@/lib/database';
import { deniedActionOf, IAM_CHANGE_RESOURCE_TYPES } from './audit';
import { DEFAULT_WINDOW_MS } from './auditFeed';
import { resolvePrincipalLabels } from './labels';
import { normalizeIp } from './context';
import type { IamTenant } from './principals';
import type { SimulateInput } from './simulate';
import { getPolicy } from './store';

const ADMIN_SERVICES: ReadonlySet<string> = new Set(RBAC_SERVICE_DEFINITIONS.filter((d) => d.adminService).map((d) => d.id));

/** What the gate generates (`randomUUID()`); anything else cannot be a decision id and is not looked up. */
export const DECISION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A custom policy that decided, and what became of it since. */
export interface DecisionPolicy {
  policyId: string;
  /** Its name now, else the one the denial or the policy-change trail kept; null when none is known. */
  name: string | null;
  /** `deleted`: the policy no longer exists. `disabled`: it exists but takes no part in decisions. */
  status: 'active' | 'disabled' | 'deleted';
}

export interface DecisionRecord {
  decisionId: string;
  at: string;
  principal: { type: 'user' | 'token'; id: string; label: string };
  service: string;
  required: string;
  route: string;
  method: string;
  code: string;
  /** The channel the request arrived on, when the record says (`portal` for a refusal of the portal runtime). */
  channel?: string;
  /** What the decision was about, for a refusal about a single resource (a portal, an agent run through one). */
  resource?: { type: string; id: string; label?: string };
  /** Feed this to the access check; null when the decision cannot be replayed (e.g. an undeclared route). */
  simulateInput: SimulateInput | null;
  /** What decided it, when the gate recorded it: custom policy ids and Cedar ids (empty = default deny). */
  policyIds: string[];
  /** `policyIds` with their names and what became of them. */
  policies: DecisionPolicy[];
  reasons: string[];
}

const NAME_LOOKUP_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

/** The name a deleted policy had, read from the audit trail of policy changes (the newest row that names it). */
async function deletedPolicyName(tenant: IamTenant, policyId: string): Promise<string | null> {
  try {
    const page = await runWithTenantScope(tenant.tenantDbName, (db) => db.iamListAuditEvents({
      tenantId: tenant.tenantId,
      from: new Date(Date.now() - NAME_LOOKUP_WINDOW_MS),
      service: 'iam',
      resourceTypes: [...IAM_CHANGE_RESOURCE_TYPES],
      metadata: { key: 'policyId', value: policyId },
      limit: 1,
      maxTimeMs: 8_000,
    }));
    const name = page.items[0]?.metadata?.name;
    return typeof name === 'string' && name ? name : null;
  } catch {
    return null;
  }
}

async function describePolicies(tenant: IamTenant, policyIds: readonly string[], kept: Record<string, unknown>): Promise<DecisionPolicy[]> {
  const out: DecisionPolicy[] = [];
  for (const policyId of policyIds) {
    const keptName = typeof kept[policyId] === 'string' && kept[policyId] ? String(kept[policyId]) : null;
    let policy: Awaited<ReturnType<typeof getPolicy>>;
    try {
      policy = await getPolicy(tenant.tenantDbName, policyId);
    } catch {
      // Cannot tell what became of it: say nothing about its state rather than something wrong.
      out.push({ policyId, name: keptName, status: 'active' });
      continue;
    }
    if (policy) out.push({ policyId, name: policy.name || keptName, status: policy.enabled ? 'active' : 'disabled' });
    else out.push({ policyId, name: keptName ?? (await deletedPolicyName(tenant, policyId)), status: 'deleted' });
  }
  return out;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The check that reproduces a refusal of the portal runtime, or null when it cannot be replayed. */
function portalReplay(
  meta: Record<string, unknown>,
  principalId: string,
  at: string,
  ip: string | null,
): { channel: string; resource: NonNullable<DecisionRecord['resource']>; input: SimulateInput | null } | null {
  if (meta.channel !== 'portal') return null;
  const action = text(meta.action);
  const type = text(meta.resourceType);
  const id = text(meta.resourceId);
  const portalId = text(meta.portalId);
  const label = text(meta.resourceName);
  if (!action || !type || !id) return null;
  const replayable = meta.code === 'forbidden' && !!principalId && (action !== 'agent.invoke' || !!portalId);
  return {
    channel: 'portal',
    resource: { type, id, ...(label ? { label } : {}) },
    input: replayable
      ? {
          principal: { type: 'user', id: principalId },
          action,
          resource: { kind: 'resource', type, id },
          context: {
            channel: 'portal',
            ...(action === 'agent.invoke' && portalId ? { portalId } : {}),
            ...(ip ? { ip } : {}),
            at,
          },
        }
      : null,
  };
}

export async function getDecision(tenant: IamTenant, decisionId: string): Promise<DecisionRecord | null> {
  if (!DECISION_ID_RE.test(decisionId)) return null;
  const page = await runWithTenantScope(tenant.tenantDbName, (db) => db.iamListAuditEvents({
    tenantId: tenant.tenantId,
    // The lookup filters on an unindexed metadata field, so it is bounded by the one
    // indexed thing the audit table has: time. Denials older than the feed's window
    // are not looked up (an unknown id would otherwise read the whole table).
    from: new Date(Date.now() - DEFAULT_WINDOW_MS),
    metadata: { key: 'decisionId', value: decisionId },
    limit: 1,
    maxTimeMs: 8_000,
  }));
  const row = page.items[0];
  if (!row) return null;

  const meta = row.metadata ?? {};
  const code = typeof meta.code === 'string' ? meta.code : 'forbidden';
  const service = typeof meta.deniedService === 'string' ? meta.deniedService : row.service;
  const required = typeof meta.required === 'string' ? meta.required : '';
  const isToken = !!row.apiTokenId;
  const principalId = (isToken ? row.apiTokenId : row.actorUserId) ?? '';
  const labels = await resolvePrincipalLabels(tenant, {
    users: !isToken && row.actorUserId ? [row.actorUserId] : [],
    tokens: isToken && row.apiTokenId ? [row.apiTokenId] : [],
  });
  const label = (isToken ? labels.tokens.get(principalId) : labels.users.get(principalId)) ?? row.actorEmail ?? principalId;

  const action = typeof meta.action === 'string' ? meta.action : deniedActionOf(row, ADMIN_SERVICES);
  const replayable = code === 'forbidden' && !!action && !!principalId && !!service;
  const projectId = typeof meta.contextProjectId === 'string' ? meta.contextProjectId : row.projectId;
  // The address the engine evaluated. The audit row's own IP is a log value, not
  // an input of the decision, so an older row without contextIp replays without one.
  const ip = normalizeIp(typeof meta.contextIp === 'string' ? meta.contextIp : null);
  const at = new Date(row.createdAt ?? 0).toISOString();
  const portal = isToken ? null : portalReplay(meta, principalId, at, ip);
  const policyIds = Array.isArray(meta.policyIds) ? meta.policyIds.filter((x): x is string => typeof x === 'string') : [];
  const keptNames = meta.policyNames && typeof meta.policyNames === 'object' && !Array.isArray(meta.policyNames)
    ? (meta.policyNames as Record<string, unknown>)
    : {};

  return {
    decisionId,
    at,
    principal: { type: isToken ? 'token' : 'user', id: principalId, label },
    service,
    required,
    route: row.path ?? '',
    method: row.method ?? '',
    code,
    ...(portal ? { channel: portal.channel, resource: portal.resource } : {}),
    simulateInput: portal
      ? portal.input
      : replayable
        ? {
            principal: { type: isToken ? 'token' : 'user', id: principalId },
            action: action as string,
            resource: { kind: 'service', service },
            context: {
              ...(projectId ? { projectId } : {}),
              channel: isToken ? 'api' : 'dashboard',
              ...(ip ? { ip } : {}),
              at,
            },
          }
        : null,
    policyIds,
    policies: await describePolicies(tenant, policyIds, keptNames),
    reasons: Array.isArray(meta.reasons) ? meta.reasons.filter((x): x is string => typeof x === 'string') : [],
  };
}
