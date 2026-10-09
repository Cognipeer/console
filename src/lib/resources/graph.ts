/**
 * The reference graph of one snapshot: resolved edges, the incoming ("used by")
 * index and the health issues. Built once when a snapshot is built and cached
 * with it; the views handed to the API are produced on demand.
 */
import { computeHealthIssues } from './health';
import {
  buildResolutionIndex,
  resolveEdge,
  toIncomingView,
  toOutgoingView,
  type RefViewContext,
  type ResolvedEdge,
} from './references';
import type {
  HealthIssue,
  HealthSeverity,
  ResourceEdgeInput,
  ResourceEdgeStatus,
  ResourceEdgeView,
  ResourceRecord,
} from './types';

/** "Used by" of a popular model can run to thousands of rows; the rest is reported as truncated. */
export const MAX_USED_BY = 500;

interface IncomingEntry {
  resolved: ResolvedEdge;
  status: ResourceEdgeStatus;
}

export interface ResourceGraph {
  /** Every issue of the tenant, errors first. */
  issues: readonly HealthIssue[];
  usesOf(type: string, id: string): ResourceEdgeView[];
  usedByOf(type: string, id: string): { edges: ResourceEdgeView[]; truncated: boolean };
  issuesOf(type: string, id: string): HealthIssue[];
  issueSummaryOf(type: string, id: string): { count: number; severity: HealthSeverity | null };
}

const recordKey = (type: string, id: string) => `${type}\u0000${id}`;

export const EMPTY_GRAPH: ResourceGraph = {
  issues: [],
  usesOf: () => [],
  usedByOf: () => ({ edges: [], truncated: false }),
  issuesOf: () => [],
  issueSummaryOf: () => ({ count: 0, severity: null }),
};

export function buildResourceGraph(input: {
  tenantId: string;
  records: readonly ResourceRecord[];
  /**
   * Outgoing edges per record, when the records were stripped of their internal
   * `edges` (the cached snapshot never holds them). Falls back to `record.edges`.
   */
  edgesOf?: ReadonlyMap<ResourceRecord, readonly ResourceEdgeInput[]>;
  projects: ReadonlyArray<{ id: string; name: string }>;
  /**
   * Types whose provider failed or was truncated: a target of such a type that
   * is not found may simply not have been loaded, so it is shown as missing on
   * the edge but is NOT raised as a health issue (the list already reports the
   * provider error / truncation).
   */
  incompleteTypes?: ReadonlySet<string>;
}): ResourceGraph {
  const ctx: RefViewContext = {
    tenantId: input.tenantId,
    projectNames: new Map(input.projects.map((p) => [p.id, p.name])),
  };
  const index = buildResolutionIndex(input.records);

  const resolved: ResolvedEdge[] = [];
  const outgoing = new Map<string, ResolvedEdge[]>();
  const incoming = new Map<string, IncomingEntry[]>();
  const pushIncoming = (target: ResourceRecord, entry: IncomingEntry) => {
    const k = recordKey(target.type, target.id);
    const bucket = incoming.get(k);
    if (bucket) bucket.push(entry);
    else incoming.set(k, [entry]);
  };

  for (const record of input.records) {
    const recordEdges = input.edgesOf ? input.edgesOf.get(record) : record.edges;
    if (!recordEdges?.length) continue;
    for (const edge of recordEdges) {
      const r = resolveEdge(index, record, edge);
      if (!r) continue;
      resolved.push(r);
      const k = recordKey(record.type, record.id);
      const bucket = outgoing.get(k);
      if (bucket) bucket.push(r);
      else outgoing.set(k, [r]);

      if (r.status === 'cross-project') {
        // Show the owner of the other-project copy who tried to use it.
        for (const candidate of r.candidates) pushIncoming(candidate, { resolved: r, status: 'cross-project' });
      } else if (r.status !== 'missing') {
        for (const match of r.matches) pushIncoming(match, { resolved: r, status: r.status });
      }
    }
  }

  const incomplete = input.incompleteTypes;
  const reliable = incomplete?.size
    ? resolved.filter((r) => !(r.status === 'missing' && incomplete.has(r.edge.toType)))
    : resolved;
  const issues = computeHealthIssues({ records: input.records, resolved: reliable, ctx });
  const issuesByResource = new Map<string, HealthIssue[]>();
  for (const issue of issues) {
    const k = recordKey(issue.resource.type, issue.resource.id as string);
    const bucket = issuesByResource.get(k);
    if (bucket) bucket.push(issue);
    else issuesByResource.set(k, [issue]);
  }

  return {
    issues,
    usesOf: (type, id) => (outgoing.get(recordKey(type, id)) ?? []).map((r) => toOutgoingView(r, ctx)),
    usedByOf: (type, id) => {
      const entries = incoming.get(recordKey(type, id)) ?? [];
      const sorted = entries
        .slice()
        .sort((a, b) => a.resolved.from.name.localeCompare(b.resolved.from.name) || a.resolved.edge.field.localeCompare(b.resolved.edge.field));
      return {
        edges: sorted.slice(0, MAX_USED_BY).map((e) => toIncomingView(e.resolved, ctx, e.status)),
        truncated: sorted.length > MAX_USED_BY,
      };
    },
    issuesOf: (type, id) => issuesByResource.get(recordKey(type, id)) ?? [],
    issueSummaryOf: (type, id) => {
      const own = issuesByResource.get(recordKey(type, id));
      if (!own || own.length === 0) return { count: 0, severity: null };
      return { count: own.length, severity: own.some((i) => i.severity === 'error') ? 'error' : 'warning' };
    },
  };
}
