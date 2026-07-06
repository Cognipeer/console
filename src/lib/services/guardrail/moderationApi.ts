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

export interface ModerationResponse {
  id: string;
  /** Guardrail key the inputs were evaluated against. */
  model: string;
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
    // `evaluation_error` findings are informational (the check did not run)
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
  const guardrailKey = await resolveModerationGuardrailKey(ctx, params.model);

  const results: ModerationResult[] = [];
  for (const text of texts) {
    const evaluation = await evaluateGuardrail({
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      guardrailKey,
      text,
      source: 'moderations-api',
    });
    results.push(toResult(evaluation.findings));
  }

  return {
    id: `modr_${randomUUID()}`,
    model: guardrailKey,
    results,
  };
}
