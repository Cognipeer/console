import slugify from 'slugify';
import { getDatabase } from '@/lib/database';
import type { IGuardrail, GuardrailType } from '@/lib/database';
import type {
  CreateGuardrailInput,
  UpdateGuardrailInput,
  GuardrailView,
  GuardrailEvaluationResult,
} from './types';
import { PII_CATEGORIES, MODERATION_CATEGORIES } from './types';
import { runPiiDetection } from './piiDetector';
import {
  runModerationCheck,
  runPromptShieldCheck,
  runCustomPromptCheck,
} from './llmEvaluator';

const SLUG_OPTIONS = { lower: true, strict: true, trim: true };
const MAX_KEY_ATTEMPTS = 50;

// ── Serialization ─────────────────────────────────────────────────────────

export function serializeGuardrail(record: IGuardrail): GuardrailView {
  const { _id, ...rest } = record;
  return {
    ...rest,
    id: typeof _id === 'string' ? _id : (_id?.toString() ?? ''),
  } as GuardrailView;
}

// ── Key generation ────────────────────────────────────────────────────────

function normalizeKey(input: string): string {
  const fallback = input?.trim().length ? input.trim() : 'guardrail';
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
    const existing = await db.findGuardrailByKey(candidate, projectId);
    if (!existing) return candidate;
    attempt++;
    candidate = `${base}-${attempt}`;
  }

  throw new Error(`Could not generate a unique key for guardrail "${desiredKey}"`);
}

// ── Default policy builder ────────────────────────────────────────────────

export function buildDefaultPresetPolicy(): IGuardrail['policy'] {
  const piiCategories: Record<string, boolean> = {};
  for (const cat of PII_CATEGORIES) {
    piiCategories[cat.id] = cat.defaultEnabled;
  }

  const moderationCategories: Record<string, boolean> = {};
  for (const cat of MODERATION_CATEGORIES) {
    moderationCategories[cat.id] = cat.defaultEnabled;
  }

  return {
    pii: {
      enabled: true,
      action: 'block',
      categories: piiCategories,
    },
    moderation: {
      enabled: false,
      categories: moderationCategories,
    },
    promptShield: {
      enabled: false,
      sensitivity: 'balanced',
    },
  };
}

// ── CRUD operations ───────────────────────────────────────────────────────

export async function createGuardrail(
  tenantDbName: string,
  tenantId: string,
  createdBy: string,
  input: CreateGuardrailInput,
): Promise<GuardrailView> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const key = await generateUniqueKey(tenantDbName, input.projectId, input.name);

  let policy = input.policy;
  if (input.type === 'preset' && !policy) {
    policy = buildDefaultPresetPolicy();
  }

  const guardrail = await db.createGuardrail({
    tenantId,
    projectId: input.projectId,
    key,
    name: input.name,
    description: input.description,
    type: input.type,
    target: input.target,
    action: input.action,
    enabled: input.enabled ?? true,
    modelKey: input.modelKey,
    policy: input.type === 'preset' ? policy : undefined,
    customPrompt: input.type === 'custom' ? input.customPrompt : undefined,
    createdBy,
  });

  return serializeGuardrail(guardrail);
}

export async function updateGuardrail(
  tenantDbName: string,
  id: string,
  updatedBy: string,
  input: UpdateGuardrailInput,
): Promise<GuardrailView | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const updated = await db.updateGuardrail(id, {
    ...input,
    updatedBy,
  });

  if (!updated) return null;
  return serializeGuardrail(updated);
}

export async function deleteGuardrail(
  tenantDbName: string,
  id: string,
): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.deleteGuardrail(id);
}

export async function getGuardrail(
  tenantDbName: string,
  id: string,
): Promise<GuardrailView | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findGuardrailById(id);
  if (!record) return null;
  return serializeGuardrail(record);
}

export async function getGuardrailByKey(
  tenantDbName: string,
  key: string,
  projectId?: string,
): Promise<GuardrailView | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findGuardrailByKey(key, projectId);
  if (!record) return null;
  return serializeGuardrail(record);
}

export async function listGuardrails(
  tenantDbName: string,
  filters?: {
    projectId?: string;
    type?: GuardrailType;
    enabled?: boolean;
    search?: string;
  },
): Promise<GuardrailView[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const records = await db.listGuardrails(filters);
  return records.map(serializeGuardrail);
}

// ── Evaluation ────────────────────────────────────────────────────────────

export async function evaluateGuardrail(params: {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  guardrailKey: string;
  text: string;
}): Promise<GuardrailEvaluationResult> {
  const { tenantDbName, tenantId, projectId, guardrailKey, text } = params;

  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findGuardrailByKey(guardrailKey, projectId);

  if (!record) {
    throw new Error(`Guardrail with key "${guardrailKey}" not found`);
  }

  if (!record.enabled) {
    return {
      passed: true,
      guardrailKey: record.key,
      guardrailName: record.name,
      action: record.action,
      findings: [],
    };
  }

  const findings = [];
  const llmCtx = record.modelKey
    ? { tenantDbName, tenantId, projectId, modelKey: record.modelKey }
    : null;

  // ── Preset guardrail checks ──
  if (record.type === 'preset' && record.policy) {
    const { pii, moderation, promptShield } = record.policy;

    // PII (no LLM needed)
    if (pii?.enabled) {
      const piiFindings = runPiiDetection(text, pii);
      findings.push(...piiFindings);
    }

    // Moderation (LLM needed)
    if (moderation?.enabled && llmCtx) {
      const moderationFindings = await runModerationCheck(
        text,
        moderation,
        llmCtx,
        record.action,
      );
      findings.push(...moderationFindings);
    }

    // Prompt Shield (LLM needed)
    if (promptShield?.enabled && llmCtx) {
      const shieldFindings = await runPromptShieldCheck(
        text,
        promptShield,
        llmCtx,
        record.action,
      );
      findings.push(...shieldFindings);
    }
  }

  // ── Custom prompt check ──
  if (record.type === 'custom' && record.customPrompt && llmCtx) {
    const customFindings = await runCustomPromptCheck(
      text,
      record.customPrompt,
      llmCtx,
      record.action,
    );
    findings.push(...customFindings);
  }

  const hasBlock = findings.some((f) => f.block);
  const passed = findings.length === 0 || !hasBlock;

  return {
    passed,
    guardrailKey: record.key,
    guardrailName: record.name,
    action: record.action,
    findings,
  };
}

// ── Re-exports ────────────────────────────────────────────────────────────

export { PII_CATEGORIES, MODERATION_CATEGORIES, PROMPT_SHIELD_ISSUES } from './types';
export { buildDefaultPresetPolicy as buildDefaultPolicy };
