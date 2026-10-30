/**
 * Flow attribution of tracing sessions and cost rows. An agent a flow owns is not an agent of its own: its
 * sessions carry a `flow` block and are shown "under the flow" (`Flow: <name> › <node>`), linked to the flow
 * run, and kept out of per-agent groupings. Pure helpers, shared by the tracing pages and tables.
 */

/** The `flow` block tracing list APIs add to a session of a flow-owned agent. */
export interface TracingFlowBlock {
  id: string;
  key?: string;
  name: string;
  runId?: string;
  nodeKey?: string;
}

/** The cost / usage label of an owned agent: "Flow: <name>". */
export const FLOW_LABEL_PREFIX = 'Flow: ';

export function hasFlowAttribution<T extends { flow?: TracingFlowBlock | null }>(session: T | null | undefined): session is T & { flow: TracingFlowBlock } {
  const flow = session?.flow;
  return Boolean(flow && typeof flow === 'object' && typeof flow.id === 'string' && flow.id);
}

/** "Flow: <name> › <node>" (the node part only when known). `prefix` is the translated "Flow". */
export function flowAttributionLabel(flow: TracingFlowBlock, prefix = 'Flow'): string {
  const name = flow.name?.trim() || flow.key || flow.id;
  const node = flow.nodeKey?.trim();
  return node ? `${prefix}: ${name} › ${node}` : `${prefix}: ${name}`;
}

/** The flow run page of a session, or null when the session has no run. */
export function flowRunHref(flow: TracingFlowBlock | null | undefined): string | null {
  return flow?.runId ? `/dashboard/tracing/flows/${encodeURIComponent(flow.runId)}` : null;
}

/** The runs of one flow. */
export function flowRunsHref(flowId: string): string {
  return `/dashboard/tracing/flows?flowId=${encodeURIComponent(flowId)}`;
}

/** A tracing session page link for an agent step's `traceSessionId` output, or null. */
export function traceSessionHref(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null;
  const id = (output as { traceSessionId?: unknown }).traceSessionId;
  return typeof id === 'string' && id.trim() ? `/dashboard/tracing/sessions/${encodeURIComponent(id.trim())}` : null;
}

/** True when a cost / usage label names a flow ("Flow: <name>"). */
export function isFlowAttributedLabel(label: string | null | undefined): boolean {
  return typeof label === 'string' && label.startsWith(FLOW_LABEL_PREFIX) && label.length > FLOW_LABEL_PREFIX.length;
}

/**
 * A cost / usage entry as the flow it belongs to, when the data says so (`flowId`, or a "Flow: <name>" label).
 * Flows have no page of their own (they open under their agent), so the link goes to the flow's runs.
 */
export function flowOfUsageEntry(entry: {
  label?: string | null;
  name?: string | null;
  flowId?: string | null;
}): { name: string; href: string | null } | null {
  const label = entry.label ?? entry.name ?? null;
  const flowId = typeof entry.flowId === 'string' && entry.flowId ? entry.flowId : null;
  if (!flowId && !isFlowAttributedLabel(label)) return null;
  const name = isFlowAttributedLabel(label) ? (label as string).slice(FLOW_LABEL_PREFIX.length).trim() : (label ?? flowId ?? '');
  return { name, href: flowId ? flowRunsHref(flowId) : null };
}

/** Drops sessions / agent rows of flow-owned agents from a per-agent view. */
export function withoutFlowOwned<T extends { flow?: TracingFlowBlock | null }>(rows: readonly T[]): T[] {
  return rows.filter((row) => !hasFlowAttribution(row));
}
