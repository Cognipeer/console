/**
 * The pure parts of creating an agent from a template: what the project has
 * against what the template needs (availability), the checklist after the
 * create (setup), the config and trigger bodies the picks turn into, the key
 * candidates, and the request body's checks. No database: the database-backed
 * flow is in api/agent-templates-routes.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { agentTemplatesEn } from '@/lib/i18n/messages/agentTemplates.en';
import { parseInstantiateInput, AgentTemplateError } from '@/lib/services/agents/templates/agentTemplateService';
import { findAgentTemplate } from '@/lib/services/agents/templates/catalog';
import { computeTemplateAvailability, type TemplateFacts } from '@/lib/services/agents/templates/templateAvailability';
import {
  AGENT_KEY_MAX_ATTEMPTS,
  AGENT_KEY_PATTERN,
  agentKeyCandidate,
  buildTemplateConfig,
  buildTriggerBody,
} from '@/lib/services/agents/templates/templateConfig';
import { buildSetupItems, type TemplateSetupFacts } from '@/lib/services/agents/templates/templateSetup';
import type { AgentTemplate, AgentTemplateTrigger } from '@/lib/services/agents/templates/types';

/** A template with nothing special about it, for the cases to bend. */
const template = (overrides: Partial<AgentTemplate> = {}): AgentTemplate => ({
  key: 'sample',
  version: 1,
  category: 'operations',
  icon: 'IconRobot',
  capabilities: [],
  modelHint: 'balanced',
  requires: {},
  surfaces: ['chat'],
  spec: { systemPrompt: 'You help.' },
  ...overrides,
});

describe('computeTemplateAvailability', () => {
  const facts = (overrides: Partial<TemplateFacts> = {}): TemplateFacts => ({
    hasLlmModel: true,
    hasWebSearchProvider: true,
    hasKnowledgeEngine: true,
    sandbox: { available: true, templateKeys: ['multi-base'] },
    ...overrides,
  });

  it('is ready when the project has what the template needs', () => {
    const needy = template({ requires: { knowledge: 'required', webSearch: 'required', sandbox: 'required' } });
    expect(computeTemplateAvailability(needy, facts())).toEqual({ status: 'ready', items: [] });
  });

  it('a missing chat model blocks every template, with or without requirements', () => {
    expect(computeTemplateAvailability(template(), facts({ hasLlmModel: false }))).toEqual({
      status: 'needs_setup',
      items: [{ code: 'no_llm_model', severity: 'blocker' }],
    });
  });

  it('a required part that is missing blocks, an optional one only warns', () => {
    const missing = facts({ hasWebSearchProvider: false, hasKnowledgeEngine: false });
    expect(computeTemplateAvailability(template({ requires: { webSearch: 'required', knowledge: 'required' } }), missing)).toEqual({
      status: 'needs_setup',
      items: [{ code: 'web_search_unavailable', severity: 'blocker' }, { code: 'knowledge_missing', severity: 'blocker' }],
    });
    expect(computeTemplateAvailability(template({ requires: { webSearch: 'optional', knowledge: 'optional' } }), missing)).toEqual({
      status: 'ready',
      items: [{ code: 'web_search_unavailable', severity: 'warning' }, { code: 'knowledge_missing', severity: 'warning' }],
    });
  });

  it('a part the template does not use is never reported', () => {
    expect(computeTemplateAvailability(template(), facts({
      hasWebSearchProvider: false, hasKnowledgeEngine: false, sandbox: { available: false, reason: 'edition' },
    }))).toEqual({ status: 'ready', items: [] });
  });

  it('no sandbox is unavailable (not something the project can fix), and says whether the edition or the license is why', () => {
    const sandboxed = template({ requires: { sandbox: 'required' } });
    expect(computeTemplateAvailability(sandboxed, facts({ sandbox: { available: false, reason: 'edition' } }))).toEqual({
      status: 'unavailable', items: [{ code: 'sandbox_unavailable', severity: 'blocker', detail: 'edition' }],
    });
    expect(computeTemplateAvailability(sandboxed, facts({ sandbox: { available: false, reason: 'license' } })).items)
      .toEqual([{ code: 'sandbox_unavailable', severity: 'blocker', detail: 'license' }]);
  });

  it('unavailable wins over the things the project could still set up', () => {
    const everything = template({ requires: { sandbox: 'required', knowledge: 'required', webSearch: 'required' } });
    const result = computeTemplateAvailability(everything, {
      hasLlmModel: false, hasWebSearchProvider: false, hasKnowledgeEngine: false, sandbox: { available: false, reason: 'license' },
    });
    expect(result.status).toBe('unavailable');
    expect(result.items.map((item) => item.code)).toEqual(['no_llm_model', 'sandbox_unavailable', 'web_search_unavailable', 'knowledge_missing']);
  });

  it('a sandbox with no template needs one; templates that could not be listed are not held against it', () => {
    const sandboxed = template({ requires: { sandbox: 'required' } });
    expect(computeTemplateAvailability(sandboxed, facts({ sandbox: { available: true, templateKeys: [] } }))).toEqual({
      status: 'needs_setup', items: [{ code: 'sandbox_template_missing', severity: 'blocker' }],
    });
    expect(computeTemplateAvailability(sandboxed, facts({ sandbox: { available: true } }))).toEqual({ status: 'ready', items: [] });
  });
});

describe('buildSetupItems', () => {
  const setupFacts = (overrides: Partial<TemplateSetupFacts> = {}): TemplateSetupFacts => ({
    template: template(),
    knowledgeKeys: [],
    guardrailKeys: [],
    webSearchAvailable: true,
    published: true,
    triggers: [],
    ...overrides,
  });
  const codes = (facts: TemplateSetupFacts) => buildSetupItems(facts).map((item) => item.code);

  it('has nothing to say about a template that needs nothing and is published', () => {
    expect(buildSetupItems(setupFacts())).toEqual([]);
  });

  it('knowledge: a warning when the template needs it, a note when it is optional, nothing once one is bound or when unused', () => {
    expect(buildSetupItems(setupFacts({ template: template({ requires: { knowledge: 'required' } }) }))).toEqual([
      { code: 'knowledge_not_bound', severity: 'warning', message: agentTemplatesEn.setup.knowledge_not_bound },
    ]);
    expect(buildSetupItems(setupFacts({ template: template({ requires: { knowledge: 'optional' } }) }))[0]).toMatchObject({ severity: 'info' });
    expect(codes(setupFacts({ template: template({ requires: { knowledge: 'required' } }), knowledgeKeys: ['faq'] }))).toEqual([]);
  });

  it('web search: a warning when needed and missing, a note when optional, nothing when available', () => {
    expect(buildSetupItems(setupFacts({ template: template({ requires: { webSearch: 'required' } }), webSearchAvailable: false }))[0])
      .toMatchObject({ code: 'web_search_unavailable', severity: 'warning' });
    expect(buildSetupItems(setupFacts({ template: template({ requires: { webSearch: 'optional' } }), webSearchAvailable: false }))[0])
      .toMatchObject({ code: 'web_search_unavailable', severity: 'info' });
    expect(codes(setupFacts({ template: template({ requires: { webSearch: 'required' } }) }))).toEqual([]);
  });

  it('guardrails: recommended only for a template that says so, and only while none is bound', () => {
    const recommended = template({ requires: { guardrails: 'recommended' } });
    expect(codes(setupFacts({ template: recommended }))).toEqual(['guardrails_recommended']);
    expect(codes(setupFacts({ template: recommended, guardrailKeys: ['g'] }))).toEqual([]);
    expect(codes(setupFacts({ guardrailKeys: [] }))).toEqual([]);
  });

  it('client tools: named, with the names in the message and as the detail', () => {
    const withTools = template({
      spec: { systemPrompt: 'x', clientTools: [{ name: 'create_ticket', description: 'd', inputSchema: { type: 'object' } }, { name: 'close_ticket', description: 'd', inputSchema: { type: 'object' } }] },
    });
    const [item] = buildSetupItems(setupFacts({ template: withTools }));
    expect(item).toMatchObject({ code: 'client_tools', severity: 'info', detail: 'create_ticket, close_ticket' });
    expect(item!.message).toContain('create_ticket, close_ticket');
    expect(item!.message).not.toMatch(/[{}]/);
  });

  it('publishing: only reminded for a template that runs from the API or a trigger, and not once published', () => {
    expect(codes(setupFacts({ published: false }))).toEqual([]);
    expect(codes(setupFacts({ template: template({ surfaces: ['chat', 'api'] }), published: false }))).toEqual(['publish_needed']);
    expect(codes(setupFacts({ template: template({ surfaces: ['trigger'] }), published: false }))).toEqual(['publish_needed']);
    expect(codes(setupFacts({ template: template({ surfaces: ['api'] }), published: true }))).toEqual([]);
  });

  it('triggers: listed by name; the secret reminder only when one of them is a webhook', () => {
    const schedule = buildSetupItems(setupFacts({ triggers: [{ name: 'Morning', type: 'schedule' }] }));
    expect(schedule.map((item) => item.code)).toEqual(['triggers_disabled']);
    expect(schedule[0]).toMatchObject({ detail: 'Morning' });
    expect(schedule[0]!.message).toContain('Morning');

    const both = buildSetupItems(setupFacts({ triggers: [{ name: 'Morning', type: 'schedule' }, { name: 'On push', type: 'webhook' }] }));
    expect(both.map((item) => item.code)).toEqual(['triggers_disabled', 'webhook_secret']);
    expect(both[0]!.detail).toBe('Morning, On push');
    expect(both[1]).toMatchObject({ severity: 'warning' });
  });

  it('puts the reminders in the order the form shows them', () => {
    const all = template({
      requires: { knowledge: 'required', webSearch: 'required', guardrails: 'recommended' },
      surfaces: ['api'],
      spec: { systemPrompt: 'x', clientTools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }] },
    });
    expect(codes(setupFacts({ template: all, webSearchAvailable: false, published: false, triggers: [{ name: 'W', type: 'webhook' }] }))).toEqual([
      'knowledge_not_bound', 'web_search_unavailable', 'guardrails_recommended', 'client_tools', 'publish_needed', 'triggers_disabled', 'webhook_secret',
    ]);
  });
});

describe('buildTemplateConfig', () => {
  const knowledgeTemplate = template({
    requires: { knowledge: 'required' },
    spec: { systemPrompt: 'x', knowledgeEngineKey: 'legacy', knowledgeBindings: [{ key: 'stale' }], knowledgeToolMode: 'separate' },
  });

  it('sets the model and keeps the rest of the spec', () => {
    const config = buildTemplateConfig(template({ spec: { systemPrompt: 'Be brief.', variables: [{ name: 'tone', type: 'string' }] } }), { modelKey: 'main' });
    expect(config).toEqual({ systemPrompt: 'Be brief.', variables: [{ name: 'tone', type: 'string' }], modelKey: 'main' });
  });

  it('returns a copy: changing it never changes the template', () => {
    const source = template({ spec: { systemPrompt: 'x', variables: [{ name: 'tone', type: 'string' }] } });
    const config = buildTemplateConfig(source, { modelKey: 'main' });
    config.variables!.push({ name: 'extra', type: 'string' });
    config.systemPrompt = 'changed';
    expect(source.spec).toEqual({ systemPrompt: 'x', variables: [{ name: 'tone', type: 'string' }] });
  });

  it('binds the knowledge bases picked (trimmed, once each) in place of whatever the spec carried', () => {
    expect(buildTemplateConfig(knowledgeTemplate, { modelKey: 'm' })).toEqual({ systemPrompt: 'x', modelKey: 'm' });
    expect(buildTemplateConfig(knowledgeTemplate, { modelKey: 'm', knowledgeKeys: [' faq ', 'faq'] })).toEqual({
      systemPrompt: 'x', modelKey: 'm', knowledgeBindings: [{ key: 'faq' }],
    });
  });

  it('gives several knowledge bases the template\'s tool mode, or the combined one', () => {
    expect(buildTemplateConfig(knowledgeTemplate, { modelKey: 'm', knowledgeKeys: ['a', 'b'] })).toMatchObject({
      knowledgeBindings: [{ key: 'a' }, { key: 'b' }], knowledgeToolMode: 'separate',
    });
    const plain = template({ requires: { knowledge: 'optional' } });
    expect(buildTemplateConfig(plain, { modelKey: 'm', knowledgeKeys: ['a', 'b'] }).knowledgeToolMode).toBe('combined');
    expect(buildTemplateConfig(plain, { modelKey: 'm', knowledgeKeys: ['a'] })).not.toHaveProperty('knowledgeToolMode');
  });

  it('binds the guardrails picked, and leaves the config without any when none is', () => {
    expect(buildTemplateConfig(template(), { modelKey: 'm', guardrailKeys: ['g1', ' g2 ', 'g1', ''] }).guardrails).toEqual([{ key: 'g1' }, { key: 'g2' }]);
    expect(buildTemplateConfig(template(), { modelKey: 'm', guardrailKeys: [] })).not.toHaveProperty('guardrails');
  });

  it('turns a sandbox template\'s sandbox on with the template picked, and adds none to one that has none', () => {
    const sandboxed = template({ requires: { sandbox: 'required' }, spec: { systemPrompt: 'x', sandbox: { enabled: false, commandTimeoutSec: 90 } } });
    expect(buildTemplateConfig(sandboxed, { modelKey: 'm', sandboxTemplateKey: 'python' }).sandbox).toEqual({ enabled: true, commandTimeoutSec: 90, templateKey: 'python' });
    expect(buildTemplateConfig(sandboxed, { modelKey: 'm' }).sandbox).toEqual({ enabled: true, commandTimeoutSec: 90 });
    expect(buildTemplateConfig(template(), { modelKey: 'm', sandboxTemplateKey: 'python' })).not.toHaveProperty('sandbox');
  });

  it('points the agent at the skill keys the project holds, once each', () => {
    const skilled = template({ spec: { systemPrompt: 'x', skills: ['tpl-a', 'tpl-b', 'own-skill'] } });
    expect(buildTemplateConfig(skilled, { modelKey: 'm' }).skills).toEqual(['tpl-a', 'tpl-b', 'own-skill']);
    expect(buildTemplateConfig(skilled, { modelKey: 'm', skillKeys: { 'tpl-a': 'tpl-a-2', 'tpl-b': 'tpl-a-2' } }).skills).toEqual(['tpl-a-2', 'own-skill']);
  });

  it('does not set temperature or token limits: the model\'s own settings govern', () => {
    const config = buildTemplateConfig(findAgentTemplate('customer-support')!, { modelKey: 'm' });
    expect(config).not.toHaveProperty('temperature');
    expect(config).not.toHaveProperty('maxTokens');
  });
});

describe('buildTriggerBody', () => {
  const webhook: AgentTemplateTrigger = {
    name: 'On push', type: 'webhook', webhook: { preset: 'github', events: ['push'], include_payload: true }, prompt: 'Review {{payload.after}}.', variables: { sha: '{{payload.after}}' },
  };

  it('is the body POST /agents/:id/triggers takes: disabled, unpinned, with the type\'s one settings object', () => {
    expect(buildTriggerBody(webhook, 'UTC')).toEqual({
      name: 'On push', type: 'webhook', webhook: { preset: 'github', events: ['push'], include_payload: true },
      prompt: 'Review {{payload.after}}.', variables: { sha: '{{payload.after}}' }, enabled: false, version: null,
    });
  });

  it('puts a schedule in the timezone given', () => {
    const schedule: AgentTemplateTrigger = { name: 'Weekly', type: 'schedule', schedule: { cron: '0 9 * * 1' }, prompt: 'Report.' };
    expect(buildTriggerBody(schedule, 'Europe/Istanbul')).toEqual({
      name: 'Weekly', type: 'schedule', schedule: { cron: '0 9 * * 1', timezone: 'Europe/Istanbul' }, prompt: 'Report.', enabled: false, version: null,
    });
  });

  it('a manual trigger has no settings, and one without variables sends none', () => {
    const body = buildTriggerBody({ name: 'Run now', type: 'manual', prompt: 'Go.' }, 'UTC');
    expect(body).toEqual({ name: 'Run now', type: 'manual', prompt: 'Go.', enabled: false, version: null });
  });

  it('copies what it hands over: changing the body never changes the template', () => {
    const body = buildTriggerBody(webhook, 'UTC') as { webhook: { events: string[] }; variables: Record<string, unknown> };
    body.webhook.events.push('release');
    body.variables.extra = 1;
    expect(webhook.webhook!.events).toEqual(['push']);
    expect(webhook.variables).toEqual({ sha: '{{payload.after}}' });
  });
});

describe('agent keys', () => {
  it('the candidates are the base, then base-2, base-3 ...', () => {
    expect([0, 1, 2, 9].map((attempt) => agentKeyCandidate('support', attempt))).toEqual(['support', 'support-2', 'support-3', 'support-10']);
    expect(AGENT_KEY_MAX_ATTEMPTS).toBeGreaterThanOrEqual(10);
  });

  it('every template key and every candidate is a key a person could have typed', () => {
    for (const attempt of [0, 1, 49]) expect(AGENT_KEY_PATTERN.test(agentKeyCandidate('customer-support', attempt))).toBe(true);
  });

  it('a typed key is lower case letters, digits, - and _, starts with a letter or digit, and is at most 64 long', () => {
    for (const ok of ['a', '9', 'support', 'support_eu-2', 'a'.repeat(64)]) expect(AGENT_KEY_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ['', '-a', '_a', 'Support', 'a b', 'a/b', 'ä', 'a.b', 'a'.repeat(65)]) expect(AGENT_KEY_PATTERN.test(bad), bad).toBe(false);
  });
});

describe('parseInstantiateInput', () => {
  const refusal = (raw: unknown) => {
    try {
      parseInstantiateInput(raw);
    } catch (error) {
      expect(error).toBeInstanceOf(AgentTemplateError);
      return error as AgentTemplateError;
    }
    throw new Error('expected the input to be refused');
  };

  it('needs only the model, and gives everything else its default', () => {
    expect(parseInstantiateInput({ modelKey: 'main' })).toEqual({
      modelKey: 'main', knowledgeKeys: [], guardrailKeys: [], createTriggers: true, timezone: 'UTC', publish: false,
    });
  });

  it('trims the text, drops blanks and repeats from the key lists, and reads null as not given', () => {
    expect(parseInstantiateInput({
      modelKey: ' main ', name: ' My agent ', description: ' Does things ', key: ' my-agent ', knowledgeKeys: [' a ', 'a', ' '], guardrailKeys: ['g', 'g'], sandboxTemplateKey: ' python ',
      createTriggers: false, timezone: 'Europe/Istanbul', publish: true,
    })).toEqual({
      modelKey: 'main', name: 'My agent', description: 'Does things', key: 'my-agent', knowledgeKeys: ['a'], guardrailKeys: ['g'], sandboxTemplateKey: 'python',
      createTriggers: false, timezone: 'Europe/Istanbul', publish: true,
    });
    expect(parseInstantiateInput({ modelKey: 'm', name: null, description: null, key: null, knowledgeKeys: null, guardrailKeys: null, timezone: null, createTriggers: null, publish: null })).toEqual({
      modelKey: 'm', knowledgeKeys: [], guardrailKeys: [], createTriggers: true, timezone: 'UTC', publish: false,
    });
    expect(parseInstantiateInput({ modelKey: 'm', name: '   ', description: '  ' })).not.toHaveProperty('name');
    expect(parseInstantiateInput({ modelKey: 'm', name: '   ', description: '  ' })).not.toHaveProperty('description');
  });

  it('refuses with a 400 and a code the caller can branch on', () => {
    const cases: Array<[unknown, string]> = [
      [null, 'invalid_request'],
      [[], 'invalid_request'],
      ['x', 'invalid_request'],
      [{}, 'invalid_model'],
      [{ modelKey: 7 }, 'invalid_model'],
      [{ modelKey: 'm', key: 'No Good' }, 'invalid_key'],
      [{ modelKey: 'm', timezone: 'Nowhere/Land' }, 'invalid_timezone'],
      [{ modelKey: 'm', name: 5 }, 'invalid_request'],
      [{ modelKey: 'm', name: 'x'.repeat(201) }, 'invalid_request'],
      [{ modelKey: 'm', description: false }, 'invalid_request'],
      [{ modelKey: 'm', description: 'x'.repeat(1001) }, 'invalid_request'],
      [{ modelKey: 'm', knowledgeKeys: 'a' }, 'invalid_request'],
      [{ modelKey: 'm', knowledgeKeys: ['a', 2] }, 'invalid_request'],
      [{ modelKey: 'm', guardrailKeys: { a: 1 } }, 'invalid_request'],
      [{ modelKey: 'm', createTriggers: 'true' }, 'invalid_request'],
      [{ modelKey: 'm', publish: 0 }, 'invalid_request'],
      [{ modelKey: 'm', sandboxTemplateKey: 5 }, 'invalid_request'],
    ];
    for (const [raw, code] of cases) {
      const error = refusal(raw);
      expect(error.status, JSON.stringify(raw)).toBe(400);
      expect(error.code, JSON.stringify(raw)).toBe(code);
    }
  });

  it('takes at most ten of each pick', () => {
    const ten = Array.from({ length: 10 }, (_, index) => `k${index}`);
    expect(parseInstantiateInput({ modelKey: 'm', knowledgeKeys: ten }).knowledgeKeys).toHaveLength(10);
    expect(refusal({ modelKey: 'm', knowledgeKeys: [...ten, 'k10'] }).code).toBe('invalid_request');
    expect(refusal({ modelKey: 'm', guardrailKeys: [...ten, 'k10'] }).code).toBe('invalid_request');
  });
});
