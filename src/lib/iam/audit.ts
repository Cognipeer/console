/**
 * Authorization audit (A6): what is written when an admin changes the policy
 * engine, and the read side behind `GET /api/iam/audit`.
 *
 * Written rows (service `iam`, action `admin`, outcome `success`):
 *   iam.policy.create | iam.policy.update | iam.policy.delete   resourceType iam-policy
 *   iam.settings.update                                         resourceType iam-settings
 *   iam.mode.change                                             resourceType iam-mode
 * `metadata` carries `iamChange: true` plus, for a policy: policyId, name, mode,
 * enabled, effect, statementCount and the new Cedar (at most 4 KB, `cedarTruncated`
 * says when it was cut). Enforce-mode denials are written by the request gate
 * (server/api/plugin.ts) with `metadata.iamEnforce` and a `decisionId`.
 *
 * Writing is awaited and never throws: a policy change must not fail because its
 * audit row could not be stored, but the failure is logged at error level.
 */

import type { FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope, type IAuditLog } from '@/lib/database';
import type { IIamPolicy } from './store';
import { summarizeEffect } from './policyRows';

const logger = createLogger('iam:audit');

export const MAX_AUDITED_CEDAR_BYTES = 4 * 1024;

export const IAM_CHANGE_RESOURCE_TYPES = ['iam-policy', 'iam-settings', 'iam-mode'] as const;
export type IamChangeResourceType = typeof IAM_CHANGE_RESOURCE_TYPES[number];

export type IamChangeEvent =
  | 'iam.policy.create'
  | 'iam.policy.update'
  | 'iam.policy.delete'
  | 'iam.settings.update'
  | 'iam.mode.change';

export interface IamActor {
  tenantDbName: string;
  tenantId: string;
  userId: string;
  userEmail?: string;
  userRole: string;
  requestId?: string;
}

/** `text` cut to at most `maxBytes` UTF-8 bytes (never in the middle of a character). */
export function clipToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) end--;
  return { text: text.slice(0, end), truncated: true };
}

/** The metadata that describes a policy in an audit row. */
export function policyAuditMetadata(policy: Pick<IIamPolicy, 'policyId' | 'name' | 'mode' | 'enabled' | 'cedar' | 'spec'>): Record<string, unknown> {
  const { effect, statementCount } = summarizeEffect(policy.cedar);
  const cedar = clipToBytes(policy.cedar, MAX_AUDITED_CEDAR_BYTES);
  return {
    iamChange: true,
    policyId: policy.policyId,
    name: policy.name.slice(0, 200),
    mode: policy.mode,
    enabled: policy.enabled,
    effect,
    statementCount,
    source: policy.spec ? 'spec' : 'cedar',
    cedar: cedar.text,
    ...(cedar.truncated ? { cedarTruncated: true } : {}),
  };
}

function statusFor(event: IamChangeEvent): number {
  if (event === 'iam.policy.create') return 201;
  if (event === 'iam.policy.delete') return 204;
  return 200;
}

export async function recordIamChange(
  request: FastifyRequest,
  actor: IamActor,
  entry: {
    event: IamChangeEvent;
    resourceType: IamChangeResourceType;
    resourceId?: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const path = (request.raw.url ?? '').split('?')[0];
    // Bound to the tenant with a real scope (never the process-global binding).
    await runWithTenantScope(actor.tenantDbName, (db) => db.createAuditLog({
        tenantId: actor.tenantId,
        actorType: 'user',
        actorUserId: actor.userId,
        actorEmail: actor.userEmail,
        actorRole: actor.userRole,
        service: 'iam',
        action: 'admin',
        event: entry.event,
        method: request.method.toUpperCase(),
        path,
        statusCode: statusFor(entry.event),
        outcome: 'success',
        ipAddress: request.ip,
        userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'].slice(0, 300) : undefined,
        requestId: actor.requestId ?? request.apiRequestId,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        metadata: { iamChange: true, ...entry.metadata },
    }));
  } catch (error) {
    logger.error('Could not write the audit row of an authorization change', {
      event: entry.event,
      resourceId: entry.resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ── read side ────────────────────────────────────────────────────────────

/** The gate action a denial was about, reconstructed from the audit row. */
export function deniedActionOf(row: Pick<IAuditLog, 'method' | 'service' | 'metadata'>, adminServices: ReadonlySet<string>): string | null {
  const meta = row.metadata ?? {};
  const code = typeof meta.code === 'string' ? meta.code : '';
  if (code === 'route_not_declared') return null;
  const service = typeof meta.deniedService === 'string' ? meta.deniedService : row.service;
  const required = typeof meta.required === 'string' ? meta.required : '';
  if (!service || !['read', 'write', 'admin'].includes(required)) return null;
  const methodLevel = ['GET', 'HEAD', 'OPTIONS'].includes((row.method ?? 'GET').toUpperCase()) ? 'read' : 'write';
  if (required === methodLevel) return `${service}.${methodLevel}`;
  // A mutation on an administration service needs `admin`, and the gate asks the Write action.
  if (required === 'admin' && methodLevel === 'write' && adminServices.has(service)) return `${service}.write`;
  // Otherwise the route declared its own level.
  return `${service}.${required}`;
}
