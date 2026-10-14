/**
 * Configure → Client tools: list edits, schema parsing, inline errors and the
 * section registration.
 */

import { describe, expect, it } from 'vitest';
import {
  addTool,
  clientToolErrors,
  normalizeClientTools,
  parseSchemaText,
  removeTool,
  updateTool,
} from '@/components/agents/studio/clientToolsSettings';
import { CONFIG_SECTION_KEYS, CONFIG_SECTION_TITLES, configSectionTitle } from '@/components/agents/studio/configSections';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

describe('list edits', () => {
  it('adds, updates and removes without mutating', () => {
    const empty = addTool(undefined);
    expect(empty).toEqual([{ name: '', description: '' }]);
    const named = updateTool(empty, 0, { name: 'pick', description: 'd', timeoutSeconds: 30 });
    expect(named[0]).toMatchObject({ name: 'pick', timeoutSeconds: 30 });
    expect(empty[0].name).toBe('');
    const cleared = updateTool(named, 0, { timeoutSeconds: undefined });
    expect('timeoutSeconds' in cleared[0]).toBe(false);
    expect(removeTool(cleared, 0)).toEqual([]);
  });

  it('caps the list at 20', () => {
    let list = addTool(undefined);
    for (let i = 0; i < 30; i += 1) list = addTool(list);
    expect(list).toHaveLength(20);
  });

  it('normalizes an empty list to undefined', () => {
    expect(normalizeClientTools([])).toBeUndefined();
    expect(normalizeClientTools(undefined)).toBeUndefined();
    expect(normalizeClientTools([{ name: 'a', description: 'b' }])).toHaveLength(1);
  });
});


describe('parseSchemaText', () => {
  it('treats empty text as no schema', () => {
    expect(parseSchemaText('  ')).toEqual({ ok: true, schema: undefined });
  });
  it('accepts an object schema', () => {
    expect(parseSchemaText('{"type":"object","properties":{}}')).toEqual({ ok: true, schema: { type: 'object', properties: {} } });
  });
  it('rejects bad JSON, non-objects and non-object types', () => {
    expect(parseSchemaText('{').ok).toBe(false);
    expect(parseSchemaText('[]').ok).toBe(false);
    expect(parseSchemaText('{"type":"string"}').ok).toBe(false);
  });
  it('rejects a schema over 16 KB', () => {
    expect(parseSchemaText(JSON.stringify({ type: 'object', description: 'x'.repeat(17 * 1024) })).ok).toBe(false);
  });
});

describe('clientToolErrors', () => {
  it('flags name, duplicate, description and timeout problems by index', () => {
    const errors = clientToolErrors([
      { name: 'ok', description: 'fine' },
      { name: 'ok', description: '' },
      { name: '1bad', description: 'x', timeoutSeconds: 601 },
    ]);
    expect(errors[0]).toBeUndefined();
    expect(errors[1]).toEqual(['nameDuplicate', 'description']);
    expect(errors[2]).toEqual(['name', 'timeout']);
  });
});

describe('section registration', () => {
  it('has a title, config key and translated heading', () => {
    expect(CONFIG_SECTION_TITLES.clienttools).toBe('Client tools');
    expect(CONFIG_SECTION_KEYS.clienttools).toEqual(['clientTools']);
    const translate = (messages: typeof en) => (key: string) =>
      key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], (messages as unknown as { agents: unknown }).agents) as string;
    expect(configSectionTitle('clienttools', translate(en))).toBe('Client tools');
    expect(configSectionTitle('clienttools', translate(tr))).toBe('İstemci araçları');
  });
});

import { hitlToolRows } from '@/components/agents/studio/hitlSettings';

describe('client tools in the Approvals & questions table', () => {
  it('lists each client tool as a row with its stored choice and the effective policy', () => {
    const rows = hitlToolRows(undefined, { toolApproval: { enabled: true, defaultPolicy: 'always', tools: { lookup_order: 'never' } } }, [{ name: 'lookup_order' }, { name: 'open_ticket' }]);
    expect(rows.find((r) => r.name === 'lookup_order')).toMatchObject({ origin: 'client', choice: 'never', effective: 'never', readOnly: false });
    expect(rows.find((r) => r.name === 'open_ticket')).toMatchObject({ origin: 'client', choice: 'default', effective: 'always' });
  });
});
