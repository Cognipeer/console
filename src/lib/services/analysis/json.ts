/**
 * Lenient JSON extraction for model output (handles ```json fences and chatty
 * preambles). Intentionally duplicated within this service rather than shared
 * with the evaluation engine, to keep the two services independent.
 */

import { stripInlineReasoning } from '@/lib/shared/inlineReasoning';
import { balancedJsonBlocks } from '@/lib/shared/jsonExtraction';

export type ParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export function extractJson(text: string): ParseResult {
  // Reasoning models whose upstream leaves `<reasoning>…</reasoning>` inside
  // `content` would otherwise fail here, or worse, parse a JSON-looking
  // fragment out of the chain-of-thought.
  const trimmed = stripInlineReasoning(text ?? '').trim();
  if (!trimmed) return { ok: false, error: 'empty output' };

  const direct = tryParse(trimmed);
  if (direct.ok) return direct;

  for (const block of balancedJsonBlocks(trimmed)) {
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

