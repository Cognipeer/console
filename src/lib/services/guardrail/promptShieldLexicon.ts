/**
 * Non-LLM prompt-shield detector — `policy.detector: 'pattern'`.
 *
 * Pattern-matches the MECHANICAL/STRUCTURAL half of `PROMPT_SHIELD_ISSUES`:
 * the attack families that have a recognisable textual SHAPE regardless of
 * subject matter (an override phrase, a fake system block, a request for
 * the system prompt, a base64 blob paired with "decode this"). These are
 * exactly the categories a plain pattern can catch without understanding
 * what the message is ABOUT.
 *
 * DELIBERATELY NOT COVERED, AND WHY: `social_engineering`,
 * `policy_circumvention`, `hypothetical_scenario`, `payload_splitting`,
 * `context_poisoning`, `multi_language_evasion`. The LLM system prompt
 * (`llmEvaluator.ts`'s `PROMPT_SHIELD_SYSTEM_PROMPT`) is explicit that these
 * turn on INTENT, not vocabulary: "hypothetically, how does photosynthesis
 * work" and "hypothetically, how would someone make a bomb" use identical
 * framing words and only differ in what they're asking about — a keyword
 * match on "hypothetically" would flag the first as readily as the second,
 * which is a false-positive rate no `runIf` pre-filter should tolerate (see
 * `families/llm.ts`'s header on that pattern; a pre-filter that fires
 * constantly is not cheaper than always calling the judge). These
 * categories stay LLM-only.
 *
 * Same caveat as `moderationLexicon.ts`: a pattern hit means "this SHAPE is
 * present", not "this message is an attack" — a security blog post
 * discussing "ignore previous instructions" attacks contains the same
 * phrase a real attack does. This is a cheap `runIf` pre-filter / low-cost
 * standalone detector, not a claim of judge-equivalent precision.
 */

import type { GuardrailAction } from '@/lib/database/provider/types.domain';
import type { GuardrailFinding } from './types';

type Severity = 'low' | 'medium' | 'high';

interface PatternRule {
  category: string;
  severity: Severity;
  pattern: RegExp;
}

// Every pattern is case-insensitive; word-ish boundaries where that matters
// to avoid matching inside an unrelated longer word.
//
// TUZAK (found writing these — kept as a comment, not just a fixed diff,
// because the next person adding a rule here will hit it too): JS `\b` is
// ASCII-only — `[A-Za-z0-9_]` — REGARDLESS of the `u`/unicode flag, which
// does not redefine it. A Turkish letter (ö, ç, ğ, ı, ş, ü and their
// capitals) is NOT a "word char" to `\b`, so `\bönceki` never matches at
// the true start of the word "önceki": both the position before it
// (whitespace/start-of-string) AND the position it's anchored at (a
// non-word char, by `\b`'s ASCII rule) read as "non-word", so `\b` finds no
// boundary there and the whole pattern silently never fires. Confirmed
// empirically while writing this file — see
// `prompt-shield-lexicon.test.ts`'s dedicated regression test. Fix: don't
// anchor `\b` directly against a non-ASCII letter; rely on the `\s+`
// already inside the phrase, or use a lookaround against `\p{L}` under the
// `u` flag (`(?<![\p{L}\p{N}_])`) if a real boundary check is needed there.
const RULES: PatternRule[] = [
  // prompt_injection / system_override
  { category: 'prompt_injection', severity: 'high', pattern: /\bignore\s+(?:all\s+|any\s+|the\s+|previous\s+|prior\s+|above\s+|earlier\s+){1,3}(?:instructions?|rules?|prompts?)\b/i },
  { category: 'prompt_injection', severity: 'high', pattern: /\bdisregard\s+(?:your\s+|the\s+|all\s+|previous\s+){1,3}(?:instructions?|rules?|guidelines?)\b/i },
  // No leading `\b` — "önceki" starts with a non-ASCII letter (see the TUZAK note above).
  { category: 'prompt_injection', severity: 'medium', pattern: /(?:önceki|verilen|yukarıdaki)\s+(?:talimatları|kuralları)\s+(?:yok\s*say|dikkate\s*alma|unut)\b/i },
  { category: 'system_override', severity: 'high', pattern: /\bnew\s+system\s+prompt\s*:/i },
  { category: 'system_override', severity: 'high', pattern: /<\s*\/?\s*system\s*>/i },
  { category: 'system_override', severity: 'medium', pattern: /^\s*\[\s*(?:system|inst)\s*\]/im },
  { category: 'system_override', severity: 'medium', pattern: /\byou\s+are\s+now\s+(?:in\s+)?(?:a\s+new\s+)?(?:system|admin|root)\s+mode\b/i },

  // role_play / jailbreak_persona
  { category: 'jailbreak_persona', severity: 'high', pattern: /\bDAN\b.{0,40}\b(?:mode|prompt|jailbreak)\b/i },
  { category: 'jailbreak_persona', severity: 'high', pattern: /\b(?:developer|god|unrestricted|uncensored)\s+mode\s+(?:enabled|activated|on)\b/i },
  { category: 'jailbreak_persona', severity: 'medium', pattern: /\byou\s+(?:have|are)\s+no\s+(?:rules|restrictions|filters|limitations)\b/i },
  { category: 'role_play', severity: 'medium', pattern: /\bpretend\s+(?:you\s+have|to\s+have)\s+no\s+(?:rules|restrictions|filters)\b/i },
  { category: 'role_play', severity: 'medium', pattern: /\bact\s+as\s+(?:an?\s+)?(?:unrestricted|uncensored|jailbroken)\s+(?:ai|assistant|model)\b/i },

  // data_exfiltration
  { category: 'data_exfiltration', severity: 'high', pattern: /\b(?:reveal|show|print|repeat|leak)\s+(?:your|the)\s+(?:system\s+prompt|instructions|hidden\s+rules)\b/i },
  { category: 'data_exfiltration', severity: 'high', pattern: /\brepeat\s+everything\s+(?:above|before\s+this)\b/i },
  { category: 'data_exfiltration', severity: 'medium', pattern: /\bwhat\s+(?:were\s+you|are\s+your)\s+(?:told|original\s+instructions)\b/i },
  { category: 'data_exfiltration', severity: 'high', pattern: /(?:gerçek|orijinal|gizli)\s+talimatlar(?:ını)?\s+(?:göster|söyle|paylaş)/i },

  // privilege_escalation (narrow, mechanical phrasing only)
  { category: 'privilege_escalation', severity: 'medium', pattern: /\bunlock\s+(?:developer|admin|hidden)\s+(?:functions?|features?|mode)\b/i },
  { category: 'privilege_escalation', severity: 'medium', pattern: /\bgrant\s+me\s+(?:admin|root|developer)\s+access\b/i },

  // recursive_prompting (narrow)
  { category: 'recursive_prompting', severity: 'medium', pattern: /\bwrite\s+a\s+prompt\s+that\s+(?:would\s+)?(?:make|force|trick)\s+an?\s+ai\b/i },
  { category: 'recursive_prompting', severity: 'medium', pattern: /\bgenerate\s+a\s+jailbreak\s+prompt\b/i },
];

const ZERO_WIDTH_RE = /[​-‍⁠﻿­]/;
const BASE64_BLOB_RE = /[A-Za-z0-9+/]{24,}={0,2}/g;
const DECODE_VERB_RE = /\b(?:decode|execute|run|eval|çöz|çalıştır)\b/i;

/**
 * `encoding_obfuscation` gets its own function rather than a `RULES` entry:
 * it needs two co-occurring signals (a decode-shaped blob AND a verb asking
 * to act on it), not one regex.
 */
function detectEncodingObfuscation(text: string): { hit: boolean; evidence: string } {
  if (ZERO_WIDTH_RE.test(text)) {
    return { hit: true, evidence: 'zero-width characters present (common obfuscation/exfiltration channel)' };
  }
  const [firstBlob] = text.match(BASE64_BLOB_RE) ?? [];
  if (firstBlob && DECODE_VERB_RE.test(text)) {
    return { hit: true, evidence: `a base64-shaped blob paired with a decode/execute instruction ("${firstBlob.slice(0, 24)}…")` };
  }
  return { hit: false, evidence: '' };
}

/**
 * Runs every mechanical pattern once over `text`. Returns one finding per
 * DISTINCT category that matched (not one per pattern — several patterns
 * covering the same category collapse to one finding at that category's
 * highest matched severity), same finding shape `runPromptShieldPolicy`
 * (the LLM path) produces.
 */
export function runPatternPromptShieldPolicy(text: string, globalAction: GuardrailAction): GuardrailFinding[] {
  if (!text.trim()) return [];

  const bestByCategory = new Map<string, Severity>();
  const rank: Record<Severity, number> = { low: 1, medium: 2, high: 3 };
  for (const rule of RULES) {
    if (!rule.pattern.test(text)) continue;
    const current = bestByCategory.get(rule.category);
    if (!current || rank[rule.severity] > rank[current]) bestByCategory.set(rule.category, rule.severity);
  }

  const findings: GuardrailFinding[] = [...bestByCategory.entries()].map(([category, severity]) => ({
    type: 'prompt_shield' as const,
    category,
    severity,
    message: `Pattern match for prompt-shield category "${category}"`,
    action: globalAction,
    block: globalAction === 'block',
  }));

  const encoding = detectEncodingObfuscation(text);
  if (encoding.hit) {
    findings.push({
      type: 'prompt_shield',
      category: 'encoding_obfuscation',
      severity: 'medium',
      message: `Pattern match for prompt-shield category "encoding_obfuscation": ${encoding.evidence}`,
      action: globalAction,
      block: globalAction === 'block',
    });
  }

  return findings;
}
