/**
 * Deterministic system-prompt checks ("prompt lint").
 *
 * Pure, model-free analysis of a system prompt: every check is a mechanical
 * rule with a reproducible verdict — no LLM involved — so the results are
 * stable across runs and safe to gate on. Consumed by the agent-insights
 * surface (tracing) which extracts the live system prompt from recent traces.
 *
 * Verdicts: 'pass' | 'warn' | 'fail'. A check that does not apply (e.g. the
 * prompt is empty) reports 'pass' with a detail note — the checklist length
 * is stable so UIs can render a fixed list.
 */

export type PromptCheckStatus = 'pass' | 'warn' | 'fail';

export interface PromptCheckResult {
  id: string;
  label: string;
  status: PromptCheckStatus;
  /** Human-readable evidence: what was measured / matched. */
  detail: string;
}

export interface PromptLintReport {
  /** Basic size profile. */
  chars: number;
  lines: number;
  /** Rough token estimate (chars / 4) — display only, not billing. */
  estTokens: number;
  paragraphs: number;
  checks: PromptCheckResult[];
  passed: number;
  warned: number;
  failed: number;
}

/** Normalise a block for duplicate comparison. */
function normalizeBlock(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Split into paragraphs (blank-line separated blocks). */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Split into sentences (rough, deterministic). */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const PLACEHOLDER_PATTERNS: Array<{ re: RegExp; name: string }> = [
  { re: /\bTODO\b/i, name: 'TODO' },
  { re: /\bFIXME\b/i, name: 'FIXME' },
  { re: /\bXXX\b/, name: 'XXX' },
  { re: /lorem ipsum/i, name: 'lorem ipsum' },
  { re: /<(?:placeholder|insert|your[-_ ]?\w*)>/i, name: '<placeholder>' },
  { re: /\{\{[^}]*\}\}/, name: '{{unrendered template}}' },
];

/** Patterns that look like per-request dynamic content (cache killers). */
const DYNAMIC_PATTERNS: Array<{ re: RegExp; name: string }> = [
  // ISO dates / datetimes
  { re: /\b20\d{2}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?/, name: 'ISO date/time' },
  // Clock times like 14:35:22
  { re: /\b\d{1,2}:\d{2}:\d{2}\b/, name: 'clock timestamp' },
  // UUIDs
  { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, name: 'UUID' },
  // Unix epoch (10-13 digits standing alone)
  { re: /\b1[6-9]\d{8,11}\b/, name: 'epoch timestamp' },
];

/** How much of the prompt head is treated as the cache-critical prefix. */
const PREFIX_WINDOW_CHARS = 600;
/** Sentences shorter than this are ignored by the duplicate-sentence check. */
const MIN_DUP_SENTENCE_CHARS = 60;
/** Paragraphs shorter than this are ignored by the duplicate-paragraph check. */
const MIN_DUP_PARAGRAPH_CHARS = 40;
/** Size thresholds (est. tokens). */
const SIZE_WARN_TOKENS = 8_000;
const SIZE_FAIL_TOKENS = 32_000;
/** Unique-trigram ratio below which the prompt is considered repetitive. */
const TRIGRAM_WARN_RATIO = 0.55;

/** Run every deterministic check against a system prompt. */
export function lintSystemPrompt(prompt: string): PromptLintReport {
  const text = prompt ?? '';
  const chars = text.length;
  const lines = text.length === 0 ? 0 : text.split('\n').length;
  const estTokens = Math.ceil(chars / 4);
  const paragraphs = splitParagraphs(text);
  const checks: PromptCheckResult[] = [];
  const empty = chars === 0;

  // ── 1. Size budget ──────────────────────────────────────────────────
  checks.push({
    id: 'size',
    label: 'Size budget',
    status: empty
      ? 'pass'
      : estTokens > SIZE_FAIL_TOKENS
        ? 'fail'
        : estTokens > SIZE_WARN_TOKENS
          ? 'warn'
          : 'pass',
    detail: empty
      ? 'Prompt is empty — nothing to measure.'
      : `~${estTokens.toLocaleString()} tokens (${chars.toLocaleString()} chars, ${lines} lines). Thresholds: warn >${SIZE_WARN_TOKENS.toLocaleString()}, fail >${SIZE_FAIL_TOKENS.toLocaleString()}.`,
  });

  // ── 2. Duplicate paragraphs ─────────────────────────────────────────
  const paragraphCounts = new Map<string, { text: string; n: number }>();
  for (const p of paragraphs) {
    if (p.length < MIN_DUP_PARAGRAPH_CHARS) continue;
    const key = normalizeBlock(p);
    const entry = paragraphCounts.get(key) ?? { text: p, n: 0 };
    entry.n += 1;
    paragraphCounts.set(key, entry);
  }
  const dupParagraphs = [...paragraphCounts.values()].filter((e) => e.n > 1);
  checks.push({
    id: 'dup-paragraph',
    label: 'Duplicate paragraphs',
    status: dupParagraphs.length > 0 ? 'fail' : 'pass',
    detail: dupParagraphs.length > 0
      ? `${dupParagraphs.length} paragraph(s) appear more than once — first: "${dupParagraphs[0].text.slice(0, 80)}…" (${dupParagraphs[0].n}×)`
      : 'No paragraph appears more than once.',
  });

  // ── 3. Duplicate sentences ──────────────────────────────────────────
  const sentenceCounts = new Map<string, { text: string; n: number }>();
  for (const s of splitSentences(text)) {
    if (s.length < MIN_DUP_SENTENCE_CHARS) continue;
    const key = normalizeBlock(s);
    const entry = sentenceCounts.get(key) ?? { text: s, n: 0 };
    entry.n += 1;
    sentenceCounts.set(key, entry);
  }
  const dupSentences = [...sentenceCounts.values()].filter((e) => e.n > 1);
  checks.push({
    id: 'dup-sentence',
    label: 'Duplicate sentences',
    status: dupSentences.length > 0 ? 'warn' : 'pass',
    detail: dupSentences.length > 0
      ? `${dupSentences.length} long sentence(s) appear more than once — first: "${dupSentences[0].text.slice(0, 80)}…" (${dupSentences[0].n}×)`
      : 'No repeated long sentences.',
  });

  // ── 4. Repetitiveness (unique-trigram ratio) ────────────────────────
  const words = normalizeBlock(text).split(' ').filter((w) => w.length > 0);
  let trigramStatus: PromptCheckStatus = 'pass';
  let trigramDetail = 'Too short to measure (<50 words) — skipped.';
  if (words.length >= 50) {
    const trigrams = new Set<string>();
    for (let i = 0; i + 2 < words.length; i += 1) {
      trigrams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }
    const ratio = trigrams.size / (words.length - 2);
    trigramStatus = ratio < TRIGRAM_WARN_RATIO ? 'warn' : 'pass';
    trigramDetail = `Unique three-word ratio ${(ratio * 100).toFixed(0)}% (threshold ${(TRIGRAM_WARN_RATIO * 100).toFixed(0)}%). Lower ratio = more repetition.`;
  }
  checks.push({ id: 'repetition', label: 'Overall repetitiveness', status: trigramStatus, detail: trigramDetail });

  // ── 5. Dynamic content in the cache-critical prefix ─────────────────
  const prefix = text.slice(0, PREFIX_WINDOW_CHARS);
  const dynamicHit = DYNAMIC_PATTERNS.find((p) => p.re.test(prefix));
  checks.push({
    id: 'dynamic-prefix',
    label: 'Dynamic content in prefix (cache killer)',
    status: dynamicHit ? 'fail' : 'pass',
    detail: dynamicHit
      ? `Found ${dynamicHit.name} in the first ${PREFIX_WINDOW_CHARS} chars — a prefix that changes per request resets the prompt cache. Move dynamic content to the END of the prompt.`
      : `No date/time/UUID in the first ${PREFIX_WINDOW_CHARS} chars — the prefix looks cacheable.`,
  });

  // ── 6. Placeholder / unfinished markers ─────────────────────────────
  const placeholderHit = PLACEHOLDER_PATTERNS.find((p) => p.re.test(text));
  checks.push({
    id: 'placeholder',
    label: 'Placeholder / unfinished content',
    status: placeholderHit ? 'warn' : 'pass',
    detail: placeholderHit
      ? `Found a "${placeholderHit.name}" marker — the prompt may contain unfinished content.`
      : 'No TODO/FIXME/template leftovers.',
  });

  // ── 7. Whitespace hygiene ───────────────────────────────────────────
  const trailingWs = text.split('\n').filter((l) => /[ \t]+$/.test(l)).length;
  const blankRuns = (text.match(/\n{4,}/g) ?? []).length;
  const wsIssues: string[] = [];
  if (trailingWs > 0) wsIssues.push(`trailing whitespace on ${trailingWs} line(s)`);
  if (blankRuns > 0) wsIssues.push(`3+ consecutive blank lines in ${blankRuns} place(s)`);
  checks.push({
    id: 'whitespace',
    label: 'Whitespace hygiene',
    status: wsIssues.length > 0 ? 'warn' : 'pass',
    detail: wsIssues.length > 0 ? wsIssues.join('; ') + ' — wasted tokens.' : 'Whitespace usage is clean.',
  });

  // ── 8. Control / non-printable characters ───────────────────────────
  const controlChars = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) ?? []).length;
  checks.push({
    id: 'control-chars',
    label: 'Invisible / control characters',
    status: controlChars > 0 ? 'warn' : 'pass',
    detail: controlChars > 0
      ? `Found ${controlChars} control character(s) — likely copy/paste residue.`
      : 'No control characters.',
  });

  const passed = checks.filter((c) => c.status === 'pass').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  const failed = checks.filter((c) => c.status === 'fail').length;
  return { chars, lines, estTokens, paragraphs: paragraphs.length, checks, passed, warned, failed };
}
