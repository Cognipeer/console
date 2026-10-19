/**
 * Unit tests — foldSupersededSpans, the Console twin of agent-sdk's helper of the
 * same name: a sub-agent that paused is recorded `pending` at each pause and once
 * more, with the same span id, when it ends; a reader draws only the latest.
 * The case table mirrors the SDK's.
 */

import { describe, expect, it } from 'vitest';

import { foldSupersededSpans } from '@/lib/shared/foldSupersededSpans';

const rec = (sequence: number, spanId: string | undefined, status = 'success') => ({ sequence, spanId, status });

describe('foldSupersededSpans', () => {
  it('keeps everything when no id repeats, in order, without touching its input', () => {
    const input = [rec(1, 'a'), rec(2, 'b', 'pending'), rec(3, 'c')];
    const snapshot = JSON.stringify(input);
    expect(foldSupersededSpans(input)).toEqual(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(foldSupersededSpans([])).toEqual([]);
  });

  it('drops a pending record once a later one has its id', () => {
    expect(foldSupersededSpans([rec(1, 'a', 'pending'), rec(2, 'x'), rec(3, 'a')])).toEqual([rec(2, 'x'), rec(3, 'a')]);
    expect(foldSupersededSpans([rec(1, 'a', 'pending'), rec(2, 'a', 'pending'), rec(3, 'a', 'error')])).toEqual([rec(3, 'a', 'error')]);
  });

  it('keeps the latest pending record while the run is still waiting', () => {
    expect(foldSupersededSpans([rec(1, 'a', 'pending'), rec(5, 'a', 'pending')])).toEqual([rec(5, 'a', 'pending')]);
  });

  it('never drops a record that is not pending, even when its id repeats', () => {
    const input = [rec(1, 'a'), rec(2, 'a'), rec(3, 'a', 'error')];
    expect(foldSupersededSpans(input)).toEqual(input);
  });

  it('does not let a pending record that follows hide an earlier finished one', () => {
    const input = [rec(1, 'a'), rec(2, 'a', 'pending')];
    expect(foldSupersededSpans(input)).toEqual(input);
  });

  it('leaves records without a span id alone and falls back to array order without sequences', () => {
    const loose = [{ spanId: undefined, status: 'pending' }, { spanId: 'a', status: 'pending' }, { spanId: 'a', status: 'success' }];
    expect(foldSupersededSpans(loose)).toEqual([loose[0], loose[2]]);
  });

  it('is decided by sequence, not by where the record sits in the array', () => {
    expect(foldSupersededSpans([rec(9, 'a'), rec(2, 'a', 'pending')])).toEqual([rec(9, 'a')]);
  });

  it('is idempotent', () => {
    const input = [rec(1, 'a', 'pending'), rec(2, 'a', 'pending'), rec(3, 'a'), rec(4, 'b', 'pending')];
    const once = foldSupersededSpans(input);
    expect(foldSupersededSpans(once)).toEqual(once);
  });
});
