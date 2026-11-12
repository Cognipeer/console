import { HOOK_SUBJECT_KIND, joinSegments, textSubject } from '@/lib/services/guardrail/hooks/contract';
import type { HookId, HookSubject, SubjectSegment } from '@/lib/services/guardrail/hooks/contract';
import type { GuardrailContext, Message } from '@cognipeer/agent-sdk';
import { isRecord } from './sdkLoader';

// ═══════════════════════════════════════════════════════════════════════════
// Subject construction
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mirrors the SDK's own extractor (`extractLatestUserQuery`, index.mjs:3685) for
 * multi-part content, except it joins with '\n' instead of ' ' — the same
 * separator `joinSegments` uses, so the flattened text a policy sees has one
 * shape no matter which builder produced it.
 */
export function messageText(message: Message | undefined): string {
  if (!message) return '';
  return contentText(message.content);
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const text = (part as { text?: unknown } | null | undefined)?.text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * A text subject over a message's `content`, with ONE SEGMENT PER TEXT PART
 * rather than one over the flattened string.
 *
 * The segmentation exists so a redaction can be written BACK: `applyMutations`
 * rewrites each segment at its own pointer, so `/content/2/text` comes back
 * rewritten in place and the other parts (an image, a tool_use block) are
 * untouched. Flattening first and rewriting the flattened string would leave no
 * way to reassemble multi-part content, which is exactly how a redact verdict
 * degrades into "we detected it and did nothing".
 *
 * A plain string content still produces a single segment, so the common case is
 * identical to `textSubject`.
 */
export function contentSubject(content: unknown, base: string): (HookSubject & { kind: 'text' }) | null {
  if (typeof content === 'string') {
    return content ? textSubject(content, base) : null;
  }
  if (!Array.isArray(content)) return null;

  const segments: SubjectSegment[] = [];
  content.forEach((part, index) => {
    const text = (part as { text?: unknown } | null | undefined)?.text;
    if (typeof text === 'string' && text !== '') {
      segments.push({ path: `${base}/${index}/text`, text });
    }
  });
  if (segments.length === 0) return null;

  return { kind: 'text', text: segments.map((segment) => segment.text).join('\n'), segments };
}

/**
 * The inverse of `contentSubject`: put the rewritten segments back where they
 * came from, by pointer, and leave every non-text part alone.
 *
 * Returns `undefined` when nothing could be placed, which the caller reports as
 * a redaction that did not land — never as a silent success.
 */
export function rewriteContent(
  original: unknown,
  subject: HookSubject,
  base: string,
): string | unknown[] | undefined {
  if (typeof original === 'string') {
    // PATH-EXACT, not `subject.text`. A single-content subject has one segment
    // at `base` and the two agree; a multi-message subject (preModelCall) joins
    // several messages into `text`, and handing that whole string to one
    // message would splice the other messages into it.
    const exact = subject.segments.find((segment) => segment.path === base);
    if (exact) return exact.text;
    return subject.segments.length === 1 ? subject.text : undefined;
  }
  if (!Array.isArray(original)) return undefined;

  const byIndex = new Map<number, string>();
  for (const segment of subject.segments) {
    if (!segment.path.startsWith(`${base}/`)) continue;
    const index = Number(segment.path.slice(base.length + 1).split('/')[0]);
    if (Number.isInteger(index)) byIndex.set(index, segment.text);
  }
  if (byIndex.size === 0) return undefined;

  return original.map((part, index) => {
    const text = byIndex.get(index);
    if (text === undefined || !isRecord(part)) return part;
    return { ...part, text };
  });
}

/** How many trailing messages one evaluation will scan, whatever the state says.
 *  A summarisation or a restored snapshot can move `messages` under us; this cap
 *  bounds the damage to a large-but-finite scan instead of an unbounded one. */
const MAX_MESSAGES_PER_EVALUATION = 32;

interface ScanSlice {
  /** `${phase}:${messages.length}` — identifies ONE evaluation pass. */
  key: string;
  text: string;
  roles: string[];
  /**
   * ONE SEGMENT PER TEXT PART PER MESSAGE, addressed by
   * `/messages/<index>/content` (string content) or
   * `/messages/<index>/content/<part>/text` (multi-part). `<index>` is the
   * message's position in the payload's `messages` array — the WIRE array — so
   * a redaction can be written back to exactly the message it came from.
   * `text` is `joinSegments(segments)`, which equals the old flattened string.
   */
  segments: SubjectSegment[];
}

export interface RunScanState {
  /** High-water mark: messages before this index have already been scanned. */
  scanned: number;
  /** The slice computed for the evaluation currently in flight. */
  current?: ScanSlice;
  /** Rule invocations already logged and billed, by `${hook}:${ruleKind}`. */
  billed: Set<string>;
  /** Gaps already reported for this run, so a 40-iteration agent turn does not
   *  emit the same "could not redact" line 80 times. */
  warned: Set<string>;
  /**
   * `preModelCall` rewrites this run has landed, keyed by the flattened text of
   * the ORIGINAL message, valued by the rewritten `content`.
   *
   * Needed because the host applies a `messages` mutation to the wire only and
   * rebuilds the wire from the unrewritten `state.messages` on EVERY model call
   * — while the high-water mark (correctly) scans each message once. Without
   * this, iteration 2 of a tool loop would re-send the raw user turn that
   * iteration 1 had redacted. Keyed by content rather than index because a
   * compaction can move indices under us.
   */
  rewrites: Map<string, unknown>;
}

/**
 * WHY EACH MESSAGE IS SCANNED EXACTLY ONCE, rather than re-scanning the
 * transcript on every iteration:
 *   · re-scanning re-reports the same finding on every subsequent iteration,
 *     and each repeat is a fresh evaluation-log row and a fresh usage event;
 *   · the SDK's own gate (`store.lastRequestLength !== state.messages.length`)
 *     already guarantees an evaluation only happens when the transcript GREW,
 *     so "what grew" is exactly the content that has not been adjudicated yet;
 *   · and it means multi-tool turns are covered. `context.latestMessage` is only
 *     the LAST appended message, so a parallel tool call that appended three
 *     results would have two of them scanned by nobody.
 *
 * The high-water mark is initialised to "everything but the newest message", NOT
 * to zero: at the first evaluation of a run the state already holds the system
 * prompt and the whole prior conversation, and scanning those would flag the
 * operator's own instructions and re-report findings from turns that were
 * already adjudicated.
 */
export function sliceMessages(
  messages: readonly (Message | undefined)[],
  key: string,
  state: RunScanState,
): ScanSlice {
  // Both rules of one guardrail run inside the SAME evaluation pass and must
  // see the SAME slice. Without this memo the first rule would advance the
  // high-water mark and the second — the LLM/webhook half — would find nothing
  // left to scan and silently pass everything.
  if (state.current?.key === key) return state.current;

  // `scanned` beyond the end means the array was replaced under us
  // (summarisation compacts the transcript, a restored snapshot rewinds it).
  // Falling back to "the newest message" keeps the guardrail scanning something
  // real; leaving the mark alone would make the slice empty forever.
  const start =
    state.scanned > messages.length
      ? Math.max(0, messages.length - 1)
      : Math.max(state.scanned, messages.length - MAX_MESSAGES_PER_EVALUATION);

  // The system prompt is the OPERATOR's text, not the conversation's: scanning
  // it would flag the instructions themselves as an injection attempt on every
  // single run, which is the fastest way to teach a tenant to switch the
  // guardrail off.
  const scannable: Array<{ index: number; message: Message }> = [];
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role === 'system') continue;
    scannable.push({ index, message });
  }

  // Segmented PER MESSAGE so a redaction maps back to the message it came from
  // (`PAYLOAD_ADAPTERS.preModelCall.rewrite`). A PII match never straddles two
  // messages, so per-message segmentation loses no detection — unlike the
  // legacy plane's `buildSubject`, which joins into ONE segment because it can
  // never act on a pointer anyway.
  const segments: SubjectSegment[] = [];
  for (const { index, message } of scannable) {
    const subject = contentSubject(message.content, `/messages/${index}/content`);
    if (!subject) continue;
    const role = String(message.role ?? 'unknown');
    for (const segment of subject.segments) segments.push({ ...segment, role });
  }

  const slice: ScanSlice = {
    key,
    text: joinSegments(segments),
    segments,
    roles: scannable.map(({ message }) => String(message.role ?? 'unknown')),
  };

  state.scanned = messages.length;
  state.current = slice;
  return slice;
}

export function sliceForEvaluation(context: GuardrailContext, state: RunScanState): ScanSlice {
  const messages = Array.isArray(context.messages) ? context.messages : [];
  return sliceMessages(messages, `${String(context.phase)}:${messages.length}`, state);
}

/**
 * ONE segment covering the joined text, rather than one segment per message.
 * Per-message pointers would be prettier in a finding, but they buy nothing the
 * LEGACY plane can spend: mutations are unsupported there, so no finding will
 * ever be acted on by path — and a multi-segment subject makes the PII family
 * drop any match that straddles a segment boundary, which on a two-message slice
 * is a real detection loss for a real reason nobody would ever guess.
 */
export function buildSubject(hook: HookId, slice: ScanSlice): HookSubject | null {
  if (!slice.text) return null;
  if (HOOK_SUBJECT_KIND[hook] !== 'text') return null;
  return textSubject(slice.text);
}
