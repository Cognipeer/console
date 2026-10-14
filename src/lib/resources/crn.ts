/**
 * Cognipeer Resource Name. Computed, never stored:
 *   crn:cpr:<tenantId>:<projectId | ->:<type>/<id>
 * `-` stands for tenant-wide (no project).
 */
export interface CrnParts {
  tenantId: string;
  projectId: string | null;
  type: string;
  id: string;
}

const CRN_PREFIX = 'crn:cpr:';

export function buildCrn(parts: {
  tenantId: string;
  projectId?: string | null;
  type: string;
  id: string;
}): string {
  return `${CRN_PREFIX}${parts.tenantId}:${parts.projectId || '-'}:${parts.type}/${parts.id}`;
}

/** Inverse of `buildCrn`; null on anything that is not a well-formed CRN. */
export function parseCrn(value: unknown): CrnParts | null {
  if (typeof value !== 'string' || !value.startsWith(CRN_PREFIX)) return null;
  const rest = value.slice(CRN_PREFIX.length);
  const first = rest.indexOf(':');
  if (first <= 0) return null;
  const second = rest.indexOf(':', first + 1);
  if (second <= first + 1) return null;
  const tenantId = rest.slice(0, first);
  const project = rest.slice(first + 1, second);
  // The id is the tail, so an id that itself contains ':' still round-trips.
  const tail = rest.slice(second + 1);
  const slash = tail.indexOf('/');
  if (slash <= 0 || slash === tail.length - 1) return null;
  return {
    tenantId,
    projectId: project === '-' ? null : project,
    type: tail.slice(0, slash),
    id: tail.slice(slash + 1),
  };
}
