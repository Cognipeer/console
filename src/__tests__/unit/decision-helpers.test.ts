import { describe, expect, it } from 'vitest';
import {
  DECISION_LIMITS,
  DecisionRequestError,
  buildDecisionQuestionsPrompt,
  buildDecisionResponseFormat,
  buildDecisionSchema,
  normalizeDecisionOutput,
  parseDecisionRequest,
  refuseAll,
} from '@/lib/providers/contracts/decisionHelpers';
import type { DecisionQuestion } from '@/lib/providers/domains/decision';

const questions: Record<string, DecisionQuestion> = {
  sentiment: {
    type: 'choice',
    instructions: 'How does the customer feel?',
    choices: { happy: 'Pleased', neutral: 'Indifferent', angry: 'Upset' },
  },
  urgent: { type: 'boolean' },
  severity: { type: 'score', levels: ['low', 'medium', 'high'] },
};

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    model: 'decider',
    input: 'The package never arrived.',
    questions: { q: { type: 'boolean' } },
    ...overrides,
  };
}

function expectRequestError(fn: () => unknown, match: RegExp, extra: Partial<DecisionRequestError> = {}) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DecisionRequestError);
    expect((error as Error).message).toMatch(match);
    for (const [key, value] of Object.entries(extra)) {
      expect((error as unknown as Record<string, unknown>)[key]).toBe(value);
    }
    return;
  }
  throw new Error('expected DecisionRequestError');
}

describe('parseDecisionRequest', () => {
  it('accepts a string input and the three question types', () => {
    const parsed = parseDecisionRequest(validBody({ questions }));
    expect(parsed.input).toEqual([{ type: 'text', text: 'The package never arrived.' }]);
    expect(Object.keys(parsed.questions)).toEqual(['sentiment', 'urgent', 'severity']);
    expect(parsed.includeRationale).toBe(false);
  });

  it('accepts text + image parts and include_rationale', () => {
    const parsed = parseDecisionRequest(validBody({
      input: [
        { type: 'text', text: 'see' },
        { type: 'image', data_url: 'data:image/png;base64,AAAA' },
      ],
      options: { include_rationale: true },
    }));
    expect(parsed.input).toHaveLength(2);
    expect(parsed.includeRationale).toBe(true);
  });

  it('rejects a missing model, empty input, stream and bad options', () => {
    expectRequestError(() => parseDecisionRequest(validBody({ model: undefined })), /model/);
    expectRequestError(() => parseDecisionRequest(validBody({ input: '   ' })), /input/);
    expectRequestError(() => parseDecisionRequest(validBody({ input: [] })), /input/);
    expectRequestError(() => parseDecisionRequest(validBody({ stream: true })), /stream/);
    expectRequestError(
      () => parseDecisionRequest(validBody({ options: { include_rationale: 'yes' } })),
      /include_rationale/,
    );
  });

  it('rejects an image part that is not a base64 image data URL', () => {
    expectRequestError(
      () => parseDecisionRequest(validBody({ input: [{ type: 'image', data_url: 'https://x/y.png' }] })),
      /data URL/,
      { param: 'input[0]' },
    );
  });

  it('names the failing question id for an unknown type', () => {
    expectRequestError(
      () => parseDecisionRequest(validBody({ questions: { ok: { type: 'boolean' }, bad: { type: 'ranking' } } })),
      /Question "bad"/,
      { questionId: 'bad' },
    );
  });

  it('enforces the choice limits (1..255) and names the question', () => {
    expectRequestError(
      () => parseDecisionRequest(validBody({ questions: { c: { type: 'choice', choices: {} } } })),
      /Question "c".*choices/,
      { questionId: 'c' },
    );
    const many = Object.fromEntries(Array.from({ length: DECISION_LIMITS.maxChoices + 1 }, (_, i) => [`k${i}`, '']));
    expectRequestError(
      () => parseDecisionRequest(validBody({ questions: { c: { type: 'choice', choices: many } } })),
      /Question "c"/,
    );
    const max = Object.fromEntries(Array.from({ length: DECISION_LIMITS.maxChoices }, (_, i) => [`k${i}`, '']));
    expect(() => parseDecisionRequest(validBody({ questions: { c: { type: 'choice', choices: max } } }))).not.toThrow();
  });

  it('enforces the score level limits (2..255)', () => {
    expectRequestError(
      () => parseDecisionRequest(validBody({ questions: { s: { type: 'score', levels: ['only'] } } })),
      /Question "s".*levels/,
      { questionId: 's' },
    );
    const tooMany = Array.from({ length: DECISION_LIMITS.maxLevels + 1 }, (_, i) => `l${i}`);
    expectRequestError(
      () => parseDecisionRequest(validBody({ questions: { s: { type: 'score', levels: tooMany } } })),
      /Question "s"/,
    );
    expectRequestError(
      () => parseDecisionRequest(validBody({ questions: { s: { type: 'score', levels: ['a', ' '] } } })),
      /level 1/,
    );
    const max = Array.from({ length: DECISION_LIMITS.maxLevels }, (_, i) => `l${i}`);
    expect(() => parseDecisionRequest(validBody({ questions: { s: { type: 'score', levels: max } } }))).not.toThrow();
  });

  it('allows more than 16 questions but rejects more than 64', () => {
    const build = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`q${i}`, { type: 'boolean' }]));
    expect(() => parseDecisionRequest(validBody({ questions: build(DECISION_LIMITS.recommendedQuestions + 1) }))).not.toThrow();
    expect(() => parseDecisionRequest(validBody({ questions: build(DECISION_LIMITS.maxQuestions) }))).not.toThrow();
    expectRequestError(
      () => parseDecisionRequest(validBody({ questions: build(DECISION_LIMITS.maxQuestions + 1) })),
      /maximum is 64/,
    );
    expectRequestError(() => parseDecisionRequest(validBody({ questions: {} })), /at least one/);
  });

  it('rejects a non-string instructions field with the question id', () => {
    expectRequestError(
      () => parseDecisionRequest(validBody({ questions: { q: { type: 'boolean', instructions: 3 } } })),
      /Question "q"/,
      { questionId: 'q' },
    );
  });
});

describe('buildDecisionSchema', () => {
  it('builds one strict object per question, keyed by choice key / level index', () => {
    const schema = buildDecisionSchema(questions, false) as any;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['answers']);
    const answers = schema.properties.answers;
    expect(answers.required).toEqual(['sentiment', 'urgent', 'severity']);
    expect(answers.additionalProperties).toBe(false);

    const sentiment = answers.properties.sentiment;
    expect(Object.keys(sentiment.properties)).toEqual(['happy', 'neutral', 'angry']);
    expect(sentiment.required).toEqual(['happy', 'neutral', 'angry']);
    expect(sentiment.additionalProperties).toBe(false);
    expect(sentiment.description).toContain('How does the customer feel?');

    expect(answers.properties.urgent.type).toBe('number');

    const severity = answers.properties.severity;
    expect(Object.keys(severity.properties)).toEqual(['0', '1', '2']);
    expect(severity.properties['2'].description).toContain('high');
  });

  it('adds rationale first, and only when asked', () => {
    const without = buildDecisionSchema(questions, false) as any;
    expect(without.properties.rationale).toBeUndefined();
    const withRationale = buildDecisionSchema(questions, true) as any;
    expect(Object.keys(withRationale.properties)).toEqual(['rationale', 'answers']);
    expect(withRationale.required).toEqual(['rationale', 'answers']);
  });

  it('a question id named "rationale" cannot collide with the rationale field', () => {
    const schema = buildDecisionSchema({ rationale: { type: 'boolean' } }, true) as any;
    expect(schema.properties.rationale.type).toBe('string');
    expect(schema.properties.answers.properties.rationale.type).toBe('number');
  });

  it('wraps the schema in a strict json_schema response_format', () => {
    const format = buildDecisionResponseFormat(questions, false);
    expect(format.type).toBe('json_schema');
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.name).toBe('decision_answers');
  });
});

describe('buildDecisionQuestionsPrompt', () => {
  it('lists choices and level indexes', () => {
    const prompt = buildDecisionQuestionsPrompt(questions);
    expect(prompt).toContain('[sentiment] (choice)');
    expect(prompt).toContain('- angry: Upset');
    expect(prompt).toContain('- 1: medium');
  });
});

describe('normalizeDecisionOutput', () => {
  it('choice: argmax, renormalizes a distribution that does not sum to 1', () => {
    const out = normalizeDecisionOutput(
      { answers: { sentiment: { happy: 0.2, neutral: 0.2, angry: 0.6 }, urgent: 0.5, severity: { 0: 1, 1: 0, 2: 0 } } },
      questions,
      false,
    );
    const sentiment = out.answers.sentiment as any;
    expect(sentiment.choice).toBe('angry');
    expect(sentiment.confidence_source).toBe('self_reported');
    expect(sentiment.confidence).toBeCloseTo(0.6);

    const skewed = normalizeDecisionOutput(
      { answers: { sentiment: { happy: 2, neutral: 1, angry: 1 } } },
      { sentiment: questions.sentiment },
      false,
    ).answers.sentiment as any;
    // Values above 1 are clamped to 1 first, so 2/1/1 becomes 1/1/1 -> a third each.
    expect(skewed.probabilities.happy).toBeCloseTo(1 / 3);
    expect(skewed.choice).toBe('happy');
  });

  it('choice: renormalizes low sums (0.1 / 0.1 / 0.2 -> 0.25 / 0.25 / 0.5)', () => {
    const out = normalizeDecisionOutput(
      { answers: { sentiment: { happy: 0.1, neutral: 0.1, angry: 0.2 } } },
      { sentiment: questions.sentiment },
      false,
    );
    const sentiment = out.answers.sentiment as any;
    expect(sentiment.probabilities.happy).toBeCloseTo(0.25);
    expect(sentiment.probabilities.angry).toBeCloseTo(0.5);
    expect(sentiment.confidence).toBeCloseTo(0.5);
    expect(sentiment.choice).toBe('angry');
  });

  it('choice: ties resolve to the earliest declared choice', () => {
    const out = normalizeDecisionOutput(
      { answers: { sentiment: { happy: 0.4, neutral: 0.4, angry: 0.2 } } },
      { sentiment: questions.sentiment },
      false,
    );
    expect((out.answers.sentiment as any).choice).toBe('happy');
  });

  it('choice: a missing key counts as 0, never an invented value', () => {
    const out = normalizeDecisionOutput(
      { answers: { sentiment: { happy: 0.5, angry: 0.5 } } },
      { sentiment: questions.sentiment },
      false,
    );
    const sentiment = out.answers.sentiment as any;
    expect(sentiment.probabilities.neutral).toBe(0);
    expect(sentiment.probabilities.happy).toBeCloseTo(0.5);
  });

  it('choice: ignores keys the model invented', () => {
    const out = normalizeDecisionOutput(
      { answers: { sentiment: { happy: 0.1, neutral: 0.1, angry: 0.1, furious: 0.9 } } },
      { sentiment: questions.sentiment },
      false,
    );
    const sentiment = out.answers.sentiment as any;
    expect(Object.keys(sentiment.probabilities)).toEqual(['happy', 'neutral', 'angry']);
    expect(sentiment.probabilities.happy).toBeCloseTo(1 / 3);
  });

  it('score: expected level = sum(i * p_i) after normalizing, with a legend', () => {
    const out = normalizeDecisionOutput(
      { answers: { severity: { 0: 0.1, 1: 0.2, 2: 0.2 } } }, // sums to 0.5 -> 0.2 / 0.4 / 0.4
      { severity: questions.severity },
      false,
    );
    const severity = out.answers.severity as any;
    expect(severity.score).toBeCloseTo(0 * 0.2 + 1 * 0.4 + 2 * 0.4);
    expect(severity.legend).toEqual({ 0: 'low', 1: 'medium', 2: 'high' });
    expect(severity.confidence).toBeCloseTo(0.4);
    expect(severity.confidence_source).toBe('self_reported');
    expect(severity.type).toBe('score');
  });

  it('score: a certain top level scores exactly its index', () => {
    const out = normalizeDecisionOutput(
      { answers: { severity: { 0: 0, 1: 0, 2: 1 } } },
      { severity: questions.severity },
      false,
    );
    expect((out.answers.severity as any).score).toBe(2);
  });

  it('boolean: passes the probability through, clamped, with no confidence fields', () => {
    const out = normalizeDecisionOutput(
      { answers: { a: 0.83, b: 7, c: -1, d: '0.4' } },
      { a: { type: 'boolean' }, b: { type: 'boolean' }, c: { type: 'boolean' }, d: { type: 'boolean' } },
      false,
    );
    expect(out.answers.a).toEqual({ type: 'boolean', probability: 0.83 });
    expect((out.answers.b as any).probability).toBe(1);
    expect((out.answers.c as any).probability).toBe(0);
    expect((out.answers.d as any).probability).toBe(0.4);
    expect(Object.keys(out.answers.a)).toEqual(['type', 'probability']);
  });

  it('refuses a question whose numbers are missing, non-numeric or all zero', () => {
    const out = normalizeDecisionOutput(
      { answers: { sentiment: { happy: 'n/a' }, urgent: null, severity: { 0: 0, 1: 0, 2: 0 } } },
      questions,
      false,
    );
    expect(out.answers.sentiment).toEqual({ type: 'refusal' });
    expect(out.answers.urgent).toEqual({ type: 'refusal' });
    expect(out.answers.severity).toEqual({ type: 'refusal' });
  });

  it('refuses every question when the document is not an object, or a question is absent', () => {
    expect(normalizeDecisionOutput('nope', questions, false)).toEqual(refuseAll(questions));
    const partial = normalizeDecisionOutput({ answers: { urgent: 0.3 } }, questions, false);
    expect(partial.answers.urgent).toEqual({ type: 'boolean', probability: 0.3 });
    expect(partial.answers.sentiment).toEqual({ type: 'refusal' });
  });

  it('keeps rationale only when requested and non-empty', () => {
    const raw = { rationale: '  because  ', answers: { urgent: 0.5 } };
    const q = { urgent: { type: 'boolean' } as DecisionQuestion };
    expect(normalizeDecisionOutput(raw, q, true).rationale).toBe('because');
    expect('rationale' in normalizeDecisionOutput(raw, q, false)).toBe(false);
    expect('rationale' in normalizeDecisionOutput({ rationale: ' ', answers: { urgent: 0.5 } }, q, true)).toBe(false);
  });
});
