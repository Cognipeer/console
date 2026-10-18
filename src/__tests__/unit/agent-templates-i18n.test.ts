/**
 * The `agentTemplates` namespace (agentTemplates.en.ts / agentTemplates.tr.ts): English and Turkish carry the
 * same keys with the same placeholders, nothing is left in English, every catalog template has its texts in
 * both languages, and the labels the gallery needs (categories, capabilities, surfaces, model hints,
 * availability and setup codes) exist for every value the catalog and the API can produce.
 */
import { describe, expect, it } from 'vitest';
import { messages } from '@/lib/i18n/messages';
import { AGENT_TEMPLATES } from '@/lib/services/agents/templates/catalog';
import {
  AGENT_TEMPLATE_AVAILABILITY_CODES,
  AGENT_TEMPLATE_CAPABILITIES,
  AGENT_TEMPLATE_CATEGORIES,
  AGENT_TEMPLATE_MODEL_HINTS,
  AGENT_TEMPLATE_SETUP_CODES,
  AGENT_TEMPLATE_SURFACES,
} from '@/lib/services/agents/templates/types';
import { buildSetupItems } from '@/lib/services/agents/templates/templateSetup';

type Tree = { [key: string]: string | Tree };

/** Strings by dotted path; a list (`useCases`) is read by index (`useCases.0`), as `useTranslations` reads it. */
function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(full, value);
    else for (const [k, v] of flatten(value, full)) out.set(k, v);
  }
  return out;
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

const enTree = (messages.en as unknown as Record<string, Tree>).agentTemplates;
const trTree = (messages.tr as unknown as Record<string, Tree>).agentTemplates;
const en = flatten(enTree ?? {});
const tr = flatten(trTree ?? {});

// words that are legitimately the same in both languages (product terms and proper nouns)
const SAME = /^(model|guardrail|api|mcp|webhook|sandbox|sql|a2a|json)$/i;

describe('agentTemplates messages', () => {
  it('exist in both languages', () => {
    expect(enTree).toBeDefined();
    expect(trTree).toBeDefined();
    expect(en.size).toBeGreaterThan(AGENT_TEMPLATES.length * 6);
  });

  it('have the same keys in English and Turkish', () => {
    expect([...tr.keys()].sort()).toEqual([...en.keys()].sort());
  });

  it('have the same placeholders in both languages and no empty text', () => {
    for (const [key, text] of en) {
      expect(text.trim(), `${key} (en) is empty`).not.toBe('');
      expect(tr.get(key)?.trim(), `${key} (tr) is empty`).not.toBe('');
      expect(placeholders(tr.get(key) ?? ''), `${key} placeholders`).toEqual(placeholders(text));
    }
  });

  it('are actually translated (no text is left in English)', () => {
    const hasWords = (text: string) => /\p{L}/u.test(text.replace(/\{\w+\}/g, ''));
    const untranslated = [...en].filter(([key, text]) => tr.get(key) === text && !SAME.test(text) && hasWords(text));
    expect(untranslated.map(([key]) => key)).toEqual([]);
  });

  it('address the reader formally in Turkish (sizin/siz, never senin/sen)', () => {
    const INFORMAL = /(?<![\p{L}])(yapabilirsin|edebilirsin|görebilirsin|seçebilirsin|istersen|sana|senin|seni|yapamazsın|değiştiremezsin)(?![\p{L}])/iu;
    for (const [key, text] of tr) expect(text, key).not.toMatch(INFORMAL);
  });

  it('never use the old name of triggers', () => {
    for (const [key, text] of [...en, ...tr]) expect(text, key).not.toMatch(/routine|rutin/i);
  });
});

describe('the catalog\'s texts', () => {
  it('give every template a name, summary, description and three use cases in both languages', () => {
    for (const template of AGENT_TEMPLATES) {
      for (const [locale, texts] of [['en', en], ['tr', tr]] as const) {
        const at = `${locale}: items.${template.key}`;
        for (const field of ['name', 'summary', 'description', 'useCases.0', 'useCases.1', 'useCases.2']) {
          expect(texts.get(`items.${template.key}.${field}`)?.trim(), `${at}.${field}`).toBeTruthy();
        }
        expect(texts.has(`items.${template.key}.useCases.3`), `${at} has more than three use cases`).toBe(false);
        expect(texts.get(`items.${template.key}.summary`)!.length, `${at}.summary length`).toBeLessThanOrEqual(90);
      }
    }
  });

  it('have no text for a template that is not in the catalog', () => {
    const keys = new Set(AGENT_TEMPLATES.map((template) => template.key));
    for (const path of en.keys()) {
      const match = /^items\.([^.]+)\./.exec(path);
      if (match) expect(keys.has(match[1]!), path).toBe(true);
    }
  });

  it('keep each template\'s summary to one sentence-sized line (no line breaks)', () => {
    for (const [path, text] of [...en, ...tr]) {
      if (/^items\.[^.]+\.(name|summary|useCases)/.test(path)) expect(text, path).not.toContain('\n');
    }
  });
});

describe('the labels of the gallery', () => {
  const labelled = (section: string, ids: readonly string[]) => {
    for (const id of ids) {
      expect(en.get(`${section}.${id}`)?.trim(), `en: ${section}.${id}`).toBeTruthy();
      expect(tr.get(`${section}.${id}`)?.trim(), `tr: ${section}.${id}`).toBeTruthy();
    }
    const known = new Set(ids);
    for (const path of en.keys()) {
      if (path.startsWith(`${section}.`)) expect(known.has(path.slice(section.length + 1)), `${path} is not a known value`).toBe(true);
    }
  };

  it('name every category, capability, surface and model hint', () => {
    labelled('categories', AGENT_TEMPLATE_CATEGORIES);
    labelled('capabilities', AGENT_TEMPLATE_CAPABILITIES);
    labelled('surfaces', AGENT_TEMPLATE_SURFACES);
    labelled('modelHints', AGENT_TEMPLATE_MODEL_HINTS);
  });

  it('say what each availability code and status means', () => {
    labelled('availability.items', AGENT_TEMPLATE_AVAILABILITY_CODES);
    labelled('availability.status', ['ready', 'needs_setup', 'unavailable']);
    labelled('availability.sandboxReasons', ['edition', 'license']);
  });

  it('say what to do for each setup code, and the API sends the same English with its placeholders filled', () => {
    labelled('setup', AGENT_TEMPLATE_SETUP_CODES);
    const template = AGENT_TEMPLATES.find((candidate) => candidate.key === 'customer-support')!;
    const items = buildSetupItems({
      template,
      knowledgeKeys: [],
      guardrailKeys: [],
      webSearchAvailable: false,
      published: false,
      triggers: [{ name: 'New ticket', type: 'webhook' }],
    });
    const codes = items.map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining(['knowledge_not_bound', 'guardrails_recommended', 'client_tools', 'publish_needed', 'triggers_disabled', 'webhook_secret']));
    for (const item of items) {
      expect(item.message, item.code).not.toMatch(/[{}]/);
      expect(en.get(`setup.${item.code}`)!.replace(/\{\w+\}/g, '').split(/\s+/).filter(Boolean).slice(0, 3).join(' '), item.code)
        .toBe(item.message.split(/\s+/).filter(Boolean).slice(0, 3).join(' '));
    }
    expect(items.find((item) => item.code === 'client_tools')?.message).toContain('create_ticket');
    expect(items.find((item) => item.code === 'triggers_disabled')?.message).toContain('New ticket');
  });

  it('explain the client tools hint with the tools named', () => {
    expect(placeholders(en.get('hints.clientTools') ?? '')).toEqual(['tools']);
    expect(placeholders(tr.get('hints.clientTools') ?? '')).toEqual(['tools']);
  });
});
