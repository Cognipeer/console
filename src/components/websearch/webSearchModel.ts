/**
 * View-model logic of the Web Search pages: what a row of the list is and what may be done with it, the form an
 * instance's search options are edited with, and the settings a save sends. Pure functions, no React, so they are
 * unit tested.
 *
 * Web search has two layers: a provider record holds the connection (credentials, endpoint), an instance holds the
 * behavior (depth, language, safe search, AI answer, cache) and points at a provider by key.
 */

import type { ProviderDescriptor, ProviderFormSchema } from '@/lib/providers/types';
import { HOSTED_WEBSEARCH_INSTANCE_FORM } from '@/lib/providers/contracts/webSearchContracts';
import type { WebSearchInstanceView, WebSearchProviderSummary } from '@/lib/services/webSearch/webSearchInstanceView';
import {
  allFields,
  formForLayer,
  isBlankValue,
  partitionProviderValues,
  settingsOutsideForm,
  type FormValueMap,
} from '@/components/providers/providerFormModel';

/**
 * A row of the Web Search list: the compatible list (`GET /api/websearch/providers`), which holds the instances and,
 * after them, the web search providers that no instance uses the key of yet.
 */
export interface WebSearchListRow {
  _id?: string;
  key: string;
  kind: 'instance' | 'provider';
  /** The instance name (an instance row) or the provider label (a provider row). */
  label: string;
  description?: string;
  driver: string;
  status: string;
  settings?: Record<string, unknown>;
  platform?: boolean;
  tenantWide?: boolean;
  providerKey?: string;
  provider?: WebSearchProviderSummary | null;
}

/**
 * The rows the list shows: the instances, then the providers no listed instance searches through. The compatible
 * list keeps a provider row while no instance has the provider's key; one that an instance under another key uses
 * has an instance, and is not offered as one without.
 */
export function listRows(rows: readonly WebSearchListRow[]): WebSearchListRow[] {
  const used = new Set(rows.filter((row) => row.kind === 'instance').map((row) => row.providerKey));
  return rows.filter((row) => row.kind === 'instance' || !used.has(row.key));
}

/** A provider row of the list as the summary an instance carries of its provider. */
export function providerOfRow(row: WebSearchListRow): WebSearchProviderSummary {
  return { key: row.key, label: row.label, driver: row.driver, status: row.status, platform: row.platform === true };
}

/** The instance an instance row of the list stands for (what the edit form opens with). */
export function instanceOfRow(row: WebSearchListRow): WebSearchInstanceView {
  return {
    _id: row._id,
    key: row.key,
    name: row.label,
    ...(row.description !== undefined ? { description: row.description } : {}),
    providerKey: row.providerKey ?? '',
    status: row.status === 'active' ? 'active' : 'disabled',
    settings: row.settings ?? {},
    platform: row.platform === true,
    tenantWide: row.tenantWide === true,
    provider: row.provider ?? null,
  };
}

/** A web search provider an instance can be created on (the project's provider list). */
export interface WebSearchProviderOption {
  _id?: string;
  key: string;
  label: string;
  driver: string;
  status: string;
  platform?: boolean;
}

/** Who may change instances: the same people who manage providers. */
export function canManageWebSearch(role: string | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

function enabledFlag(settings: Record<string, unknown> | undefined, name: 'aiAnswer' | 'cache'): boolean {
  const value = settings?.[name];
  return Boolean(value && typeof value === 'object' && (value as { enabled?: unknown }).enabled === true);
}

export function hasAiAnswer(settings: Record<string, unknown> | undefined): boolean {
  return enabledFlag(settings, 'aiAnswer');
}

export function hasCache(settings: Record<string, unknown> | undefined): boolean {
  return enabledFlag(settings, 'cache');
}

/**
 * What a person may do with a row. A platform instance is managed for the tenant: open it, nothing else. A provider
 * row has no instance to edit or delete (its connection is edited on the Providers page); an owner or admin can create
 * one on it.
 */
export function rowAbilities(row: WebSearchListRow, canManage: boolean): {
  edit: boolean;
  remove: boolean;
  createInstance: boolean;
} {
  if (row.kind === 'provider') return { edit: false, remove: false, createInstance: canManage };
  const own = canManage && row.platform !== true;
  return { edit: own, remove: own, createInstance: false };
}

/** A platform record the operator switched off: listed, but searches through it fail until it is back. */
export function isUnavailable(row: Pick<WebSearchListRow, 'platform' | 'status' | 'provider'>): boolean {
  if (row.platform !== true) return false;
  return row.status !== 'active' || (row.provider ? row.provider.status !== 'active' : false);
}

/**
 * The instance key a name suggests: lower case without accents (a dotless i is an i), a dash for anything else, at
 * most 64 characters.
 */
export function instanceKeyFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

/**
 * A provider whose driver has no form the tenant can load: a platform provider, or one on a driver the console does
 * not offer for web search (a managed one). Its instances take the fixed search options of a hosted search.
 */
export function isHostedProvider(
  provider: Pick<WebSearchProviderOption, 'driver' | 'platform'>,
  drivers: readonly Pick<ProviderDescriptor, 'id'>[],
): boolean {
  return provider.platform === true || !drivers.some((driver) => driver.id === provider.driver);
}

/**
 * The form an instance's search options are edited with: the fixed hosted options for a platform or managed
 * provider, otherwise the behavior part of the driver's own form (null until that form is loaded).
 */
export function instanceBehaviorForm(
  provider: Pick<WebSearchProviderOption, 'driver' | 'platform'>,
  drivers: readonly Pick<ProviderDescriptor, 'id'>[],
  driverForm: ProviderFormSchema | null,
): ProviderFormSchema | null {
  if (isHostedProvider(provider, drivers)) return HOSTED_WEBSEARCH_INSTANCE_FORM;
  return driverForm ? formForLayer(driverForm, 'behavior') : null;
}

/**
 * The settings an instance save sends: what the search options form holds, over the stored settings the form does
 * not show (the AI answer, the cache, a key of an earlier driver form). The settings replace the stored ones
 * wholesale, so a cleared option is dropped and everything else survives.
 */
export function instanceSettingsFromForm(
  form: ProviderFormSchema | null,
  values: FormValueMap,
  stored?: Record<string, unknown> | null,
): Record<string, unknown> {
  const entered = partitionProviderValues(form, values, stored ? { settings: stored } : undefined).settings;
  return { ...settingsOutsideForm(stored, form), ...entered };
}

/** Settings an instance page shows on cards of their own. */
const OWN_CARD_SETTINGS: ReadonlySet<string> = new Set(['aiAnswer', 'cache']);

export interface OptionRow {
  name: string;
  label: string;
  value: string;
}

/**
 * The search options an instance sets, to show: the fields of its options form that hold a value (a choice by its
 * label), in the form's order, then the stored keys the form does not name. Without the form (not loaded yet) every
 * stored option is shown by its key.
 */
export function optionRows(form: ProviderFormSchema | null, settings: Record<string, unknown>): OptionRow[] {
  const text = (value: unknown) => (typeof value === 'object' ? JSON.stringify(value) : String(value));
  const fields = allFields(form);
  const named = fields
    .filter((field) => !isBlankValue(settings[field.name]))
    .map((field) => {
      const value = settings[field.name];
      const choice = field.options?.find((option) => String(option.value) === String(value));
      return { name: field.name, label: field.label, value: choice?.label ?? text(value) };
    });
  const known = new Set(fields.map((field) => field.name));
  const others = Object.entries(settings)
    .filter(([name, value]) => !known.has(name) && !OWN_CARD_SETTINGS.has(name) && !isBlankValue(value))
    .map(([name, value]) => ({ name, label: name, value: text(value) }));
  return [...named, ...others];
}
