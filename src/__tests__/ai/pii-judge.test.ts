/**
 * AI-judged regression: PII detector behavior.
 *
 * The regex-based detector at `src/lib/services/guardrail/piiDetector.ts` is
 * already unit-tested for exact pattern matches. This suite adds a second
 * line of defense: an LLM judge evaluates whether the DETECTOR'S OUTPUT
 * matches what a human would have flagged. That catches:
 *   - Regression in regex tuning (a tweak that drops a real-world case).
 *   - Over-blocking (flagging benign text as PII).
 *   - New PII shapes we don't yet have regex for.
 *
 * Skip behavior: this suite is skipped automatically if no judge backend is
 * configured. CI sets one of OPENAI_API_KEY / ANTHROPIC_API_KEY for nightly.
 * Local dev: leave it skipped or set JUDGE_DISABLED=1 explicitly.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { runPiiDetection } from '@/lib/services/guardrail/piiDetector';
import { resolveJudgeBackend, type JudgeBackend } from './judge';

// Resolve backend at import time so describe.skipIf gets the right flag.
const JUDGE = resolveJudgeBackend();

const PII_POLICY = {
  enabled: true,
  action: 'block' as const,
  categories: {
    email: true,
    phone: true,
    creditCard: true,
    nationalId: true,
    iban: true,
  },
};

type Case = {
  id: string;
  text: string;
  rubric: string;
};

/**
 * Realistic-ish PII corpus. Keep these synthetic — no real customer data.
 * Add cases when a regression is reported in production; the new case
 * documents the contract so the next change can't re-break it.
 */
const CASES: Case[] = [
  {
    id: 'plain-email',
    text: 'Please email me at alice.smith@example.com for follow-up.',
    rubric: 'A correct PII detector MUST flag the email address. Score 1 if flagged, 0 if missed.',
  },
  {
    id: 'phone-international',
    text: 'You can reach me at +1 (415) 555-2671 after 3pm.',
    rubric: 'A correct PII detector MUST flag the phone number. Score 1 if flagged, 0 if missed.',
  },
  {
    id: 'benign-numbers',
    text: 'The total cost is 415 dollars and the project ID is 2671.',
    rubric:
      'This text contains numbers but NO PII. Score 1 if the detector produced zero findings. ' +
      'Score 0 if it falsely flagged anything.',
  },
  {
    id: 'cc-with-spaces',
    text: 'My credit card is 4532 1488 0343 6467, expires 12/27.',
    rubric: 'A correct PII detector MUST flag the credit card number. Score 1 if flagged, 0 if missed.',
  },
];

describe.skipIf(!JUDGE)('AI-judged: PII detector behavior', () => {
  const backend = JUDGE as JudgeBackend;

  it.each(CASES)('$id', async (testCase) => {
    const findings = runPiiDetection(testCase.text, PII_POLICY);
    const verdict = await backend.judge({
      testId: `pii-${testCase.id}`,
      rubric: testCase.rubric,
      candidate: JSON.stringify(findings.map((f) => ({ category: f.category, value: f.value }))),
      context: { input: testCase.text },
    });

    // Per-test attached reason makes CI failures actionable.
    expect.soft(verdict.score, `judge reason: ${verdict.reason}`).toBeGreaterThanOrEqual(0.7);
  });
});

// Unused-import guard when backend is missing — keeps the file lint-clean.
void beforeAll;
