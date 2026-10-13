/**
 * What an agent turn says when the model hit its output token limit twice (the
 * second time with a raised limit) without producing an answer or a tool call.
 *
 * The turn ends cleanly with this as the assistant message; `describeTurnOutcome`
 * recognises it so the stop is reported as an incomplete run
 * (`incomplete_details.reason = max_output_tokens`) in Studio, the API and
 * portals. The text is the English rendering of i18n key
 * `agents.outputLimit.message`.
 */
export const OUTPUT_LIMIT_MESSAGE_KEY = 'agents.outputLimit.message';

const NOTICE_HEAD = 'The model reached its output token limit before it could answer';

export function outputLimitNotice(limit?: number): string {
  const detail = limit ? ` (${limit} tokens)` : '';
  return `${NOTICE_HEAD}${detail}. Raise the model's maximum output tokens or lower its reasoning effort, then try again.`;
}

/** The limit named by a notice, or `undefined`; `null` when the text is not a notice. */
export function parseOutputLimitNotice(text: string): { limit?: number } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(NOTICE_HEAD)) return null;
  const match = /^\((\d+) tokens\)/.exec(trimmed.slice(NOTICE_HEAD.length).trimStart());
  return match ? { limit: Number(match[1]) } : {};
}
