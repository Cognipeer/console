/**
 * Custom policy store.
 *
 * Collections (tenant database, created lazily on first use, identical on
 * MongoDB and SQLite — see database/{mongodb,sqlite}/iam-docs.mixin.ts):
 *
 *   iam_policies  one document per custom policy, keyed by `policyId`
 *   iam_meta      { id: 'policy_version', value: <counter> } — bumped on every
 *                 policy write; other nodes notice a change by polling it
 *
 * Writes validate the Cedar text against the generated schema FIRST and refuse
 * anything with parse errors or validation errors (Cedar's `validate` answers
 * "success" even when it found validation errors, so the check is explicit).
 *
 * `spec` (A4): a policy written in the visual editor keeps its structured form
 * next to the Cedar it compiles to (`null` = raw Cedar). Cedar is what is
 * evaluated; the spec only lets the editor re-open it. A policy saved with a
 * spec must have EXACTLY the Cedar that spec compiles to, otherwise the editor
 * would show something the engine does not run. HTTP API: plugins/iam.ts.
 */

import { randomBytes } from 'node:crypto';
import { runWithTenantScope } from '@/lib/database';
import type { CedarMessage } from './cedar';
import { invalidateTenantPolicies } from './events';
import { compileSpecToCedar, type PolicySpec } from './policySpec';
import {
  MAX_POLICIES_PER_TENANT,
  MAX_STATEMENTS_PER_TENANT,
  MAX_TENANT_POLICY_BYTES,
  validateCustomPolicyText,
  type PolicyValidation,
} from './policyText';
import { splitPolicyText } from './cedar';

// Kept importable from here (the original home of the validation).
export {
  MAX_POLICIES_PER_TENANT,
  MAX_POLICY_TEXT_BYTES,
  MAX_STATEMENTS_PER_POLICY,
  MAX_STATEMENTS_PER_TENANT,
  MAX_TENANT_POLICY_BYTES,
  validateCustomPolicyText,
  type PolicyValidation,
} from './policyText';

export type IamPolicyMode = 'enforce' | 'monitor';

export interface IIamPolicy {
  /** Stable record id (same value as `policyId`; kept for API symmetry with other stores). */
  _id: string;
  /** Unique slug within the tenant. Cedar policy ids are derived from it. */
  policyId: string;
  name: string;
  description?: string;
  /** Cedar policy text: one or more `permit`/`forbid` statements (no templates). */
  cedar: string;
  /** The structured form the visual editor wrote (`cedar` is its compilation); null = raw Cedar. */
  spec: PolicySpec | null;
  /** `monitor` policies are evaluated but never change a decision. */
  mode: IamPolicyMode;
  enabled: boolean;
  /** Reserved for per-service set splitting: the service the policy is scoped to. */
  service?: string;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export type IamPolicyErrorCode = 'validation' | 'conflict' | 'not_found' | 'invalid_input' | 'limit_reached';

export class IamPolicyError extends Error {
  readonly code: IamPolicyErrorCode;
  readonly details: CedarMessage[];
  constructor(code: IamPolicyErrorCode, message: string, details: CedarMessage[] = []) {
    super(message);
    this.name = 'IamPolicyError';
    this.code = code;
    this.details = details;
  }
}

const POLICIES = 'iam_policies' as const;
const META = 'iam_meta' as const;
const VERSION_DOC = 'policy_version';
const VERSION_FIELD = 'value';

const POLICY_ID_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

// ── Cedar id mapping ─────────────────────────────────────────────────────

/** Cedar policy ids of a stored policy with `count` statements. */
export function customCedarIds(policyId: string, count: number): string[] {
  return count <= 1
    ? [`custom:${policyId}`]
    : Array.from({ length: count }, (_, i) => `custom:${policyId}#${i}`);
}

/** Inverse of customCedarIds: Cedar id -> store policyId (null for managed/unknown ids). */
export function policyIdFromCedarId(cedarId: string): string | null {
  if (!cedarId.startsWith('custom:')) return null;
  const rest = cedarId.slice('custom:'.length);
  const hash = rest.lastIndexOf('#');
  return hash === -1 ? rest : rest.slice(0, hash);
}

// ── mapping ──────────────────────────────────────────────────────────────

function toDoc(policy: IIamPolicy): Record<string, unknown> {
  return {
    _id: policy._id,
    policyId: policy.policyId,
    name: policy.name,
    description: policy.description ?? null,
    cedar: policy.cedar,
    spec: policy.spec ?? null,
    mode: policy.mode,
    enabled: policy.enabled,
    service: policy.service ?? null,
    createdBy: policy.createdBy,
    updatedBy: policy.updatedBy,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  };
}

function fromDoc(data: Record<string, unknown>): IIamPolicy {
  const policyId = String(data.policyId);
  return {
    _id: String(data._id ?? policyId),
    policyId,
    name: String(data.name ?? policyId),
    description: typeof data.description === 'string' ? data.description : undefined,
    cedar: String(data.cedar ?? ''),
    // Old rows have no `spec`; anything that is not an object reads as raw Cedar.
    spec: data.spec && typeof data.spec === 'object' && !Array.isArray(data.spec) ? (data.spec as PolicySpec) : null,
    mode: data.mode === 'monitor' ? 'monitor' : 'enforce',
    enabled: data.enabled !== false,
    service: typeof data.service === 'string' ? data.service : undefined,
    createdBy: String(data.createdBy ?? ''),
    updatedBy: String(data.updatedBy ?? data.createdBy ?? ''),
    createdAt: new Date(String(data.createdAt ?? 0)),
    updatedAt: new Date(String(data.updatedAt ?? 0)),
  };
}

// ── version counter ──────────────────────────────────────────────────────

/** Current policy version of the tenant (0 when the tenant never had a custom policy). */
export async function getPolicyVersion(tenantDbName: string): Promise<number> {
  return runWithTenantScope(tenantDbName, async (db) => {
    const doc = await db.iamDocGet(META, VERSION_DOC);
    const value = doc?.data?.[VERSION_FIELD];
    return typeof value === 'number' ? value : 0;
  });
}

async function bumpPolicyVersion(tenantDbName: string): Promise<number> {
  const next = await runWithTenantScope(tenantDbName, (db) =>
    db.iamDocIncrement(META, VERSION_DOC, VERSION_FIELD, 1),
  );
  invalidateTenantPolicies(tenantDbName);
  return next;
}

// ── CRUD ─────────────────────────────────────────────────────────────────

export interface ListPoliciesOptions {
  enabled?: boolean;
  mode?: IamPolicyMode;
  service?: string;
}

export async function listPolicies(
  tenantDbName: string,
  options: ListPoliciesOptions = {},
): Promise<IIamPolicy[]> {
  const docs = await runWithTenantScope(tenantDbName, (db) => db.iamDocList(POLICIES, { limit: 10_000 }));
  return docs
    .map((d) => fromDoc(d.data))
    .filter((p) => options.enabled === undefined || p.enabled === options.enabled)
    .filter((p) => !options.mode || p.mode === options.mode)
    .filter((p) => !options.service || p.service === options.service);
}

export async function getPolicy(tenantDbName: string, policyId: string): Promise<IIamPolicy | null> {
  const doc = await runWithTenantScope(tenantDbName, (db) => db.iamDocGet(POLICIES, policyId));
  return doc ? fromDoc(doc.data) : null;
}

export interface CreatePolicyInput {
  /** Optional slug; generated when omitted. */
  policyId?: string;
  name: string;
  description?: string;
  cedar: string;
  /** The spec `cedar` was compiled from (visual editor); omit for raw Cedar. */
  spec?: PolicySpec | null;
  mode?: IamPolicyMode;
  enabled?: boolean;
  service?: string;
}

/** A spec and the Cedar stored with it must agree; the compiler is pure, so this is a cheap integrity check. */
function assertSpecMatches(spec: PolicySpec | null | undefined, cedar: string): void {
  if (!spec) return;
  let expected: string;
  try {
    expected = compileSpecToCedar(spec);
  } catch (error) {
    throw new IamPolicyError('invalid_input', `The policy spec cannot be compiled: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (expected !== cedar) {
    throw new IamPolicyError('invalid_input', 'The stored Cedar does not match the policy spec it claims to come from');
  }
}

function assertValid(cedar: string): PolicyValidation {
  const validation = validateCustomPolicyText(cedar);
  if (!validation.valid) {
    throw new IamPolicyError(
      'validation',
      `Policy is not valid: ${validation.errors.map((e) => e.message).join('; ')}`,
      validation.errors,
    );
  }
  return validation;
}

// ── tenant-wide bounds ───────────────────────────────────────────────────

const statementCountCache = new Map<string, number>();

/** How many statements a stored policy text holds (0 when it does not parse). Memoised: a write re-reads every policy. */
function statementCountOf(cedar: string): number {
  const hit = statementCountCache.get(cedar);
  if (hit !== undefined) return hit;
  const parts = splitPolicyText(cedar);
  const count = parts.ok ? parts.policies.length : 0;
  if (cedar.length <= 8 * 1024) {
    if (statementCountCache.size >= 1_000) statementCountCache.clear();
    statementCountCache.set(cedar, count);
  }
  return count;
}

interface PolicyTotals { policies: number; statements: number; bytes: number }

function totalsOf(policies: readonly IIamPolicy[]): PolicyTotals {
  let statements = 0;
  let bytes = 0;
  for (const p of policies) {
    statements += statementCountOf(p.cedar);
    bytes += Buffer.byteLength(p.cedar, 'utf8');
  }
  return { policies: policies.length, statements, bytes };
}

/**
 * Refuse a write that would push the tenant's policy set past the aggregate
 * caps (MAX_POLICIES_PER_TENANT, MAX_STATEMENTS_PER_TENANT,
 * MAX_TENANT_POLICY_BYTES). Disabled and monitor policies count: they are
 * parsed, evaluated (monitor) and listed all the same. A write that does not
 * grow the set (an edit that shrinks a policy, in a tenant that is already over
 * a cap) is always allowed, so nobody is locked out of cleaning up.
 */
async function assertWithinTenantBounds(
  tenantDbName: string,
  policyId: string,
  next: { cedar: string; statements: number },
  creating: boolean,
): Promise<void> {
  const all = await listPolicies(tenantDbName);
  const current = all.find((p) => p.policyId === policyId);
  // Updating a policy that is not there: the write itself answers "not found".
  if (!creating && !current) return;
  const others = totalsOf(all.filter((p) => p.policyId !== policyId));
  const before: PolicyTotals = current
    ? { policies: others.policies + 1, statements: others.statements + statementCountOf(current.cedar), bytes: others.bytes + Buffer.byteLength(current.cedar, 'utf8') }
    : { ...others };
  const after: PolicyTotals = {
    policies: others.policies + 1,
    statements: others.statements + next.statements,
    bytes: others.bytes + Buffer.byteLength(next.cedar, 'utf8'),
  };
  const limit = (what: string): never => {
    throw new IamPolicyError('limit_reached', what);
  };
  if (!current && after.policies > MAX_POLICIES_PER_TENANT) {
    limit(`A workspace can have at most ${MAX_POLICIES_PER_TENANT} custom policies`);
  }
  if (after.statements > MAX_STATEMENTS_PER_TENANT && after.statements > before.statements) {
    limit(`A workspace can hold at most ${MAX_STATEMENTS_PER_TENANT} policy statements in total (this change would make ${after.statements}). Remove or merge policies first.`);
  }
  if (after.bytes > MAX_TENANT_POLICY_BYTES && after.bytes > before.bytes) {
    limit(`A workspace's policies can total at most ${Math.floor(MAX_TENANT_POLICY_BYTES / 1024)} KB of Cedar (this change would make ${Math.ceil(after.bytes / 1024)} KB). Remove or shorten policies first.`);
  }
}

export async function createPolicy(
  tenantDbName: string,
  input: CreatePolicyInput,
  actor: string,
): Promise<IIamPolicy> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new IamPolicyError('invalid_input', 'Policy name is required');
  const policyId = input.policyId ?? `p-${randomBytes(6).toString('hex')}`;
  if (!POLICY_ID_RE.test(policyId)) {
    throw new IamPolicyError('invalid_input', 'policyId must match [a-z0-9][a-z0-9._-]{0,62}');
  }
  if (input.mode && input.mode !== 'enforce' && input.mode !== 'monitor') {
    throw new IamPolicyError('invalid_input', 'mode must be "enforce" or "monitor"');
  }
  const validation = assertValid(input.cedar);
  assertSpecMatches(input.spec, input.cedar);
  await assertWithinTenantBounds(tenantDbName, policyId, { cedar: input.cedar, statements: validation.statements.length }, true);

  const now = new Date();
  const policy: IIamPolicy = {
    _id: policyId,
    policyId,
    name,
    description: input.description,
    cedar: input.cedar,
    spec: input.spec ?? null,
    mode: input.mode ?? 'enforce',
    enabled: input.enabled ?? true,
    service: input.service,
    createdBy: actor,
    updatedBy: actor,
    createdAt: now,
    updatedAt: now,
  };

  await runWithTenantScope(tenantDbName, async (db) => {
    if (await db.iamDocGet(POLICIES, policyId)) {
      throw new IamPolicyError('conflict', `Policy "${policyId}" already exists`);
    }
    await db.iamDocPut(POLICIES, policyId, toDoc(policy));
  });
  await bumpPolicyVersion(tenantDbName);
  return policy;
}

export interface UpdatePolicyInput {
  name?: string;
  description?: string | null;
  cedar?: string;
  /**
   * The spec the new `cedar` was compiled from. Replacing the Cedar WITHOUT a
   * spec makes the policy raw (the editor can no longer show it as a form).
   */
  spec?: PolicySpec | null;
  mode?: IamPolicyMode;
  enabled?: boolean;
  service?: string | null;
}

export async function updatePolicy(
  tenantDbName: string,
  policyId: string,
  patch: UpdatePolicyInput,
  actor: string,
): Promise<IIamPolicy> {
  if (patch.cedar !== undefined) {
    const validation = assertValid(patch.cedar);
    assertSpecMatches(patch.spec, patch.cedar);
    await assertWithinTenantBounds(tenantDbName, policyId, { cedar: patch.cedar, statements: validation.statements.length }, false);
  } else if (patch.spec !== undefined && patch.spec !== null) {
    throw new IamPolicyError('invalid_input', 'A spec can only be replaced together with its Cedar');
  }
  if (patch.mode !== undefined && patch.mode !== 'enforce' && patch.mode !== 'monitor') {
    throw new IamPolicyError('invalid_input', 'mode must be "enforce" or "monitor"');
  }
  if (patch.name !== undefined && !patch.name.trim()) {
    throw new IamPolicyError('invalid_input', 'Policy name must not be empty');
  }

  const updated = await runWithTenantScope(tenantDbName, async (db) => {
    const doc = await db.iamDocGet(POLICIES, policyId);
    if (!doc) throw new IamPolicyError('not_found', `Policy "${policyId}" not found`);
    const current = fromDoc(doc.data);
    const next: IIamPolicy = {
      ...current,
      name: patch.name?.trim() ?? current.name,
      description: patch.description === undefined ? current.description : (patch.description ?? undefined),
      cedar: patch.cedar ?? current.cedar,
      // New Cedar without a spec = raw; otherwise keep (or replace) the spec.
      spec: patch.cedar !== undefined ? (patch.spec ?? null) : current.spec,
      mode: patch.mode ?? current.mode,
      enabled: patch.enabled ?? current.enabled,
      service: patch.service === undefined ? current.service : (patch.service ?? undefined),
      updatedBy: actor,
      updatedAt: new Date(),
    };
    await db.iamDocPut(POLICIES, policyId, toDoc(next));
    return next;
  });
  await bumpPolicyVersion(tenantDbName);
  return updated;
}

export async function deletePolicy(tenantDbName: string, policyId: string): Promise<boolean> {
  const deleted = await runWithTenantScope(tenantDbName, (db) => db.iamDocDelete(POLICIES, policyId));
  if (deleted) await bumpPolicyVersion(tenantDbName);
  return deleted;
}
