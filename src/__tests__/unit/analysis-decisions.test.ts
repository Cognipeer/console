/**
 * Unit tests — analysis decision layer (engine): field routing, answer
 * mapping, review flags, aggregation, input rendering, score extraction.
 * Decision and extraction invokers are fakes.
 */

import { describe, it, expect, vi } from 'vitest';
import { runAnalysis, aggregateItems } from '@/lib/services/analysis/runner';
import {
  isDecisionField,
  renderDecisionInput,
  buildDecisionQuestions,
  mapDecisionAnswer,
  applyReviewFlags,
  fnv1a32,
  MAX_DECISION_INPUT_CHARS,
} from '@/lib/services/analysis/decision';
import { coerceField, buildExtractionPrompt } from '@/lib/services/analysis/extraction';
import type {
  AnalysisConversation,
  AnalysisSpec,
  DecisionInvoker,
  FieldDef,
  ModelInvoker,
} from '@/lib/services/analysis/types';

const INTENT: FieldDef = { key: 'intent', type: 'enum', enumValues: ['billing', 'support'], required: true };
const RESOLVED: FieldDef = { key: 'resolved', type: 'boolean' };
const TONE: FieldDef = { key: 'tone', type: 'score', levels: ['bad', 'ok', 'good'] };
const SUMMARY: FieldDef = { key: 'summary', type: 'string' };
const AMOUNT: FieldDef = { key: 'amount', type: 'number' };

function conv(id: string, marker = 'hello', referenceFields?: Record<string, unknown>): AnalysisConversation {
  return { id, transcript: [{ role: 'user', content: marker }], referenceFields };
}

/** Decision invoker branching on a transcript marker. */
const decisionInvoker: DecisionInvoker = async (req) => {
  if (req.input.includes('BOOM')) throw new Error('decision exploded');
  if (req.input.includes('REFUSE')) {
    return { answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { type: 'refusal' as const }])), backendKind: 'native' };
  }
  const unsure = req.input.includes('UNSURE');
  return {
    answers: {
      intent: { type: 'choice', choice: 'billing', probabilities: { billing: unsure ? 0.5 : 0.95, support: unsure ? 0.5 : 0.05 } },
      resolved: { type: 'boolean', probability: unsure ? 0.55 : 0.9 },
      tone: { type: 'score', score: 1.8, probabilities: { '0': 0.05, '1': 0.2, '2': 0.75 }, confidence: 0.75, confidence_source: 'logprobs' },
    },
    rationale: ' because ',
    backendKind: 'structured',
  };
};

const extractionInvoker: ModelInvoker = async () => '{"summary":"short","amount":12}';

const spec = (over: Partial<AnalysisSpec> = {}): AnalysisSpec => ({
  fieldSet: [INTENT, RESOLVED, TONE, SUMMARY, AMOUNT],
  modes: {},
  useDecisionModel: true,
  ...over,
});

describe('isDecisionField', () => {
  it('routes enum, boolean and score only when a decision model is used', () => {
    for (const f of [INTENT, RESOLVED, TONE]) {
      expect(isDecisionField(f, { useDecisionModel: true })).toBe(true);
      expect(isDecisionField(f, { useDecisionModel: false })).toBe(false);
      expect(isDecisionField(f, {})).toBe(false);
    }
    expect(isDecisionField(SUMMARY, { useDecisionModel: true })).toBe(false);
    expect(isDecisionField(AMOUNT, { useDecisionModel: true })).toBe(false);
  });
});

describe('runAnalysis routing', () => {
  it('splits decision and extraction fields and merges them', async () => {
    const decision = vi.fn(decisionInvoker);
    const extraction = vi.fn(extractionInvoker);
    const result = await runAnalysis({ conversations: [conv('a')], spec: spec(), invokeExtraction: extraction, invokeDecision: decision });
    const item = result.items[0];
    expect(decision).toHaveBeenCalledTimes(1);
    expect(Object.keys(decision.mock.calls[0][0].questions)).toEqual(['intent', 'resolved', 'tone']);
    // The extraction prompt only lists text and number fields.
    const prompt = extraction.mock.calls[0][0].map((m) => m.content).join('\n');
    expect(prompt).toContain('"summary"');
    expect(prompt).not.toContain('"intent"');
    expect(item.extractedFields).toEqual({ intent: 'billing', resolved: true, tone: 'good', summary: 'short', amount: 12 });
    expect(item.error).toBeUndefined();
    expect(item.passed).toBe(true);
    expect(item.rationale).toBe('because');
  });

  it('runs without an extraction model when every field is a decision field', async () => {
    const result = await runAnalysis({
      conversations: [conv('a')],
      spec: spec({ fieldSet: [INTENT, RESOLVED] }),
      invokeDecision: decisionInvoker,
    });
    expect(result.items[0].error).toBeUndefined();
    expect(result.items[0].extractedFields).toEqual({ intent: 'billing', resolved: true });
  });

  it('reports a missing extraction model when text fields remain', async () => {
    const result = await runAnalysis({ conversations: [conv('a')], spec: spec(), invokeDecision: decisionInvoker });
    expect(result.items[0].error).toBe('No extraction model configured');
    expect(result.items[0].passed).toBe(false);
    // The decision half still answered.
    expect(result.items[0].decisions?.intent.answer).toBe('billing');
  });

  it('extracts decision-type fields when no decision invoker is given', async () => {
    const extraction: ModelInvoker = async () => '{"intent":"support","resolved":false,"tone":"ok"}';
    const result = await runAnalysis({
      conversations: [conv('a')],
      spec: spec({ fieldSet: [INTENT, RESOLVED, TONE] }),
      invokeExtraction: extraction,
    });
    expect(result.items[0].extractedFields).toEqual({ intent: 'support', resolved: false, tone: 'ok' });
    expect(result.items[0].decisions).toBeUndefined();
    expect(result.aggregate.decisions).toBeUndefined();
  });

  it('joins errors when both halves fail', async () => {
    const result = await runAnalysis({
      conversations: [conv('a', 'BOOM')],
      spec: spec(),
      invokeExtraction: async () => {
        throw new Error('extract boom');
      },
      invokeDecision: decisionInvoker,
    });
    expect(result.items[0].error).toBe('extract boom; decision exploded');
    expect(result.items[0].missing).toEqual(['intent']);
    expect(result.aggregate.failed).toBe(1);
  });

  it('marks required decision fields missing on a refusal and flags the item', async () => {
    const result = await runAnalysis({
      conversations: [conv('a', 'REFUSE')],
      spec: spec({ fieldSet: [INTENT, RESOLVED] }),
      invokeDecision: decisionInvoker,
    });
    const item = result.items[0];
    expect(item.missing).toEqual(['intent']);
    expect(item.decisions?.intent).toMatchObject({ refused: true, confidence: 0, needsReview: true });
    expect(item.needsReview).toBe(true);
    expect(item.reviewReason).toBe('low_confidence');
    expect(item.minConfidence).toBe(0);
  });

  it('scores accuracy over merged fields, decision labels included', async () => {
    const result = await runAnalysis({
      conversations: [conv('a', 'hello', { intent: 'Billing', tone: 'GOOD', resolved: false })],
      spec: spec({ fieldSet: [INTENT, RESOLVED, TONE], modes: { accuracy: true } }),
      invokeDecision: decisionInvoker,
    });
    expect(result.items[0].accuracy?.comparedCount).toBe(3);
    expect(result.items[0].accuracy?.score).toBeCloseTo(2 / 3, 5);
  });

  it('works for conversations of different confidence under bounded concurrency', async () => {
    const result = await runAnalysis({
      conversations: [conv('a'), conv('b', 'UNSURE'), conv('c')],
      spec: spec({ fieldSet: [INTENT, RESOLVED, TONE] }),
      invokeDecision: decisionInvoker,
      config: { concurrency: 2 },
    });
    expect(result.items.map((i) => i.needsReview)).toEqual([false, true, false]);
  });
});

describe('mapDecisionAnswer', () => {
  it('maps a choice with its own confidence and source', () => {
    const { decision, value } = mapDecisionAnswer(
      INTENT,
      { type: 'choice', choice: 'support', probabilities: { billing: 0.2, support: 0.8 }, confidence: 0.77, confidence_source: 'logprobs' },
      'structured',
    );
    expect(value).toBe('support');
    expect(decision).toMatchObject({ answer: 'support', confidence: 0.77, confidenceSource: 'logprobs' });
  });

  it('falls back to the top probability and the backend kind', () => {
    const answer = { type: 'choice' as const, choice: 'support', probabilities: { billing: 0.2, support: 0.8 } };
    expect(mapDecisionAnswer(INTENT, answer, 'structured').decision).toMatchObject({ confidence: 0.8, confidenceSource: 'self_reported' });
    expect(mapDecisionAnswer(INTENT, answer, 'native').decision).toMatchObject({ confidence: 0.8, confidenceSource: 'native' });
  });

  it('maps a boolean from its probability only', () => {
    const yes = mapDecisionAnswer(RESOLVED, { type: 'boolean', probability: 0.8 }, 'native');
    expect(yes.value).toBe(true);
    expect(yes.decision.answer).toBe(true);
    expect(yes.decision.confidence).toBeCloseTo(0.8, 10);
    expect(yes.decision.probabilities?.yes).toBeCloseTo(0.8, 10);
    expect(yes.decision.probabilities?.no).toBeCloseTo(0.2, 10);
    const no = mapDecisionAnswer(RESOLVED, { type: 'boolean', probability: 0.1 }, 'structured');
    expect(no.value).toBe(false);
    expect(no.decision.confidence).toBeCloseTo(0.9, 10);
    expect(no.decision.confidenceSource).toBe('self_reported');
  });

  it('maps a score to its most likely level label and re-keys probabilities', () => {
    const { decision, value } = mapDecisionAnswer(
      TONE,
      { type: 'score', score: 1.6, probabilities: { '0': 0.1, '1': 0.3, '2': 0.6 } },
      'structured',
    );
    expect(value).toBe('good');
    expect(decision).toMatchObject({ answer: 'good', score: 1.6, probabilities: { bad: 0.1, ok: 0.3, good: 0.6 }, confidence: 0.6 });
  });

  it('answers a score with the most likely level, not the rounded expectation, so the confidence is that answer\'s', () => {
    // Expected level 0.78 rounds to "ok", but "bad" is the likeliest (0.48): the answer and its confidence must agree.
    const { decision } = mapDecisionAnswer(
      TONE,
      { type: 'score', score: 0.78, probabilities: { '0': 0.48, '1': 0.26, '2': 0.26 }, confidence: 0.48 },
      'structured',
    );
    expect(decision).toMatchObject({ answer: 'bad', score: 0.78, confidence: 0.48 });
  });

  it('clamps a score outside the levels', () => {
    expect(mapDecisionAnswer(TONE, { type: 'score', score: 7, probabilities: {} }, 'native').value).toBe('good');
    expect(mapDecisionAnswer(TONE, { type: 'score', score: -3, probabilities: {} }, 'native').value).toBe('bad');
  });

  it('treats a refusal, a missing answer and a wrong shape as refused', () => {
    for (const answer of [{ type: 'refusal' as const }, undefined, { type: 'boolean' as const, probability: 0.9 }]) {
      const { decision, value } = mapDecisionAnswer(INTENT, answer, 'native');
      expect(decision).toEqual({ confidence: 0, refused: true });
      expect(value).toBeUndefined();
    }
  });
});

describe('buildDecisionQuestions', () => {
  it('builds choice, boolean and score questions with defaults', () => {
    const q = buildDecisionQuestions([INTENT, { key: 'is_resolved', type: 'boolean' }, TONE]);
    expect(q.intent).toEqual({
      type: 'choice',
      instructions: 'Which option best describes "intent" in this conversation?',
      choices: { billing: 'billing', support: 'support' },
    });
    expect(q.is_resolved).toEqual({ type: 'boolean', instructions: 'Yes or no: is resolved?' });
    expect(q.tone).toEqual({ type: 'score', instructions: 'Rate "tone" for this conversation.', levels: ['bad', 'ok', 'good'] });
  });

  it('prefers the field description', () => {
    const q = buildDecisionQuestions([{ ...RESOLVED, description: 'Did the agent solve it?' }]);
    expect(q.resolved).toEqual({ type: 'boolean', instructions: 'Did the agent solve it?' });
  });
});

describe('renderDecisionInput', () => {
  it('renders role-tagged lines with a transcript heading', () => {
    const c: AnalysisConversation = { id: 'x', transcript: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] };
    expect(renderDecisionInput(c)).toBe('Transcript:\n[user] hi\n[assistant] hello');
    expect(renderDecisionInput(c, 'Support chat')).toBe('Context: Support chat\n\nTranscript:\n[user] hi\n[assistant] hello');
  });

  it('truncates the middle of an over-long transcript, keeping more of the end', () => {
    const big: AnalysisConversation = {
      id: 'x',
      transcript: [
        { role: 'user', content: 'START' + 'a'.repeat(150_000) },
        { role: 'assistant', content: 'b'.repeat(150_000) + 'END' },
      ],
    };
    const out = renderDecisionInput(big);
    expect(out.length).toBeLessThanOrEqual(MAX_DECISION_INPUT_CHARS);
    expect(out).toContain('[user] START');
    expect(out.endsWith('END')).toBe(true);
    expect(out).toMatch(/\n\[… \d+ characters omitted …\]\n/);
    const head = out.indexOf('\n[… ');
    const tail = out.length - out.indexOf('…]\n') - 3;
    expect(tail).toBeGreaterThan(head * 1.5);
  });
});

describe('applyReviewFlags', () => {
  const decisions = { intent: { answer: 'billing', confidence: 0.75 }, resolved: { answer: true, confidence: 0.9 } };

  it('uses the default threshold of 0.7', () => {
    const flags = applyReviewFlags(decisions, [INTENT, RESOLVED], {}, 'c1');
    expect(flags.needsReview).toBe(false);
    expect(flags.minConfidence).toBe(0.75);
  });

  it('flags below the definition threshold', () => {
    const flags = applyReviewFlags(decisions, [INTENT, RESOLVED], { review: { threshold: 0.8 } }, 'c1');
    expect(flags).toMatchObject({ needsReview: true, reviewReason: 'low_confidence', minConfidence: 0.75 });
    expect(flags.decisions.intent.needsReview).toBe(true);
    expect(flags.decisions.resolved.needsReview).toBeUndefined();
  });

  it('lets a field override the threshold', () => {
    const flags = applyReviewFlags(decisions, [{ ...INTENT, reviewBelow: 0.5 }, { ...RESOLVED, reviewBelow: 0.95 }], { review: { threshold: 0.8 } }, 'c1');
    expect(flags.decisions.intent.needsReview).toBeUndefined();
    expect(flags.decisions.resolved.needsReview).toBe(true);
  });

  it('treats a refusal as confidence 0', () => {
    const flags = applyReviewFlags({ intent: { confidence: 0, refused: true } }, [INTENT], {}, 'c1');
    expect(flags).toMatchObject({ needsReview: true, minConfidence: 0 });
  });

  it('never flags an item without decisions', () => {
    const flags = applyReviewFlags({}, [], { review: { spotCheckPct: 100 } }, 'c1');
    expect(flags).toEqual({ decisions: {}, needsReview: false, minConfidence: 1 });
  });

  it('picks spot-checks deterministically from the salt and conversation id', () => {
    const confident = { intent: { answer: 'billing', confidence: 0.99 } };
    const picks = (pct: number, salt: string) =>
      Array.from({ length: 200 }, (_, i) => `conv-${i}`).filter(
        (id) => applyReviewFlags(confident, [INTENT], { review: { spotCheckPct: pct }, spotCheckSalt: salt }, id).reviewReason === 'spot_check',
      );
    expect(picks(0, 'def')).toEqual([]);
    expect(picks(100, 'def')).toHaveLength(200);
    const twenty = picks(20, 'def');
    expect(twenty).toEqual(picks(20, 'def'));
    expect(twenty.length).toBeGreaterThan(15);
    expect(twenty.length).toBeLessThan(70);
    expect(twenty).not.toEqual(picks(20, 'other'));
    // A spot-check leaves the decisions themselves unflagged.
    const id = twenty[0];
    const flags = applyReviewFlags(confident, [INTENT], { review: { spotCheckPct: 20 }, spotCheckSalt: 'def' }, id);
    expect(flags.needsReview).toBe(true);
    expect(flags.decisions.intent.needsReview).toBeUndefined();
  });

  it('hashes with FNV-1a 32', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
  });

  it('prefers low confidence over a spot-check', () => {
    const flags = applyReviewFlags({ intent: { answer: 'billing', confidence: 0.1 } }, [INTENT], { review: { spotCheckPct: 100 } }, 'c');
    expect(flags.reviewReason).toBe('low_confidence');
  });
});

describe('aggregation', () => {
  it('counts answers, refusals, flags and means per decision field', async () => {
    const result = await runAnalysis({
      conversations: [conv('a'), conv('b', 'UNSURE'), conv('c', 'REFUSE'), conv('d')],
      spec: spec({ fieldSet: [INTENT, RESOLVED, TONE] }),
      invokeDecision: decisionInvoker,
    });
    const { aggregate } = result;
    expect(aggregate.needsReview).toBe(2); // b (0.5 intent) and c (refused)
    const intent = aggregate.decisions?.intent;
    expect(intent).toMatchObject({ answered: 3, refused: 1, needsReview: 2, counts: { billing: 3 } });
    expect(intent?.avgConfidence).toBeCloseTo((0.95 + 0.5 + 0.95) / 3, 5);
    expect(aggregate.decisions?.resolved.counts).toEqual({ yes: 3 });
    const tone = aggregate.decisions?.tone;
    expect(tone?.counts).toEqual({ good: 3 });
    expect(tone?.avgScore).toBeCloseTo(1.8, 5);
    expect(aggregate.decisions?.intent.avgScore).toBeUndefined();
  });

  it('aggregates chunked items with aggregateItems', async () => {
    const s = spec({ fieldSet: [INTENT, RESOLVED] });
    const a = await runAnalysis({ conversations: [conv('a')], spec: s, invokeDecision: decisionInvoker });
    const b = await runAnalysis({ conversations: [conv('b', 'UNSURE')], spec: s, invokeDecision: decisionInvoker });
    const merged = aggregateItems([...a.items, ...b.items], s.fieldSet, s);
    expect(merged.total).toBe(2);
    expect(merged.needsReview).toBe(1);
    expect(merged.decisions?.intent.answered).toBe(2);
  });
});

describe('score extraction fallback', () => {
  const field: FieldDef = { key: 'tone', type: 'score', levels: ['Low', 'Medium', 'High'] };

  it('accepts a level label case-insensitively', () => {
    expect(coerceField('high', field)).toEqual({ value: 'High', valid: true });
    expect(coerceField(' Medium ', field)).toEqual({ value: 'Medium', valid: true });
  });

  it('maps a 0-based index to its label', () => {
    expect(coerceField(0, field)).toEqual({ value: 'Low', valid: true });
    expect(coerceField('2', field)).toEqual({ value: 'High', valid: true });
  });

  it('rejects unknown levels and out-of-range indexes', () => {
    expect(coerceField('great', field).valid).toBe(false);
    expect(coerceField(3, field).valid).toBe(false);
    expect(coerceField(1.5, field).valid).toBe(false);
    expect(coerceField('', field).valid).toBe(false);
    expect(coerceField(null, field).valid).toBe(false);
  });

  it('prefers a label over an index when levels are numeric', () => {
    expect(coerceField('1', { key: 's', type: 'score', levels: ['1', '2', '3'] })).toEqual({ value: '1', valid: true });
  });

  it('lists the levels in the extraction prompt', () => {
    const prompt = buildExtractionPrompt(conv('a'), [field]).map((m) => m.content).join('\n');
    expect(prompt).toContain('one of Low | Medium | High');
  });
});

describe('back-compat (no decision model)', () => {
  it('keeps the item shape and adds only needsReview: 0 to the aggregate', async () => {
    const fieldSet: FieldDef[] = [INTENT, RESOLVED];
    const extraction: ModelInvoker = async () => '{"intent":"support","resolved":false}';
    const result = await runAnalysis({
      conversations: [conv('a', 'hi', { intent: 'support' })],
      spec: { fieldSet, modes: { accuracy: true } },
      invokeExtraction: extraction,
      invokeDecision: decisionInvoker as DecisionInvoker,
    });
    const keys = (obj: object) => Object.keys(obj).filter((k) => (obj as Record<string, unknown>)[k] !== undefined).sort();
    expect(keys(result.items[0])).toEqual(['accuracy', 'conversationId', 'extractedFields', 'missing', 'passed']);
    expect(result.items[0].extractedFields).toEqual({ intent: 'support', resolved: false });
    expect(result.aggregate).toEqual({
      total: 1,
      completed: 1,
      failed: 0,
      passed: 1,
      passRate: 1,
      avgJudgeScore: null,
      avgExtractionAccuracy: 1,
      needsReview: 0,
    });
  });
});
