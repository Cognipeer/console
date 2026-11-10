/**
 * Reply shapes of the web search API: an instance with a small summary of the provider it searches through, and
 * the compatible list (instances plus the provider rows that have no instance yet) that callers of the provider-based
 * routes still read.
 */

import type { IWebSearchInstance } from '@/lib/database';
import {
  redactPlatformProvider,
  type ProviderConfigView,
  type ProviderViewOptions,
} from '@/lib/services/providers/providerService';
import { listWebSearchProviders } from '@/lib/services/webSearch';
import { listWebSearchInstances } from './webSearchInstanceService';

/** What a reply says of the provider behind an instance: never credentials or connection settings. */
export interface WebSearchProviderSummary {
  key: string;
  label: string;
  driver: string;
  status: string;
  platform: boolean;
}

export interface WebSearchInstanceView {
  _id?: string;
  key: string;
  name: string;
  description?: string;
  providerKey: string;
  projectId?: string | null;
  status: IWebSearchInstance['status'];
  settings: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  platform: boolean;
  /** True when no project owns it. */
  tenantWide: boolean;
  provider: WebSearchProviderSummary | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * One row of the compatible list. An instance row reads like the provider row the old callers expect (`label`,
 * `driver`, `status`, `settings`, `platform`, `hasCredentials`) and adds `kind: 'instance'`, `providerKey` and
 * `provider`. A provider row without an instance keeps its own shape and is marked `kind: 'provider'`,
 * `legacy: true`.
 */
export type WebSearchCompatRow = Record<string, unknown> & { key: string; kind: 'instance' | 'provider' };

export function summarizeProvider(provider: ProviderConfigView): WebSearchProviderSummary {
  return {
    key: provider.key,
    label: provider.label,
    driver: provider.driver,
    status: provider.status,
    platform: Boolean(provider.platform),
  };
}

export function toInstanceView(
  instance: IWebSearchInstance,
  provider: ProviderConfigView | null | undefined,
): WebSearchInstanceView {
  // The behavior of a platform-provided instance belongs to the deployment, like a platform provider's settings.
  const hidden = Boolean(instance.platform);
  return {
    _id: instance._id === undefined ? undefined : String(instance._id),
    key: instance.key,
    name: instance.name,
    ...(hidden || instance.description === undefined ? {} : { description: instance.description }),
    providerKey: instance.providerKey,
    projectId: instance.projectId ?? null,
    status: instance.status,
    settings: hidden ? {} : (instance.settings ?? {}),
    ...(hidden || !instance.metadata ? {} : { metadata: instance.metadata }),
    platform: Boolean(instance.platform),
    tenantWide: !instance.projectId,
    provider: provider ? summarizeProvider(provider) : null,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
}

export function toCompatRow(view: WebSearchInstanceView, provider?: ProviderConfigView): WebSearchCompatRow {
  return {
    _id: view._id,
    key: view.key,
    kind: 'instance',
    type: 'websearch',
    label: view.name,
    name: view.name,
    ...(view.description !== undefined ? { description: view.description } : {}),
    driver: view.provider?.driver ?? '',
    status: view.status,
    settings: view.settings,
    projectId: view.projectId ?? undefined,
    platform: view.platform,
    hasCredentials: provider ? Boolean(provider.hasCredentials) : false,
    providerKey: view.providerKey,
    provider: view.provider,
    tenantWide: view.tenantWide,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

export async function listWebSearchInstanceViews(
  tenantDbName: string,
  tenantId: string,
  projectId?: string,
): Promise<{ instances: WebSearchInstanceView[]; providers: ProviderConfigView[] }> {
  const [instances, providers] = await Promise.all([
    listWebSearchInstances(tenantDbName, tenantId, projectId),
    listWebSearchProviders(tenantDbName, tenantId, projectId),
  ]);
  const byKey = new Map(providers.map((p) => [p.key, p]));
  return { instances: instances.map((i) => toInstanceView(i, byKey.get(i.providerKey))), providers };
}

/**
 * The visible instances in the shape provider-based callers read, then every visible websearch provider that has no
 * instance with its key (not migrated yet, or a platform provider the hosting layer has not given an instance).
 * Keys never repeat.
 */
export async function listWebSearchCompatRows(
  tenantDbName: string,
  tenantId: string,
  projectId?: string,
  options?: ProviderViewOptions,
): Promise<WebSearchCompatRow[]> {
  const [instances, providers] = await Promise.all([
    listWebSearchInstances(tenantDbName, tenantId, projectId),
    listWebSearchProviders(tenantDbName, tenantId, projectId, options),
  ]);
  const byKey = new Map(providers.map((p) => [p.key, p]));
  const keys = new Set(instances.map((i) => i.key));
  const rows: WebSearchCompatRow[] = instances.map((i) => {
    const provider = byKey.get(i.providerKey);
    return toCompatRow(toInstanceView(i, provider), provider);
  });
  for (const provider of providers) {
    if (keys.has(provider.key)) continue;
    rows.push({ ...redactPlatformProvider(provider), kind: 'provider', legacy: true } as unknown as WebSearchCompatRow);
  }
  return rows;
}
