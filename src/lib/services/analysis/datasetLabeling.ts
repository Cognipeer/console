/**
 * Dataset labeling adapter — lets the analysis engine run over an evaluation
 * dataset's items instead of the `analysis_conversations` corpus.
 *
 * The analysis engine's extract mode is already "an LLM assigns structured,
 * typed fields to a transcript", which is exactly what labeling is. All that is
 * missing is a shape conversion, so this module is pure (no DB, no model) and
 * unit-testable:
 *
 *   dataset item  →  AnalysisConversation   (labeling input)
 *   extracted fields  →  item.labels        (labeling output)
 *
 * Two decisions worth knowing about:
 *   - A human label is ground truth. It is fed to the engine as
 *     `referenceFields`, so a definition with accuracy mode on scores the
 *     LABELER against reviewer corrections, and the write-back never
 *     overwrites it.
 *   - The item's `expected.reference` (the recorded assistant reply on
 *     traffic-captured items) is appended to the transcript. Without it the
 *     labeler would only ever see the user side of the exchange and could not
 *     judge how the assistant actually did.
 */

import type { IEvaluationDatasetItem } from '@/lib/database';
import type { AnalysisConversation, AnalysisMessage } from './types';

/** Compact one-line rendering of a recorded tool call. */
function renderToolCall(call: { name: string; args?: Record<string, unknown> }): string {
  let args = '';
  try {
    args = call.args ? JSON.stringify(call.args) : '';
  } catch {
    args = '{…}';
  }
  return `[tool_call] ${call.name}(${args})`;
}

/** Flatten one dataset-item message into transcript text the labeler can read. */
function renderMessage(message: IEvaluationDatasetItem['input'][number]): AnalysisMessage {
  const parts: string[] = [];
  if (message.content) parts.push(message.content);
  for (const call of message.toolCalls ?? []) parts.push(renderToolCall(call));
  const role = message.role === 'tool' && message.name ? `tool:${message.name}` : message.role;
  return { role, content: parts.join('\n') };
}

/** The recorded assistant reply, when the item captured one. */
function referenceReply(item: IEvaluationDatasetItem): string | null {
  const reference = item.expected?.reference;
  return typeof reference === 'string' && reference.trim() !== '' ? reference : null;
}

/** Human-reviewed labels are the only ones treated as ground truth. */
export function humanLabels(item: IEvaluationDatasetItem): Record<string, unknown> | undefined {
  if (item.labelMeta?.source !== 'human') return undefined;
  return item.labels && Object.keys(item.labels).length > 0 ? item.labels : undefined;
}

/** True when this item's labels were last written by a human. */
export function isHumanLabeled(item: IEvaluationDatasetItem): boolean {
  return item.labelMeta?.source === 'human';
}

/** Convert a dataset item into the conversation shape the engine consumes. */
export function datasetItemToConversation(item: IEvaluationDatasetItem): AnalysisConversation {
  const transcript = (item.input ?? []).map(renderMessage);
  const reply = referenceReply(item);
  if (reply) transcript.push({ role: 'assistant', content: reply });
  return {
    id: item.id,
    transcript,
    referenceFields: humanLabels(item),
  };
}
