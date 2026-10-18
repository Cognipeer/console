/**
 * Configure → Variables: the editor that declares an agent's typed variables
 * (`config.variables`) — how an edit lands in the stored list, what the rows show
 * (with the server's own rules marking a bad row), what the editor tells a person
 * about where variables fit and where they do not (chat), the section's place in
 * Configure and the manifest, and the English and Turkish text.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { I18nProvider } from '@/lib/i18n';
import AgentVariablesEditor, {
  compactVariable,
  isRequiredWithoutDefault,
  newVariable,
  retypeVariable,
  variablesForSave,
} from '@/components/agents/studio/AgentVariablesEditor';
import { CONFIG_SECTION_KEYS, CONFIG_SECTION_TITLES, changedConfigSections, configSectionTitle } from '@/components/agents/studio/configSections';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';
import type { IAgentVariable } from '@/lib/database/provider/types.domain';

(globalThis as { React?: typeof React }).React = React;

const render = (node: ReactNode, locale: 'en' | 'tr' = 'en') =>
  renderToStaticMarkup(h(MantineProvider, null, h(I18nProvider, { locale, children: node })));
const noop = () => undefined;
/** What React writes into markup for a piece of text, so copy can be looked up in the output as written. */
const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

const FIELDS: IAgentVariable[] = [
  { name: 'customer_id', label: 'Customer', type: 'string', required: true, description: 'Who to look up' },
  { name: 'priority', type: 'string', enum: ['low', 'high'], default: 'low' },
  { name: 'attempts', type: 'integer', default: 3 },
];

describe('how an edit lands in the stored variables', () => {
  it('stores nothing for an agent with no rows', () => {
    expect(variablesForSave([])).toBeUndefined();
  });

  it('drops what a row left empty and keeps the rest', () => {
    expect(compactVariable({ name: 'a', type: 'string', label: '', description: '', enum: [], required: false, default: '' }))
      .toEqual({ name: 'a', type: 'string' });
    expect(compactVariable(FIELDS[1]!)).toEqual(FIELDS[1]);
    // `false` is a real default; `required: false` is not worth storing.
    expect(compactVariable({ name: 'b', type: 'boolean', default: false, required: false })).toEqual({ name: 'b', type: 'boolean', default: false });
  });

  it('a new row takes the first free name', () => {
    expect(newVariable([])).toEqual({ name: 'variable_1', type: 'string' });
    expect(newVariable([{ name: 'variable_2', type: 'string' }])).toEqual({ name: 'variable_3', type: 'string' });
    expect(newVariable([{ name: 'variable_2', type: 'string' }, { name: 'variable_3', type: 'string' }]).name).toBe('variable_4');
  });

  it('changing the type drops the default and the allowed values that no longer fit', () => {
    expect(retypeVariable(FIELDS[1]!, 'number')).toEqual({ name: 'priority', type: 'number' });
    expect(retypeVariable(FIELDS[1]!, 'boolean')).toEqual({ name: 'priority', type: 'boolean' });
    expect(retypeVariable({ name: 'x', type: 'string', description: 'd', required: true }, 'json'))
      .toEqual({ name: 'x', type: 'json', description: 'd', required: true });
  });
});

describe('a required variable without a default (the one chat cannot fill)', () => {
  it('is exactly a required variable that has no default, as the server counts defaults', () => {
    expect(isRequiredWithoutDefault({ name: 'a', type: 'string', required: true })).toBe(true);
    // The server reads a null default as none, like an absent one.
    expect(isRequiredWithoutDefault({ name: 'a', type: 'string', required: true, default: null as unknown as string })).toBe(true);
    expect(isRequiredWithoutDefault({ name: 'a', type: 'string', required: true, default: 'x' })).toBe(false);
    // `false` and `0` are real defaults: a request that leaves them out still passes.
    expect(isRequiredWithoutDefault({ name: 'a', type: 'boolean', required: true, default: false })).toBe(false);
    expect(isRequiredWithoutDefault({ name: 'a', type: 'integer', required: true, default: 0 })).toBe(false);
    expect(isRequiredWithoutDefault({ name: 'a', type: 'string' })).toBe(false);
    expect(isRequiredWithoutDefault({ name: 'a', type: 'string', required: false })).toBe(false);
  });
});

describe('the editor', () => {
  const html = (value: IAgentVariable[] | undefined, locale: 'en' | 'tr' = 'en') =>
    render(h(AgentVariablesEditor, { value, onChange: noop }), locale);

  it('says there are no variables, and offers to add one', () => {
    const out = html(undefined);
    expect(out).toContain(en.agents.variables.empty);
    expect(out).toContain(en.agents.variables.add);
    expect(out).not.toContain('data-testid="agent-variable-row"');
  });

  it('shows a row per variable with its values', () => {
    const out = html(FIELDS);
    expect(out.match(/data-testid="agent-variable-row"/g)).toHaveLength(3);
    for (const needle of ['customer_id', 'Customer', 'Who to look up', 'priority', 'attempts']) expect(out).toContain(needle);
    expect(out).toContain('{{variables.customer_id}}');
    expect(out).not.toContain(en.agents.variables.empty);
  });

  it('marks a row the server would refuse', () => {
    const out = html([{ name: 'bad name', type: 'string' }, { name: 'n', type: 'integer', default: 'x' as unknown as number }]);
    expect(out).toContain('Name must start with a letter');
    expect(out).toContain('The default must match the type (Integer)');
  });

  it('words a row the server would refuse in the language of the page, not in the server’s English', () => {
    const out = html([{ name: 'bad name', type: 'string' }, { name: 'n', type: 'integer', default: 'x' as unknown as number }, { name: 'n', type: 'string', enum: [] }], 'tr');
    expect(out).toContain(tr.agents.variables.issue_name_invalid.replace(/"/g, '&quot;'));
    expect(out).toContain('Varsayılan değer türle uyumlu olmalı (Tam sayı)');
    expect(out).toContain('&quot;n&quot; değişkeni iki kez tanımlanmış');
    expect(out).toContain(tr.agents.variables.issue_enum_invalid_strings);
    expect(out).not.toContain('Name must start with a letter');
    expect(out).not.toContain('is declared twice');
  });

  it('is in Turkish when the language is', () => {
    const out = html(FIELDS, 'tr');
    expect(out).toContain(tr.agents.variables.add);
    expect(out).toContain(tr.agents.variables.required);
    expect(out).not.toContain(en.agents.variables.add);
  });
});

describe('what the editor says about where variables fit', () => {
  const html = (value: IAgentVariable[] | undefined, locale: 'en' | 'tr' = 'en') =>
    render(h(AgentVariablesEditor, { value, onChange: noop }), locale);
  const HINT = 'data-testid="agent-variable-chat-hint"';

  it('opens with what they are, when to use them, and that chat does not send them, even with no rows', () => {
    for (const value of [undefined, FIELDS]) {
      const out = html(value);
      expect(out).toContain('data-testid="agent-variables-intro"');
      expect(out).toContain(escaped(en.agents.variables.intro));
      expect(out).toContain(escaped(en.agents.variables.introWhen));
      expect(out).toContain(escaped(en.agents.variables.introChat));
    }
  });

  it('the intro keeps to what the platform does: checked before the model runs, a 400 that spends nothing, the schema it publishes', () => {
    const { intro, introWhen, introChat } = en.agents.variables;
    expect(intro).toMatch(/400/);
    expect(intro).toMatch(/nothing is spent/);
    expect(intro).toContain('{{variables.name}}');
    expect(intro).toContain('variables_schema');
    expect(introWhen).toMatch(/runs API/);
    expect(introWhen).toMatch(/trigger/);
    expect(introChat).toMatch(/chat/i);
    expect(introChat).toMatch(/400/);
    expect(introChat).toMatch(/default/);
  });

  it('is in Turkish when the language is', () => {
    const out = html(FIELDS, 'tr');
    expect(out).toContain(escaped(tr.agents.variables.intro));
    expect(out).toContain(escaped(tr.agents.variables.introChat));
    expect(out).not.toContain(escaped(en.agents.variables.intro));
  });

  it('warns next to Required when a required variable has no default, and only then', () => {
    const warned = html([{ name: 'customer_id', type: 'string', required: true }]);
    expect(warned.match(new RegExp(HINT, 'g'))).toHaveLength(1);
    expect(warned).toContain(escaped(en.agents.variables.requiredNoDefaultHint));

    for (const quiet of [
      [{ name: 'a', type: 'string', required: true, default: 'x' }],
      [{ name: 'a', type: 'boolean', required: true, default: false }],
      [{ name: 'a', type: 'string' }],
      FIELDS.filter((field) => field.name !== 'customer_id'),
    ] as IAgentVariable[][]) {
      expect(html(quiet)).not.toContain(HINT);
    }
  });

  it('puts the warning on each row that needs it', () => {
    const out = html([
      { name: 'a', type: 'string', required: true },
      { name: 'b', type: 'integer', required: true, default: 1 },
      { name: 'c', type: 'json', required: true },
    ]);
    expect(out.match(new RegExp(HINT, 'g'))).toHaveLength(2);
  });

  it('words the warning in Turkish too', () => {
    const out = html([{ name: 'musteri_id', type: 'string', required: true }], 'tr');
    expect(out).toContain(escaped(tr.agents.variables.requiredNoDefaultHint));
    expect(out).not.toContain(escaped(en.agents.variables.requiredNoDefaultHint));
  });
});

describe('the Variables section in Configure', () => {
  it('owns config.variables, sits before Structured output, and has a translated heading', () => {
    expect(CONFIG_SECTION_KEYS.variables).toEqual(['variables']);
    const keys = Object.keys(CONFIG_SECTION_KEYS);
    expect(keys.indexOf('variables')).toBe(keys.indexOf('output') - 1);
    expect(CONFIG_SECTION_TITLES.variables).toBe('Variables');
    expect(configSectionTitle('variables', (key) => `t:${key}`)).toBe('t:variables.sectionTitle');
  });

  it('flags the section when the draft\'s variables differ from the published ones', () => {
    const published = { modelKey: 'm', variables: [{ name: 'a', type: 'string' }] };
    expect([...changedConfigSections({ ...published, variables: [{ name: 'a', type: 'string' }, { name: 'b', type: 'number' }] }, published)]).toEqual(['variables']);
    expect(changedConfigSections(published, published).size).toBe(0);
  });
});

describe('the text', () => {
  const keysOf = (messages: Record<string, unknown>) => Object.keys(messages).sort();
  it('English and Turkish carry the same keys, and every key has text', () => {
    expect(keysOf(tr.agents.variables)).toEqual(keysOf(en.agents.variables));
    for (const value of Object.values(en.agents.variables)) expect(String(value).length).toBeGreaterThan(0);
    for (const value of Object.values(tr.agents.variables)) expect(String(value).length).toBeGreaterThan(0);
  });

  it('every type has a label', () => {
    for (const key of ['typeString', 'typeNumber', 'typeInteger', 'typeBoolean', 'typeJson']) {
      expect(en.agents.variables).toHaveProperty(key);
      expect(tr.agents.variables).toHaveProperty(key);
    }
  });

  it('the explanation keys exist in both languages', () => {
    for (const key of ['intro', 'introWhen', 'introChat', 'requiredNoDefaultHint']) {
      expect(en.agents.variables).toHaveProperty(key);
      expect(tr.agents.variables).toHaveProperty(key);
    }
  });
});
