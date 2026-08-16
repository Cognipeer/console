import { describe, it, expect } from 'vitest';
import {
  datasetItemToConversation,
  humanLabels,
  isHumanLabeled,
} from '@/lib/services/analysis/datasetLabeling';
import { summarizeLabels } from '@/lib/services/evaluation/labelSummary';
import {
  canonicalLabelValue,
  labelValueCandidates,
  matchesLabel,
  mongoLabelCandidates,
} from '@/lib/database/provider/labelMatch';
import type { IEvaluationDatasetItem } from '@/lib/database';

const item = (over: Partial<IEvaluationDatasetItem> = {}): IEvaluationDatasetItem => ({
  id: 'i1',
  input: [{ role: 'user', content: 'hello' }],
  ...over,
});

describe('datasetItemToConversation', () => {
  it('maps turns and keeps the item id as the conversation key', () => {
    const conversation = datasetItemToConversation(
      item({ input: [{ role: 'system', content: 'be nice' }, { role: 'user', content: 'refund please' }] }),
    );
    expect(conversation.id).toBe('i1');
    expect(conversation.transcript).toEqual([
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'refund please' },
    ]);
  });

  it('appends the recorded assistant reply so the labeler sees both sides', () => {
    const conversation = datasetItemToConversation(
      item({ expected: { reference: 'Refunded, sorry about that.' } }),
    );
    expect(conversation.transcript.at(-1)).toEqual({
      role: 'assistant',
      content: 'Refunded, sorry about that.',
    });
  });

  it('ignores a non-string or empty reference', () => {
    expect(datasetItemToConversation(item({ expected: { reference: '  ' } })).transcript).toHaveLength(1);
    expect(datasetItemToConversation(item({ expected: { toolCalls: [] } })).transcript).toHaveLength(1);
  });

  it('renders tool calls and tool results into the transcript text', () => {
    const conversation = datasetItemToConversation(
      item({
        input: [
          { role: 'assistant', content: 'checking', toolCalls: [{ name: 'lookup', args: { id: 7 } }] },
          { role: 'tool', content: '{"status":"shipped"}', name: 'lookup', toolCallId: 'c1' },
        ],
      }),
    );
    expect(conversation.transcript[0].content).toBe('checking\n[tool_call] lookup({"id":7})');
    expect(conversation.transcript[1].role).toBe('tool:lookup');
  });

  it('feeds human labels in as ground truth, and never AI labels', () => {
    const human = item({ labels: { intent: 'refund' }, labelMeta: { source: 'human' } });
    const ai = item({ labels: { intent: 'refund' }, labelMeta: { source: 'ai' } });
    expect(datasetItemToConversation(human).referenceFields).toEqual({ intent: 'refund' });
    expect(datasetItemToConversation(ai).referenceFields).toBeUndefined();
    expect(humanLabels(human)).toEqual({ intent: 'refund' });
    expect(humanLabels(ai)).toBeUndefined();
    expect(isHumanLabeled(human)).toBe(true);
    expect(isHumanLabeled(ai)).toBe(false);
    expect(isHumanLabeled(item())).toBe(false);
  });

  it('treats an empty human label map as no ground truth', () => {
    expect(humanLabels(item({ labels: {}, labelMeta: { source: 'human' } }))).toBeUndefined();
  });
});

describe('label matching', () => {
  it('compares values in a canonical form across types', () => {
    expect(canonicalLabelValue(true)).toBe('true');
    expect(canonicalLabelValue(3)).toBe('3');
    expect(canonicalLabelValue(' Refund ')).toBe('refund');
    expect(canonicalLabelValue(null)).toBe('');
  });

  it('accepts SQLite\'s numeric form of a JSON boolean', () => {
    expect(labelValueCandidates('true')).toEqual(['true', '1']);
    expect(labelValueCandidates('False')).toEqual(['false', '0']);
    expect(labelValueCandidates('Refund')).toEqual(['refund']);
  });

  it('offers every typed form Mongo may have stored', () => {
    expect(mongoLabelCandidates('true')).toContain(true);
    expect(mongoLabelCandidates('3')).toContain(3);
    expect(mongoLabelCandidates('Refund')).toEqual(['Refund', 'refund']);
  });

  it('matches labels in memory the same way the providers do', () => {
    const labels = { intent: 'Refund', escalated: true, turns: 3 };
    expect(matchesLabel(labels, 'intent', 'refund')).toBe(true);
    expect(matchesLabel(labels, 'escalated', 'true')).toBe(true);
    expect(matchesLabel(labels, 'turns', '3')).toBe(true);
    expect(matchesLabel(labels, 'intent', 'order_status')).toBe(false);
    expect(matchesLabel(labels, 'intent')).toBe(true);
    expect(matchesLabel(labels, 'missing')).toBe(false);
    expect(matchesLabel(undefined, 'intent', 'refund')).toBe(false);
  });
});

describe('summarizeLabels', () => {
  it('counts values per key and ranks them by frequency', () => {
    const summary = summarizeLabels([
      item({ id: 'a', labels: { intent: 'refund' }, labelMeta: { source: 'ai', definitionKey: 'triage' } }),
      item({ id: 'b', labels: { intent: 'refund' }, labelMeta: { source: 'ai', definitionKey: 'triage' } }),
      item({ id: 'c', labels: { intent: 'status' }, labelMeta: { source: 'human' } }),
      item({ id: 'd' }),
    ]);
    expect(summary.total).toBe(4);
    expect(summary.labeled).toBe(3);
    expect(summary.humanLabeled).toBe(1);
    expect(summary.definitionKeys).toEqual(['triage']);
    expect(summary.keys).toHaveLength(1);
    expect(summary.keys[0].key).toBe('intent');
    expect(summary.keys[0].count).toBe(3);
    expect(summary.keys[0].values[0]).toEqual({ value: 'refund', count: 2, share: 2 / 3 });
    expect(summary.keys[0].values[1].value).toBe('status');
  });

  it('skips empty extractions rather than reporting them as a segment', () => {
    const summary = summarizeLabels([
      item({ id: 'a', labels: { intent: null, topic: 'billing' } }),
      item({ id: 'b', labels: { intent: '', topic: 'billing' } }),
    ]);
    expect(summary.labeled).toBe(2);
    expect(summary.keys.map((k) => k.key)).toEqual(['topic']);
    expect(summary.keys[0].count).toBe(2);
  });

  it('reports nothing for an unlabeled dataset', () => {
    const summary = summarizeLabels([item({ id: 'a' }), item({ id: 'b' })]);
    expect(summary.labeled).toBe(0);
    expect(summary.keys).toEqual([]);
  });
});
