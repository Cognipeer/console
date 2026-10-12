/**
 * Paging an offset-based list whose server may filter AFTER it reads a page.
 *
 * The usual list answers `{ rows, total }` and page N starts at `(N - 1) * pageSize`. A list whose rows are
 * filtered by what the caller may see (the tracing lists, for a caller who may not view other people's
 * sessions) cannot count what it did not read, and a page it filled from several reads ends further on than
 * `pageSize` rows: it answers `{ rows, hasMore, nextSkip }` instead, where `nextSkip` is the offset the next page
 * starts at. A screen keeps the offsets it was given (`SkipTrail`) so "next" and "previous" land where the
 * server said, and reads `hasMore` where it would have compared the page with the total.
 */

/** The paging fields of a list response: `total` for an ordinary list, `hasMore` / `nextSkip` for a filtered one. */
export interface OffsetPageInfo {
  total?: number;
  hasMore?: boolean;
  nextSkip?: number | null;
}

export class SkipTrail {
  private readonly starts = new Map<number, number>([[1, 0]]);

  /** Where page `page` (1-based) starts: where the server said, else the arithmetic of an ordinary list. */
  skipFor(page: number, pageSize: number): number {
    return this.starts.get(page) ?? Math.max(0, (page - 1) * pageSize);
  }

  /** Remember where the page after `page` starts, when the server said. */
  remember(page: number, info: OffsetPageInfo): void {
    if (typeof info.nextSkip === 'number') this.starts.set(page + 1, info.nextSkip);
    else this.starts.delete(page + 1);
  }

  /** Forget everything past the first page (the filters changed). */
  reset(): void {
    this.starts.clear();
    this.starts.set(1, 0);
  }
}
