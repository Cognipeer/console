/**
 * Web Search provider contracts.
 *
 * Like the dedicated rerank providers, web search bypasses the runtime layer
 * entirely — searches are executed directly against the provider's HTTP API by
 * `src/lib/services/webSearch/webSearchAdapter.ts`, keyed on the provider
 * `driver` (which equals the contract `id`). The runtime factory therefore
 * returns an empty runtime.
 *
 * Supported drivers:
 *   - bing        → Bing Web Search API v7 (api key)
 *   - brave       → Brave Search API (api key)
 *   - serper      → Serper.dev Google SERP API (api key)
 *   - tavily      → Tavily Search API (api key)
 *   - searxng     → self-hosted SearxNG instance (open source, base URL)
 *   - duckduckgo  → DuckDuckGo HTML endpoint (no credentials, best-effort)
 */

import type { ProviderContract, ProviderFormSchema } from '../types';

export type WebSearchProviderRuntime = Record<string, never>;

const EMPTY_WEBSEARCH_RUNTIME: () => WebSearchProviderRuntime = () => ({});

export interface WebSearchApiKeyCredentials {
  apiKey?: string;
}

export interface WebSearchCommonSettings {
  /** ISO language code passed to the provider when supported (e.g. "en", "tr"). */
  language?: string;
  /** Country/market hint when supported (e.g. "US", "TR", "en-US"). */
  country?: string;
  /** Provider-native safe-search level. */
  safeSearch?: 'off' | 'moderate' | 'strict';
}

function safeSearchField() {
  return {
    name: 'safeSearch',
    label: 'Safe Search',
    type: 'select' as const,
    scope: 'settings' as const,
    defaultValue: 'moderate',
    options: [
      { label: 'Off', value: 'off' },
      { label: 'Moderate', value: 'moderate' },
      { label: 'Strict', value: 'strict' },
    ],
  };
}

function apiKeyForm(extraSettingsFields: ProviderFormSchema['sections'][number]['fields'] = []): ProviderFormSchema {
  return {
    sections: [
      {
        title: 'Credentials',
        fields: [
          {
            name: 'apiKey',
            label: 'API Key',
            type: 'password',
            required: true,
            scope: 'credentials',
          },
        ],
      },
      {
        title: 'Search Settings',
        fields: [...extraSettingsFields, safeSearchField()],
      },
    ],
  };
}

export const BingWebSearchProviderContract: ProviderContract<
  WebSearchProviderRuntime,
  WebSearchApiKeyCredentials,
  WebSearchCommonSettings
> = {
  id: 'bing',
  version: '1.0.0',
  domains: ['websearch'],
  display: {
    label: 'Bing Web Search',
    description: 'Microsoft Bing Web Search API v7 (Azure Cognitive Services).',
  },
  form: apiKeyForm([
    {
      name: 'endpoint',
      label: 'Endpoint',
      type: 'text',
      scope: 'settings',
      placeholder: 'https://api.bing.microsoft.com/v7.0/search',
      description: 'Override for Azure regional / custom endpoints. Leave empty for the global endpoint.',
    },
    {
      name: 'country',
      label: 'Market (mkt)',
      type: 'text',
      scope: 'settings',
      placeholder: 'en-US',
    },
  ]),
  createRuntime: EMPTY_WEBSEARCH_RUNTIME,
};

export const BraveWebSearchProviderContract: ProviderContract<
  WebSearchProviderRuntime,
  WebSearchApiKeyCredentials,
  WebSearchCommonSettings
> = {
  id: 'brave-search',
  version: '1.0.0',
  domains: ['websearch'],
  display: {
    label: 'Brave Search',
    description: 'Brave independent web search index (api.search.brave.com).',
  },
  form: apiKeyForm([
    {
      name: 'country',
      label: 'Country',
      type: 'text',
      scope: 'settings',
      placeholder: 'US',
    },
    {
      name: 'language',
      label: 'Search Language',
      type: 'text',
      scope: 'settings',
      placeholder: 'en',
    },
  ]),
  createRuntime: EMPTY_WEBSEARCH_RUNTIME,
};

export const SerperWebSearchProviderContract: ProviderContract<
  WebSearchProviderRuntime,
  WebSearchApiKeyCredentials,
  WebSearchCommonSettings
> = {
  id: 'serper',
  version: '1.0.0',
  domains: ['websearch'],
  display: {
    label: 'Serper',
    description: 'Google SERP results via serper.dev.',
  },
  form: apiKeyForm([
    {
      name: 'country',
      label: 'Country (gl)',
      type: 'text',
      scope: 'settings',
      placeholder: 'us',
    },
    {
      name: 'language',
      label: 'Language (hl)',
      type: 'text',
      scope: 'settings',
      placeholder: 'en',
    },
  ]),
  createRuntime: EMPTY_WEBSEARCH_RUNTIME,
};

export const TavilyWebSearchProviderContract: ProviderContract<
  WebSearchProviderRuntime,
  WebSearchApiKeyCredentials,
  WebSearchCommonSettings & { searchDepth?: 'basic' | 'advanced'; includeAnswer?: boolean }
> = {
  id: 'tavily',
  version: '1.0.0',
  domains: ['websearch'],
  display: {
    label: 'Tavily',
    description: 'Tavily Search API — LLM-optimized web search with optional synthesized answers.',
  },
  form: apiKeyForm([
    {
      name: 'searchDepth',
      label: 'Search Depth',
      type: 'select',
      scope: 'settings',
      defaultValue: 'basic',
      options: [
        { label: 'Basic', value: 'basic' },
        { label: 'Advanced', value: 'advanced' },
      ],
    },
    {
      name: 'includeAnswer',
      label: 'Include synthesized answer',
      type: 'switch',
      scope: 'settings',
      defaultValue: false,
    },
  ]),
  createRuntime: EMPTY_WEBSEARCH_RUNTIME,
};

export const SearxngWebSearchProviderContract: ProviderContract<
  WebSearchProviderRuntime,
  { authUsername?: string; authPassword?: string },
  WebSearchCommonSettings & { baseUrl?: string; engines?: string }
> = {
  id: 'searxng',
  version: '1.0.0',
  domains: ['websearch'],
  display: {
    label: 'SearxNG',
    description: 'Self-hosted open-source metasearch engine (JSON API).',
  },
  form: {
    sections: [
      {
        title: 'Instance',
        fields: [
          {
            name: 'baseUrl',
            label: 'Base URL',
            type: 'text',
            required: true,
            scope: 'settings',
            placeholder: 'https://searx.example.com',
            description: 'Root URL of the SearxNG instance. The JSON format must be enabled in its settings.yml.',
          },
          {
            name: 'engines',
            label: 'Engines',
            type: 'text',
            scope: 'settings',
            placeholder: 'google,bing,duckduckgo',
            description: 'Optional comma-separated engine list forwarded to SearxNG.',
          },
          {
            name: 'language',
            label: 'Language',
            type: 'text',
            scope: 'settings',
            placeholder: 'en',
          },
        ],
      },
      {
        title: 'Credentials',
        description: 'Only needed when the instance sits behind HTTP basic auth.',
        fields: [
          {
            name: 'authUsername',
            label: 'Basic Auth Username',
            type: 'text',
            scope: 'credentials',
          },
          {
            name: 'authPassword',
            label: 'Basic Auth Password',
            type: 'password',
            scope: 'credentials',
          },
        ],
      },
      {
        title: 'Search Settings',
        fields: [safeSearchField()],
      },
    ],
  },
  createRuntime: EMPTY_WEBSEARCH_RUNTIME,
};

export const DuckDuckGoWebSearchProviderContract: ProviderContract<
  WebSearchProviderRuntime,
  Record<string, never>,
  WebSearchCommonSettings
> = {
  id: 'duckduckgo',
  version: '1.0.0',
  domains: ['websearch'],
  display: {
    label: 'DuckDuckGo',
    description: 'Keyless best-effort search over the DuckDuckGo HTML endpoint. No API key required.',
  },
  form: {
    sections: [
      {
        title: 'Search Settings',
        fields: [
          {
            name: 'country',
            label: 'Region (kl)',
            type: 'text',
            scope: 'settings',
            placeholder: 'us-en',
            description: 'DuckDuckGo region code, e.g. us-en, tr-tr, wt-wt (no region).',
          },
          safeSearchField(),
        ],
      },
    ],
  },
  createRuntime: EMPTY_WEBSEARCH_RUNTIME,
};

export const WEBSEARCH_PROVIDER_CONTRACTS = [
  BingWebSearchProviderContract,
  BraveWebSearchProviderContract,
  SerperWebSearchProviderContract,
  TavilyWebSearchProviderContract,
  SearxngWebSearchProviderContract,
  DuckDuckGoWebSearchProviderContract,
] as unknown as ProviderContract<WebSearchProviderRuntime, unknown, unknown>[];
