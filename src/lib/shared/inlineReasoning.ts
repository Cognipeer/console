/**
 * Some OpenAI-compatible upstreams do not split a reasoning model's
 * chain-of-thought out of the answer: instead of populating
 * `message.reasoning_content` they leave the raw channel markup INSIDE
 * `message.content`, e.g. AWS Bedrock's `/openai/v1` shim with the gpt-oss
 * family:
 *
 *   {"message":{"content":"<reasoning>The user wants …</reasoning>Hey there"}}
 *
 * Everything downstream that treats `content` as the answer then breaks — most
 * visibly anything that parses it as JSON (`JSON.parse` → `Unexpected token
 * '<', "<reasoning"... is not valid JSON`), but also structured output, routing
 * deciders that match a label, evaluators, and the UI.
 *
 * These helpers move that markup where it belongs. They are deliberately
 * CONSERVATIVE: only a tag that opens the message (leading whitespace aside) is
 * treated as leaked reasoning, so an answer that merely *mentions* `<think>`
 * mid-sentence is never touched.
 */

/** Tags observed in the wild for a leaked reasoning channel. */
const REASONING_TAGS = ['reasoning', 'think', 'thinking', 'thought'] as const;

const OPEN_TAG_RE = new RegExp(`^<(${REASONING_TAGS.join('|')})>`, 'i');

const OPEN_TAGS = REASONING_TAGS.map((tag) => `<${tag}>`);

/** True while `partial` can still grow into an opening tag (`"<thi"`). */
function couldOpen(partial: string): boolean {
  const lower = partial.toLowerCase();
  return OPEN_TAGS.some((tag) => tag.startsWith(lower));
}

/** The longest tail we must hold back so a split closing tag is never missed. */
const MAX_CLOSE_TAG_LENGTH = Math.max(...REASONING_TAGS.map((t) => t.length + 3));

export interface InlineReasoningSplit {
  /** The answer, with any leading reasoning block removed. */
  content: string;
  /** The reasoning text that was pulled out, if any. */
  reasoning?: string;
}

/**
 * Splits a COMPLETE assistant message into answer + leaked reasoning. Returns
 * the input unchanged when there is nothing to strip.
 */
export function splitInlineReasoning(text: string): InlineReasoningSplit {
  if (!text.includes('<')) return { content: text };

  const reasoning: string[] = [];
  let rest = text;

  for (;;) {
    const lead = rest.length - rest.trimStart().length;
    const after = rest.slice(lead);
    const open = OPEN_TAG_RE.exec(after);
    if (!open) break;

    const tag = open[1].toLowerCase();
    const body = after.slice(open[0].length);
    const closeIndex = body.toLowerCase().indexOf(`</${tag}>`);

    if (closeIndex === -1) {
      // Unterminated: the completion was cut off mid-thought, so everything
      // that remains is reasoning and the answer is empty.
      reasoning.push(body);
      rest = '';
      break;
    }

    reasoning.push(body.slice(0, closeIndex));
    rest = body.slice(closeIndex + tag.length + 3);
  }

  if (reasoning.length === 0) return { content: text };

  const joined = reasoning.join('').trim();
  return {
    content: rest.trimStart(),
    ...(joined ? { reasoning: joined } : {}),
  };
}

/** `splitInlineReasoning` when only the cleaned answer is wanted. */
export function stripInlineReasoning(text: string): string {
  return splitInlineReasoning(text).content;
}

export interface InlineReasoningSplitter {
  /** Feeds one streamed delta; returns the parts that are safe to emit now. */
  push(delta: string): { content: string; reasoning: string };
  /** Releases whatever is still buffered when the stream ends. */
  flush(): { content: string; reasoning: string };
}

/**
 * The streaming counterpart. Tags arrive split across deltas
 * (`"<reason"` + `"ing>"`), so the splitter buffers just enough to recognise
 * one, and never holds back text that cannot be part of a tag.
 */
export function createInlineReasoningSplitter(): InlineReasoningSplitter {
  // `boundary`: at a position where a reasoning block may start.
  // `inside`:   within one, looking for its closing tag.
  // `passthru`: the answer has begun; nothing is inspected any more.
  let state: 'boundary' | 'inside' | 'passthru' = 'boundary';
  let buffer = '';
  let openTag = '';
  let emittedContent = false;

  const emit = (text: string) => {
    // Whitespace between a closing tag and the answer is markup padding.
    const value = emittedContent ? text : text.trimStart();
    if (value) emittedContent = true;
    return value;
  };

  const drain = (final: boolean): { content: string; reasoning: string } => {
    let content = '';
    let reasoning = '';

    for (;;) {
      if (state === 'passthru') {
        content += emit(buffer);
        buffer = '';
        break;
      }

      if (state === 'boundary') {
        const lead = buffer.length - buffer.trimStart().length;
        const after = buffer.slice(lead);
        if (!after) {
          // Only whitespace so far — a tag may still follow.
          if (final) {
            content += emit(buffer);
            buffer = '';
          }
          break;
        }
        if (after[0] !== '<') {
          state = 'passthru';
          continue;
        }
        const open = OPEN_TAG_RE.exec(after);
        if (open) {
          state = 'inside';
          openTag = open[1].toLowerCase();
          buffer = after.slice(open[0].length);
          continue;
        }
        if (!final && couldOpen(after)) break; // wait for the rest of the tag
        state = 'passthru';
        continue;
      }

      // state === 'inside'
      const closeTag = `</${openTag}>`;
      const closeIndex = buffer.toLowerCase().indexOf(closeTag);
      if (closeIndex !== -1) {
        reasoning += buffer.slice(0, closeIndex);
        buffer = buffer.slice(closeIndex + closeTag.length);
        state = 'boundary';
        continue;
      }
      if (final) {
        reasoning += buffer;
        buffer = '';
        break;
      }
      // Hold back a tail long enough to contain a split closing tag.
      const safe = Math.max(0, buffer.length - (MAX_CLOSE_TAG_LENGTH - 1));
      reasoning += buffer.slice(0, safe);
      buffer = buffer.slice(safe);
      break;
    }

    return { content, reasoning };
  };

  return {
    push(delta: string) {
      if (!delta) return { content: '', reasoning: '' };
      if (state === 'passthru') {
        return { content: emit(delta), reasoning: '' };
      }
      buffer += delta;
      return drain(false);
    },
    flush() {
      if (!buffer) return { content: '', reasoning: '' };
      return drain(true);
    },
  };
}
