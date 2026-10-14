/**
 * Conversation search helpers shared by the database providers: input normalisation, the escaping that keeps a
 * search string literal (LIKE wildcards, regex metacharacters), and the "first match" a result carries.
 */
import type { IAgentConversationMessage, IAgentConversationSearchMatch } from './types.domain';

export const CONVERSATION_SEARCH_MIN_LENGTH = 2;
export const CONVERSATION_SEARCH_MAX_LENGTH = 200;
export const CONVERSATION_SEARCH_SNIPPET_MAX = 160;

/** The text to look for: trimmed, capped at 200 characters; `undefined` when it is too short to search. */
export function normalizeConversationSearch(raw: string | undefined | null): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim().slice(0, CONVERSATION_SEARCH_MAX_LENGTH).trim();
  return text.length >= CONVERSATION_SEARCH_MIN_LENGTH ? text : undefined;
}

/** `%needle%` for `LIKE ... ESCAPE '\'`, with `%`, `_` and `\` in the needle taken literally. */
export function toLikePattern(needle: string): string {
  return `%${needle.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** The needle as a regular expression source that matches it literally. */
export function escapeRegex(needle: string): string {
  return needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A window of `text` around the match at `index`, whitespace collapsed, `…` where it was cut. */
export function buildSnippet(text: string, index: number, length: number): string {
  const max = CONVERSATION_SEARCH_SNIPPET_MAX;
  const collapsed = (value: string) => value.replace(/\s+/g, ' ');
  const lead = Math.max(0, Math.floor((max - length) / 3));
  let start = Math.max(0, index - lead);
  let end = Math.min(text.length, start + max);
  start = Math.max(0, end - max);
  let slice = collapsed(text.slice(start, end));
  // Collapsing can leave a space at a cut end; keep the ellipsis next to text.
  if (start > 0) slice = `…${slice.trimStart()}`;
  else slice = slice.trimStart();
  if (end < text.length) slice = `${slice.trimEnd()}…`;
  else slice = slice.trimEnd();
  return slice;
}

/** Where `needle` first occurs in a conversation: the title first, else the first message that holds it. */
export function findConversationSearchMatch(
  title: string | undefined,
  messages: IAgentConversationMessage[] | undefined,
  needle: string,
): IAgentConversationSearchMatch | undefined {
  const lowered = needle.toLowerCase();
  if (title) {
    const at = title.toLowerCase().indexOf(lowered);
    if (at >= 0) return { field: 'title', snippet: buildSnippet(title, at, needle.length) };
  }
  for (const message of messages ?? []) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const content = typeof message.content === 'string' ? message.content : '';
    const at = content.toLowerCase().indexOf(lowered);
    if (at < 0) continue;
    return {
      field: 'message',
      ...(message.id ? { messageId: message.id } : {}),
      role: message.role,
      snippet: buildSnippet(content, at, needle.length),
    };
  }
  return undefined;
}

/** The Mongo condition for "title or a message's text contains the needle": a literal, case-insensitive regex. */
export function buildMongoConversationSearchCondition(needle: string): Record<string, unknown> {
  const pattern = { $regex: escapeRegex(needle), $options: 'i' };
  return { $or: [{ title: pattern }, { messages: { $elemMatch: { content: pattern } } }] };
}
