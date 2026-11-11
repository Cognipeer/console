/**
 * Unit tests — producer-side tool fidelity of snapshots and imports:
 * parallel tool calls merge into one assistant turn (T3), and Langfuse /
 * legacy `function` role shapes keep their tool menus and tool turns (T13).
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/services/evaluation/service', () => ({ createDataset: vi.fn() }));

import { mergeParallelCalls } from '@/lib/services/snapshots/snapshotService';
import { parseImportItems } from '@/lib/services/datasetImport/datasetImport';

describe('mergeParallelCalls', () => {
  it('folds consecutive tool-call assistant turns into one message with N calls', () => {
    const merged = mergeParallelCalls([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'f', args: {} }] },
      { role: 'assistant', content: '', toolCalls: [{ id: 'b', name: 'g', args: {} }] },
      { role: 'tool', content: 'ra', toolCallId: 'a' },
      { role: 'tool', content: 'rb', toolCallId: 'b' },
    ] as never);
    expect(merged).toHaveLength(4);
    expect(merged[1].toolCalls?.map((c) => c.id)).toEqual(['a', 'b']);
    expect(merged[2].toolCallId).toBe('a');
  });

  it('keeps assistant turns with text separate', () => {
    const merged = mergeParallelCalls([
      { role: 'assistant', content: 'thinking', toolCalls: [{ id: 'a', name: 'f', args: {} }] },
      { role: 'assistant', content: '', toolCalls: [{ id: 'b', name: 'g', args: {} }] },
    ] as never);
    expect(merged).toHaveLength(2);
  });
});

describe('import: tool shapes', () => {
  it('keeps the tool menu next to Langfuse messages', () => {
    const line = JSON.stringify({
      input: {
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
      },
      output: 'ok',
    });
    const { items } = parseImportItems(line, 'langfuse-generations');
    expect(items[0].tools?.map((t) => t.name)).toEqual(['get_weather']);
  });

  it('treats the legacy function role as a tool turn', () => {
    const line = JSON.stringify({
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: null, function_call: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
        { role: 'function', name: 'get_weather', content: '20C' },
        { role: 'user', content: 'thanks' },
      ],
    });
    const { items } = parseImportItems(line, 'openai-chat-jsonl');
    expect(items[0].input.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(items[0].input[1].toolCalls?.[0]).toMatchObject({ name: 'get_weather', args: { city: 'Paris' } });
  });
});
