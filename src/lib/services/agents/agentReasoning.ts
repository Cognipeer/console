/**
 * Reasoning of an agent run, in one place. Pure (no server imports): the
 * Studio imports it too, so what the operator picks is what the run does.
 *
 * Precedence, the UI wins:
 *   agent selection (the model's own entry in the Build tab)
 *     >  Model Hub default of the model that runs
 *     >  the API request (`reasoning_effort` / `reasoning: {effort}`)
 *     >  nothing sent (the provider's own default).
 * It is a whole-value pick, not a field merge, and it is made per model: the
 * main model, an additional model the caller chose, a sub-agent's model each
 * resolve their own.
 *
 * Visibility is separate: `config.showReasoning === false` hides the reasoning
 * text from API responses, session events/messages and Studio chat. Token
 * accounting never changes.
 */

import type { IAgentConfig, IAgentRuntimeConfig } from '@/lib/database/provider/types.domain';
import {
  normalizeReasoning,
  readModelReasoning,
  readRequestReasoning,
  REASONING_EFFORTS,
  reasoningControlForDriver,
  type NormalizedReasoning,
  type ReasoningEffort,
} from '@/lib/services/models/reasoning';

export type AgentReasoningSource = 'agent' | 'model' | 'request' | 'none';

export interface ResolvedAgentReasoning {
  reasoning?: NormalizedReasoning;
  source: AgentReasoningSource;
}

type ReasoningPick = Pick<NormalizedReasoning, 'effort' | 'budgetTokens'>;
type ModelEntryLike = { modelKey?: string; reasoningEffort?: unknown; reasoningBudgetTokens?: unknown };

const EFFORT_SET: ReadonlySet<string> = new Set(REASONING_EFFORTS);

function isEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && EFFORT_SET.has(value);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function pickOf(entry: ModelEntryLike | undefined): ReasoningPick | undefined {
  if (!entry) return undefined;
  const out: ReasoningPick = {};
  if (isEffort(entry.reasoningEffort)) out.effort = entry.reasoningEffort;
  const budget = positiveInt(entry.reasoningBudgetTokens);
  // A budget next to 'none' means nothing: thinking is off.
  if (budget !== undefined && out.effort !== 'none') out.budgetTokens = budget;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * What the agent itself selected for `modelKey`: the main model's fields, or
 * the matching `additionalModels` entry. Undefined = "Model default".
 */
export function agentReasoningForModel(
  config: Pick<IAgentConfig, 'modelKey' | 'reasoningEffort' | 'reasoningBudgetTokens' | 'additionalModels'> | undefined,
  modelKey: string | undefined,
): ReasoningPick | undefined {
  if (!config || !modelKey) return undefined;
  if (modelKey === config.modelKey) return pickOf(config);
  return pickOf(config.additionalModels?.find((entry) => entry?.modelKey === modelKey));
}

/** agent > Model Hub > API request > nothing. */
export function resolveAgentReasoning(input: {
  /** The agent's selection for the model that runs (`agentReasoningForModel`). */
  agent?: ReasoningPick;
  /** The model record's `settings`. */
  modelSettings?: unknown;
  /** Already-normalized request value (`parseAgentRequestReasoning(...).value`). */
  request?: NormalizedReasoning;
}): ResolvedAgentReasoning {
  if (input.agent && (input.agent.effort || input.agent.budgetTokens)) {
    return { reasoning: { ...input.agent }, source: 'agent' };
  }
  const fromModel = readModelReasoning(input.modelSettings);
  if (fromModel) return { reasoning: fromModel, source: 'model' };
  if (input.request) return { reasoning: input.request, source: 'request' };
  return { source: 'none' };
}

/**
 * The run's config with `modelKey` swapped to the chosen model AND the
 * reasoning selection swapped with it: the main model's pick must not follow
 * an additional model into the run, and vice versa.
 */
export function applyModelToConfig<T extends IAgentConfig>(config: T, modelKey: string): T {
  if (!modelKey || modelKey === config.modelKey) return config;
  const pick = agentReasoningForModel(config, modelKey);
  const next: T = { ...config, modelKey };
  delete next.reasoningEffort;
  delete next.reasoningBudgetTokens;
  if (pick?.effort) next.reasoningEffort = pick.effort;
  if (pick?.budgetTokens) next.reasoningBudgetTokens = pick.budgetTokens;
  return next;
}

/** Whether reasoning text may leave the platform for this agent. */
export function agentShowsReasoning(config: Pick<IAgentConfig, 'showReasoning'> | undefined | null): boolean {
  return config?.showReasoning !== false;
}

/**
 * Old Advanced-tab reasoning (`runtime.reasoning`: enabled/level/effort/budget/
 * includeThoughts) becomes the main model's own fields; only `reflection` stays
 * under `runtime.reasoning`. Pure and idempotent: an explicit new-style value
 * wins over a stale old one, and a second pass changes nothing.
 */
export function migrateAgentReasoning(config: IAgentConfig): IAgentConfig {
  const old = config?.runtime?.reasoning;
  if (!old || typeof old !== 'object') return config;
  const legacyKeys = ['enabled', 'level', 'effort', 'budgetTokens', 'includeThoughts'] as const;
  if (!legacyKeys.some((key) => (old as Record<string, unknown>)[key] !== undefined)) return config;

  const next: IAgentConfig = { ...config };
  if (config.reasoningEffort === undefined && config.reasoningBudgetTokens === undefined && old.enabled !== false) {
    const effort = isEffort(old.effort) ? old.effort : isEffort(old.level) ? old.level : undefined;
    const budget = positiveInt(old.budgetTokens);
    if (effort) next.reasoningEffort = effort;
    if (budget !== undefined && effort !== 'none') next.reasoningBudgetTokens = budget;
  }

  const runtime: IAgentRuntimeConfig = { ...(config.runtime ?? {}) };
  if (old.reflection !== undefined) runtime.reasoning = { reflection: old.reflection };
  else delete runtime.reasoning;
  if (Object.keys(runtime).length > 0) next.runtime = runtime;
  else delete next.runtime;
  return next;
}

export interface ParsedRequestReasoning {
  value?: NormalizedReasoning;
  /** Set when the request carries something that is not a valid effort. */
  error?: string;
}

/**
 * Reads `reasoning_effort` and `reasoning: {effort}` off an agent API body.
 * Unlike the gateway's lenient reader this one refuses bad values (400), so a
 * typo does not silently run with no reasoning.
 */
export function parseAgentRequestReasoning(body: unknown): ParsedRequestReasoning {
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;
  const efforts = REASONING_EFFORTS.join(', ');

  if (b.reasoning_effort !== undefined && b.reasoning_effort !== null) {
    if (!isEffort(typeof b.reasoning_effort === 'string' ? b.reasoning_effort.trim().toLowerCase() : b.reasoning_effort)) {
      return { error: `reasoning_effort must be one of: ${efforts}` };
    }
  }
  if (b.reasoning !== undefined && b.reasoning !== null) {
    if (typeof b.reasoning !== 'object' || Array.isArray(b.reasoning)) {
      return { error: 'reasoning must be an object, e.g. { "effort": "low" }' };
    }
    const effort = (b.reasoning as Record<string, unknown>).effort;
    if (effort !== undefined && effort !== null
      && !isEffort(typeof effort === 'string' ? effort.trim().toLowerCase() : effort)) {
      return { error: `reasoning.effort must be one of: ${efforts}` };
    }
  }
  return { value: readRequestReasoning({ reasoning: b.reasoning, reasoning_effort: b.reasoning_effort }) };
}

/** Config-level checks for the new fields; messages match the validator's style. */
export function reasoningConfigIssues(config: IAgentConfig): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = [];
  const efforts = REASONING_EFFORTS.join(', ');
  const check = (prefix: string, entry: ModelEntryLike | undefined) => {
    if (!entry) return;
    if (entry.reasoningEffort !== undefined && entry.reasoningEffort !== null && !isEffort(entry.reasoningEffort)) {
      issues.push({ field: `${prefix}reasoningEffort`, message: `must be one of: ${efforts}` });
    }
    const budget = entry.reasoningBudgetTokens;
    if (budget !== undefined && budget !== null && (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0)) {
      issues.push({ field: `${prefix}reasoningBudgetTokens`, message: 'must be a positive number' });
    }
  };
  check('', config as ModelEntryLike);
  (config.additionalModels ?? []).forEach((entry, index) => check(`additionalModels[${index}].`, entry));
  if (config.showReasoning !== undefined && config.showReasoning !== null && typeof config.showReasoning !== 'boolean') {
    issues.push({ field: 'showReasoning', message: 'must be true or false' });
  }
  return issues;
}

/**
 * Title generation never needs to think. 'none' where the driver takes it,
 * otherwise 'minimal' (OpenAI-family models that predate 'none' accept it);
 * unknown / Dynamic drivers get 'none' and the routed model translates.
 */
export function titleReasoning(driver?: string): NormalizedReasoning {
  const control = reasoningControlForDriver(driver);
  if (control.efforts.length === 0 || control.efforts.includes('none')) return { effort: 'none' };
  return { effort: 'minimal' };
}

/** Re-exported so callers need one import. */
export { normalizeReasoning };
