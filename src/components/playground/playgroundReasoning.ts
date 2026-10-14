import {
  readModelReasoning,
  reasoningControlForDriver,
  shouldReturnReasoning,
  type NormalizedReasoning,
  type ReasoningControlKind,
  type ReasoningEffort,
} from '@/lib/services/models/reasoning';
import { requestReasoningEffortAccepted } from '@/lib/providers/unsupportedParams';
import { resolveUpstreamApi } from '@/lib/services/models/upstreamApi';

/**
 * Reasoning in the model playgrounds. Pure on purpose (no React): the control, the
 * request body and the "why is there no reasoning text" hint all derive from the
 * same three facts about the model, so they cannot drift apart.
 *
 * Precedence for a direct call is Model Hub default > request > nothing
 * (`resolveGatewayReasoning`). A playground request is a plain request, so when the
 * model carries a Model Hub default the control is shown as that value, locked, and
 * nothing is sent: the model default wins and the page says so.
 */

/** What the playground knows about the model it talks to. */
export interface PlaygroundModelInfo {
  /** Provider driver (`openai`, `azure`, `anthropic`, ...). */
  driver?: string;
  /** The provider-side model id / deployment name. */
  modelId?: string;
  /** The Model Hub record's settings (reasoning default, upstream API, ...). */
  settings?: Record<string, unknown>;
}

export interface PlaygroundReasoningControl {
  kind: Exclude<ReasoningControlKind, 'none'>;
  /** Levels a request can pick for this model (the "Model default" entry is added by the UI). */
  efforts: ReasoningEffort[];
  /** The Model Hub default, when set: it wins over the request, so the control is locked to it. */
  pinned?: NormalizedReasoning;
}

/**
 * The control to offer, or null when the model has no reasoning knob worth showing:
 * the driver has none, or (OpenAI family) the model is not one that takes an effort,
 * so the gateway would drop whatever the request carried.
 */
export function playgroundReasoningControl(
  model: PlaygroundModelInfo | undefined,
): PlaygroundReasoningControl | null {
  if (!model) return null;
  const control = reasoningControlForDriver(model.driver);
  if (control.kind === 'none') return null;

  const pinned = readModelReasoning(model.settings);
  if (pinned) return { kind: control.kind, efforts: [], pinned };

  const efforts = control.efforts.filter((effort) =>
    requestReasoningEffortAccepted(model.driver, model.modelId, effort),
  );
  return efforts.length > 0 ? { kind: control.kind, efforts } : null;
}

/**
 * The request fields for the chosen level. "Model default" ('') sends nothing, and so
 * does a model whose Model Hub default would win anyway.
 */
export function playgroundReasoningFields(
  control: PlaygroundReasoningControl | null,
  effort: '' | ReasoningEffort,
): { reasoning_effort?: ReasoningEffort } {
  if (!control || control.pinned || !effort || !control.efforts.includes(effort)) return {};
  return { reasoning_effort: effort };
}

/** Reasoning tokens from an OpenAI `usage` object (the final stream frame); 0 when absent. */
export function readReasoningTokens(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0;
  const u = usage as Record<string, unknown>;
  const details = u.completion_tokens_details;
  const nested = details && typeof details === 'object'
    ? (details as Record<string, unknown>).reasoning_tokens
    : undefined;
  const value = Number(nested ?? u.reasoning_tokens);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export type PlaygroundReasoningHint = 'responsesOnly' | 'tryHigher';

/**
 * Why an answer billed reasoning tokens but showed no reasoning text, when there is a
 * known reason:
 *  - OpenAI / Azure on Chat Completions never return reasoning text; summaries come back
 *    only when the model's Upstream API is Responses.
 *  - Claude returns thinking text only when it actually thought out loud; a higher
 *    effort makes that likely.
 * Nothing when the operator hid the text on purpose, when text came back, or for any
 * other model.
 */
export function playgroundReasoningHint(input: PlaygroundModelInfo & {
  hasReasoningText: boolean;
  reasoningTokens: number;
}): PlaygroundReasoningHint | null {
  if (input.hasReasoningText || !(input.reasoningTokens > 0)) return null;
  if (!shouldReturnReasoning(input.settings)) return null;

  const { driver, modelId = '' } = input;
  if ((driver === 'openai' || driver === 'azure') && resolveUpstreamApi(input.settings) === 'chat') {
    return 'responsesOnly';
  }
  if (driver === 'anthropic' || (driver === 'bedrock' && /claude|anthropic/i.test(modelId))) {
    return 'tryHigher';
  }
  return null;
}
