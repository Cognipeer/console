import { describe, expect, it } from 'vitest';
import { normalizeDatasetItem, normalizeDatasetItems } from '@/lib/services/evaluation/itemValidation';

const userMsg = { role: 'user', content: 'hello' };

function ok(raw: unknown, opts?: { partial?: boolean }) {
  const r = normalizeDatasetItem(raw, 'item', opts);
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
  return r.value;
}

function err(raw: unknown, opts?: { partial?: boolean }) {
  const r = normalizeDatasetItem(raw, 'item', opts);
  if (!('error' in r)) throw new Error('expected an error');
  return r.error;
}

describe('normalizeDatasetItem', () => {
  it('maps OpenAI tool_calls and tool_call_id onto the canonical spelling', () => {
    const item = ok({
      input: [
        userMsg,
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' } }] },
        { role: 'tool', content: 'result', tool_call_id: 'c1' },
      ],
    });
    const input = item.input as Array<Record<string, unknown>>;
    expect(input[1]).toEqual({ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'lookup', args: { q: 'a' } }] });
    expect(input[2]).toEqual({ role: 'tool', content: 'result', toolCallId: 'c1' });
  });

  it('keeps canonical toolCalls and treats an empty arguments string as no arguments', () => {
    const item = ok({
      input: [userMsg, { role: 'assistant', content: 'x', toolCalls: [{ name: 'ping', args: { a: 1 } }, { function: { name: 'noargs', arguments: '' } }] }],
    });
    const calls = (item.input as Array<Record<string, unknown>>)[1].toolCalls;
    expect(calls).toEqual([{ name: 'ping', args: { a: 1 } }, { name: 'noargs', args: {} }]);
  });

  it.each([
    [{ input: [{ role: 'robot', content: 'x' }] }, 'role'],
    [{ input: [{ role: 'user', content: 5 }] }, 'content'],
    [{ input: [{ role: 'user' }] }, 'content'],
    [{ input: [userMsg, { role: 'assistant', content: '', toolCalls: [{ args: {} }] }] }, 'name'],
    [{ input: [userMsg, { role: 'assistant', content: '', toolCalls: [{ name: 'a', args: '[1]' }] }] }, 'args'],
    [{ input: [userMsg, { role: 'assistant', content: '', toolCalls: [{ name: 'a', args: 'not json' }] }] }, 'args'],
    [{ input: [{ role: 'tool', content: 'r', toolCallId: 7 }] }, 'toolCallId'],
    [{ input: [userMsg], tools: [{ parameters: {} }] }, 'name'],
    [{ input: [userMsg], tools: [{ name: 't', parameters: 'x' }] }, 'parameters'],
    [{ input: [userMsg], expected: { toolCalls: [{ name: 'a', argsMatch: 'fuzzy' }] } }, 'argsMatch'],
    [{ input: [userMsg], expected: { toolCalls: [{ args: {} }] } }, 'name'],
    [{ input: [userMsg], tags: ['a', 2] }, 'tags'],
    [{ input: [userMsg], toolResults: [] }, 'toolResults'],
    [{ input: 'nope' }, 'input'],
  ])('rejects %j', (raw, fragment) => {
    expect(err(raw)).toContain(fragment);
  });

  it('accepts a null parameters block on a tool (Mongo hands null back for an unset field)', () => {
    const item = ok({ input: [userMsg], tools: [{ name: 't', parameters: null }] });
    expect(item.tools).toEqual([{ name: 't' }]);
  });

  it('unwraps the OpenAI tool menu shape', () => {
    const item = ok({
      input: [userMsg],
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }],
    });
    expect(item.tools).toEqual([{ name: 'f', description: 'd', parameters: { type: 'object' } }]);
  });

  it('accepts every argsMatch mode and normalises string expected args', () => {
    for (const mode of ['exact', 'subset', 'schema', 'ignore']) {
      expect(ok({ input: [userMsg], expected: { toolCalls: [{ name: 'a', argsMatch: mode }] } })).toBeDefined();
    }
    const item = ok({ input: [userMsg], expected: { toolCalls: [{ name: 'a', args: '{"x":1}' }] } });
    expect((item.expected as { toolCalls: Array<{ args: unknown }> }).toolCalls[0].args).toEqual({ x: 1 });
  });

  it('drops unknown keys and always drops labelMeta, but keeps labels', () => {
    const item = ok({ input: [userMsg], labels: { topic: 'a' }, labelMeta: { source: 'human' }, createdAt: 'x', _id: 'y' });
    expect(item.labelMeta).toBeUndefined();
    expect((item as Record<string, unknown>).createdAt).toBeUndefined();
    expect((item as Record<string, unknown>)._id).toBeUndefined();
    expect(item.labels).toEqual({ topic: 'a' });
  });

  it('create form treats null blocks as absent; patch form passes null through to clear', () => {
    const created = ok({ input: [userMsg], expected: null, tools: null });
    expect('expected' in created).toBe(false);
    expect('tools' in created).toBe(false);
    const patched = ok({ expected: null, tags: ['a'] }, { partial: true });
    expect(patched).toEqual({ expected: null, tags: ['a'] });
  });

  it('patch form returns only the keys that were sent', () => {
    expect(ok({ tags: ['x'] }, { partial: true })).toEqual({ tags: ['x'] });
    expect(err({ input: 5 }, { partial: true })).toContain('input');
  });
});

describe('normalizeDatasetItems', () => {
  it('requires a unique non-empty id on every entry', () => {
    expect('error' in normalizeDatasetItems([{ input: [userMsg] }])).toBe(true);
    const dup = normalizeDatasetItems([{ id: 'a', input: [userMsg] }, { id: 'a', input: [userMsg] }]);
    expect('error' in dup && dup.error).toContain('duplicates');
  });

  it('returns the normalised items in order', () => {
    const r = normalizeDatasetItems([{ id: 'a', input: [userMsg] }, { id: 'b', input: [userMsg], tags: ['t'] }]);
    expect('items' in r && r.items.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('names the failing index', () => {
    const r = normalizeDatasetItems([{ id: 'a', input: [userMsg] }, { id: 'b', input: [{ role: 'x', content: '' }] }]);
    expect('error' in r && r.error).toContain('items[1]');
  });
});
