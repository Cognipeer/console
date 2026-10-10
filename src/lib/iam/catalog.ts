/**
 * The catalog the policy editor and the access check are built from
 * (`GET /api/iam/catalog`): every permission service, every action (the Read /
 * Write / Admin groups, `<service>.read|write|admin`, the per-type resource
 * verbs), the resource types of the registry, and the request-context
 * attributes a policy may reference.
 *
 * Generated from the same sources as the Cedar schema (RBAC definitions + the
 * resource registry), so a service or resource type that exists is selectable the
 * moment it exists. `labelKey`s are i18n keys under `iamApi`, `resources.types`
 * for resource types; every item also carries the product's own English
 * `label` for a UI that cannot resolve a key.
 */

import { RBAC_SERVICE_DEFINITIONS } from '@/lib/security/rbac';
import { IAM_CHANNELS, type IamChannel } from './context';
import { IAM_CONTEXT_ATTRS } from './schema';
import { getIamSchema } from './schemaState';
import { listIamResourceTypes } from './resourceTypes';
import { enforcedChannelsOf } from './runtimeEnforced';

export interface CatalogService {
  id: string;
  labelKey: string;
  adminService: boolean;
  label: string;
  category: string;
  deprecated?: true;
}

export interface CatalogAction {
  id: string;
  kind: 'group' | 'service' | 'resource';
  level: 'read' | 'write' | 'admin';
  service?: string;
  resourceType?: string;
  verb?: string;
  labelKey: string;
  labelParams: Record<string, string>;
  /**
   * The channels in which a real request is decided on this action in this build:
   * a service action by the request gates (`dashboard`, `api`), `portal.use` and
   * `agent.invoke` by the portal runtime (`portal`, only where it exists). Absent
   * (a level group, a resource action nothing asks for): the Access check and the
   * preview evaluate it, but no request is held to the answer.
   */
  enforcedIn?: IamChannel[];
}

export interface CatalogResourceType {
  type: string;
  service: string;
  labelKey: string;
}

export interface IamCatalog {
  services: CatalogService[];
  actions: CatalogAction[];
  resourceTypes: CatalogResourceType[];
  contextAttrs: string[];
  channels: string[];
}

/** The catalog's label keys are namespaced `iam.action.*`; the API serves them under `iamApi.action.*`. */
const apiLabelKey = (key: string): string => key.replace(/^iam\.action\./, 'iamApi.action.');

export function buildCatalog(): IamCatalog {
  const schema = getIamSchema();
  return {
    services: RBAC_SERVICE_DEFINITIONS.map((d) => ({
      id: d.id,
      labelKey: `iamApi.services.${d.id}`,
      adminService: d.adminService === true,
      label: d.label,
      category: d.category,
      ...(d.deprecated ? { deprecated: true as const } : {}),
    })),
    actions: schema.catalog.map((a) => {
      const enforcedIn: IamChannel[] = a.kind === 'service' ? ['dashboard', 'api'] : a.kind === 'resource' ? enforcedChannelsOf(a.id) : [];
      return {
        id: a.id,
        kind: a.kind,
        level: a.level,
        ...(a.service ? { service: a.service } : {}),
        ...(a.resourceType ? { resourceType: a.resourceType } : {}),
        ...(a.verb ? { verb: a.verb } : {}),
        labelKey: apiLabelKey(a.labelKey),
        labelParams: a.labelParams,
        ...(enforcedIn.length > 0 ? { enforcedIn } : {}),
      };
    }),
    resourceTypes: listIamResourceTypes().map((t) => ({
      type: t.type,
      service: t.service,
      labelKey: `resources.types.${t.type}`,
    })),
    contextAttrs: [...IAM_CONTEXT_ATTRS],
    channels: [...IAM_CHANNELS],
  };
}
