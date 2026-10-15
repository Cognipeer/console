/** Where the labels of the chart markers go so they neither overlap each other nor leave the plot area. Pure. */

export interface MarkerLabelInput {
  key: string;
  /** Pixel x of the marker line. */
  x: number;
  /** The short text drawn on the chart. */
  text: string;
}

export interface MarkerLabelPlacement {
  key: string;
  text: string;
  /** Row the label sits on (0 is the top one). */
  row: number;
  /** `start`: the text begins right of the line; `end`: it ends left of the line (near the right edge). */
  anchor: 'start' | 'end';
  /** False when no row had room: only the marker tag is drawn, the full text stays in its tooltip. */
  visible: boolean;
}

export interface MarkerLabelLayoutOptions {
  /** Plot area bounds in pixels; text never goes outside them. */
  left: number;
  right: number;
  /** Estimated pixel width of one character. */
  charWidth: number;
  /** Rows of labels available above the plot. */
  rows: number;
  /** Space between the line and its text, and the least space between two labels in a row. */
  pad?: number;
}

/**
 * Anchors each label inside the plot area (flipping it to the left of its line near the right edge), then puts it
 * on the first row where it does not touch the previous label of that row. A label that fits on no row is
 * hidden. Input order does not matter; the result keeps it.
 */
export function layoutMarkerLabels(items: MarkerLabelInput[], options: MarkerLabelLayoutOptions): MarkerLabelPlacement[] {
  const pad = options.pad ?? 4;
  const rowEnds: number[] = Array.from({ length: Math.max(1, options.rows) }, () => -Infinity);
  const placed = new Map<string, MarkerLabelPlacement>();
  const ordered = [...items].sort((a, b) => a.x - b.x);

  for (const item of ordered) {
    const width = item.text.length * options.charWidth;
    const anchor: 'start' | 'end' = item.x + pad + width > options.right ? 'end' : 'start';
    const from = anchor === 'start' ? item.x + pad : item.x - pad - width;
    const to = from + width;
    const fits = from >= options.left && to <= options.right;
    const row = fits ? rowEnds.findIndex((end) => end + pad <= from) : -1;
    if (row === -1) {
      placed.set(item.key, { key: item.key, text: item.text, row: 0, anchor, visible: false });
      continue;
    }
    rowEnds[row] = to;
    placed.set(item.key, { key: item.key, text: item.text, row, anchor, visible: true });
  }
  return items.map((item) => placed.get(item.key)!);
}
