/**
 * Decision lookup (`GET /api/iam/decisions/:decisionId`): the id a caller saw in a
 * 403 `{ code: 'forbidden', decisionId }` resolves to the audit row the gate
 * wrote, and from it to a ready-to-run access check (`simulateInput`) that
 * reproduces the decision.
 */

import { RBAC_SERVICE_DEFINITIONS } from '@/lib/security/rbac';
import { runWithTenantScope } from '@/lib/database';
import { deniedActionOf } from './audit';
import { DEFAULT_WINDOW_MS } from './auditFeed';
import { resolvePrincipalLabels } from './labels';
import { normalizeIp } from './context';
import type { IamTenant } from './principals';
import type { SimulateInput } from './simulate';

const ADMIN_SERVICES: ReadonlySet<string> = new Set(RBAC_SERVICE_DEFINITIONS.filter((d) => d.adminService).map((d) => d.id));

/** What the gate generates (`randomUUID()`); anything else cannot be a decision id and is not looked up. */
export const DECISION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DecisionRecord {
  decisionId: string;
  at: string;
  principal: { type: 'user' | 'token'; id: string; label: string };
  service: string;
  required: string;
  route: string;
  method: string;
  code: string;
  /** Feed this to the access check; null when the decision cannot be replayed (e.g. an undeclared route). */
  simulateInput: SimulateInput | null;
  /** What decided it, when the gate recorded it: custom policy ids and Cedar ids (empty = default deny). */
  policyIds: string[];
  reasons: string[];
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

  return {
    decisionId,
    at: new Date(row.createdAt ?? 0).toISOString(),
    principal: { type: isToken ? 'token' : 'user', id: principalId, label },
    service,
    required,
    route: row.path ?? '',
    method: row.method ?? '',
    code,
    simulateInput: replayable
      ? {
          principal: { type: isToken ? 'token' : 'user', id: principalId },
          action: action as string,
          resource: { kind: 'service', service },
          context: {
            ...(projectId ? { projectId } : {}),
            channel: isToken ? 'api' : 'dashboard',
            ...(ip ? { ip } : {}),
            at: new Date(row.createdAt ?? 0).toISOString(),
          },
        }
      : null,
    policyIds: Array.isArray(meta.policyIds) ? meta.policyIds.filter((x): x is string => typeof x === 'string') : [],
    reasons: Array.isArray(meta.reasons) ? meta.reasons.filter((x): x is string => typeof x === 'string') : [],
  };
}
