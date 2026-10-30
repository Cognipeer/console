/**
 * What an agent turn says when the model could not finish inside its output
 * token limit, and how the turn learns it.
 *
 * Two endings, both reported by the chat model (gatewayChatModel.ts) through an
 * `OutputLimitTap` and never recognised by their text:
 *  - `notice`: the model hit its output limit twice (the second time with a
 *    raised limit) without producing an answer or a tool call, or its context
 *    window was full. The turn ends cleanly with the notice as the assistant
 *    message.
 *  - `truncated`: the model answered, and the answer was cut off at the limit.
 *    The text stays; the turn is partial.
 *
 * `describeTurnOutcome` turns a report into `stopReason: 'limit'` (incomplete
 * details reason `max_output_tokens`) for Studio, the API and portals. A
 * `notice` is no answer of the model's: the message is flagged
 * (`markOutputLimitNotice`) and left out of the history the next turn replays,
 * and the call that carries it finishes `length` (not `stop`), so a reader of
 * the finish reason (a summarizer) can tell it from an answer.
 * The text is the English rendering of i18n key `agents.outputLimit.message`.
 */
export const OUTPUT_LIMIT_MESSAGE_KEY = 'agents.outputLimit.message';

/** What an output-limit ending reports about itself. */
export type OutputLimitReport =
  /** The model said nothing usable: `contextWindow` when its context window was full rather than its output limit. */
  | { kind: 'notice'; limit?: number; contextWindow?: boolean }
  /** The answer is the model's own, cut off at the limit. */
  | { kind: 'truncated'; limit?: number };

/**
 * Where the chat model of ONE run leaves its output-limit ending, for the
 * turn's outcome to read. Every model call clears it first, so it only ever
 * describes the latest call.
 */
export interface OutputLimitTap {
  record(report: OutputLimitReport): void;
  clear(): void;
  latest(): OutputLimitReport | undefined;
}

export function createOutputLimitTap(): OutputLimitTap {
  let current: OutputLimitReport | undefined;
  return {
    record: (report) => { current = report; },
    clear: () => { current = undefined; },
    latest: () => current,
  };
}

/** The limit notice (`limit`: the limit the last attempt ran with). Points at the settings that raise it. */
export function outputLimitNotice(limit?: number): string {
  const detail = limit ? ` (${limit} tokens)` : '';
  return `The model reached its output token limit before it could answer${detail}. `
    + 'Raise max_tokens (the agent\'s "Max output tokens per call", or the model\'s "Default max tokens") '
    + 'or lower the reasoning effort, then try again.';
}

/**
 * What a live view of the turn's thinking shows where the model starts again with a higher output limit:
 * the failed attempt's thinking is already on screen (a stream cannot take it back) and the retry's follows
 * it. English, like the notice above.
 */
export function outputLimitRetrySeparator(): string {
  return '\n\n[Retrying with a higher output limit]\n\n';
}

/** The notice for a model whose context window is full: more output tokens would not help. */
export function contextWindowNotice(): string {
  return 'The conversation no longer fits the model\'s context window, so it could not answer. '
    + 'Shorten the conversation or its inputs, or start a new session, then try again.';
}

const CONTEXT_WINDOW_STOP = 'contextWindow exceeded by the model';
const NOTICE_STOP_SUFFIX = 'reached by the model';

/** The `stopDetail` a report is stored with. `incompleteReason` reads the `maxOutputTokens` prefix. */
export function outputLimitStopDetail(report: OutputLimitReport): string {
  if (report.kind === 'notice' && report.contextWindow) return CONTEXT_WINDOW_STOP;
  const limit = report.limit ? ` (${report.limit})` : '';
  return report.kind === 'notice'
    ? `maxOutputTokens${limit} ${NOTICE_STOP_SUFFIX}`
    : `maxOutputTokens${limit} cut the answer short`;
}

/** True for the stored stop of a turn that ended with a notice (not for one that kept a truncated answer). */
export function isOutputLimitNoticeStop(stopReason: string | undefined, stopDetail: string | undefined): boolean {
  return stopReason === 'limit'
    && typeof stopDetail === 'string'
    && (stopDetail === CONTEXT_WINDOW_STOP || (stopDetail.startsWith('maxOutputTokens') && stopDetail.endsWith(NOTICE_STOP_SUFFIX)));
}

/** The key on a stored message's `additional_kwargs` that says "the console wrote this, the model did not". */
export const OUTPUT_LIMIT_NOTICE_FLAG = 'consoleOutputLimitNotice';

type LooseMessage = Record<string, unknown> & { role?: string; additional_kwargs?: unknown };

/** True for a state message the run flagged as a limit notice. */
export function isOutputLimitNoticeMessage(message: unknown): boolean {
  const kwargs = (message as LooseMessage | null | undefined)?.additional_kwargs;
  return Boolean(kwargs && typeof kwargs === 'object' && (kwargs as Record<string, unknown>)[OUTPUT_LIMIT_NOTICE_FLAG]);
}

/**
 * Flags the notice a run ended with (the last assistant message of its state), so
 * the state carried to the next turn leaves it out. Only a `notice` is flagged: a
 * `truncated` answer is the model's own words and stays in the history.
 */
export function markOutputLimitNotice(state: unknown, report: OutputLimitReport | undefined): void {
  if (report?.kind !== 'notice') return;
  const messages = (state as { messages?: unknown } | undefined)?.messages;
  if (!Array.isArray(messages)) return;
  const last = messages[messages.length - 1] as LooseMessage | undefined;
  if (!last || typeof last !== 'object' || last.role !== 'assistant') return;
  const kwargs = last.additional_kwargs && typeof last.additional_kwargs === 'object'
    ? last.additional_kwargs as Record<string, unknown>
    : {};
  last.additional_kwargs = { ...kwargs, [OUTPUT_LIMIT_NOTICE_FLAG]: true };
}
