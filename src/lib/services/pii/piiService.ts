/**
 * Standalone PII service.
 *
 * Capabilities:
 *  - Built-in PII catalog (multi-language) + custom regex patterns
 *  - Detect, redact, mask, scan-with-policy
 *  - CRUD for tenant-scoped reusable PII policies
 *
 * NOTE: This service is intentionally not wired into other modules
 * (guardrails / tracing / RAG / audit) yet — integration is a later phase.
 */

import slugify from 'slugify';
import { getDatabase } from '@/lib/database';
import type {
  IPiiPolicy,
  PiiAction,
  PiiLanguage,
} from '@/lib/database';
import {
  PII_CATEGORIES,
  PII_CATEGORIES_BY_ID,
  categoryLabel,
  categoryDescription,
  filterCategoriesByLanguages,
  type PiiCategoryDefinition,
} from './categories';
import { detect, applyReplacements } from './detector';
import type {
  PiiFinding,
  PiiScanResult,
  PiiServicePolicyView,
  CreatePiiPolicyInput,
  UpdatePiiPolicyInput,
  DetectInput,
  RedactInput,
} from './types';

const SLUG_OPTIONS = { lower: true, strict: true, trim: true };
const MAX_KEY_ATTEMPTS = 50;

// ── Serialization ─────────────────────────────────────────────────────────

export function serializePiiPolicy(record: IPiiPolicy): PiiServicePolicyView {
  const { _id, ...rest } = record;
  return {
    ...rest,
    id: typeof _id === 'string' ? _id : (_id?.toString() ?? ''),
  };
}

// ── Key generation ────────────────────────────────────────────────────────

function normalizeKey(input: string): string {
  const fallback = input?.trim().length ? input.trim() : 'pii-policy';
  return slugify(fallback, SLUG_OPTIONS);
}

async function generateUniqueKey(
  tenantDbName: string,
  projectId: string | undefined,
  desiredKey: string,
): Promise<string> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const base = normalizeKey(desiredKey);
  let attempt = 0;
  let candidate = base;
  while (attempt < MAX_KEY_ATTEMPTS) {
    const existing = await db.findPiiPolicyByKey(candidate, projectId);
    if (!existing) return candidate;
    attempt++;
    candidate = `${base}-${attempt}`;
  }
  throw new Error(`Could not generate a unique key for PII policy "${desiredKey}"`);
}

// ── Default policy builder ────────────────────────────────────────────────

export function buildDefaultPolicyCategories(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const cat of PII_CATEGORIES) {
    out[cat.id] = cat.defaultEnabled;
  }
  return out;
}

// ── CRUD operations ───────────────────────────────────────────────────────

export async function createPiiPolicy(
  tenantDbName: string,
  tenantId: string,
  createdBy: string,
  input: CreatePiiPolicyInput,
): Promise<PiiServicePolicyView> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const key = await generateUniqueKey(tenantDbName, input.projectId, input.name);

  const record = await db.createPiiPolicy({
    tenantId,
    projectId: input.projectId,
    key,
    name: input.name,
    description: input.description,
    defaultAction: input.defaultAction,
    categories: input.categories,
    customPatterns: input.customPatterns ?? [],
    languages: input.languages ?? [],
    enabled: input.enabled ?? true,
    metadata: input.metadata ?? {},
    createdBy,
  });

  return serializePiiPolicy(record);
}

export async function updatePiiPolicy(
  tenantDbName: string,
  id: string,
  updatedBy: string,
  input: UpdatePiiPolicyInput,
): Promise<PiiServicePolicyView | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const updated = await db.updatePiiPolicy(id, { ...input, updatedBy });
  if (!updated) return null;
  return serializePiiPolicy(updated);
}

export async function deletePiiPolicy(tenantDbName: string, id: string): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.deletePiiPolicy(id);
}

export async function getPiiPolicy(
  tenantDbName: string,
  id: string,
): Promise<PiiServicePolicyView | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findPiiPolicyById(id);
  if (!record) return null;
  return serializePiiPolicy(record);
}

export async function getPiiPolicyByKey(
  tenantDbName: string,
  key: string,
  projectId?: string,
): Promise<PiiServicePolicyView | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findPiiPolicyByKey(key, projectId);
  if (!record) return null;
  return serializePiiPolicy(record);
}

export async function listPiiPolicies(
  tenantDbName: string,
  filters?: { projectId?: string; enabled?: boolean; search?: string },
): Promise<PiiServicePolicyView[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const records = await db.listPiiPolicies(filters);
  return records.map(serializePiiPolicy);
}

// ── Catalog helpers (for UI/API) ──────────────────────────────────────────

export interface CategoryCatalogEntry {
  id: string;
  label: string;
  description: string;
  languages: PiiLanguage[];
  severity: 'low' | 'medium' | 'high';
  defaultEnabled: boolean;
}

/**
 * Return the catalog in the requested locale. If `languages` is given, only
 * categories matching that language set are returned.
 */
export function getCategoryCatalog(
  locale: PiiLanguage = 'en',
  languages?: PiiLanguage[],
): CategoryCatalogEntry[] {
  const list = filterCategoriesByLanguages(languages);
  return list.map((c) => ({
    id: c.id,
    label: categoryLabel(c, locale),
    description: categoryDescription(c, locale),
    languages: c.languages,
    severity: c.severity,
    defaultEnabled: c.defaultEnabled,
  }));
}

// ── Detect / Redact / Mask (stateless) ────────────────────────────────────

export function detectPii(input: DetectInput): PiiScanResult {
  const findings = detect(
    input.text,
    {
      categories: input.categories,
      customPatterns: input.customPatterns,
      languages: input.languages,
      locale: input.locale ?? 'en',
    },
    'detect',
  );
  return {
    inputLength: input.text.length,
    findings,
    outputText: input.text,
    hasBlocking: false,
    action: 'detect',
    languages: input.languages ?? ['global'],
  };
}

export function redactPii(input: RedactInput): PiiScanResult {
  const action: PiiAction = input.action === 'mask' ? 'mask' : 'redact';
  const findings = detect(
    input.text,
    {
      categories: input.categories,
      customPatterns: input.customPatterns,
      languages: input.languages,
      locale: input.locale ?? 'en',
    },
    action,
  );
  const outputText = applyReplacements(input.text, findings);
  return {
    inputLength: input.text.length,
    findings,
    outputText,
    hasBlocking: false,
    action,
    languages: input.languages ?? ['global'],
  };
}

export function maskPii(input: DetectInput): PiiScanResult {
  return redactPii({ ...input, action: 'mask' });
}

// ── Scan with a stored policy ─────────────────────────────────────────────

export async function scanWithPolicy(params: {
  tenantDbName: string;
  policyKey: string;
  projectId?: string;
  text: string;
  /** Override the policy's defaultAction for this call only. */
  actionOverride?: PiiAction;
  /** Override the response locale. Defaults to 'en'. */
  locale?: PiiLanguage;
}): Promise<PiiScanResult & { policyKey: string; policyName: string }> {
  const db = await getDatabase();
  await db.switchToTenant(params.tenantDbName);
  const policy = await db.findPiiPolicyByKey(params.policyKey, params.projectId);
  if (!policy) {
    throw new Error(`PII policy with key "${params.policyKey}" not found`);
  }
  if (!policy.enabled) {
    return {
      inputLength: params.text.length,
      findings: [],
      outputText: params.text,
      hasBlocking: false,
      action: policy.defaultAction,
      languages: policy.languages ?? [],
      policyKey: policy.key,
      policyName: policy.name,
    };
  }

  const action: PiiAction = params.actionOverride ?? policy.defaultAction;
  const findings = detect(
    params.text,
    {
      categories: policy.categories,
      customPatterns: policy.customPatterns,
      languages: policy.languages,
      locale: params.locale ?? 'en',
    },
    action,
  );
  const outputText = action === 'detect' || action === 'block'
    ? params.text
    : applyReplacements(params.text, findings);
  const blockedFindings: PiiFinding[] = action === 'block'
    ? findings.map((f) => ({ ...f, block: true }))
    : findings;
  return {
    inputLength: params.text.length,
    findings: blockedFindings,
    outputText,
    hasBlocking: blockedFindings.some((f) => f.block),
    action,
    languages: policy.languages ?? [],
    policyKey: policy.key,
    policyName: policy.name,
  };
}

export type { PiiFinding, PiiScanResult };
export { PII_CATEGORIES, PII_CATEGORIES_BY_ID };
export type { PiiCategoryDefinition };
