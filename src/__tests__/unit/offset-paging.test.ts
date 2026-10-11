/**
 * Paging an offset-based list whose server may filter after it reads a page (the tracing lists, for a caller held to
 * their own sessions): `SkipTrail` remembers where each page starts.
 */
import { describe, expect, it } from 'vitest';
import { SkipTrail } from '@/lib/shared/offsetPaging';

describe('SkipTrail', () => {
  it('starts every page at (page - 1) * pageSize until the server says otherwise', () => {
    const trail = new SkipTrail();
    expect(trail.skipFor(1, 25)).toBe(0);
    expect(trail.skipFor(3, 25)).toBe(50);
  });

  it('goes where the server said: the page after a page filled from several reads starts further on', () => {
    const trail = new SkipTrail();
    trail.remember(1, { hasMore: true, nextSkip: 130 });
    expect(trail.skipFor(2, 25)).toBe(130);
    trail.remember(2, { hasMore: true, nextSkip: 410 });
    expect(trail.skipFor(3, 25)).toBe(410);
    // going back lands on the page it came from
    expect(trail.skipFor(2, 25)).toBe(130);
    expect(trail.skipFor(1, 25)).toBe(0);
  });

  it('forgets a start that is no longer true (the list ends, or an ordinary list answers)', () => {
    const trail = new SkipTrail();
    trail.remember(1, { hasMore: true, nextSkip: 130 });
    trail.remember(1, { total: 90 });
    expect(trail.skipFor(2, 25)).toBe(25);
  });

  it('forgets everything past the first page when the filters change', () => {
    const trail = new SkipTrail();
    trail.remember(1, { hasMore: true, nextSkip: 130 });
    trail.reset();
    expect(trail.skipFor(2, 25)).toBe(25);
    expect(trail.skipFor(1, 25)).toBe(0);
  });
});
