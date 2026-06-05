/**
 * Unit tests — analysis runner.
 * Covers extraction aggregation, judge + accuracy wiring, extraction failures,
 * concurrency, and the progress hook. Model invokers are mocked.
 */

import { describe, it, expect, vi } from 'vitest';
import { runAnalysis } from '@/lib/services/analysis/runner';
import type { AnalysisConversation, AnalysisSpec, FieldSet, ModelInvoker } from '@/lib/services/analysis/types';

const FIELD_SET: FieldSet = [
  { key: 'intent', type: 'enum', enumValues: ['billing', 'support'], required: true },
  { key: 'resolved', type: 'boolean' },
];

/** Extraction invoker that branches on a marker embedded in the transcript. */
const extractionInvoker: ModelInvoker = async (messages) => {
  const text = messages.map((m) => m.content).join('\n');
  if (text.includes('BOOM')) throw new Error('model exploded');
  if (text.includes('MISSING')) return '{"resolved":true}'; // omits required intent
  if (text.includes('SUPPORT')) return '{"intent":"support","resolved":false}';
  return '{"intent":"billing","resolved":true}';
};

function conv(id: string, marker: string, referenceFields?: Record<string, unknown>): AnalysisConversation {
  return { id, transcript: [{ role: 'caller', content: marker }], referenceFields };
}

const BASE_SPEC: AnalysisSpec = { fieldSet: FIELD_SET, modes: {} };

describe('runAnalysis', () => {
  it('extracts and aggregates over a batch', async () => {
    const conversations = [conv('a', 'BILLING'), conv('b', 'SUPPORT'), conv('c', 'MISSING')];
    const result = await runAnalysis({ conversations, spec: BASE_SPEC, invokeExtraction: extractionInvoker });
    expect(result.aggregate.total).toBe(3);
    expect(result.aggregate.completed).toBe(3); // no extraction errors
    expect(result.aggregate.failed).toBe(0);
    expect(result.aggregate.passed).toBe(2); // 'c' is missing required intent
    const cItem = result.items.find((i) => i.conversationId === 'c');
    expect(cItem?.missing).toEqual(['intent']);
    expect(cItem?.passed).toBe(false);
  });

  it('records extraction errors without aborting', async () => {
    const conversations = [conv('a', 'BILLING'), conv('b', 'BOOM')];
    const result = await runAnalysis({ conversations, spec: BASE_SPEC, invokeExtraction: extractionInvoker });
    expect(result.aggregate.failed).toBe(1);
    expect(result.aggregate.completed).toBe(1);
    expect(result.items.find((i) => i.conversationId === 'b')?.error).toMatch(/exploded/);
  });

  it('wires the judge and averages its score', async () => {
    const conversations = [conv('a', 'BILLING'), conv('b', 'BILLING')];
    const invokeJudge = vi.fn().mockResolvedValue('{"score":0.8,"passed":true}');
    const spec: AnalysisSpec = { fieldSet: FIELD_SET, modes: { judge: { rubric: 'Be polite' } } };
    const result = await runAnalysis({ conversations, spec, invokeExtraction: extractionInvoker, invokeJudge });
    expect(invokeJudge).toHaveBeenCalledTimes(2);
    expect(result.aggregate.avgJudgeScore).toBeCloseTo(0.8, 5);
    expect(result.items[0].judge?.passed).toBe(true);
  });

  it('scores accuracy against reference fields', async () => {
    const conversations = [
      conv('a', 'BILLING', { intent: 'billing', resolved: true }),
      conv('b', 'SUPPORT', { intent: 'billing' }), // extracted support → mismatch
    ];
    const spec: AnalysisSpec = { fieldSet: FIELD_SET, modes: { accuracy: true } };
    const result = await runAnalysis({ conversations, spec, invokeExtraction: extractionInvoker });
    const a = result.items.find((i) => i.conversationId === 'a');
    const b = result.items.find((i) => i.conversationId === 'b');
    expect(a?.accuracy?.score).toBe(1);
    expect(b?.accuracy?.score).toBe(0);
    expect(result.aggregate.avgExtractionAccuracy).toBeCloseTo(0.5, 5);
  });

  it('fails an item when the judge rejects it', async () => {
    const conversations = [conv('a', 'BILLING')];
    const invokeJudge = vi.fn().mockResolvedValue('{"score":0.1,"passed":false}');
    const spec: AnalysisSpec = { fieldSet: FIELD_SET, modes: { judge: { rubric: 'strict' } } };
    const result = await runAnalysis({ conversations, spec, invokeExtraction: extractionInvoker, invokeJudge });
    expect(result.items[0].passed).toBe(false);
    expect(result.aggregate.passed).toBe(0);
  });

  it('processes every conversation once under bounded concurrency and calls onItem', async () => {
    const conversations = Array.from({ length: 9 }, (_, i) => conv(`c${i}`, 'BILLING'));
    const onItem = vi.fn();
    const result = await runAnalysis({ conversations, spec: BASE_SPEC, invokeExtraction: extractionInvoker, config: { concurrency: 3 }, onItem });
    expect(result.items.every((i) => i)).toBe(true);
    expect(result.items).toHaveLength(9);
    expect(onItem).toHaveBeenCalledTimes(9);
  });
});
