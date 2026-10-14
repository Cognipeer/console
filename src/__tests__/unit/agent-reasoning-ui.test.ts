/**
 * Studio: the reasoning dropdown beside each model (Build tab) and the
 * trimmed Advanced tab. Option logic is tested directly; the placement is
 * pinned against the source, like the other Studio structure tests.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reasoningPickerOptions } from '@/components/agents/studio/AgentReasoningPicker';
import { CONFIG_SECTION_KEYS, changedConfigSections } from '@/components/agents/studio/configSections';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const drivers = { openaiProv: 'openai', claude: 'anthropic', gem: 'vertex', local: 'openai-compatible', odd: 'mystery' };
const m = (providerKey: string, settings?: Record<string, unknown>, modelId?: string) => ({ key: 'k', name: 'K', providerKey, settings, modelId });
const LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

describe('options follow the chosen model', () => {
  it('OpenAI-family: exactly the efforts of the model rule, no budget field', () => {
    const efforts = (modelId: string, provider = 'openaiProv') => reasoningPickerOptions(m(provider, undefined, modelId), drivers)?.efforts;
    expect(reasoningPickerOptions(m('openaiProv', undefined, 'gpt-6-luna'), drivers)).toMatchObject({ kind: 'effort', budget: false });
    expect(efforts('gpt-6-luna')).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
    expect(efforts('gpt-5.6-luna')).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
    expect(efforts('gpt-5')).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(efforts('o3')).toEqual(['low', 'medium', 'high']);
  });

  it('a model no rule names (an Azure deployment) offers the whole ladder: the SDK maps at request time', () => {
    expect(reasoningPickerOptions(m('openaiProv', undefined, 'my-prod-deployment'), { ...drivers, openaiProv: 'azure' })).toMatchObject({
      kind: 'effort', efforts: LADDER, budget: false,
    });
    expect(reasoningPickerOptions(m('openaiProv'), drivers)?.efforts).toEqual(LADDER);
  });

  it('Anthropic / Vertex: levels plus a token budget where the model thinks in tokens, adaptive levels otherwise', () => {
    const claude = (modelId: string) => reasoningPickerOptions(m('claude', undefined, modelId), drivers);
    expect(claude('claude-sonnet-5-5')).toMatchObject({ kind: 'budget', budget: false, efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] });
    // opus 5.5 cannot be turned off
    expect(claude('claude-opus-5-5')?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(claude('claude-haiku-5-5')?.efforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(claude('claude-sonnet-4-5')).toMatchObject({ kind: 'budget', budget: true, efforts: LADDER });
    expect(reasoningPickerOptions(m('gem', undefined, 'gemini-2.5-pro'), drivers)).toMatchObject({ kind: 'budget', budget: true });
  });

  it('OpenAI-compatible engines: on / off for the models whose rule is a toggle', () => {
    expect(reasoningPickerOptions(m('local', undefined, 'qwen3-32b'), drivers)).toMatchObject({ kind: 'toggle', efforts: ['none', 'medium'] });
    expect(reasoningPickerOptions(m('local', undefined, 'gpt-6-luna'), drivers)).toMatchObject({ kind: 'effort' });
  });

  it('a Dynamic LLM offers every level (the routed model translates)', () => {
    expect(reasoningPickerOptions(m('dynamic', { dynamic: { strategy: 'rule-based' } }), drivers)?.efforts)
      .toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('no picker for a provider without reasoning controls, or without a model', () => {
    expect(reasoningPickerOptions(m('odd'), drivers)).toBeUndefined();
    expect(reasoningPickerOptions(undefined, drivers)).toBeUndefined();
  });
});

describe('the dropdown is not lost when the provider list cannot say the driver', () => {
  const everyLevel = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

  it('the model record\'s own driver wins over (and replaces) the provider lookup', () => {
    expect(reasoningPickerOptions({ ...m('missing'), providerDriver: 'anthropic' }, {})).toMatchObject({ kind: 'budget', budget: true });
    expect(reasoningPickerOptions({ ...m('openaiProv'), providerDriver: 'anthropic' }, drivers)).toMatchObject({ kind: 'budget' });
  });

  it('a driver nobody can name (empty provider map, no record driver) still offers the generic effort list', () => {
    expect(reasoningPickerOptions(m('missing'), {})).toEqual({ kind: 'effort', efforts: everyLevel, budget: false });
    expect(reasoningPickerOptions(m('missing'), drivers)?.efforts).toEqual(everyLevel);
  });

  it('a known driver without controls shows the list only for a model flagged as reasoning', () => {
    expect(reasoningPickerOptions({ ...m('odd'), capabilities: { supportsReasoning: true } }, drivers)?.efforts).toEqual(everyLevel);
    expect(reasoningPickerOptions({ ...m('odd'), capabilities: { supportsReasoning: false } }, drivers)).toBeUndefined();
  });

  it('the Build tab loads the project-scoped provider list (the tenant one is provider-admin only)', () => {
    const detail = read('src/components/agents/AgentDetailPage.tsx');
    expect(detail).toContain("loadList('/api/providers', (d) => d.providers");
    expect(detail).not.toContain('/api/providers?scope=tenant');
  });
});

describe('placement', () => {
  const detail = read('src/components/agents/AgentDetailPage.tsx');

  it('the main picker sits in the same row as the main model select', () => {
    const row = detail.slice(detail.indexOf('<Group align="flex-end"'), detail.indexOf('<AgentAdditionalModels'));
    expect(row).toContain("label={t('config.model')}");
    expect(row).toContain('<AgentReasoningPicker');
    expect(row).toContain('agent-main-reasoning');
  });

  it('every additional model row gets its own picker', () => {
    expect(read('src/components/agents/studio/AgentAdditionalModels.tsx')).toContain('<AgentReasoningPicker');
  });

  it('the first option of the dropdown is "Model default"', () => {
    const picker = read('src/components/agents/studio/AgentReasoningPicker.tsx');
    expect(picker.indexOf("t('reasoningModelDefault')")).toBeLessThan(picker.indexOf('options.efforts.map'));
    expect(en.agents.config.reasoningModelDefault).toBe('Model default');
    expect(tr.agents.config.reasoningModelDefault).toBeTruthy();
  });

  it('a change of main model resets its pick to "Model default"', () => {
    expect(detail).toContain('setMainReasoning({})');
  });

  it('the reasoning fields belong to the Build section for the changed-sections marker', () => {
    expect(CONFIG_SECTION_KEYS.basic).toEqual(expect.arrayContaining(['reasoningEffort', 'reasoningBudgetTokens', 'showReasoning']));
    const changed = changedConfigSections({ modelKey: 'm', reasoningEffort: 'low' }, { modelKey: 'm' });
    expect(changed.has('basic')).toBe(true);
  });
});

describe('Advanced tab', () => {
  const advanced = read('src/components/agents/studio/AgentAdvancedSettings.tsx');

  it('keeps reflection and drops effort / level / budget / thoughts', () => {
    expect(advanced).toContain('agent-reflection');
    expect(advanced).not.toContain('Enable reasoning');
    expect(advanced).not.toContain('Provider effort');
    expect(advanced).not.toContain('Thinking budget');
    expect(advanced).not.toContain('Include thoughts in the trace');
  });
});

describe('i18n', () => {
  const keys = ['reasoningEffort', 'reasoningModelDefault', 'reasoningBudget', 'reasoningBudgetHint', 'reasoningEffortHint', 'reasoningPickerAria', 'showReasoning', 'showReasoningDescription'] as const;

  it('English and Turkish both carry every new key', () => {
    for (const key of keys) {
      expect(en.agents.config[key], `en ${key}`).toBeTruthy();
      expect(tr.agents.config[key], `tr ${key}`).toBeTruthy();
    }
    expect(en.agents.sessionPage.showReasoning).toBeTruthy();
    expect(tr.agents.sessionPage.showReasoning).toBeTruthy();
  });
});
