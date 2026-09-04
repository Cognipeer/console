import { describe, expect, it } from 'vitest';
import {
  createInlineReasoningSplitter,
  splitInlineReasoning,
  stripInlineReasoning,
} from '@/lib/shared/inlineReasoning';
import { extractJson as extractJsonAnalysis } from '@/lib/services/analysis/json';
import { extractJson as extractJsonScorer } from '@/lib/services/evaluation/scorers/json';
import { balancedJsonBlocks, repairJsonContent } from '@/lib/shared/jsonExtraction';

describe('splitInlineReasoning', () => {
  it('pulls a leading <reasoning> block out of the answer', () => {
    // Verbatim shape returned by AWS Bedrock `/openai/v1` for gpt-oss.
    const raw = '<reasoning>User wants a greeting. Keep it short.</reasoning>Hey there buddy';
    expect(splitInlineReasoning(raw)).toEqual({
      content: 'Hey there buddy',
      reasoning: 'User wants a greeting. Keep it short.',
    });
  });

  it('leaves the answer parseable as JSON', () => {
    const raw = '<reasoning>Return {"ok": false} — no, {"ok": true}.</reasoning>{"ok": true}';
    expect(JSON.parse(stripInlineReasoning(raw))).toEqual({ ok: true });
  });

  it('handles <think> and <thinking> the same way', () => {
    expect(stripInlineReasoning('<think>hmm</think>42')).toBe('42');
    expect(stripInlineReasoning('  <Thinking>hmm</Thinking>\n42')).toBe('42');
  });

  it('treats an unterminated block as reasoning only', () => {
    const raw = '<reasoning>cut off mid thought';
    expect(splitInlineReasoning(raw)).toEqual({
      content: '',
      reasoning: 'cut off mid thought',
    });
  });

  it('never touches a tag that is not at the start of the message', () => {
    const raw = 'Use <think> tags like <think>this</think> in your prompt.';
    expect(stripInlineReasoning(raw)).toBe(raw);
  });

  it('passes through text with no markup', () => {
    expect(splitInlineReasoning('plain answer')).toEqual({ content: 'plain answer' });
  });
});

describe('createInlineReasoningSplitter', () => {
  const feed = (deltas: string[]) => {
    const splitter = createInlineReasoningSplitter();
    let content = '';
    let reasoning = '';
    for (const delta of deltas) {
      const part = splitter.push(delta);
      content += part.content;
      reasoning += part.reasoning;
    }
    const tail = splitter.flush();
    return { content: content + tail.content, reasoning: reasoning + tail.reasoning };
  };

  it('splits a block that spans several deltas', () => {
    expect(feed(['<reason', 'ing>thin', 'king</reason', 'ing>Hel', 'lo'])).toEqual({
      content: 'Hello',
      reasoning: 'thinking',
    });
  });

  it('never withholds text that cannot open a tag', () => {
    const splitter = createInlineReasoningSplitter();
    expect(splitter.push('Hello ')).toEqual({ content: 'Hello ', reasoning: '' });
    expect(splitter.push('<b>world</b>')).toEqual({ content: '<b>world</b>', reasoning: '' });
  });

  it('releases a truncated block on flush', () => {
    const splitter = createInlineReasoningSplitter();
    splitter.push('<think>half a thou');
    expect(splitter.flush()).toEqual({ content: '', reasoning: '<think>half a thou'.slice(7) });
  });

  it('matches the non-streaming split for the same text', () => {
    const raw = '<reasoning>because</reasoning>\n\nThe answer is 4.';
    const chunked = feed(raw.match(/.{1,3}/g) as string[]);
    expect(chunked.content).toBe(splitInlineReasoning(raw).content);
    expect(chunked.reasoning).toBe(splitInlineReasoning(raw).reasoning);
  });
});

/**
 * Live captures from `bedrock-runtime.eu-central-1.amazonaws.com/openai/v1`,
 * eu-central-1, 2026-09-04. Two separate upstream defects show up together:
 * the reasoning channel is left in `content`, and with `response_format` the
 * constrained decoder splices a stray brace or a truncated prose answer in
 * front of the real payload.
 */
describe('lenient JSON extraction over real Bedrock output', () => {
  const CAPTURES: Array<[string, string, unknown]> = [
    [
      'gpt-oss-120b json_object — stray brace before the payload',
      '<reasoning>So final answer: {"city":"Istanbul","ok":true}.</reasoning>{\n{"city":"Istanbul","ok":true}',
      { city: 'Istanbul', ok: true },
    ],
    [
      'gpt-oss-20b json_object — stray quote before the payload',
      '<reasoning>Let\'s produce exactly that.</reasoning>{"{"city":"Istanbul","ok":true}',
      { city: 'Istanbul', ok: true },
    ],
    [
      'gpt-oss-120b json_schema — prose truncated mid-answer',
      '<reasoning>Provide a friendly response.</reasoning>Sounds{   "city":"Istanbul",   "tempC":22 }',
      { city: 'Istanbul', tempC: 22 },
    ],
    [
      'gpt-oss-20b json_schema — prose truncated mid-word',
      '<reasoning>So final answer.</reasoning>Enjoy. Visit Sultanah{ \t"city":"Istanbul",\n  "tempC":22.0\n}',
      { city: 'Istanbul', tempC: 22 },
    ],
    [
      'minimax-m2.5 json_schema — clean payload behind reasoning',
      '<reasoning>Extract the fields.</reasoning>{\n  "city": "Istanbul",\n  "tempC": 22\n}',
      { city: 'Istanbul', tempC: 22 },
    ],
  ];

  it.each(CAPTURES)('recovers the payload: %s', (_label, raw, expected) => {
    expect(extractJsonAnalysis(raw as string)).toEqual({ ok: true, value: expected });
    expect(extractJsonScorer(raw as string)).toEqual({ ok: true, value: expected });
  });

  it('still prefers the first block when it parses', () => {
    const raw = '{"a":1} trailing {"b":2}';
    expect(extractJsonAnalysis(raw)).toEqual({ ok: true, value: { a: 1 } });
  });

  it('reports failure when nothing in the text is JSON', () => {
    expect(extractJsonAnalysis('no json here { unbalanced').ok).toBe(false);
  });
});

describe('repairJsonContent', () => {
  it('returns the model\'s own bytes, not a re-serialized copy', () => {
    const { content, repaired } = repairJsonContent('Sounds{   "city":"Istanbul" }');
    expect(repaired).toBe(true);
    expect(content).toBe('{   "city":"Istanbul" }');
  });

  it('is a no-op on text that already parses', () => {
    const clean = '{\n  "a": 1\n}';
    expect(repairJsonContent(clean)).toEqual({ content: clean, repaired: false });
  });

  it('is a no-op when nothing in the text is JSON', () => {
    expect(repairJsonContent('sorry, I cannot')).toEqual({ content: 'sorry, I cannot', repaired: false });
  });

  it('recovers an array payload too', () => {
    expect(repairJsonContent('Here: [{"i":1}]').content).toBe('[{"i":1}]');
  });

  it('does not walk past the candidate cap on pathological input', () => {
    // 5000 unclosed braces: the scan must bail, not run to completion.
    expect([...balancedJsonBlocks('{'.repeat(5000))]).toEqual([]);
  });

  it('ignores brackets inside string literals', () => {
    expect(repairJsonContent('x{"s":"a } b","n":1}').content).toBe('{"s":"a } b","n":1}');
  });
});
