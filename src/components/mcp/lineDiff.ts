/** One line of a line diff. */
export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

/** The changed middle of two texts is compared cell by cell: bounded so a large definition cannot stall the page. */
const MAX_CELLS = 1_000_000;

/**
 * A line diff of two texts (longest common subsequence over the lines that
 * differ), or null when the changed part is too large to compare here.
 */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;

  // lcs[i][j]: the common subsequence length of midA[i..] and midB[j..].
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = midA[i] === midB[j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const out: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      out.push({ kind: 'same', text: midA[i] });
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      out.push({ kind: 'removed', text: midA[i] });
      i += 1;
    } else {
      out.push({ kind: 'added', text: midB[j] });
      j += 1;
    }
  }
  for (; i < n; i += 1) out.push({ kind: 'removed', text: midA[i] });
  for (; j < m; j += 1) out.push({ kind: 'added', text: midB[j] });
  for (const text of a.slice(endA)) out.push({ kind: 'same', text });
  return out;
}
