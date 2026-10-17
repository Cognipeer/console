/**
 * Configure → Inputs: the editor that declares an agent's typed inputs
 * (`config.inputs`) — how an edit lands in the stored list, what the rows show
 * (with the server's own rules marking a bad row), the section's place in
 * Configure and the manifest, and the English and Turkish text.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { I18nProvider } from '@/lib/i18n';
import AgentInputsEditor, {
  compactInputField,
  inputsForSave,
  newInputField,
  retypeInputField,
} from '@/components/agents/studio/AgentInputsEditor';
import { CONFIG_SECTION_KEYS, CONFIG_SECTION_TITLES, changedConfigSections, configSectionTitle } from '@/components/agents/studio/configSections';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';
import type { IAgentInputField } from '@/lib/database/provider/types.domain';

(globalThis as { React?: typeof React }).React = React;

const render = (node: ReactNode, locale: 'en' | 'tr' = 'en') =>
  renderToStaticMarkup(h(MantineProvider, null, h(I18nProvider, { locale, children: node })));
const noop = () => undefined;

const FIELDS: IAgentInputField[] = [
  { name: 'customer_id', label: 'Customer', type: 'string', required: true, description: 'Who to look up' },
  { name: 'priority', type: 'string', enum: ['low', 'high'], default: 'low' },
  { name: 'attempts', type: 'integer', default: 3 },
];

describe('how an edit lands in the stored inputs', () => {
  it('stores nothing for an agent with no rows', () => {
    expect(inputsForSave([])).toBeUndefined();
  });

  it('drops what a row left empty and keeps the rest', () => {
    expect(compactInputField({ name: 'a', type: 'string', label: '', description: '', enum: [], required: false, default: '' }))
      .toEqual({ name: 'a', type: 'string' });
    expect(compactInputField(FIELDS[1]!)).toEqual(FIELDS[1]);
    // `false` is a real default; `required: false` is not worth storing.
    expect(compactInputField({ name: 'b', type: 'boolean', default: false, required: false })).toEqual({ name: 'b', type: 'boolean', default: false });
  });

  it('a new row takes the first free name', () => {
    expect(newInputField([])).toEqual({ name: 'input_1', type: 'string' });
    expect(newInputField([{ name: 'input_2', type: 'string' }])).toEqual({ name: 'input_3', type: 'string' });
    expect(newInputField([{ name: 'input_2', type: 'string' }, { name: 'input_3', type: 'string' }]).name).toBe('input_4');
  });

  it('changing the type drops the default and the allowed values that no longer fit', () => {
    expect(retypeInputField(FIELDS[1]!, 'number')).toEqual({ name: 'priority', type: 'number' });
    expect(retypeInputField(FIELDS[1]!, 'boolean')).toEqual({ name: 'priority', type: 'boolean' });
    expect(retypeInputField({ name: 'x', type: 'string', description: 'd', required: true }, 'json'))
      .toEqual({ name: 'x', type: 'json', description: 'd', required: true });
  });
});

describe('the editor', () => {
  const html = (value: IAgentInputField[] | undefined, locale: 'en' | 'tr' = 'en') =>
    render(h(AgentInputsEditor, { value, onChange: noop }), locale);

  it('says there are no inputs, and offers to add one', () => {
    const out = html(undefined);
    expect(out).toContain(en.agents.inputs.empty);
    expect(out).toContain(en.agents.inputs.add);
    expect(out).not.toContain('data-testid="agent-input-row"');
  });

  it('shows a row per input with its values', () => {
    const out = html(FIELDS);
    expect(out.match(/data-testid="agent-input-row"/g)).toHaveLength(3);
    for (const needle of ['customer_id', 'Customer', 'Who to look up', 'priority', 'attempts']) expect(out).toContain(needle);
    expect(out).toContain('{{input.customer_id}}');
    expect(out).not.toContain(en.agents.inputs.empty);
  });

  it('marks a row the server would refuse', () => {
    const out = html([{ name: 'bad name', type: 'string' }, { name: 'n', type: 'integer', default: 'x' as unknown as number }]);
    expect(out).toContain('Name must start with a letter');
    expect(out).toContain('The default must match the type (Integer)');
  });

  it('words a row the server would refuse in the language of the page, not in the server’s English', () => {
    const out = html([{ name: 'bad name', type: 'string' }, { name: 'n', type: 'integer', default: 'x' as unknown as number }, { name: 'n', type: 'string', enum: [] }], 'tr');
    expect(out).toContain(tr.agents.inputs.issue_name_invalid.replace(/"/g, '&quot;'));
    expect(out).toContain('Varsayılan değer türle uyumlu olmalı (Tam sayı)');
    expect(out).toContain('&quot;n&quot; girdisi iki kez tanımlanmış');
    expect(out).toContain(tr.agents.inputs.issue_enum_invalid_strings);
    expect(out).not.toContain('Name must start with a letter');
    expect(out).not.toContain('is declared twice');
  });

  it('is in Turkish when the language is', () => {
    const out = html(FIELDS, 'tr');
    expect(out).toContain(tr.agents.inputs.add);
    expect(out).toContain(tr.agents.inputs.required);
    expect(out).not.toContain(en.agents.inputs.add);
  });
});

describe('the Inputs section in Configure', () => {
  it('owns config.inputs, sits before Structured output, and has a translated heading', () => {
    expect(CONFIG_SECTION_KEYS.inputs).toEqual(['inputs']);
    const keys = Object.keys(CONFIG_SECTION_KEYS);
    expect(keys.indexOf('inputs')).toBe(keys.indexOf('output') - 1);
    expect(CONFIG_SECTION_TITLES.inputs).toBe('Inputs');
    expect(configSectionTitle('inputs', (key) => `t:${key}`)).toBe('t:inputs.sectionTitle');
  });

  it('flags the section when the draft\'s inputs differ from the published ones', () => {
    const published = { modelKey: 'm', inputs: [{ name: 'a', type: 'string' }] };
    expect([...changedConfigSections({ ...published, inputs: [{ name: 'a', type: 'string' }, { name: 'b', type: 'number' }] }, published)]).toEqual(['inputs']);
    expect(changedConfigSections(published, published).size).toBe(0);
  });
});

describe('the text', () => {
  const keysOf = (messages: Record<string, unknown>) => Object.keys(messages).sort();
  it('English and Turkish carry the same keys, and every key has text', () => {
    expect(keysOf(tr.agents.inputs)).toEqual(keysOf(en.agents.inputs));
    for (const value of Object.values(en.agents.inputs)) expect(String(value).length).toBeGreaterThan(0);
    for (const value of Object.values(tr.agents.inputs)) expect(String(value).length).toBeGreaterThan(0);
  });

  it('every type has a label', () => {
    for (const key of ['typeString', 'typeNumber', 'typeInteger', 'typeBoolean', 'typeJson']) {
      expect(en.agents.inputs).toHaveProperty(key);
      expect(tr.agents.inputs).toHaveProperty(key);
    }
  });
});
