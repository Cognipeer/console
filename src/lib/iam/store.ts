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
 * There is no HTTP API on top of this yet.
 */

import { randomBytes } from 'node:crypto';
import { runWithTenantScope } from '@/lib/database';
import { policyAnnotations, splitPolicyText, type CedarMessage } from './cedar';
import { invalidateTenantPolicies } from './events';
import { MANAGED_ANNOTATION } from './managedPolicies';
import { validateAgainstSchema } from './schemaState';

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

export type IamPolicyErrorCode = 'validation' | 'conflict' | 'not_found' | 'invalid_input';

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

export const MAX_POLICY_TEXT_BYTES = 64 * 1024;
export const MAX_STATEMENTS_PER_POLICY = 50;
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

// ── validation ───────────────────────────────────────────────────────────

export interface PolicyValidation {
  valid: boolean;
  errors: CedarMessage[];
  warnings: CedarMessage[];
  /** The parsed statements (empty when the text does not parse). */
  statements: string[];
}

/** Validate Cedar text as a custom policy against the generated schema. Pure: touches no store. */
export function validateCustomPolicyText(cedar: unknown): PolicyValidation {
  const fail = (message: string): PolicyValidation => ({
    valid: false,
    errors: [{ message }],
    warnings: [],
    statements: [],
  });
  if (typeof cedar !== 'string' || cedar.trim() === '') return fail('Policy text is empty');
  if (Buffer.byteLength(cedar, 'utf8') > MAX_POLICY_TEXT_BYTES) {
    return fail(`Policy text exceeds ${MAX_POLICY_TEXT_BYTES} bytes`);
  }
  const parts = splitPolicyText(cedar);
  if (!parts.ok) return { valid: false, errors: parts.errors, warnings: [], statements: [] };
  if (parts.templates.length > 0) return fail('Policy templates are not supported');
  if (parts.policies.length === 0) return fail('Policy text contains no permit/forbid statement');
  if (parts.policies.length > MAX_STATEMENTS_PER_POLICY) {
    return fail(`A policy may contain at most ${MAX_STATEMENTS_PER_POLICY} statements`);
  }
  for (const statement of parts.policies) {
    const annotations = policyAnnotations(statement);
    if (annotations && MANAGED_ANNOTATION in annotations) {
      return fail(`The @${MANAGED_ANNOTATION} annotation is reserved for built-in policies`);
    }
  }
  const record: Record<string, string> = {};
  parts.policies.forEach((statement, i) => {
    record[`candidate#${i}`] = statement;
  });
  const result = validateAgainstSchema(record);
  return { valid: result.valid, errors: result.errors, warnings: result.warnings, statements: parts.policies };
}

// ── mapping ──────────────────────────────────────────────────────────────

function toDoc(policy: IIamPolicy): Record<string, unknown> {
  return {
    _id: policy._id,
    policyId: policy.policyId,
    name: policy.name,
    description: policy.description ?? null,
    cedar: policy.cedar,
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
  mode?: IamPolicyMode;
  enabled?: boolean;
  service?: string;
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
  assertValid(input.cedar);

  const now = new Date();
  const policy: IIamPolicy = {
    _id: policyId,
    policyId,
    name,
    description: input.description,
    cedar: input.cedar,
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
  if (patch.cedar !== undefined) assertValid(patch.cedar);
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
