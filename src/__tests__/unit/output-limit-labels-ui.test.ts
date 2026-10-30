/**
 * Output-limit wording and wiring (D6/D7): "Maximum output tokens" is the model maximum, "Default max tokens" the
 * default per-request limit, and an agent can set "Max output tokens per call" (config.maxTokens -> max_tokens).
 * Pinned against the sources, like the other Studio structure tests.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('model form labels', () => {
  const keys = ['maxOutputTokens', 'runtimeMaxTokens'] as const;

  it('both languages carry label and description for the maximum and the default', () => {
    for (const key of keys) {
      expect(en.modelWizard.fields[key].label, `en ${key}`).toBeTruthy();
      expect(en.modelWizard.fields[key].description, `en ${key}`).toBeTruthy();
      expect(tr.modelWizard.fields[key].label, `tr ${key}`).toBeTruthy();
      expect(tr.modelWizard.fields[key].description, `tr ${key}`).toBeTruthy();
    }
  });

  it('keeps the two apart: the maximum is the model\'s, the default is per request', () => {
    expect(en.modelWizard.fields.maxOutputTokens.label).toBe('Maximum output tokens');
    expect(en.modelWizard.fields.runtimeMaxTokens.label).toBe('Default max tokens');
    expect(en.modelWizard.fields.maxOutputTokens.description).toMatch(/Default max tokens/);
    expect(en.modelWizard.fields.runtimeMaxTokens.description).toMatch(/Maximum output tokens/);
    expect(tr.modelWizard.fields.maxOutputTokens.description).toMatch(/Varsayılan maksimum token/);
    expect(tr.modelWizard.fields.runtimeMaxTokens.description).toMatch(/Maksimum çıktı token/);
  });

  it('the create form labels the default too (it had no label or hint)', () => {
    const create = read('src/components/models/CreateModelModal.tsx');
    expect(create).toContain("tWizard('fields.runtimeMaxTokens.label')");
    expect(create).toContain("tWizard('fields.runtimeMaxTokens.description')");
  });

  it('the limit notice points at the default / request limit, not the advertised maximum', () => {
    expect(en.agents.outputLimit.message).toMatch(/Default max tokens/);
    expect(en.agents.outputLimit.message).not.toMatch(/maximum output tokens/i);
    expect(tr.agents.outputLimit.message).toMatch(/Varsayılan maksimum token/);
  });
});

describe('Fill from catalog', () => {
  it('both forms fill the limits through limitsFromCatalogFill, chat models only', () => {
    for (const file of ['src/components/models/CreateModelModal.tsx', 'src/components/models/EditModelModal.tsx']) {
      const source = read(file);
      expect(source, file).toContain('limitsFromCatalogFill(');
      expect(source, file).toMatch(/onApplyCatalog=\{\(pricing, meta\)/);
      expect(source, file).toMatch(/if \(isLlm\) \{\s*const limits = limitsFromCatalogFill/);
    }
  });

  it('the notification title no longer claims it only filled pricing', () => {
    expect(en.modelPriceCatalog.fill.filledTitle).toBe('Filled from catalog');
    expect(tr.modelPriceCatalog.fill.filledTitle).toBeTruthy();
  });
});

describe('agent "Max output tokens per call"', () => {
  const keys = ['maxTokensPerCall', 'maxTokensPerCallDescription', 'maxTokensPerCallPlaceholder'] as const;

  it('English and Turkish carry every key with the same placeholders', () => {
    for (const key of keys) {
      expect(en.agents.config[key], `en ${key}`).toBeTruthy();
      expect(tr.agents.config[key], `tr ${key}`).toBeTruthy();
      expect(placeholders(tr.agents.config[key]), key).toEqual(placeholders(en.agents.config[key]));
    }
    expect(en.agents.config.maxTokensPerCall).toBe('Max output tokens per call');
  });

  it('the Advanced section renders the field only when the page wires it, blank = undefined', () => {
    const advanced = read('src/components/agents/studio/AgentAdvancedSettings.tsx');
    expect(advanced).toMatch(/onMaxTokensChange \? \(/);
    expect(advanced).toContain('onChange={(next) => onMaxTokensChange(numberValue(next))}');
    expect(advanced).toContain("value={maxTokens ?? ''}");
  });

  it('the page loads and saves config.maxTokens, so a save no longer clears it', () => {
    const detail = read('src/components/agents/AgentDetailPage.tsx');
    expect(detail).toContain('setMaxTokens(typeof cfg.maxTokens');
    expect(detail).toMatch(/\n\s+maxTokens,\n/);
    expect(detail).toContain("t('config.maxTokensPerCall')");
  });
});
