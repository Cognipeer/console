/**
 * View model over the IAM catalog (`GET /api/iam/catalog`): lookups, ordering
 * and grouping the pickers need. Pure (no React); the label side lives in
 * `useIamLabels`.
 */

import { RBAC_SERVICE_DEFINITIONS } from '@/lib/security/rbac';
import type {
  CatalogAction,
  CatalogResourceType,
  CatalogService,
  IamCatalog,
} from './api';

export type ServiceCategory = 'build' | 'data' | 'operate' | 'admin' | 'other';

export const SERVICE_CATEGORY_ORDER: readonly ServiceCategory[] = [
  'build',
  'data',
  'operate',
  'admin',
  'other',
];

export const LEVELS = ['read', 'write', 'admin'] as const;
export type ActionLevel = (typeof LEVELS)[number];

export const LEVEL_GROUP_IDS = ['Read', 'Write', 'Admin'] as const;

const RBAC_BY_ID = new Map(RBAC_SERVICE_DEFINITIONS.map((d, i) => [d.id as string, { def: d, order: i }]));

/** The category the server sent for the service, else the built-in definition's, else `other`. */
export function serviceCategory(serviceId: string, category?: string): ServiceCategory {
  if (category && (SERVICE_CATEGORY_ORDER as readonly string[]).includes(category)) return category as ServiceCategory;
  return RBAC_BY_ID.get(serviceId)?.def.category ?? 'other';
}

/** Retired services stay resolvable (labels, stored grants) but are never offered for new policies. */
export function isDeprecatedService(serviceId: string): boolean {
  return RBAC_BY_ID.get(serviceId)?.def.deprecated === true;
}

export function isOfferableService(service: Pick<CatalogService, 'id' | 'deprecated'>): boolean {
  return service.deprecated !== true && !isDeprecatedService(service.id);
}

/** The built-in English label of a permission service (fallback when no translation resolves). */
export function rbacServiceLabel(serviceId: string): string | undefined {
  return RBAC_BY_ID.get(serviceId)?.def.label;
}

export interface CatalogIndex {
  actionById: Map<string, CatalogAction>;
  /** `Read`, `Write`, `Admin` (the level groups), in that order. */
  groupActions: CatalogAction[];
  /** `<service>.read|write|admin` by service. */
  serviceActions: Map<string, Partial<Record<ActionLevel, CatalogAction>>>;
  /** Resource-registry actions (`agent.invoke`...) by owning service, in catalog order. */
  resourceActions: Map<string, CatalogAction[]>;
  /** Offerable services, in the product's own order. */
  services: CatalogService[];
  serviceById: Map<string, CatalogService>;
  resourceTypeById: Map<string, CatalogResourceType>;
}

function serviceOrder(id: string): number {
  return RBAC_BY_ID.get(id)?.order ?? Number.MAX_SAFE_INTEGER;
}

export function indexCatalog(catalog: IamCatalog): CatalogIndex {
  const actionById = new Map<string, CatalogAction>();
  const groupActions: CatalogAction[] = [];
  const serviceActions = new Map<string, Partial<Record<ActionLevel, CatalogAction>>>();
  const resourceActions = new Map<string, CatalogAction[]>();

  for (const action of catalog.actions) {
    actionById.set(action.id, action);
    if (action.kind === 'group') {
      groupActions.push(action);
    } else if (action.kind === 'service' && action.service) {
      const entry = serviceActions.get(action.service) ?? {};
      entry[action.level] = action;
      serviceActions.set(action.service, entry);
    } else if (action.kind === 'resource' && action.service) {
      const list = resourceActions.get(action.service) ?? [];
      list.push(action);
      resourceActions.set(action.service, list);
    }
  }
  groupActions.sort(
    (a, b) => (LEVEL_GROUP_IDS as readonly string[]).indexOf(a.id) - (LEVEL_GROUP_IDS as readonly string[]).indexOf(b.id),
  );

  const services = catalog.services
    .filter(isOfferableService)
    .sort((a, b) => serviceOrder(a.id) - serviceOrder(b.id) || a.id.localeCompare(b.id));

  return {
    actionById,
    groupActions,
    serviceActions,
    resourceActions,
    services,
    serviceById: new Map(catalog.services.map((s) => [s.id, s])),
    resourceTypeById: new Map(catalog.resourceTypes.map((t) => [t.type, t])),
  };
}

/** Case-insensitive "all words appear" match, the same rule everywhere a picker filters locally. */
export function matchesQuery(haystack: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = haystack.toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Stable order of an action list: catalog order, unknown ids last. */
export function sortActionIds(ids: readonly string[], catalog: IamCatalog): string[] {
  const rank = new Map(catalog.actions.map((a, i) => [a.id, i]));
  return [...ids].sort(
    (a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b),
  );
}
