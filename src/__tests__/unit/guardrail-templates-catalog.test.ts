/**
 * Every guardrail template must be a config the write path accepts as-is.
 *
 * A template is applied through `parseGuardrailCreateBody` like any hand-written
 * request, so a catalog entry the validator refuses would surface to an operator
 * as a 500 on "Use this template". These tests build every template through the
 * same validators the route runs, and pin the promises the catalog makes in its
 * header: no model needed, every policy bound, PII presets that point at real
 * categories, and regex rules that fire on what they claim and not on noise.
 */
import { describe, expect, it } from 'vitest';
import {
  GUARDRAIL_TEMPLATE_CATEGORIES,
  GUARDRAIL_TEMPLATE_PII_PRESETS,
  GUARDRAIL_TEMPLATES,
  findGuardrailTemplate,
  templateHighlights,
} from '@/lib/services/guardrail/templates/catalog';
import { readTemplateMarker } from '@/lib/services/guardrail/templates/service';
import { validateGuardrailHooks } from '@/lib/services/guardrail/hooks/legacy';
import { familyNeedsModel } from '@/lib/services/guardrail/catalog/families';
import { PII_CATEGORIES_BY_ID } from '@/lib/services/pii/categories';
import { scanRegexRules } from '@/lib/services/guardrail/families/regex';
import { parseGuardrailCreateBody } from '@/server/api/plugins/guardrail-write';
import type { GuardrailPolicy, GuardrailRegexRule } from '@/lib/database/provider/types.domain';

const build = (key: string) => {
  const template = findGuardrailTemplate(key);
  if (!template) throw new Error(`no template ${key}`);
  return template.build({ piiPolicyKey: template.piiPreset ? 'tpl-pii' : undefined });
};

describe('guardrail template catalog', () => {
  it('has unique, kebab-case keys in known categories', () => {
    const keys = GUARDRAIL_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    const categories = new Set(GUARDRAIL_TEMPLATE_CATEGORIES.map((c) => c.id));
    for (const template of GUARDRAIL_TEMPLATES) {
      expect(template.key).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(categories.has(template.category)).toBe(true);
      expect(template.version).toBeGreaterThanOrEqual(1);
      expect(template.attachTo.length).toBeGreaterThan(0);
    }
  });

  it.each(GUARDRAIL_TEMPLATES.map((t) => [t.key]))('%s passes the save-time validator', (key) => {
    expect(validateGuardrailHooks(build(key))).toEqual([]);
  });

  it.each(GUARDRAIL_TEMPLATES.map((t) => [t.key]))('%s passes the create-route parser unchanged', (key) => {
    const template = findGuardrailTemplate(key)!;
    const parsed = parseGuardrailCreateBody({
      name: template.name,
      description: template.description,
      type: 'preset',
      mode: 'monitor',
      enabled: true,
      hooks: build(key),
    });
    expect(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed)).toBe(true);
  });

  it.each(GUARDRAIL_TEMPLATES.map((t) => [t.key]))('%s needs no model', (key) => {
    // Not even the "no model" detectors of the LLM families: the evaluator asks
    // those families for a model regardless of detector.
    for (const policy of build(key).policies as GuardrailPolicy[]) {
      expect(familyNeedsModel(policy.family), `${key}/${policy.id}`).toBe(false);
      expect(['moderation', 'prompt_shield', 'custom'], `${key}/${policy.id}`).not.toContain(policy.family);
    }
  });

  it.each(GUARDRAIL_TEMPLATES.map((t) => [t.key]))('%s binds every hook its policies name, with a label on each policy', (key) => {
    const hooks = build(key);
    for (const policy of hooks.policies) {
      expect(policy.label, `${key}/${policy.id}`).toBeTruthy();
      for (const hook of policy.hooks) {
        expect(hooks.bindings?.[hook]?.enabled, `${key}/${policy.id} -> ${hook}`).toBe(true);
      }
    }
    // A stream policy without streaming enabled would never run.
    const streams = hooks.policies.some((p) => p.hooks.includes('output.stream.delta'));
    expect(hooks.stream?.enabled === true).toBe(streams);
  });

  it('a template with a PII preset refuses to build without a policy key', () => {
    const withPii = GUARDRAIL_TEMPLATES.filter((t) => t.piiPreset);
    expect(withPii.length).toBeGreaterThan(0);
    for (const template of withPii) {
      expect(() => template.build({})).toThrow(/PII policy key/);
      const pii = template.build({ piiPolicyKey: 'k' }).policies.filter((p) => p.family === 'pii');
      expect(pii.length).toBeGreaterThan(0);
      for (const policy of pii) expect((policy as { piiPolicyKey: string }).piiPolicyKey).toBe('k');
    }
  });

  it('every PII preset names real catalog categories', () => {
    for (const preset of Object.values(GUARDRAIL_TEMPLATE_PII_PRESETS)) {
      expect(preset.categories.length).toBeGreaterThan(0);
      for (const id of preset.categories) {
        expect(PII_CATEGORIES_BY_ID[id], `${preset.id}: ${id}`).toBeDefined();
      }
    }
  });

  it('every template references an existing PII preset', () => {
    for (const template of GUARDRAIL_TEMPLATES) {
      if (template.piiPreset) expect(GUARDRAIL_TEMPLATE_PII_PRESETS[template.piiPreset]).toBeDefined();
    }
  });

  it('builds a fresh config each time, so a caller cannot mutate the catalog', () => {
    const a = build('baseline');
    a.policies.pop();
    expect(build('baseline').policies.length).toBe(a.policies.length + 1);
  });

  it('lists policy labels for the gallery card', () => {
    expect(templateHighlights(findGuardrailTemplate('kvkk')!)).toEqual(['KVKK personal data']);
    expect(templateHighlights(findGuardrailTemplate('baseline')!)).toHaveLength(4);
  });

  it('the agent template reuses the built-in tool posture', () => {
    const tool = build('agent-tool-safety');
    expect(tool.policies.map((p) => p.id)).toEqual(
      expect.arrayContaining(['tool-policy', 'dlp-secrets', 'tool-result-injection']),
    );
  });

  it('the MCP template guards both tool hooks and leaves personal data to the server’s PII protection', () => {
    const mcp = build('mcp-protection');
    expect(mcp.policies.map((p) => p.id)).toEqual(['mcp-limits', 'mcp-secrets', 'mcp-prompt-shield']);
    expect(Object.keys(mcp.bindings ?? {}).sort()).toEqual(['tool.post', 'tool.pre']);
    expect(mcp.policies.some((p) => p.family === 'pii')).toBe(false);
    expect(findGuardrailTemplate('mcp-protection')!.attachTo).toEqual(['mcp']);
  });

  it('reads the template marker back off record metadata', () => {
    expect(readTemplateMarker({ template: { key: 'kvkk', version: 1 } })).toEqual({ key: 'kvkk', version: 1 });
    expect(readTemplateMarker({ template: { key: 'kvkk' } })).toBeUndefined();
    expect(readTemplateMarker(undefined)).toBeUndefined();
  });
});

describe('template regex rules', () => {
  const rulesOf = (key: string, policyId: string): GuardrailRegexRule[] => {
    const policy = build(key).policies.find((p) => p.id === policyId) as { rules: GuardrailRegexRule[] };
    return policy.rules;
  };
  const hits = (rules: GuardrailRegexRule[], text: string) => scanRegexRules(text, rules).matches.map((m) => m.ruleId);

  it('internal addresses: private IPs and internal host names, not public ones', () => {
    const rules = rulesOf('credential-leak', 'internal-addresses');
    expect(hits(rules, 'connect to 10.2.3.4 or 192.168.1.20')).toEqual(['private-ipv4', 'private-ipv4']);
    expect(hits(rules, 'db is at 172.16.0.5')).toEqual(['private-ipv4']);
    expect(hits(rules, 'the api runs on billing-api.corp and ldap.internal')).toEqual(['internal-host', 'internal-host']);
    expect(hits(rules, 'see 8.8.8.8, 172.32.0.1 and www.example.com')).toEqual([]);
  });

  it('card details: only with their label next to them', () => {
    const rules = rulesOf('payment-card', 'card-details');
    expect(hits(rules, 'CVV: 123')).toEqual(['card-security-code']);
    expect(hits(rules, 'güvenlik kodu 4567')).toEqual(['card-security-code']);
    expect(hits(rules, 'exp 09/27')).toEqual(['card-expiry']);
    expect(hits(rules, 'son kullanma tarihi: 12/2029')).toEqual(['card-expiry']);
    expect(hits(rules, 'order 123 shipped on 09/27')).toEqual([]);
  });
});
