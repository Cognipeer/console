/**
 * Lenient JSON extraction for model output (handles ```json fences and chatty
 * preambles). Intentionally duplicated within this service rather than shared
 * with the evaluation engine, to keep the two services independent.
 */

export type ParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export function extractJson(text: string): ParseResult {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { ok: false, error: 'empty output' };

  const direct = tryParse(trimmed);
  if (direct.ok) return direct;

  const block = findFirstBalancedBlock(trimmed);
  if (block) {
    const parsed = tryParse(block);
    if (parsed.ok) return parsed;
  }
  return { ok: false, error: 'no valid JSON found in output' };
}

function tryParse(s: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function findFirstBalancedBlock(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const open = text[start];
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
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
