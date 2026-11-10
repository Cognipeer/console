/**
 * Web search settings split: connection fields stay on the provider record, behavior fields go to an instance.
 */
import { describe, expect, it } from 'vitest';

import {
  WEBSEARCH_PROVIDER_CONTRACTS,
  splitWebSearchSettings,
  webSearchConnectionKeys,
} from '@/lib/providers/contracts/webSearchContracts';

describe('web search settings split', () => {
  it('marks every settings field as connection or behavior', () => {
    for (const contract of WEBSEARCH_PROVIDER_CONTRACTS) {
      const settingsFields = contract.form.sections.flatMap((s) => s.fields).filter((f) => f.scope === 'settings');
      expect(settingsFields.length).toBeGreaterThan(0);
      for (const field of settingsFields) {
        expect(['connection', 'behavior'], `${contract.id}.${field.name}`).toContain(field.settingsTarget);
      }
    }
  });

  it('keeps only the endpoint (bing) and the base URL (searxng) on the connection', () => {
    expect(webSearchConnectionKeys('bing')).toEqual(['endpoint']);
    expect(webSearchConnectionKeys('searxng')).toEqual(['baseUrl']);
    for (const driver of ['brave-search', 'serper', 'tavily', 'duckduckgo', 'unknown']) {
      expect(webSearchConnectionKeys(driver)).toEqual([]);
    }
  });

  it('splits a settings object by driver; unknown keys are behavior', () => {
    expect(splitWebSearchSettings('searxng', {
      baseUrl: 'https://s.example', engines: 'a', language: 'en', aiAnswer: { enabled: true }, custom: 1,
    })).toEqual({
      connection: { baseUrl: 'https://s.example' },
      behavior: { engines: 'a', language: 'en', aiAnswer: { enabled: true }, custom: 1 },
    });
    expect(splitWebSearchSettings('tavily', { baseUrl: 'x', searchDepth: 'basic' }))
      .toEqual({ connection: {}, behavior: { baseUrl: 'x', searchDepth: 'basic' } });
    expect(splitWebSearchSettings('bing', undefined)).toEqual({ connection: {}, behavior: {} });
  });
});
