/**
 * The view model of the Web Search pages and the two-layer helpers of the provider form: a split driver form gives
 * the provider its connection and an instance its behavior, an instance on a platform or managed provider gets the
 * fixed hosted options, a save keeps the settings the form does not show, and the list says what may be done with
 * each row. Pure functions.
 */
import { describe, expect, it } from 'vitest';
import type { ProviderFormSchema } from '@/lib/providers/types';
import { HOSTED_WEBSEARCH_INSTANCE_FORM, SearxngWebSearchProviderContract } from '@/lib/providers/contracts/webSearchContracts';
import {
  allFields,
  fieldLayer,
  formForLayer,
  isLayeredForm,
  settingsOutsideForm,
} from '@/components/providers/providerFormModel';
import {
  canManageWebSearch,
  instanceBehaviorForm,
  instanceKeyFromName,
  instanceOfRow,
  instanceSettingsFromForm,
  isHostedProvider,
  isUnavailable,
  listRows,
  optionRows,
  rowAbilities,
  type WebSearchListRow,
} from '@/components/websearch/webSearchModel';

/** A split driver form: an endpoint on the provider, a credential, and two search options. */
const SPLIT: ProviderFormSchema = {
  sections: [
    {
      title: 'Connection',
      fields: [
        { name: 'baseUrl', label: 'Base URL', type: 'text', scope: 'settings', settingsTarget: 'connection', required: true },
        { name: 'apiKey', label: 'API key', type: 'password' },
      ],
    },
    {
      title: 'Search',
      fields: [
        { name: 'engines', label: 'Engines', type: 'text', scope: 'settings' },
        {
          name: 'safeSearch',
          label: 'Safe Search',
          type: 'select',
          scope: 'settings',
          settingsTarget: 'behavior',
          defaultValue: 'moderate',
          options: [
            { label: 'Off', value: 'off' },
            { label: 'Moderate', value: 'moderate' },
            { label: 'Strict', value: 'strict' },
          ],
        },
      ],
    },
  ],
};

const names = (schema: ProviderFormSchema | null) => allFields(schema).map((field) => field.name);
const DRIVERS = [{ id: 'searxng' }, { id: 'tavily' }];

describe('the two layers of a driver form', () => {
  it('gives the provider the connection and an instance the behavior (an unset target is behavior)', () => {
    expect(isLayeredForm(SPLIT)).toBe(true);
    expect(names(formForLayer(SPLIT, 'connection'))).toEqual(['baseUrl', 'apiKey']);
    expect(names(formForLayer(SPLIT, 'behavior'))).toEqual(['engines', 'safeSearch']);
    expect(fieldLayer(allFields(SPLIT)[1])).toBe('connection');
  });

  it('leaves a form that is not split whole for the provider, and gives an instance nothing of it', () => {
    const plain: ProviderFormSchema = { sections: [{ title: 'S3', fields: [{ name: 'bucket', label: 'Bucket', type: 'text', scope: 'settings' }] }] };
    expect(isLayeredForm(plain)).toBe(false);
    expect(formForLayer(plain, 'connection')).toBe(plain);
    expect(formForLayer(plain, 'behavior').sections).toEqual([]);
  });

  it('drops a section left without fields', () => {
    expect(formForLayer(SPLIT, 'behavior').sections.map((section) => section.title)).toEqual(['Search']);
  });

  it('splits a real web search driver form: the endpoint stays with the provider', () => {
    const form = SearxngWebSearchProviderContract.form;
    expect(names(formForLayer(form, 'connection'))).toContain('baseUrl');
    expect(names(formForLayer(form, 'behavior'))).not.toContain('baseUrl');
  });

  it('keeps the stored settings a form does not show', () => {
    const stored = { baseUrl: 'https://search.example', engines: 'a', aiAnswer: { enabled: true } };
    expect(settingsOutsideForm(stored, formForLayer(SPLIT, 'connection'))).toEqual({ engines: 'a', aiAnswer: { enabled: true } });
    expect(settingsOutsideForm(null, SPLIT)).toEqual({});
  });
});

describe('the search options form of an instance', () => {
  it('is the fixed hosted form for a platform provider or a driver the console does not offer', () => {
    expect(isHostedProvider({ driver: 'searxng', platform: true }, DRIVERS)).toBe(true);
    expect(isHostedProvider({ driver: 'hosted-search' }, DRIVERS)).toBe(true);
    expect(isHostedProvider({ driver: 'searxng' }, DRIVERS)).toBe(false);
    expect(instanceBehaviorForm({ driver: 'hosted-search', platform: true }, DRIVERS, null)).toBe(HOSTED_WEBSEARCH_INSTANCE_FORM);
    expect(names(HOSTED_WEBSEARCH_INSTANCE_FORM)).toEqual(['searchDepth', 'language', 'country', 'safeSearch']);
    expect(allFields(HOSTED_WEBSEARCH_INSTANCE_FORM).every((field) => fieldLayer(field) === 'behavior')).toBe(true);
  });

  it('is the behavior part of the driver form otherwise, once it is loaded', () => {
    expect(instanceBehaviorForm({ driver: 'searxng' }, DRIVERS, null)).toBeNull();
    expect(names(instanceBehaviorForm({ driver: 'searxng' }, DRIVERS, SPLIT))).toEqual(['engines', 'safeSearch']);
  });

  it('saves what the form holds over the settings it does not show: the AI answer and the cache survive an edit', () => {
    const form = formForLayer(SPLIT, 'behavior');
    const stored = { engines: 'a', aiAnswer: { enabled: true, modelKey: 'm' }, cache: { enabled: false }, legacy: 1 };
    expect(instanceSettingsFromForm(form, { engines: 'b', safeSearch: 'strict' }, stored)).toEqual({
      engines: 'b',
      safeSearch: 'strict',
      aiAnswer: { enabled: true, modelKey: 'm' },
      cache: { enabled: false },
      legacy: 1,
    });
  });

  it('drops a cleared option, and leaves an untouched default out of an edit but in a create', () => {
    const form = formForLayer(SPLIT, 'behavior');
    expect(instanceSettingsFromForm(form, { engines: '', safeSearch: 'moderate' }, { engines: 'a' })).toEqual({});
    expect(instanceSettingsFromForm(form, { engines: '', safeSearch: 'moderate' })).toEqual({ safeSearch: 'moderate' });
  });

  it('shows the options an instance sets by their labels, then the keys the form does not name', () => {
    expect(optionRows(HOSTED_WEBSEARCH_INSTANCE_FORM, {
      safeSearch: 'strict', searchDepth: 'advanced', language: '', aiAnswer: { enabled: true }, custom: 'x',
    })).toEqual([
      { name: 'searchDepth', label: 'Search Depth', value: 'Advanced' },
      { name: 'safeSearch', label: 'Safe Search', value: 'Strict' },
      { name: 'custom', label: 'custom', value: 'x' },
    ]);
    expect(optionRows(null, { language: 'tr', cache: { enabled: true } })).toEqual([{ name: 'language', label: 'language', value: 'tr' }]);
  });
});

describe('instanceKeyFromName', () => {
  it('suggests a lower-case key with dashes, without accents', () => {
    expect(instanceKeyFromName('Docs Search')).toBe('docs-search');
    expect(instanceKeyFromName('  Doküman araması / Ürün  ')).toBe('dokuman-aramasi-urun');
    expect(instanceKeyFromName('***')).toBe('');
    expect(instanceKeyFromName('a'.repeat(70))).toHaveLength(64);
  });
});

describe('the rows of the list', () => {
  const instance = (extra: Partial<WebSearchListRow> = {}): WebSearchListRow => ({
    _id: 'i1', key: 'docs', kind: 'instance', label: 'Docs', driver: 'searxng', status: 'active', providerKey: 'searx',
    settings: { engines: 'a' }, platform: false, tenantWide: false,
    provider: { key: 'searx', label: 'Searx', driver: 'searxng', status: 'active', platform: false },
    ...extra,
  });
  const providerRow = (key: string, extra: Partial<WebSearchListRow> = {}): WebSearchListRow => ({
    _id: `p-${key}`, key, kind: 'provider', label: key, driver: 'searxng', status: 'active', ...extra,
  });

  it('leaves out a provider an instance searches through, and keeps one that no instance uses', () => {
    const rows = listRows([instance(), providerRow('searx'), providerRow('other')]);
    expect(rows.map((row) => `${row.kind}:${row.key}`)).toEqual(['instance:docs', 'provider:other']);
  });

  it('lets owners and admins change their own instances, and create one on a provider that has none', () => {
    expect(canManageWebSearch('owner') && canManageWebSearch('admin')).toBe(true);
    expect(canManageWebSearch('project_admin') || canManageWebSearch('user') || canManageWebSearch(undefined)).toBe(false);
    expect(rowAbilities(instance(), true)).toEqual({ edit: true, remove: true, createInstance: false });
    expect(rowAbilities(instance(), false)).toEqual({ edit: false, remove: false, createInstance: false });
    expect(rowAbilities(providerRow('p'), true)).toEqual({ edit: false, remove: false, createInstance: true });
    expect(rowAbilities(providerRow('p'), false).createInstance).toBe(false);
  });

  it('keeps a platform instance read-only', () => {
    expect(rowAbilities(instance({ platform: true }), true)).toEqual({ edit: false, remove: false, createInstance: false });
  });

  it('marks a platform record switched off, or one whose provider is, as unavailable', () => {
    expect(isUnavailable(instance({ platform: true }))).toBe(false);
    expect(isUnavailable(instance({ platform: true, status: 'disabled' }))).toBe(true);
    expect(isUnavailable(instance({
      platform: true,
      provider: { key: 'p', label: 'P', driver: 'x', status: 'disabled', platform: true },
    }))).toBe(true);
    // A tenant's own disabled instance is just disabled.
    expect(isUnavailable(instance({ status: 'disabled' }))).toBe(false);
  });

  it('opens the edit form from an instance row', () => {
    expect(instanceOfRow(instance({ description: 'd', tenantWide: true }))).toEqual({
      _id: 'i1',
      key: 'docs',
      name: 'Docs',
      description: 'd',
      providerKey: 'searx',
      status: 'active',
      settings: { engines: 'a' },
      platform: false,
      tenantWide: true,
      provider: { key: 'searx', label: 'Searx', driver: 'searxng', status: 'active', platform: false },
    });
  });
});
