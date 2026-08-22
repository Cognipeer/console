import { getDatabase } from '@/lib/database';
import type { IGuardrail, GuardrailType } from '@/lib/database';
import { getCache } from '@/lib/core/cache';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { fireAndForget } from '@/lib/core/asyncTask';
import { recordUsageEvent } from '@/lib/services/usage/usageEvents';
import { generateUniqueSlugKey } from './keyGeneration';
import type {
  CreateGuardrailInput,
  UpdateGuardrailInput,
  GuardrailView,
  GuardrailEvaluationResult,
  GuardrailFinding,
} from './types';
import {
  PII_CATEGORIES,
  MODERATION_CATEGORIES,
  WORD_FILTER_BUILTIN_LISTS,
  buildEvaluationErrorFinding,
} from './types';
import { runPiiDetection, redactFindings } from './piiDetector';
import { runWordFilter } from './wordFilter';
import { resolveCustomWordLists } from './wordListService';
import {
  runModerationCheck,
  runPromptShieldCheck,
  runCustomPromptCheck,
} from './llmEvaluator';

// ── Serialization ─────────────────────────────────────────────────────────

export function serializeGuardrail(record: IGuardrail): GuardrailView {
  const { _id, ...rest } = record;
  return {
    ...rest,
    id: typeof _id === 'string' ? _id : (_id?.toString() ?? ''),
  } as GuardrailView;
}

// ── Key generation ────────────────────────────────────────────────────────

async function generateUniqueKey(
  tenantDbName: string,
  projectId: string | undefined,
  desiredKey: string,
): Promise<string> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return generateUniqueSlugKey(desiredKey, 'guardrail', async (candidate) =>
    Boolean(await db.findGuardrailByKey(candidate, projectId)),
  );
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

  const builtinLists: Record<string, boolean> = {};
  for (const list of WORD_FILTER_BUILTIN_LISTS) {
    builtinLists[list.id] = list.defaultEnabled;
  }

  return {
    pii: {
      enabled: true,
      action: 'block',
      categories: piiCategories,
    },
    wordFilter: {
      enabled: false,
      action: 'block',
      builtinLists,
      words: [],
      regexes: [],
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
    target: input.target ?? 'input',
    action: input.action,
    enabled: input.enabled ?? true,
    failMode: input.failMode ?? 'open',
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

  // Read before writing: an update that renames the key or moves the guardrail
  // between projects leaves a stale entry under the previous cache key.
  const prior = await db.findGuardrailById(id);

  const updated = await db.updateGuardrail(id, {
    ...input,
    updatedBy,
  });

  await invalidateGuardrailCache(tenantDbName, prior);
  await invalidateGuardrailCache(tenantDbName, updated);

  if (!updated) return null;
  return serializeGuardrail(updated);
}

export async function deleteGuardrail(
  tenantDbName: string,
  id: string,
): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const existing = await db.findGuardrailById(id);
  const deleted = await db.deleteGuardrail(id);
  await invalidateGuardrailCache(tenantDbName, existing);
  return deleted;
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

const cacheLog = createLogger('guardrail-cache');

/*
 * A guarded model resolves its guardrail on the request path — twice, when both
 * an input and an output guardrail are configured — and the lookup was
 * uncached, so the config was re-read from the database on every call.
 */

function guardrailCacheKey(tenantDbName: string, key: string, projectId?: string): string {
  return `guardrail-cfg:${tenantDbName}:${key}:${projectId ?? ''}`;
}

/**
 * Resolve a guardrail by key, through a short-lived cache.
 *
 * Returns the stored record, which callers treat as read-only: the memory cache
 * provider hands back the object itself.
 */
async function loadGuardrailRecord(
  tenantDbName: string,
  key: string,
  projectId?: string,
): Promise<IGuardrail | null> {
  const ttl = getConfig().guardrail.configCacheTtlSeconds;
  const cacheKey = guardrailCacheKey(tenantDbName, key, projectId);

  if (ttl > 0) {
    try {
      const cache = await getCache();
      const cached = await cache.get<IGuardrail>(cacheKey);
      if (cached) return cached;
    } catch {
      /* cache miss or unavailable — fall through to the database */
    }
  }

  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findGuardrailByKey(key, projectId);

  if (record && ttl > 0) {
    try {
      const cache = await getCache();
      await cache.set(cacheKey, record, ttl);
    } catch {
      /* best-effort cache write */
    }
  }

  return record;
}

/**
 * Drop a guardrail's cached config so an edit applies to the next request.
 *
 * Best-effort, and only for a record whose project is known: a guardrail with
 * no project is visible to every one of them and the cache is keyed per
 * project, so those edits land on the TTL instead.
 */
async function invalidateGuardrailCache(
  tenantDbName: string,
  record: IGuardrail | null | undefined,
): Promise<void> {
  if (!record) return;
  try {
    const cache = await getCache();
    await cache.del(guardrailCacheKey(tenantDbName, record.key, record.projectId));
  } catch (error) {
    cacheLog.warn('Failed to invalidate guardrail cache; entry expires on TTL', {
      guardrailKey: record.key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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

const LOGGED_INPUT_MAX_CHARS = 1500;

/**
 * Masks detected PII / banned-word values before the text is persisted, so
 * evaluation logs never store the very data the guardrail exists to protect.
 */
function maskTextForLogging(text: string, findings: GuardrailFinding[]): string {
  const masked = redactFindings(text, findings.filter((f) => f.value));
  return masked.length > LOGGED_INPUT_MAX_CHARS
    ? `${masked.slice(0, LOGGED_INPUT_MAX_CHARS)}…`
    : masked;
}

function logEvaluation(params: {
  tenantDbName: string;
  record: IGuardrail;
  result: GuardrailEvaluationResult;
  text: string;
  latencyMs: number;
  phase: 'input' | 'output';
  source?: string;
  requestId?: string;
}): void {
  const { tenantDbName, record, result, text, latencyMs, phase, source, requestId } = params;
  // Resolve attribution + rollup synchronously so the request ALS is in scope.
  // No tokens/cost — LLM-backed checks flow through the models service.
  const attribution = recordUsageEvent({
    tenantDbName,
    tenantId: record.tenantId,
    projectId: record.projectId,
    service: 'guardrails',
    refKey: record.key,
    status: 'success',
    latencyMs,
  });
  fireAndForget('guardrail-eval-log', async () => {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    await db.createGuardrailEvaluationLog({
      userId: attribution.userId,
      apiTokenId: attribution.apiTokenId,
      actorType: attribution.actorType,
      tenantId: record.tenantId,
      projectId: record.projectId,
      guardrailId: typeof record._id === 'string' ? record._id : (record._id?.toString() ?? ''),
      guardrailKey: record.key,
      guardrailName: record.name,
      guardrailType: record.type,
      target: phase,
      action: record.action,
      passed: result.passed,
      findings: result.findings.map((f) => ({
        ...f,
        // Never persist raw PII/banned values; keep a hint of the shape only.
        value: f.value ? `${f.value.slice(0, 2)}…(${f.value.length} chars)` : undefined,
      })),
      inputText: maskTextForLogging(text, result.findings),
      latencyMs,
      source,
      requestId,
      message: result.passed ? null : result.findings[0]?.message ?? null,
    });
  });
}

export async function evaluateGuardrail(params: {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  guardrailKey: string;
  text: string;
  /** Which side of the model call is being checked. Defaults to 'input'. */
  phase?: 'input' | 'output';
  /** Caller tag persisted in evaluation logs, e.g. 'chat.completions', 'agent', 'evaluate-api'. */
  source?: string;
  requestId?: string;
  /** Set true to skip writing an evaluation log (e.g. nested/duplicate calls). */
  skipLogging?: boolean;
}): Promise<GuardrailEvaluationResult> {
  const { tenantDbName, tenantId, projectId, guardrailKey, text } = params;
  const phase = params.phase ?? 'input';
  const startedAt = Date.now();

  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await loadGuardrailRecord(tenantDbName, guardrailKey, projectId);

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
      disabled: true,
    };
  }

  const findings: GuardrailFinding[] = [];
  const llmCtx = record.modelKey
    ? { tenantDbName, tenantId, projectId, modelKey: record.modelKey, failMode: record.failMode }
    : null;

  // ── Preset guardrail checks ──
  if (record.type === 'preset' && record.policy) {
    const { pii, wordFilter, moderation, promptShield } = record.policy;

    // Deterministic checks first (no LLM, no latency)
    if (pii?.enabled) {
      findings.push(...runPiiDetection(text, pii));
    }
    if (wordFilter?.enabled) {
      const customLists = wordFilter.customListKeys?.length
        ? await resolveCustomWordLists(tenantDbName, projectId, wordFilter.customListKeys)
        : undefined;
      findings.push(...runWordFilter(text, wordFilter, customLists));
    }

    // LLM checks run concurrently. Policy-level modelKey lets them run even
    // without a guardrail-level model; failMode governs error behavior.
    const llmChecks: Array<Promise<GuardrailFinding[]>> = [];
    const baseCtx = llmCtx ?? { tenantDbName, tenantId, projectId, modelKey: '', failMode: record.failMode };
    // A check that is enabled but cannot run must never be invisible: closed
    // mode blocks, open mode emits a non-blocking informational finding.
    const missingModelFinding = (type: GuardrailFinding['type']): GuardrailFinding =>
      buildEvaluationErrorFinding({
        type,
        failMode: record.failMode,
        action: record.action,
        message:
          record.failMode === 'closed'
            ? 'Check is enabled but no evaluation model is configured; guardrail fails closed.'
            : 'Check is enabled but no evaluation model is configured (fail-open — content passed unchecked).',
      });
    if (moderation?.enabled) {
      if (moderation.modelKey || record.modelKey) {
        llmChecks.push(runModerationCheck(text, moderation, baseCtx, record.action));
      } else {
        findings.push(missingModelFinding('moderation'));
      }
    }
    if (promptShield?.enabled) {
      if (promptShield.modelKey || record.modelKey) {
        llmChecks.push(runPromptShieldCheck(text, promptShield, baseCtx, record.action));
      } else {
        findings.push(missingModelFinding('prompt_shield'));
      }
    }
    if (llmChecks.length > 0) {
      const results = await Promise.all(llmChecks);
      for (const result of results) findings.push(...result);
    }
  }

  // ── Custom prompt check ──
  if (record.type === 'custom' && record.customPrompt && llmCtx) {
    findings.push(
      ...(await runCustomPromptCheck(text, record.customPrompt, llmCtx, record.action)),
    );
  }

  const hasBlock = findings.some((f) => f.block);
  const passed = findings.length === 0 || !hasBlock;

  // Redaction: findings whose action is 'redact' don't block — they rewrite.
  const redactable = findings.filter((f) => f.action === 'redact' && f.value);
  const redactedText = redactable.length > 0 && !hasBlock
    ? redactFindings(text, redactable)
    : undefined;

  const result: GuardrailEvaluationResult = {
    passed,
    guardrailKey: record.key,
    guardrailName: record.name,
    action: record.action,
    findings,
    redactedText,
  };

  if (!params.skipLogging) {
    logEvaluation({
      tenantDbName,
      record,
      result,
      text,
      latencyMs: Date.now() - startedAt,
      phase,
      source: params.source,
      requestId: params.requestId,
    });
  }

  return result;
}

// ── Re-exports ────────────────────────────────────────────────────────────

export { PII_CATEGORIES, MODERATION_CATEGORIES, PROMPT_SHIELD_ISSUES, WORD_FILTER_BUILTIN_LISTS } from './types';
export { buildDefaultPresetPolicy as buildDefaultPolicy };
