/**
 * agent-sdk records a sub-agent that paused for a person and later resumed as ONE
 * span written in several records: `running` when each segment of the run starts
 * (agent-sdk 0.19+), `pending` each time the run paused, and the record that ends
 * the run repeats the same `spanId` with its final status. The latest record of a
 * span id (highest `sequence`) is the one to draw; an earlier record of that id is
 * dropped only when it is still `pending` or `running`, so an id repeated by
 * anything else is left exactly as it was sent. Order is kept, the input is
 * not touched, and folding a folded list changes nothing. Mirrors agent-sdk's
 * `foldSupersededSpans`. Dependency-free: usable on the server and in the client.
 */
export function foldSupersededSpans<T extends { spanId?: string | null; sequence?: number | null; status?: string | null }>(
  events: readonly T[],
): T[] {
  const rank = (event: T, index: number) =>
    typeof event.sequence === 'number' && Number.isFinite(event.sequence) ? event.sequence : index;
  const winner = new Map<string, number>();
  events.forEach((event, index) => {
    if (!event.spanId) return;
    const current = winner.get(event.spanId);
    if (current === undefined || rank(event, index) >= rank(events[current], current)) winner.set(event.spanId, index);
  });
  return events.filter(
    (event, index) => !(event.spanId && (event.status === 'pending' || event.status === 'running') && winner.get(event.spanId) !== index),
  );
}
