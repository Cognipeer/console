/**
 * OpenAI-compatible Moderation API shim.
 *
 * Wraps `evaluateGuardrail` so external callers get the familiar
 * `/v1/moderations` request/response shape. The `model` parameter is the key
 * of a console guardrail (typically a preset guardrail with the moderation
 * policy enabled); when omitted, the tenant's first enabled guardrail with an
 * active moderation policy is used.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@/lib/database';
import { evaluateGuardrail } from './guardrailService';
import { handleModerationRequest } from '@/lib/services/models/inferenceService';
import type { ModerationClassification } from '@/lib/providers';
import { MODERATION_CATEGORIES } from './types';
import type { GuardrailFinding } from './types';

export class ModerationRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModerationRequestError';
  }
}

export interface ModerationContext {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
}

export interface ModerationResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  categoryScores: Record<string, number>;
  findings: GuardrailFinding[];
}

/**
 * Where `category_scores` came from. A classifier reports a real probability; a
 * judge reports a severity bucket that is widened into one of three fixed
 * values. A caller that thresholds on the score has to be able to tell the
 * difference, so it is stated rather than left to be inferred.
 */
export type ModerationScoreSource = 'model' | 'severity';

export interface ModerationResponse {
  id: string;
  /** The guardrail key or moderation model key the inputs were evaluated against. */
  model: string;
  /** Which detector ran. */
  detector: 'guardrail' | 'model';
  scoreSource: ModerationScoreSource;
  results: ModerationResult[];
}

const SEVERITY_SCORES: Record<GuardrailFinding['severity'], number> = {
  low: 0.3,
  medium: 0.6,
  high: 0.9,
};

/** Normalize OpenAI `input` (string | string[] | content parts) to texts. */
export function normalizeModerationInput(input: unknown): string[] {
  if (typeof input === 'string') return [input];
  if (Array.isArray(input)) {
    return input.map((entry, index) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object' && typeof (entry as { text?: unknown }).text === 'string') {
        return (entry as { text: string }).text;
      }
      throw new ModerationRequestError(
        `input[${index}] must be a string or an object with a \`text\` field (image inputs are not supported)`,
      );
    });
  }
  throw new ModerationRequestError('`input` must be a string or an array of strings');
}

export type ModerationTarget =
  | { kind: 'guardrail'; key: string }
  | { kind: 'model'; key: string };

/**
 * Decide what `model` names.
 *
 * Order matters and is deliberate: a guardrail key wins, so every caller that
 * worked before keeps working; a moderation-category MODEL is the second
 * lookup, which is what lets a client migrating off OpenAI point at a
 * classifier without authoring a guardrail first.
 *
 * With nothing named, the project's own configuration decides — an enabled
 * moderation guardrail, else a registered moderation model. There is NO hidden
 * fallback to some provider default: routing a caller's text to an upstream the
 * operator never chose is a cost, data-residency and DPA decision, not a
 * convenience.
 */
export async function resolveModerationTarget(
  ctx: ModerationContext,
  explicitKey?: string,
): Promise<ModerationTarget> {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);

  if (explicitKey) {
    const guardrail = await db.findGuardrailByKey(explicitKey, ctx.projectId);
    if (guardrail) return { kind: 'guardrail', key: guardrail.key };

    const model = await db.findModelByKey(explicitKey, ctx.projectId);
    if (model && model.category === 'moderation') {
      return { kind: 'model', key: model.key };
    }
    throw new ModerationRequestError(
      `"${explicitKey}" matches no guardrail and no moderation model. Pass a guardrail key, or the key of a model whose category is "moderation".`,
    );
  }

  const guardrails = await db.listGuardrails({ projectId: ctx.projectId, enabled: true });
  const guardrail = guardrails.find(
    (record) => record.type === 'preset' && record.policy?.moderation?.enabled,
  );
  if (guardrail) return { kind: 'guardrail', key: guardrail.key };

  const models = await db.listModels(ctx.projectId ? { projectId: ctx.projectId } : {});
  const model = models.find((record) => record.category === 'moderation');
  if (model) return { kind: 'model', key: model.key };

  throw new ModerationRequestError(
    'No moderation detector configured. Either add a model with category "moderation", '
    + 'or create an enabled guardrail with the moderation policy — then pass its key as `model`.',
  );
}

/**
 * Resolve which guardrail to evaluate against. An explicit key must exist;
 * otherwise fall back to the first enabled guardrail whose moderation policy
 * is active.
 */
export async function resolveModerationGuardrailKey(
  ctx: ModerationContext,
  explicitKey?: string,
): Promise<string> {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);

  if (explicitKey) {
    const record = await db.findGuardrailByKey(explicitKey, ctx.projectId);
    if (!record) {
      throw new ModerationRequestError(`Guardrail with key "${explicitKey}" not found`);
    }
    return record.key;
  }

  const guardrails = await db.listGuardrails({ projectId: ctx.projectId, enabled: true });
  const fallback = guardrails.find(
    (record) => record.type === 'preset' && record.policy?.moderation?.enabled,
  );
  if (!fallback) {
    throw new ModerationRequestError(
      'No moderation guardrail configured. Create an enabled guardrail with the moderation policy, or pass its key as `model`.',
    );
  }
  return fallback.key;
}

function toResult(findings: GuardrailFinding[]): ModerationResult {
  const categories: Record<string, boolean> = {};
  const categoryScores: Record<string, number> = {};
  for (const category of MODERATION_CATEGORIES) {
    categories[category.id] = false;
    categoryScores[category.id] = 0;
  }
  for (const finding of findings) {
    if (finding.type !== 'moderation') continue;
    categories[finding.category] = true;
    categoryScores[finding.category] = Math.max(
      categoryScores[finding.category] ?? 0,
      SEVERITY_SCORES[finding.severity] ?? 0.9,
    );
  }
  return {
    // Any real finding flags the input — including PII / prompt-shield
    // findings when the guardrail has those policies enabled (they stay
    // visible in `findings` rather than the fixed category map). Fail-open
    // `evaluation_error` findings are informational (the policy did not run)
    // and must not flag the input; fail-closed ones block and do flag.
    flagged: findings.some((f) => f.block || f.category !== 'evaluation_error'),
    categories,
    categoryScores,
    findings,
  };
}

/** Evaluate every input against the resolved guardrail. */
export async function runModeration(
  ctx: ModerationContext,
  params: { input: unknown; model?: string },
): Promise<ModerationResponse> {
  const texts = normalizeModerationInput(params.input);
  if (texts.length === 0) {
    throw new ModerationRequestError('`input` must not be empty');
  }
  const target = await resolveModerationTarget(ctx, params.model);

  if (target.kind === 'model') {
    const { result } = await handleModerationRequest({
      tenantDbName: ctx.tenantDbName,
      modelKey: target.key,
      projectId: ctx.projectId ?? '',
      texts,
    });
    return {
      id: `modr_${randomUUID()}`,
      model: target.key,
      detector: 'model',
      scoreSource: 'model',
      results: result.results.map(toNativeResult),
    };
  }

  const results: ModerationResult[] = [];
  for (const text of texts) {
    const evaluation = await evaluateGuardrail({
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      guardrailKey: target.key,
      text,
      source: 'moderations-api',
    });
    results.push(toResult(evaluation.findings));
  }

  return {
    id: `modr_${randomUUID()}`,
    model: target.key,
    detector: 'guardrail',
    scoreSource: 'severity',
    results,
  };
}

/**
 * Folds a classifier verdict into the same response shape the guardrail path
 * produces. Categories the console knows but the upstream did not report stay
 * `false`/`0` rather than being dropped, so the map is the same size whichever
 * detector ran; categories the upstream reports that the console does not model
 * are carried through as-is rather than silently discarded.
 */
function toNativeResult(classification: ModerationClassification): ModerationResult {
  const categories: Record<string, boolean> = {};
  const categoryScores: Record<string, number> = {};
  for (const category of MODERATION_CATEGORIES) {
    categories[category.id] = false;
    categoryScores[category.id] = 0;
  }
  for (const [id, verdict] of Object.entries(classification.categories)) {
    categories[id] = verdict.flagged;
    categoryScores[id] = verdict.score ?? (verdict.flagged ? 1 : 0);
  }
  return {
    flagged: classification.flagged,
    categories,
    categoryScores,
    findings: [],
  };
}
