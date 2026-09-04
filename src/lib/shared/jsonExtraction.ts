/**
 * Lenient JSON recovery from model output.
 *
 * A model that was asked for JSON does not always return only JSON. Two shapes
 * show up often enough to be worth handling in one place:
 *
 *   1. Chatty prose or a code fence around the payload.
 *   2. A stray fragment spliced in FRONT of the payload by a provider's
 *      constrained decoder. AWS Bedrock's `/openai/v1` gpt-oss path does this
 *      whenever `response_format` is used — observed live in eu-central-1:
 *        `{\n{"city":"Istanbul","ok":true}`      (stray brace)
 *        `{"{"city":"Istanbul","ok":true}`       (stray quote)
 *        `Sounds{   "city":"Istanbul", … }`      (answer cut off mid-word)
 *
 * Because of (2) the FIRST balanced block in the text is not always the
 * parseable one, so candidates are tried in order until one parses.
 */

/**
 * How many `{` / `[` positions are worth trying before giving up. Bounds the
 * scan on pathological input; a real payload is found within the first few.
 */
const MAX_BLOCK_CANDIDATES = 20;

/**
 * Yields every balanced object / array literal in `text`, one per opening
 * bracket, respecting string literals and escapes.
 */
export function* balancedJsonBlocks(text: string): Generator<string> {
  let candidates = 0;
  for (let start = 0; start < text.length; start += 1) {
    const open = text[start];
    if (open !== '{' && open !== '[') continue;
    if (++candidates > MAX_BLOCK_CANDIDATES) return;

    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          yield text.slice(start, i + 1);
          break;
        }
      }
    }
  }
}

export type JsonRecovery =
  | { ok: true; value: unknown; text: string }
  | { ok: false; error: string };

/**
 * Recovers the first parseable JSON value in `text`. Returns the matched
 * SUBSTRING alongside the parsed value, so a caller that has to hand the JSON
 * back on the wire can return the model's own bytes rather than a re-serialized
 * copy.
 */
export function recoverJson(text: string): JsonRecovery {
  for (const block of balancedJsonBlocks(text)) {
    try {
      return { ok: true, value: JSON.parse(block), text: block };
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, error: 'no valid JSON found in output' };
}

/**
 * Repairs an answer that was supposed to be JSON. A no-op when the text already
 * parses — the model's own formatting is never rewritten for its own sake.
 */
export function repairJsonContent(text: string): { content: string; repaired: boolean } {
  try {
    JSON.parse(text);
    return { content: text, repaired: false };
  } catch {
    const recovered = recoverJson(text);
    return recovered.ok
      ? { content: recovered.text, repaired: true }
      : { content: text, repaired: false };
  }
}
