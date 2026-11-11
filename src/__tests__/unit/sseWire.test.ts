import { describe, expect, it } from 'vitest';
import { formatSseFrame } from '@/server/api/sseWire';

describe('formatSseFrame', () => {
  it('writes event and JSON data lines', () => {
    expect(formatSseFrame('text', { text: 'hi' })).toBe('event: text\ndata: {"text":"hi"}\n\n');
  });
  it('prefixes an id line when given, including 0', () => {
    expect(formatSseFrame('status', { a: 1 }, 7)).toBe('id: 7\nevent: status\ndata: {"a":1}\n\n');
    expect(formatSseFrame('x', null, 0)).toBe('id: 0\nevent: x\ndata: null\n\n');
  });
});
