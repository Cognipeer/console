/**
 * What the dashboard (`/api/providers`) and the token-authenticated client API (`/client/v1/providers`) provider
 * routes share: reading a request body, mapping it to a service input, and finding the provider a request names.
 * Everything about who may call, which scope a call is in and how a failure is answered stays in each route file.
 */
import type { ProviderDomain } from '@/lib/database';
import type {
  CreateProviderConfigInput,
  ProviderConfigView,
  ProviderStatus,
  UpdateProviderConfigInput,
} from '@/lib/services/providers/providerService';
import { getProviderConfigById } from '@/lib/services/providers/providerService';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A `?status=` filter: the three statuses a provider can have, anything else is no filter. */
export function parseProviderStatus(value: string | undefined): ProviderStatus | undefined {
  return value === 'active' || value === 'disabled' || value === 'errored' ? value : undefined;
}

const REQUIRED_CREATE_FIELDS = ['key', 'type', 'driver', 'label', 'credentials', 'createdBy'] as const;

/** Throws a message fit for a 400 when a create body is not an object or lacks one of the required fields. */
export function assertCreateProviderPayload(body: unknown): asserts body is CreateProviderConfigInput {
  if (!isRecord(body)) {
    throw new Error('Invalid payload');
  }
  for (const field of REQUIRED_CREATE_FIELDS) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      throw new Error(`${field} is required`);
    }
  }
}

/** The fields of an update body the service takes, each only when it has the right shape. */
export function sanitizeProviderUpdatePayload(body: unknown): UpdateProviderConfigInput {
  const payload: UpdateProviderConfigInput = {};
  if (!isRecord(body)) {
    return payload;
  }

  if (typeof body.label === 'string') payload.label = body.label;
  if (typeof body.description === 'string' || body.description === null) {
    payload.description = (body.description ?? undefined) as string | undefined;
  }
  if (body.status === 'active' || body.status === 'disabled' || body.status === 'errored') {
    payload.status = body.status;
  }
  if (isRecord(body.settings)) payload.settings = body.settings;
  if (isRecord(body.metadata)) payload.metadata = body.metadata;
  if (isRecord(body.credentials)) payload.credentials = body.credentials;
  if (
    Array.isArray(body.projectIds)
    && body.projectIds.every((item) => typeof item === 'string')
  ) {
    payload.projectIds = body.projectIds;
  }
  if (
    Array.isArray(body.capabilitiesOverride)
    && body.capabilitiesOverride.every((item) => typeof item === 'string')
  ) {
    payload.capabilitiesOverride = body.capabilitiesOverride;
  }

  return payload;
}

/**
 * Where a created provider lives: one project (`projectId`), a list of them (`projectIds`, tenant scope), or neither
 * (`{}`: tenant scope, unassigned). The keys that are present are passed on as they are, `undefined` values included.
 */
export type CreateProviderScope = { projectId?: string } | { projectIds?: string[] };

/** The service input of a create body that already passed `assertCreateProviderPayload`. */
export function buildCreateProviderInput(
  body: Record<string, unknown>,
  options: { createdBy: string; scope: CreateProviderScope; allowHostPaths: boolean },
): CreateProviderConfigInput {
  return {
    capabilitiesOverride: body.capabilitiesOverride as string[] | undefined,
    createdBy: options.createdBy,
    credentials: body.credentials as Record<string, unknown>,
    description: body.description as string | undefined,
    driver: body.driver as string,
    key: body.key as string,
    label: body.label as string,
    metadata: body.metadata as Record<string, unknown> | undefined,
    settings: body.settings as Record<string, unknown> | undefined,
    status: body.status as ProviderStatus | undefined,
    type: body.type as ProviderDomain,
    allowHostPaths: options.allowHostPaths,
    ...options.scope,
  };
}

/** True when the provider row belongs to this project (direct or via projectIds). */
export function isAssignedToProject(
  provider: { projectId?: unknown; projectIds?: unknown },
  projectId: string,
): boolean {
  return (
    String(provider.projectId) === String(projectId)
    || (Array.isArray(provider.projectIds) && provider.projectIds.map(String).includes(String(projectId)))
  );
}

/**
 * The provider a request names, or null: it does not exist, belongs to another tenant, or - in project scope - is not
 * assigned to the project (which includes a project scope without a project). Callers answer every null with the same 404.
 * Tenant scope sees every provider of the tenant.
 */
export async function loadScopedProvider(
  tenantDbName: string,
  tenantId: string,
  id: string,
  options: { scope: 'tenant' | 'project'; projectId?: string; credentialFields?: boolean },
): Promise<ProviderConfigView | null> {
  const provider = options.credentialFields
    ? await getProviderConfigById(tenantDbName, id, { credentialFields: true })
    : await getProviderConfigById(tenantDbName, id);
  if (!provider || provider.tenantId !== tenantId) return null;
  if (options.scope === 'tenant') return provider;
  return options.projectId && isAssignedToProject(provider, options.projectId) ? provider : null;
}
