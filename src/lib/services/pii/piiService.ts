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
  IPiiCustomPattern,
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
import { detect, applyReplacements, tokenize, detokenize, explainCustomPatternError } from './detector';
import type {
  PiiFinding,
  PiiScanResult,
  PiiVault,
  PiiServicePolicyView,
  CreatePiiPolicyInput,
  UpdatePiiPolicyInput,
  DetectInput,
  RedactInput,
  TokenizeInput,
  DetokenizeInput,
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

/** Upper bound on custom patterns per policy; each one is a regex sweep per scan. */
export const MAX_CUSTOM_PATTERNS_PER_POLICY = 64;

/**
 * Validate a `customPatterns` request field BEFORE it is stored. A pattern the
 * detector would refuse at runtime (`explainCustomPatternError`: empty, over
 * the source cap, or not compiling) is rejected here with the same reason, so
 * an admin learns at save time rather than seeing a silently `degraded` scan.
 * `undefined` means "field absent" and is passed through untouched.
 */
export function parseCustomPatternsInput(
  input: unknown,
): { patterns?: IPiiCustomPattern[]; error?: string } {
  if (input === undefined) return {};
  if (!Array.isArray(input)) return { error: 'customPatterns must be an array' };
  if (input.length > MAX_CUSTOM_PATTERNS_PER_POLICY) {
    return { error: `customPatterns: at most ${MAX_CUSTOM_PATTERNS_PER_POLICY} entries are allowed` };
  }
  const out: IPiiCustomPattern[] = [];
  for (const [index, raw] of input.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: `customPatterns[${index}] must be an object` };
    }
    const candidate = raw as Partial<IPiiCustomPattern>;
    if (typeof candidate.pattern !== 'string') {
      return { error: `customPatterns[${index}].pattern must be a string` };
    }
    if (candidate.flags !== undefined && typeof candidate.flags !== 'string') {
      return { error: `customPatterns[${index}].flags must be a string` };
    }
    const why = explainCustomPatternError({ pattern: candidate.pattern, flags: candidate.flags });
    if (why) return { error: `customPatterns[${index}]: ${why}` };
    out.push(raw as IPiiCustomPattern);
  }
  return { patterns: out };
}

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
  /** string = that project's row; `null` = the tenant-wide row only; `undefined` = any project. */
  projectId?: string | null,
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

// ── Tokenize / Detokenize (reversible masking) ────────────────────────────

/**
 * Replace detected PII with reversible tokens (e.g. `[EMAIL_1]`) and return a
 * `vault` for restoring the originals later. Stateless: the vault is returned
 * to the caller and never persisted. Typical use is a round-trip around an LLM
 * call — tokenize the prompt, send it to the model, then `detokenizePii` the
 * model's response with the same vault.
 */
export function tokenizePii(input: TokenizeInput): PiiScanResult & { vault: PiiVault } {
  const findings = detect(
    input.text,
    {
      categories: input.categories,
      customPatterns: input.customPatterns,
      languages: input.languages,
      locale: input.locale ?? 'en',
    },
    'tokenize',
  );
  const { outputText, vault, findings: tokenized } = tokenize(input.text, findings);
  return {
    inputLength: input.text.length,
    findings: tokenized,
    outputText,
    hasBlocking: false,
    action: 'tokenize',
    languages: input.languages ?? ['global'],
    vault,
  };
}

/**
 * Reverse a prior tokenize call: replace each token in `input.text` with its
 * original value from the vault. Tokens absent from the vault are left as-is.
 */
export function detokenizePii(input: DetokenizeInput): { outputText: string } {
  return { outputText: detokenize(input.text, input.vault) };
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

  if (action === 'tokenize') {
    const { outputText, vault, findings: tokenized } = tokenize(params.text, findings);
    return {
      inputLength: params.text.length,
      findings: tokenized,
      outputText,
      hasBlocking: false,
      action,
      languages: policy.languages ?? [],
      vault,
      policyKey: policy.key,
      policyName: policy.name,
    };
  }

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

export type { PiiFinding, PiiScanResult, PiiVault };
export { PII_CATEGORIES, PII_CATEGORIES_BY_ID };
export type { PiiCategoryDefinition };
