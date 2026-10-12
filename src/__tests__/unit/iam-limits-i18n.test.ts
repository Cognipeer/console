/**
 * Every message the Limits tab and the extended quota editor ask for exists in
 * English AND Turkish, and `iamLimits` has the same shape in both.
 *
 * The UI looks keys up through `useTranslations(ns)`; a missing key would
 * render as its dotted path. Static keys are read straight out of the source
 * (`const t = useTranslations('ns')` ... `t('some.key')`), so a new string
 * cannot ship untranslated.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '@/lib/i18n/messages';

const ROOT = path.resolve(__dirname, '../..');
const FILES = [
  'components/iam/limits/LimitsTab.tsx',
  'components/quota/QuotaPolicyModal.tsx',
  'components/quota/ScopeIdSelector.tsx',
  'components/quota/TargetSelect.tsx',
];

/** Every kind of target the pickers name (QuotaTargetNoun) and every registry type one can show. */
const TARGET_NOUNS = ['model', 'vectorIndex', 'fileBucket', 'agent', 'agentName', 'provider', 'resource'];
const TARGET_TYPES = ['model', 'vector-index', 'file-bucket', 'agent', 'provider'];

function lookup(locale: 'en' | 'tr', key: string): unknown {
  let node: unknown = messages[locale];
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** `{ variable: namespace }` for every `const x = useTranslations('ns')` in the source. */
function translators(source: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of source.matchAll(/const\s+(\w+)\s*=\s*useTranslations\(\s*'([^']+)'\s*\)/g)) {
    found.set(match[1], match[2]);
  }
  return found;
}

function staticKeys(source: string): string[] {
  const keys: string[] = [];
  for (const [variable, namespace] of translators(source)) {
    // `t('key')`, `t('key', {...})` — literal first argument only (template keys are checked by shape below).
    for (const match of source.matchAll(new RegExp(`\\b${variable}\\(\\s*'([^'$]+)'`, 'g'))) {
      keys.push(`${namespace}.${match[1]}`);
    }
  }
  return keys;
}

describe('quota / limits UI strings', () => {
  for (const file of FILES) {
    it(`${file}: every literal key exists in en and tr`, () => {
      const keys = staticKeys(readFileSync(path.join(ROOT, file), 'utf8'));
      expect(keys.length).toBeGreaterThan(0);
      const missing = keys.filter(
        (key) => typeof lookup('en', key) !== 'string' || typeof lookup('tr', key) !== 'string',
      );
      expect(missing).toEqual([]);
    });
  }

  it('resolves the keys the Limits tab builds at run time (error codes, amount kinds and windows)', () => {
    const dynamic = [
      ...['group_not_found', 'group_required', 'agent_required', 'project_not_found', 'invalid_group_mode',
        'group_mode_requires_group_scope', 'invalid_scope', 'invalid_domain', 'forbidden'].map((c) => `iamLimits.errors.${c}`),
      ...['requests', 'tokens', 'vectors', 'files', 'storage'].map((k) => `iamLimits.amounts.kind.${k}`),
      ...['perSecond', 'perMinute', 'perHour', 'perDay', 'perMonth'].map((w) => `iamLimits.amounts.window.${w}`),
      'iamLimits.form.globalAgentNote',
      ...['group', 'user', 'token', 'resource', 'provider', 'agent', 'model', 'vectorIndex', 'fileBucket', 'agentName'].flatMap((k) => [
        `iamLimits.form.targetLabel.${k}`,
        `iamLimits.form.targetHint.${k}`,
      ]),
      'iamLimits.form.projectFromTarget',
      // The search pickers build these from the kind of target (QuotaTargetNoun) and the registry type of a row.
      ...TARGET_NOUNS.flatMap((noun) => [
        `settings.quotaSection.target.placeholder.${noun}`,
        `settings.quotaSection.target.empty.${noun}`,
        `settings.quotaSection.target.kind.${noun}`,
      ]),
      ...TARGET_TYPES.map((type) => `settings.quotaSection.target.types.${type}`),
      ...['user', 'group', 'token', 'agent'].map((kind) => `settings.quotaSection.target.gone.${kind}`),
      ...['tenant', 'group', 'user', 'token', 'resource', 'provider'].map((s) => `settings.quotaSection.scopes.${s}`),
      ...['global', 'llm', 'embedding', 'vector', 'file', 'tracing', 'stt', 'tts', 'ocr', 'image', 'moderation', 'decision', 'agent']
        .map((d) => `settings.quotaSection.domains.${d}`),
    ];
    const missing = dynamic.filter((key) => typeof lookup('en', key) !== 'string' || typeof lookup('tr', key) !== 'string');
    expect(missing).toEqual([]);
  });

  it('keeps iamLimits the same shape in both languages', () => {
    const shape = (node: unknown, prefix = ''): string[] =>
      node && typeof node === 'object'
        ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => shape(v, `${prefix}${k}.`))
        : [prefix.slice(0, -1)];
    expect(shape(messages.tr.iamLimits).sort()).toEqual(shape(messages.en.iamLimits).sort());
  });

  it('gives the target pickers the same strings, with the same placeholders, in both languages', () => {
    const shape = (node: unknown, prefix = ''): string[] =>
      node && typeof node === 'object'
        ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => shape(v, `${prefix}${k}.`))
        : [prefix.slice(0, -1)];
    const en = lookup('en', 'settings.quotaSection.target');
    const tr = lookup('tr', 'settings.quotaSection.target');
    expect(shape(tr).sort()).toEqual(shape(en).sort());

    const tokens = (value: unknown) => [...String(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of shape(en)) {
      expect(tokens(lookup('tr', `settings.quotaSection.target.${key}`)), key).toEqual(tokens(lookup('en', `settings.quotaSection.target.${key}`)));
    }
  });

  it('translates the target picker strings instead of repeating the English', () => {
    const leaves = (node: unknown, prefix = ''): Array<[string, string]> =>
      node && typeof node === 'object'
        ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leaves(v, `${prefix}${k}.`))
        : [[prefix.slice(0, -1), String(node)]];
    const en = new Map(leaves(lookup('en', 'settings.quotaSection.target')));
    // Words that are the same in Turkish.
    const sameOnPurpose = new Set(['types.model', 'kind.model']);
    const untranslated = leaves(lookup('tr', 'settings.quotaSection.target'))
      .filter(([key, value]) => value === en.get(key) && !sameOnPurpose.has(key))
      .map(([key]) => key);
    expect(untranslated).toEqual([]);
  });

  it('translates the Turkish iamLimits strings instead of repeating the English', () => {
    const leaves = (node: unknown, prefix = ''): Array<[string, string]> =>
      node && typeof node === 'object'
        ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leaves(v, `${prefix}${k}.`))
        : [[prefix.slice(0, -1), String(node)]];
    const en = new Map(leaves(messages.en.iamLimits));
    // A few words are the same in both languages (units, product names).
    const sameOnPurpose = new Set(['columns.limit', 'amounts.kind.tokens', 'form.targetLabel.model']);
    const untranslated = leaves(messages.tr.iamLimits)
      .filter(([key, value]) => value === en.get(key) && !sameOnPurpose.has(key))
      .map(([key]) => key);
    expect(untranslated).toEqual([]);
  });
});
