/**
 * Resource health: the problems that fall out of the reference graph plus two
 * registry-wide checks. Pure functions over one snapshot — nothing is stored,
 * every issue is recomputed when the snapshot is rebuilt.
 */
import { createHash } from 'node:crypto';
import {
  MAX_EDGE_CANDIDATES,
  severityFor,
  toBareRefView,
  toRefView,
  type RefViewContext,
  type ResolvedEdge,
} from './references';
import type { HealthIssue, HealthIssueKind, HealthSeverity, ResourceEdgeStatus, ResourceRecord } from './types';

export const HEALTH_ISSUE_KINDS: readonly HealthIssueKind[] = [
  'broken-reference',
  'cross-project-reference',
  'inactive-reference',
  'ambiguous-reference',
  'duplicate-key',
  'mcp-dual-registration',
];

const ISSUE_KIND_BY_STATUS: Record<Exclude<ResourceEdgeStatus, 'ok'>, HealthIssueKind> = {
  missing: 'broken-reference',
  'cross-project': 'cross-project-reference',
  inactive: 'inactive-reference',
  ambiguous: 'ambiguous-reference',
};

/**
 * Types whose key is only unique together with another attribute: the same
 * index key under two vector providers is legitimate.
 */
const KEY_DISCRIMINATOR_ATTRIBUTE: Record<string, string> = {
  'vector-index': 'providerKey',
};

function issueId(parts: Array<string | null | undefined>): string {
  return createHash('sha1').update(parts.map((p) => p ?? '').join('\u0000')).digest('hex').slice(0, 16);
}

function scopeOf(r: ResourceRecord): string {
  return r.projectId ?? '';
}

function edgeIssue(resolved: ResolvedEdge, ctx: RefViewContext): HealthIssue | null {
  if (resolved.status === 'ok') return null;
  const kind = ISSUE_KIND_BY_STATUS[resolved.status];
  const severity = severityFor(resolved) as HealthSeverity;
  const { from, edge } = resolved;
  const others = resolved.status === 'ambiguous'
    ? resolved.matches
    : resolved.status === 'cross-project'
      ? resolved.candidates
      : [];
  const bare = toBareRefView(edge);
  return {
    id: issueId([kind, from.type, from.id, edge.kind, edge.field, edge.toType, edge.target, edge.qualifier]),
    kind,
    severity,
    resource: toRefView(from, ctx),
    ...(others.length > 0
      ? { related: others.slice(0, MAX_EDGE_CANDIDATES).map((o) => toRefView(o, ctx)) }
      : {}),
    edgeKind: edge.kind,
    field: edge.field,
    targetType: edge.toType,
    targetKey: bare.key ?? bare.id ?? edge.target,
  };
}

function duplicateKeyIssues(records: readonly ResourceRecord[], ctx: RefViewContext): HealthIssue[] {
  const groups = new Map<string, ResourceRecord[]>();
  for (const r of records) {
    if (!r.key) continue;
    const discriminator = KEY_DISCRIMINATOR_ATTRIBUTE[r.type];
    const extra = discriminator ? String(r.attributes.find((a) => a.key === discriminator)?.value ?? '') : '';
    // A tenant-wide row and a project row sharing a key are the intended fallback, not a duplicate.
    const groupKey = [r.type, scopeOf(r), extra, r.key].join('\u0000');
    const bucket = groups.get(groupKey);
    if (bucket) bucket.push(r);
    else groups.set(groupKey, [r]);
  }
  const issues: HealthIssue[] = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    for (const row of rows) {
      // Bounded: a pathological group (thousands of rows sharing a key) must not cost O(N^2).
      const others: ResourceRecord[] = [];
      for (const o of rows) {
        if (o === row) continue;
        others.push(o);
        if (others.length >= MAX_EDGE_CANDIDATES) break;
      }
      issues.push({
        id: issueId(['duplicate-key', row.type, row.id, row.key]),
        kind: 'duplicate-key',
        severity: 'warning',
        resource: toRefView(row, ctx),
        related: others.map((o) => toRefView(o, ctx)),
        targetType: row.type,
        targetKey: row.key as string,
      });
    }
  }
  return issues;
}

/**
 * A tool of type 'mcp' and an MCP server registered under the same key in the
 * same scope: the same upstream is wired twice and the two copies drift. Only
 * key + scope are compared — the records never carry endpoints (they are
 * deliberately not whitelisted), and no URL may reach an API response.
 */
function mcpDualRegistrationIssues(records: readonly ResourceRecord[], ctx: RefViewContext): HealthIssue[] {
  const servers = new Map<string, ResourceRecord[]>();
  const tools: ResourceRecord[] = [];
  for (const r of records) {
    if (!r.key) continue;
    if (r.type === 'mcp-server') {
      const k = `${scopeOf(r)}\u0000${r.key}`;
      const bucket = servers.get(k);
      if (bucket) bucket.push(r);
      else servers.set(k, [r]);
    } else if (r.type === 'tool' && r.attributes.some((a) => a.key === 'type' && a.value === 'mcp')) {
      tools.push(r);
    }
  }
  const issues: HealthIssue[] = [];
  for (const tool of tools) {
    const twins = servers.get(`${scopeOf(tool)}\u0000${tool.key}`);
    if (!twins) continue;
    issues.push({
      id: issueId(['mcp-dual-registration', tool.type, tool.id, tool.key]),
      kind: 'mcp-dual-registration',
      severity: 'warning',
      resource: toRefView(tool, ctx),
      related: twins.slice(0, MAX_EDGE_CANDIDATES).map((s) => toRefView(s, ctx)),
      targetType: 'mcp-server',
      targetKey: tool.key as string,
    });
    for (const server of twins) {
      issues.push({
        id: issueId(['mcp-dual-registration', server.type, server.id, server.key]),
        kind: 'mcp-dual-registration',
        severity: 'warning',
        resource: toRefView(server, ctx),
        related: [toRefView(tool, ctx)],
        targetType: 'tool',
        targetKey: server.key as string,
      });
    }
  }
  return issues;
}

const SEVERITY_RANK: Record<HealthSeverity, number> = { error: 0, warning: 1 };

export function compareIssues(a: HealthIssue, b: HealthIssue): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || a.resource.name!.localeCompare(b.resource.name!)
    || a.kind.localeCompare(b.kind)
    || (a.field ?? '').localeCompare(b.field ?? '')
    || a.id.localeCompare(b.id)
  );
}

export function computeHealthIssues(input: {
  records: readonly ResourceRecord[];
  resolved: readonly ResolvedEdge[];
  ctx: RefViewContext;
}): HealthIssue[] {
  const issues: HealthIssue[] = [];
  for (const resolved of input.resolved) {
    const issue = edgeIssue(resolved, input.ctx);
    if (issue) issues.push(issue);
  }
  issues.push(...duplicateKeyIssues(input.records, input.ctx));
  issues.push(...mcpDualRegistrationIssues(input.records, input.ctx));
  return issues.sort(compareIssues);
}
