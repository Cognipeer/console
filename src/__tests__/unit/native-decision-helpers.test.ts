import { describe, expect, it } from 'vitest';
import {
  ALIBABA_REGIONS,
  buildOpenAiDecisionBody,
  buildSystemOneBody,
  buildSystemOneUrl,
  isValidWorkspaceId,
  normalizeOpenAiDecisionResponse,
  normalizeSystemOneResponse,
} from '@/lib/providers/contracts/nativeDecisionHelpers';
import { DecisionRequestError } from '@/lib/providers/contracts/decisionHelpers';
import { DecisionBackendError } from '@/lib/providers/contracts/structuredDecisionRuntime';
import type { DecisionRequest } from '@/lib/providers/domains/decision';

/*
 * Fixtures follow the vendors' PUBLISHED docs (OpenAI Decisions guide/reference,
 * Alibaba Model Studio "Decision Model API"). Field names and shapes are from the
 * docs; the numbers are the docs' illustrative ones where the docs give them and
 * otherwise chosen to be self-consistent. Nothing here comes from a live call.
 */

// ── OpenAI: complaint routing + severity + damage check ─────────────────────

const OPENAI_REQUEST: DecisionRequest = {
  input: [{ type: 'text', text: 'I was charged twice for my order and the export fails in Safari.' }],
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this complaint?',
      choices: {
        billing: 'Charges, refunds, invoices',
        technical: 'Product defects and errors',
        shipping: 'Delivery problems',
        other: 'Anything else',
      },
    },
    severity: {
      type: 'score',
      instructions: 'How severe is the problem?',
      levels: ['Cosmetic', 'Workaround available', 'Fully blocked'],
    },
    visible_damage: { type: 'boolean', instructions: 'Does the product show visible damage?' },
  },
};

const OPENAI_RESPONSE = {
  model: 'gpt-6-luna',
  answers: [
    {
      type: 'choice',
      name: 'department',
      choice: 'billing',
      confidence: 0.93,
      probabilities: [
        { value: 'billing', probability: 0.93 },
        { value: 'technical', probability: 0.04 },
        { value: 'shipping', probability: 0.02 },
        { value: 'other', probability: 0.01 },
      ],
    },
    {
      type: 'score',
      name: 'severity',
      score: 1.1,
      confidence: 0.55,
      probabilities: [
        { label: 'Cosmetic', value: 0, probability: 0.1 },
        { label: 'Workaround available', value: 1, probability: 0.7 },
        { label: 'Fully blocked', value: 2, probability: 0.2 },
      ],
    },
    { type: 'predicate', name: 'visible_damage', probability: 0.92 },
  ],
  usage: {
    input_tokens: 42,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 42,
  },
};

describe('buildOpenAiDecisionBody', () => {
  it('sends questions as an array with names; boolean becomes predicate', () => {
    const body = buildOpenAiDecisionBody('gpt-6-luna', OPENAI_REQUEST) as any;
    expect(body.model).toBe('gpt-6-luna');
    expect(body.input).toBe('I was charged twice for my order and the export fails in Safari.');
    expect(Array.isArray(body.questions)).toBe(true);
    expect(body.questions.map((q: any) => [q.name, q.type])).toEqual([
      ['department', 'choice'],
      ['severity', 'score'],
      ['visible_damage', 'predicate'],
    ]);
    expect(body.questions[0].choices).toEqual([
      { value: 'billing', description: 'Charges, refunds, invoices' },
      { value: 'technical', description: 'Product defects and errors' },
      { value: 'shipping', description: 'Delivery problems' },
      { value: 'other', description: 'Anything else' },
    ]);
    expect(body.questions[1].levels).toEqual([
      { label: 'Cosmetic' }, { label: 'Workaround available' }, { label: 'Fully blocked' },
    ]);
    expect(body.questions[2].instructions).toBe('Does the product show visible damage?');
  });

  it('omits an empty choice description and falls back to the id for missing instructions', () => {
    const body = buildOpenAiDecisionBody('m', {
      input: [{ type: 'text', text: 'x' }],
      questions: { q: { type: 'choice', choices: { a: '', b: 'bee' } }, p: { type: 'boolean' } },
    }) as any;
    expect(body.questions[0].choices[0]).toEqual({ value: 'a' });
    expect(body.questions[0].instructions).toBe('q');
    expect(body.questions[1].instructions).toBe('p');
  });

  it('turns images into input_image parts inside a user message, keeping order', () => {
    const body = buildOpenAiDecisionBody('m', {
      input: [
        { type: 'text', text: 'Inspect the product in this photo.' },
        { type: 'image', data_url: 'data:image/png;base64,AAAA' },
      ],
      questions: { visible_damage: { type: 'boolean', instructions: 'Damaged?' } },
    }) as any;
    expect(body.input).toEqual([{
      role: 'user',
      content: [
        { type: 'input_text', text: 'Inspect the product in this photo.' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      ],
    }]);
  });

  it('rejects http(s) image URLs even if one slipped past request parsing', () => {
    expect(() => buildOpenAiDecisionBody('m', {
      input: [{ type: 'image', data_url: 'https://example.com/a.png' }],
      questions: { q: { type: 'boolean' } },
    })).toThrowError(DecisionRequestError);
  });

  it('rejects more than 128 images and a single-choice question', () => {
    const image = { type: 'image' as const, data_url: 'data:image/png;base64,AAAA' };
    expect(() => buildOpenAiDecisionBody('m', {
      input: Array.from({ length: 129 }, () => image),
      questions: { q: { type: 'boolean' } },
    })).toThrowError(/at most 128 images/);
    expect(() => buildOpenAiDecisionBody('m', {
      input: [{ type: 'text', text: 'x' }],
      questions: { solo: { type: 'choice', choices: { only: '' } } },
    })).toThrowError(/Question "solo".*2\.\.255/);
  });
});

describe('normalizeOpenAiDecisionResponse', () => {
  it('maps the documented answers array onto the console map', () => {
    const out = normalizeOpenAiDecisionResponse(OPENAI_RESPONSE, OPENAI_REQUEST);
    expect(out.answers.department).toEqual({
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.93, technical: 0.04, shipping: 0.02, other: 0.01 },
      confidence: 0.93,
      confidence_source: 'native',
    });
    expect(out.answers.severity).toEqual({
      type: 'score',
      score: 1.1,
      probabilities: { 0: 0.1, 1: 0.7, 2: 0.2 },
      legend: { 0: 'Cosmetic', 1: 'Workaround available', 2: 'Fully blocked' },
      confidence: 0.55,
      confidence_source: 'native',
    });
  });

  it('predicate carries only a probability: no confidence fields are invented', () => {
    const out = normalizeOpenAiDecisionResponse(OPENAI_RESPONSE, OPENAI_REQUEST);
    expect(out.answers.visible_damage).toEqual({ type: 'boolean', probability: 0.92 });
    expect(Object.keys(out.answers.visible_damage)).toEqual(['type', 'probability']);
  });

  it('reports input tokens only, output 0', () => {
    expect(normalizeOpenAiDecisionResponse(OPENAI_RESPONSE, OPENAI_REQUEST).usage)
      .toEqual({ inputTokens: 42, outputTokens: 0 });
  });

  it('omits confidence and confidence_source when the vendor sent no confidence', () => {
    const response = structuredClone(OPENAI_RESPONSE) as any;
    delete response.answers[0].confidence;
    delete response.usage;
    const out = normalizeOpenAiDecisionResponse(response, OPENAI_REQUEST);
    expect('confidence' in out.answers.department).toBe(false);
    expect('confidence_source' in out.answers.department).toBe(false);
    expect(out.usage).toBeUndefined();
  });

  it('maps a per-question refusal to {type:"refusal"} and keeps the others', () => {
    const response = structuredClone(OPENAI_RESPONSE) as any;
    response.answers[1] = { type: 'refusal', name: 'severity' };
    const out = normalizeOpenAiDecisionResponse(response, OPENAI_REQUEST);
    expect(out.answers.severity).toEqual({ type: 'refusal' });
    expect(out.answers.department).toMatchObject({ choice: 'billing' });
  });

  it('matches by name, so a reordered answers array cannot swap answers', () => {
    const response = structuredClone(OPENAI_RESPONSE) as any;
    response.answers.reverse();
    const out = normalizeOpenAiDecisionResponse(response, OPENAI_REQUEST);
    expect(out.answers.department).toMatchObject({ choice: 'billing' });
    expect(out.answers.visible_damage).toEqual({ type: 'boolean', probability: 0.92 });
  });

  it.each([
    ['no answers array', { answers: {} }],
    ['wrong answer count', { answers: OPENAI_RESPONSE.answers.slice(0, 2) }],
    ['a choice that was never offered', { answers: [{ ...OPENAI_RESPONSE.answers[0], choice: 'sales' }, OPENAI_RESPONSE.answers[1], OPENAI_RESPONSE.answers[2]] }],
    ['a type mismatch', { answers: [OPENAI_RESPONSE.answers[2], OPENAI_RESPONSE.answers[1], OPENAI_RESPONSE.answers[0]].map((a, i) => ({ ...a, name: OPENAI_RESPONSE.answers[i].name })) }],
    ['a predicate without a probability', { answers: [OPENAI_RESPONSE.answers[0], OPENAI_RESPONSE.answers[1], { type: 'predicate', name: 'visible_damage' }] }],
  ])('rejects a malformed body: %s', (_label, body) => {
    expect(() => normalizeOpenAiDecisionResponse(body, OPENAI_REQUEST)).toThrowError(DecisionBackendError);
  });

  it('rejects a non-object body', () => {
    expect(() => normalizeOpenAiDecisionResponse('nope', OPENAI_REQUEST)).toThrowError(DecisionBackendError);
    expect(() => normalizeOpenAiDecisionResponse(null, OPENAI_REQUEST)).toThrowError(DecisionBackendError);
  });
});

// ── Alibaba System One: ticket routing ──────────────────────────────────────

const ALIBABA_REQUEST: DecisionRequest = {
  input: [{ type: 'text', text: 'I was billed twice and checkout is down for all my users.' }],
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this ticket?',
      choices: {
        billing: 'Payment, refund and billing issues',
        technical: 'Product failures and integration problems',
      },
    },
    escalate: { type: 'boolean', instructions: 'Should on-call staff be notified immediately?' },
    severity: {
      type: 'score',
      instructions: 'How severe is the issue?',
      levels: [
        'Minor issue, no effect on functionality',
        'Some functionality affected, workaround exists',
        'Core functionality unavailable, no workaround',
        'Severe business or security impact',
      ],
    },
  },
};

const ALIBABA_RESPONSE = {
  model: 'decision-model-preview',
  request_id: '7b986c65-b223-9341-b5f0-b988e27ecaac',
  answers: {
    department: {
      type: 'choice',
      choice: 'billing',
      confidence: 0.88,
      probabilities: { billing: 0.94, technical: 0.06 },
    },
    escalate: { type: 'noul', noul: 0.99 },
    severity: {
      type: 'score',
      score: 2.25,
      confidence: 0.91,
      legend: {
        0: 'Minor issue, no effect on functionality',
        1: 'Some functionality affected, workaround exists',
        2: 'Core functionality unavailable, no workaround',
        3: 'Severe business or security impact',
      },
      probabilities: { 0: 0.0, 1: 0.01, 2: 0.73, 3: 0.26 },
    },
  },
  usage: { input_tokens: 125 },
  latency_ms: 52.9,
};

describe('buildSystemOneBody', () => {
  it('builds {model, state, questions map} with choice | noul | score and criteria', () => {
    const body = buildSystemOneBody('decision-model-preview', ALIBABA_REQUEST) as any;
    expect(body.model).toBe('decision-model-preview');
    expect(body.state).toBe('I was billed twice and checkout is down for all my users.');
    expect(Object.keys(body.questions)).toEqual(['department', 'escalate', 'severity']);
    expect(body.questions.department).toEqual({
      type: 'choice',
      instructions: 'Which team should handle this ticket?',
      criteria: {
        billing: 'Payment, refund and billing issues',
        technical: 'Product failures and integration problems',
      },
    });
    expect(body.questions.escalate).toEqual({
      type: 'noul',
      instructions: 'Should on-call staff be notified immediately?',
    });
    expect(body.questions.severity.type).toBe('score');
    expect(body.questions.severity.criteria).toEqual(ALIBABA_REQUEST.questions.severity && (ALIBABA_REQUEST.questions.severity as any).levels);
  });

  it('joins several text parts into one state string', () => {
    const body = buildSystemOneBody('m', {
      input: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
      questions: { q: { type: 'boolean' } },
    }) as any;
    expect(body.state).toBe('a\n\nb');
    expect(body.questions.q).toEqual({ type: 'noul' });
  });

  it('rejects image input: the model is text only', () => {
    try {
      buildSystemOneBody('m', {
        input: [{ type: 'text', text: 'a' }, { type: 'image', data_url: 'data:image/png;base64,AAAA' }],
        questions: { q: { type: 'boolean' } },
      });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionRequestError);
      expect((error as Error).message).toMatch(/text input only/);
      expect((error as DecisionRequestError).param).toBe('input[1]');
    }
  });
});

describe('normalizeSystemOneResponse', () => {
  it('maps the documented ticket-routing answers onto the console shape', () => {
    const out = normalizeSystemOneResponse(ALIBABA_RESPONSE, ALIBABA_REQUEST);
    expect(out.answers.department).toEqual({
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.94, technical: 0.06 },
      confidence: 0.88,
      confidence_source: 'native',
    });
    expect(out.answers.escalate).toEqual({ type: 'boolean', probability: 0.99 });
    expect(out.answers.severity).toMatchObject({
      type: 'score',
      score: 2.25,
      confidence: 0.91,
      confidence_source: 'native',
      probabilities: { 0: 0, 1: 0.01, 2: 0.73, 3: 0.26 },
    });
    expect((out.answers.severity as any).legend[3]).toBe('Severe business or security impact');
  });

  it('input tokens only, with the vendor request id and latency kept for the trace', () => {
    const out = normalizeSystemOneResponse(ALIBABA_RESPONSE, ALIBABA_REQUEST);
    expect(out.usage).toEqual({ inputTokens: 125, outputTokens: 0 });
    expect(out.upstream).toEqual({ request_id: '7b986c65-b223-9341-b5f0-b988e27ecaac', latency_ms: 52.9 });
  });

  it('omits what the vendor did not send', () => {
    const response = structuredClone(ALIBABA_RESPONSE) as any;
    delete response.answers.severity.confidence;
    delete response.answers.severity.legend;
    delete response.usage;
    delete response.request_id;
    delete response.latency_ms;
    const out = normalizeSystemOneResponse(response, ALIBABA_REQUEST);
    expect(Object.keys(out.answers.severity).sort()).toEqual(['probabilities', 'score', 'type']);
    expect(out.usage).toBeUndefined();
    expect(out.upstream).toBeUndefined();
  });

  it.each([
    ['no answers object', { answers: [] }],
    ['a missing question', { answers: { department: ALIBABA_RESPONSE.answers.department } }],
    ['a choice that was never offered', { answers: { ...ALIBABA_RESPONSE.answers, department: { ...ALIBABA_RESPONSE.answers.department, choice: 'sales' } } }],
    ['a noul without a number', { answers: { ...ALIBABA_RESPONSE.answers, escalate: { type: 'noul' } } }],
    ['a type mismatch', { answers: { ...ALIBABA_RESPONSE.answers, escalate: { type: 'choice', choice: 'x' } } }],
  ])('rejects a malformed body: %s', (_label, body) => {
    expect(() => normalizeSystemOneResponse(body, ALIBABA_REQUEST)).toThrowError(DecisionBackendError);
  });
});

describe('Alibaba endpoint host', () => {
  it('uses the documented regional hosts', () => {
    expect(buildSystemOneUrl('ws-123', 'singapore'))
      .toBe('https://ws-123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/systemone');
    expect(buildSystemOneUrl('WS-123', 'beijing'))
      .toBe('https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone');
    expect(Object.keys(ALIBABA_REGIONS)).toEqual(['singapore', 'beijing']);
  });

  it.each([
    'evil.com/x', 'a.b', 'a@b', 'a b', '', '-lead', 'trail-', 'x#y', 'a/../b', '127.0.0.1:80/', 'a\nb',
  ])('never builds a host from an unvalidated workspace id: %j', (id) => {
    expect(isValidWorkspaceId(id)).toBe(false);
    expect(() => buildSystemOneUrl(id, 'singapore')).toThrow(/workspace id/);
  });

  it.each(['us', 'cn-beijing', 'singapore.evil.com', '', 'constructor', '__proto__'])(
    'rejects region %j', (region) => {
      expect(() => buildSystemOneUrl('ws', region)).toThrow(/region/);
    },
  );
});
