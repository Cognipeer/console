/**
 * Client side of GET /api/resource-usage/:type/:id plus the pure helpers the
 * delete / rename dialogs build their wording from (kept free of React so they
 * can be unit-tested).
 */
import type { ResourceEdgeView, ResourceRefView } from '@/components/resources/ResourceUsagePanel';

export type UsageImpact = 'error' | 'warning' | null;

export interface ResourceUsageEdge extends ResourceEdgeView {
  /** What deleting / re-keying the target does to this referrer (see the API). */
  impact?: UsageImpact;
}

/** Mirrors `ResourceUsage` of src/lib/resources/types.ts. */
export interface ResourceUsageResponse {
  resource: ResourceRefView;
  uses?: ResourceEdgeView[];
  usedBy: ResourceUsageEdge[];
  hiddenUsedByCount: number;
  hiddenByType: Record<string, number>;
  summary: { error: number; warning: number };
  usedByTruncated: boolean;
}

export class ResourceUsageError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ResourceUsageError';
  }
}

export async function fetchResourceUsage(
  type: string,
  id: string,
  signal?: AbortSignal,
): Promise<ResourceUsageResponse> {
  const response = await fetch(`/api/resource-usage/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, {
    cache: 'no-store',
    signal,
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // keep the status text
    }
    throw new ResourceUsageError(response.status, message);
  }
  return (await response.json()) as ResourceUsageResponse;
}

export interface ImpactGroup {
  /** Registry type of the referrers. */
  type: string;
  count: number;
}

/** Visible referrers that a delete would affect with `impact`, grouped by referrer type (largest first). */
export function groupByImpact(usage: Pick<ResourceUsageResponse, 'usedBy'>, impact: 'error' | 'warning'): ImpactGroup[] {
  const counts = new Map<string, number>();
  for (const edge of usage.usedBy) {
    if (edge.impact !== impact) continue;
    counts.set(edge.other.type, (counts.get(edge.other.type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

/** Total number of places that reference the resource, hidden ones included. */
export function totalUses(usage: Pick<ResourceUsageResponse, 'usedBy' | 'hiddenUsedByCount'>): number {
  return usage.usedBy.length + usage.hiddenUsedByCount;
}

/** Deleting needs a typed confirmation as soon as ONE dependent (visible or not) would fail. */
export function needsTypedConfirmation(usage: Pick<ResourceUsageResponse, 'summary'>): boolean {
  return usage.summary.error > 0;
}

/** Text the user has to type: the resource name, else its key, else its id. */
export function typedConfirmationText(ref: { name: string | null; key: string | null; id?: string | null }, fallback?: string): string | undefined {
  const text = ref.name?.trim() || ref.key?.trim() || ref.id?.trim() || fallback?.trim();
  return text || undefined;
}

/** True when the key was edited to a different non-empty value (whitespace is not a change). */
export function keyChanged(original: string | null | undefined, next: string | null | undefined): boolean {
  const before = (original ?? '').trim();
  const after = (next ?? '').trim();
  return before !== '' && before !== after;
}

/** Edges of `usedBy` that stop resolving when the target's key changes (the ones whose reference currently works). */
export function edgesBrokenByKeyChange(usage: Pick<ResourceUsageResponse, 'usedBy'>): ResourceUsageEdge[] {
  return usage.usedBy.filter((e) => e.impact === 'error' || e.impact === 'warning');
}
