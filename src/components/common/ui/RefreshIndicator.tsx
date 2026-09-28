export interface RefreshIndicatorProps {
  /** Show the indicator while data is refetched behind existing content. */
  active: boolean;
}

/**
 * Thin, delayed progress line pinned to the top edge of the nearest
 * positioned container (for example a `ds-card` with `position: relative`).
 * Purely visual: pair it with `aria-busy` on the region being refreshed.
 */
export default function RefreshIndicator({ active }: RefreshIndicatorProps) {
  if (!active) return null;
  return <div className="ds-refresh-bar" aria-hidden="true" />;
}
