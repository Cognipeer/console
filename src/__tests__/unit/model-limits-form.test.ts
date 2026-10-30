/**
 * Unit tests — the limits of a model form
 *
 *  - "Default max tokens" shows what a blank value amounts to (the model maximum on Anthropic, the provider's own
 *    default elsewhere), and says that reasoning tokens count against it;
 *  - limits that do not fit together are noted next to the fields (never blocking);
 *  - a cleared "Default max tokens" on the edit form is sent as `null`, which removes the key, and a stringified
 *    model maximum is healed like the other numeric settings.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import LimitsSection from '@/components/models/modelFormSections/LimitsSection';
import { blankMaxTokensDefault, limitWarnings, numberSettingOrNull } from '@/components/models/requestParams';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';
import { normalizeModelSettings } from '@/lib/services/models/modelSettings';
import { computeOutputTokenLimit } from '@/lib/services/models/outputLimits';

(globalThis as { React?: typeof React }).React = React;

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('blankMaxTokensDefault (the placeholder of "Default max tokens")', () => {
  const anthropic = (modelId: string | undefined, maxOutputTokens: unknown = '') =>
    blankMaxTokensDefault({ driver: 'anthropic', modelId, maxOutputTokens });

  it('is the declared "Maximum output tokens" on Anthropic, ahead of the built-in table', () => {
    expect(anthropic('claude-haiku-5-5', 32000)).toBe(32000);
    expect(anthropic('claude-3-7-sonnet-20250219', 12000)).toBe(12000);
  });

  it('is the built-in model maximum on Anthropic while none is declared', () => {
    expect(anthropic('claude-haiku-5-5')).toBe(128000);
    expect(anthropic('claude-haiku-4-5')).toBe(64000);
    expect(anthropic('us.anthropic.claude-sonnet-5-5-v1:0')).toBe(128000);
  });

  it('is 8192 on Anthropic for a model nothing knows the maximum of', () => {
    expect(anthropic('claude-3-7-sonnet-20250219')).toBe(8192);
    expect(anthropic('my-claude-deployment')).toBe(8192);
    expect(anthropic('')).toBe(8192);
    expect(anthropic(undefined)).toBe(8192);
  });

  it('reads a blank, zero, negative or non-numeric "Maximum output tokens" as not declared', () => {
    for (const blank of ['', undefined, null, 0, -5, Number.NaN, 'abc']) {
      expect(anthropic('claude-haiku-4-5', blank), String(blank)).toBe(64000);
    }
  });

  it('is nothing for every other driver: the provider\'s own default applies', () => {
    for (const driver of ['openai', 'azure', 'openai-compatible', 'together', 'bedrock', 'vertex', undefined]) {
      expect(blankMaxTokensDefault({ driver, modelId: 'claude-haiku-5-5', maxOutputTokens: '' }), String(driver)).toBeUndefined();
      // A declared maximum is the model's, not a default somebody sends.
      expect(blankMaxTokensDefault({ driver, modelId: 'gpt-5', maxOutputTokens: 16000 }), String(driver)).toBeUndefined();
    }
  });

  it('agrees with what the gateway sends for the same model (one resolver, streaming call)', () => {
    for (const [modelId, declared] of [['claude-haiku-5-5', undefined], ['claude-haiku-4-5', 20000], ['claude-3-7-sonnet-20250219', undefined]] as const) {
      expect(anthropic(modelId, declared ?? ''), modelId).toBe(
        computeOutputTokenLimit({ driver: 'anthropic', modelId, modelMax: declared, stream: true }),
      );
    }
  });
});

describe('limitWarnings (limits that do not fit together)', () => {
  it('is silent while the limits fit', () => {
    expect(limitWarnings({ contextWindow: 200000, maxOutputTokens: 64000, maxTokens: 8000 })).toEqual([]);
    // At the maximum is not above it.
    expect(limitWarnings({ contextWindow: 8192, maxOutputTokens: 8192, maxTokens: 8192 })).toEqual([]);
  });

  it('notes a default above the maximum output', () => {
    expect(limitWarnings({ contextWindow: 200000, maxOutputTokens: 4096, maxTokens: 8192 })).toEqual(['defaultAboveMaxOutput']);
  });

  it('notes a maximum output above the context window', () => {
    expect(limitWarnings({ contextWindow: 8192, maxOutputTokens: 16384, maxTokens: '' })).toEqual(['maxOutputAboveContext']);
  });

  it('notes both, the default first', () => {
    expect(limitWarnings({ contextWindow: 4096, maxOutputTokens: 8192, maxTokens: 16384 }))
      .toEqual(['defaultAboveMaxOutput', 'maxOutputAboveContext']);
  });

  it('compares only what somebody entered: a blank field has nothing to be above or below', () => {
    expect(limitWarnings({ contextWindow: '', maxOutputTokens: 4096, maxTokens: 8192 })).toEqual(['defaultAboveMaxOutput']);
    expect(limitWarnings({ contextWindow: 1000, maxOutputTokens: '', maxTokens: 5000 })).toEqual([]);
    expect(limitWarnings({ contextWindow: 1000, maxOutputTokens: 4096, maxTokens: '' })).toEqual(['maxOutputAboveContext']);
    expect(limitWarnings({ contextWindow: '', maxOutputTokens: '', maxTokens: '' })).toEqual([]);
    for (const blank of [undefined, null, 0, Number.NaN, 'abc']) {
      expect(limitWarnings({ contextWindow: blank, maxOutputTokens: blank, maxTokens: blank }), String(blank)).toEqual([]);
    }
  });
});

describe('numberSettingOrNull (a number field of the edit form as the update API takes it)', () => {
  it('is null while the field is blank, which the settings merge reads as "remove the key"', () => {
    for (const blank of ['', '   ', undefined, null, Number.NaN]) {
      expect(numberSettingOrNull(blank), String(blank)).toBeNull();
    }
  });

  it('passes a value through as it is', () => {
    expect(numberSettingOrNull(4096)).toBe(4096);
    expect(numberSettingOrNull(0)).toBe(0);
    // A numeric string is healed by `normalizeModelSettings` on the server.
    expect(numberSettingOrNull('4096')).toBe('4096');
  });
});

describe('the model maximum in a settings blob', () => {
  it('is healed from a string in every spelling the output-limit resolver reads', () => {
    expect(normalizeModelSettings({
      maxOutputTokens: '32000',
      max_output_tokens: ' 16000 ',
      maxOutput: '8192',
      maxTokens: '4096',
      maxCompletionTokens: '2048',
    })).toEqual({
      maxOutputTokens: 32000,
      max_output_tokens: 16000,
      maxOutput: 8192,
      maxTokens: 4096,
      maxCompletionTokens: 2048,
    });
  });

  it('leaves a blank or non-numeric one alone, and numbers as they are', () => {
    expect(normalizeModelSettings({ maxOutputTokens: '', max_output_tokens: '   ', maxOutput: 'abc' }))
      .toEqual({ maxOutputTokens: '', max_output_tokens: '   ', maxOutput: 'abc' });
    expect(normalizeModelSettings({ maxOutputTokens: 32000, maxOutput: 8192 })).toEqual({ maxOutputTokens: 32000, maxOutput: 8192 });
  });
});

describe('LimitsSection', () => {
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(h(MantineProvider, null, h(LimitsSection, {
      number: 3,
      maxTokens: { label: 'Default max tokens', props: { value: '', onChange: () => undefined } },
      ...props,
    } as never)));

  it('shows the placeholder the form computed in "Default max tokens"', () => {
    const html = render({ maxTokens: { label: 'Default max tokens', placeholder: '128,000', props: { value: '', onChange: () => undefined } } });
    expect(html).toContain('placeholder="128,000"');
  });

  it('keeps the generic placeholder when the form passes none', () => {
    expect(render({})).toContain('placeholder="Optional"');
  });

  it('lists each warning as its own note, and nothing without warnings', () => {
    const html = render({ warnings: ['First note.', 'Second note.'] });
    expect(html.match(/data-testid="limits-warning"/g)).toHaveLength(2);
    expect(html).toContain('First note.');
    expect(html).toContain('Second note.');
    expect(render({})).not.toContain('limits-warning');
    expect(render({ warnings: [] })).not.toContain('limits-warning');
  });
});

describe('the strings', () => {
  it('both languages carry the placeholder fallback and the two limit warnings', () => {
    for (const [name, messages] of [['en', en], ['tr', tr]] as const) {
      expect(messages.modelWizard.fields.runtimeMaxTokens.providerDefault, name).toBeTruthy();
      expect(messages.modelWizard.limitWarnings.defaultAboveMaxOutput, name).toBeTruthy();
      expect(messages.modelWizard.limitWarnings.maxOutputAboveContext, name).toBeTruthy();
    }
    expect(tr.modelWizard.fields.runtimeMaxTokens.providerDefault).not.toBe(en.modelWizard.fields.runtimeMaxTokens.providerDefault);
    expect(tr.modelWizard.limitWarnings.defaultAboveMaxOutput).not.toBe(en.modelWizard.limitWarnings.defaultAboveMaxOutput);
    expect(tr.modelWizard.limitWarnings.maxOutputAboveContext).not.toBe(en.modelWizard.limitWarnings.maxOutputAboveContext);
  });

  it('the warnings name the fields they compare, as the labels do', () => {
    const { fields, limitWarnings: notes } = en.modelWizard;
    expect(notes.defaultAboveMaxOutput).toContain(fields.runtimeMaxTokens.label);
    expect(notes.defaultAboveMaxOutput).toContain(fields.maxOutputTokens.label);
    expect(notes.maxOutputAboveContext).toContain(fields.maxOutputTokens.label);
  });

  it('the "Default max tokens" hint says that reasoning tokens count against it, and still names the maximum', () => {
    expect(en.modelWizard.fields.runtimeMaxTokens.description).toMatch(/Reasoning \(thinking\) tokens count against this limit/);
    expect(en.modelWizard.fields.runtimeMaxTokens.description).toMatch(/Maximum output tokens/);
    expect(tr.modelWizard.fields.runtimeMaxTokens.description).toMatch(/Akıl yürütme/);
    expect(tr.modelWizard.fields.runtimeMaxTokens.description).toMatch(/Maksimum çıktı token/);
  });

  it('keeps the blocking message of the forms as it was', () => {
    expect(en.modelWizard.validation.maxOutputTokens).toBe('Maximum output tokens cannot exceed the context window.');
  });
});

describe('the model forms', () => {
  const create = read('src/components/models/CreateModelModal.tsx');
  const edit = read('src/components/models/EditModelModal.tsx');
  const requestParams = read('src/components/models/modelFormSections/RequestParamsSection.tsx');

  it('both show what a blank default amounts to, note limits that do not fit and hand the driver to the parameter list', () => {
    for (const [name, source] of [['create', create], ['edit', edit]]) {
      expect(source, name).toContain('blankMaxTokensPlaceholder({');
      expect(source, name).toContain('limitWarnings({');
      expect(source, name).toContain("tWizard('fields.runtimeMaxTokens.providerDefault')");
      expect(source, name).toContain('warnings={limitNotes}');
      expect(source, name).toContain('driver={selectedProvider?.driver}');
    }
  });

  it('the edit form sends a cleared "Default max tokens" as null, so the key is removed', () => {
    expect(edit).toContain('maxTokens: numberSettingOrNull(values.settings.maxTokens)');
  });

  it('the update APIs read null as "remove the key" (what the edit form relies on)', () => {
    for (const file of ['src/server/api/plugins/models.ts', 'src/server/api/plugins/client-models.ts']) {
      expect(read(file), file).toMatch(/if \(value === null\) \{\s*delete merged\[key\];/);
    }
  });

  it('the request-parameter section lists the options of the model\'s driver', () => {
    expect(requestParams).toContain('unsupportedParamOptions(driver');
    expect(requestParams).not.toContain('data={UNSUPPORTED_PARAM_OPTIONS}');
  });

  it('neither form announces the forced "none" the old, prop-driven way (the Reasoning section decides itself)', () => {
    for (const [name, source] of [['create', create], ['edit', edit]]) {
      expect(source, name).not.toContain('forcedNoneWithTools');
      expect(source, name).not.toContain('detectForcedParams');
    }
  });
});
