/**
 * The agent template catalog: what every template has to satisfy so that "Use
 * template" never produces an agent the Studio would have refused, and so that
 * the gallery, the detail view and the create form can trust the data.
 *
 * Content checks run over every template; the validators are the product's own
 * (`validateAgentManifest`, `validateAgentConfig`, the variable and trigger
 * validators), not copies of them.
 */

import Mustache from 'mustache';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  switchToTenant: vi.fn(async () => undefined),
  findModelByKey: vi.fn(),
  findSkillByKey: vi.fn(),
}));

vi.mock('@/lib/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/database')>()),
  getDatabase: vi.fn(async () => db),
}));
vi.mock('@/lib/services/agents/agentSandboxTools', () => ({
  resolveSandboxAvailability: vi.fn(async () => ({
    available: true,
    runner: { listTemplates: async () => [{ key: 'multi-base', name: 'Multi base' }] },
  })),
}));

import type { IAgentConfig } from '@/lib/database';
import { AGENT_MANIFEST_API_VERSION, validateAgentManifest, type AgentManifest } from '@/lib/services/agents/agentManifest';
import { validateAgentConfig } from '@/lib/services/agents/agentConfigValidation';
import { validateTriggerCron } from '@/lib/services/agents/agentTriggerSchedule';
import { WEBHOOK_PRESETS } from '@/lib/services/agents/agentTriggerWebhookAuth';
import { parseFilterRules, templateProblem, variableMappingProblems } from '@/lib/services/agents/agentTriggerWebhookView';
import { resolveRunVariables, validateVariableDeclaration } from '@/lib/services/agents/agentVariables';
import { AGENT_TEMPLATE_CATALOG_VERSION, AGENT_TEMPLATES, findAgentTemplate } from '@/lib/services/agents/templates/catalog';
import { buildTemplateConfig } from '@/lib/services/agents/templates/templateConfig';
import {
  AGENT_TEMPLATE_CAPABILITIES,
  AGENT_TEMPLATE_CATEGORIES,
  AGENT_TEMPLATE_MODEL_HINTS,
  AGENT_TEMPLATE_SURFACES,
  type AgentTemplate,
} from '@/lib/services/agents/templates/types';

const withTemplates = (check: (template: AgentTemplate) => void) => () => {
  for (const template of AGENT_TEMPLATES) {
    try {
      check(template);
    } catch (error) {
      throw new Error(`${template.key}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every property name in a value, with the path it sits at. */
function propertyNames(value: unknown, path = '$', out: Array<{ name: string; path: string }> = []) {
  if (Array.isArray(value)) value.forEach((entry, index) => propertyNames(entry, `${path}[${index}]`, out));
  else if (isObject(value)) {
    for (const [name, child] of Object.entries(value)) {
      out.push({ name, path: `${path}.${name}` });
      // The JSON Schemas a template ships (structured output, client tool arguments) name the fields of the data, not keys of the project.
      if (name === 'schema' || name === 'inputSchema' || name === 'outputSchema') continue;
      propertyNames(child, `${path}.${name}`, out);
    }
  }
  return out;
}

function strictSchemaProblems(schema: unknown, path = '$'): string[] {
  if (!isObject(schema)) return [];
  const problems: string[] = [];
  if (schema.type === 'object' || isObject(schema.properties)) {
    const properties = Object.keys(isObject(schema.properties) ? schema.properties : {});
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    if (schema.additionalProperties !== false) problems.push(`${path} needs additionalProperties: false`);
    if (properties.length !== required.length || properties.some((name) => !required.includes(name))) {
      problems.push(`${path} must require every property`);
    }
    for (const name of properties) problems.push(...strictSchemaProblems((schema.properties as Json)[name], `${path}.${name}`));
  }
  if (schema.items) problems.push(...strictSchemaProblems(schema.items, `${path}[]`));
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(schema[keyword])) (schema[keyword] as unknown[]).forEach((part, index) => problems.push(...strictSchemaProblems(part, `${path}.${keyword}[${index}]`)));
  }
  return problems;
}

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;
const referencedVariables = (text: string) => [...text.matchAll(/\{\{\s*&?\s*variables\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((match) => match[1]);
/** The roots of the tags a system prompt uses (`variables`, and the built-ins `now`, `agent`, `user`). */
const promptTagRoots = (text: string) => (new Mustache.Writer().parse(text) as unknown as Array<[string, string]>)
  .filter(([type]) => type !== 'text' && type !== '!')
  .map(([, name]) => name.split('.')[0]);
const hasWebSearch = (config: Omit<IAgentConfig, 'modelKey'>) =>
  [config.toolBindings, ...(config.subagents ?? []).map((subagent) => subagent.toolBindings)]
    .some((bindings) => (bindings ?? []).some((binding) => binding.source === 'system' && binding.sourceKey === 'web_search'));

describe('catalog shape', () => {
  it('lists each template once, with a stable kebab-case key and a version', () => {
    const keys = AGENT_TEMPLATES.map((template) => template.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(AGENT_TEMPLATE_CATALOG_VERSION).toBeGreaterThanOrEqual(1);
    expect(AGENT_TEMPLATES.length).toBeGreaterThanOrEqual(24);
    withTemplates((template) => {
      expect(template.key).toMatch(/^[a-z0-9][a-z0-9-]{1,47}$/);
      expect(Number.isInteger(template.version) && template.version >= 1).toBe(true);
      expect(findAgentTemplate(template.key)).toBe(template);
    })();
    expect(findAgentTemplate('no-such-template')).toBeUndefined();
  });

  it('uses only known categories, capabilities, model hints and surfaces', withTemplates((template) => {
    expect(AGENT_TEMPLATE_CATEGORIES).toContain(template.category);
    expect(AGENT_TEMPLATE_MODEL_HINTS).toContain(template.modelHint);
    expect(template.capabilities.length).toBeGreaterThan(0);
    expect(new Set(template.capabilities).size).toBe(template.capabilities.length);
    for (const capability of template.capabilities) expect(AGENT_TEMPLATE_CAPABILITIES).toContain(capability);
    expect(template.surfaces.length).toBeGreaterThan(0);
    expect(new Set(template.surfaces).size).toBe(template.surfaces.length);
    for (const surface of template.surfaces) expect(AGENT_TEMPLATE_SURFACES).toContain(surface);
    expect(template.icon).toMatch(/^Icon[A-Z][A-Za-z0-9]*$/);
  }));

  it('fills every category and has a featured row', () => {
    for (const category of AGENT_TEMPLATE_CATEGORIES) {
      expect(AGENT_TEMPLATES.some((template) => template.category === category), category).toBe(true);
    }
    expect(AGENT_TEMPLATES.filter((template) => template.featured).length).toBeGreaterThanOrEqual(6);
  });

  it('names icons the icon library has', async () => {
    const icons = (await import('@tabler/icons-react')) as unknown as Record<string, unknown>;
    for (const template of AGENT_TEMPLATES) expect(icons[template.icon], `${template.key}: ${template.icon}`).toBeTruthy();
  });

  it('declares capabilities that are really in the spec, and every main capability the spec uses', withTemplates((template) => {
    const { spec, requires } = template;
    const has = (capability: (typeof AGENT_TEMPLATE_CAPABILITIES)[number]) => template.capabilities.includes(capability);
    const actual: Record<string, boolean> = {
      knowledge: Boolean(requires.knowledge),
      web_search: hasWebSearch(spec),
      client_tools: (spec.clientTools?.length ?? 0) > 0,
      approval: spec.humanInTheLoop?.toolApproval?.enabled === true,
      ask_user: spec.humanInTheLoop?.askUser?.enabled === true,
      subagents: (spec.subagents?.length ?? 0) > 0,
      skills: (spec.skills?.length ?? 0) > 0,
      structured_output: spec.structuredOutput?.enabled === true,
      variables: (spec.variables?.length ?? 0) > 0,
      schedule: (template.triggers ?? []).some((trigger) => trigger.type === 'schedule'),
      // The `webhook` chip stands for every event-driven trigger: a generic webhook or a connector event.
      webhook: (template.triggers ?? []).some((trigger) => trigger.type === 'webhook' || trigger.type === 'connector'),
      sandbox: spec.sandbox?.enabled === true,
      guardrails: requires.guardrails === 'recommended',
      mcp: (spec.toolBindings ?? []).some((binding) => binding.source === 'mcp'),
    };
    for (const [capability, present] of Object.entries(actual)) {
      expect(has(capability as (typeof AGENT_TEMPLATE_CAPABILITIES)[number]), capability).toBe(present);
    }
    expect(Boolean(requires.webSearch)).toBe(actual.web_search);
    expect(Boolean(requires.sandbox)).toBe(actual.sandbox);
  }));

  it('says it is a trigger template exactly when it suggests triggers', withTemplates((template) => {
    expect(template.surfaces.includes('trigger')).toBe((template.triggers?.length ?? 0) > 0);
  }));
});

describe('what a template may carry', () => {
  it('has no model and no key of the project: those are chosen when the agent is created', withTemplates((template) => {
    const allowed = (path: string) => /^\$\.spec\.(toolBindings|subagents\[\d+\]\.toolBindings)\[\d+\]\.sourceKey$/.test(path);
    const problems = propertyNames({ spec: template.spec, triggers: template.triggers, resources: template.resources, tryIt: template.tryIt })
      .filter(({ name, path }) => /[a-z]Keys?$/.test(name) && !allowed(path))
      .map(({ path }) => path);
    expect(problems).toEqual([]);
    expect(JSON.stringify(template)).not.toContain('modelKey');
    for (const binding of [...(template.spec.toolBindings ?? []), ...(template.spec.subagents ?? []).flatMap((subagent) => subagent.toolBindings ?? [])]) {
      expect(binding.source, 'only built-in tools: nothing of the project').toBe('system');
      expect(binding.sourceKey).toBe('web_search');
      expect(binding.config?.providerKey).toBeUndefined();
    }
    expect(template.spec.attachments?.bucketKey).toBeUndefined();
    expect(template.spec.sandbox?.templateKey).toBeUndefined();
  }));

  it('does not set temperature, top-p or a token cap (the model\'s own settings govern)', withTemplates((template) => {
    expect(template.spec.temperature).toBeUndefined();
    expect(template.spec.topP).toBeUndefined();
    expect(template.spec.maxTokens).toBeUndefined();
  }));

  it('has a system prompt of 120-450 words with headed sections, written in English', withTemplates((template) => {
    const prompt = template.spec.systemPrompt ?? '';
    const words = wordCount(prompt);
    expect(words, `${words} words`).toBeGreaterThanOrEqual(120);
    expect(words, `${words} words`).toBeLessThanOrEqual(450);
    expect(prompt.split('\n').filter((line) => /^#{1,3}\s/.test(line)).length).toBeGreaterThanOrEqual(3);
    for (const root of promptTagRoots(prompt)) expect(['variables', 'now', 'agent', 'user'], `{{${root}...}}`).toContain(root);
  }));

  it('keeps prompts from using the renamed concepts\' old names', withTemplates((template) => {
    expect(JSON.stringify(template)).not.toMatch(/routine|\binputs?\b JSON block|Inputs block/i);
  }));

  it('embeds only skills keyed tpl-*, each bound by the spec, within the size limit', withTemplates((template) => {
    const skills = template.resources?.skills ?? [];
    expect(skills.map((skill) => skill.key).sort()).toEqual([...(template.spec.skills ?? [])].sort());
    for (const skill of skills) {
      expect(skill.key).toMatch(/^tpl-[a-z0-9-]+$/);
      expect(skill.title.trim()).not.toBe('');
      expect(skill.header.trim()).not.toBe('');
      expect(skill.body.length).toBeLessThanOrEqual(1500);
    }
    expect(Object.keys(template.resources ?? {}).filter((name) => name !== 'skills')).toEqual([]);
  }));

  it('has inline sub-agents only, with a prompt and a header, under a bounded policy', withTemplates((template) => {
    const subagents = template.spec.subagents ?? [];
    for (const subagent of subagents) {
      expect(subagent.kind).toBe('inline');
      expect((subagent.systemPrompt ?? '').trim()).not.toBe('');
      expect(subagent.header.trim()).not.toBe('');
      expect(subagent.modelKey).toBeUndefined();
      expect(subagent.knowledgeEngineKey).toBeUndefined();
    }
    expect(new Set(subagents.map((subagent) => subagent.name)).size).toBe(subagents.length);
    if (subagents.length > 0) {
      const policy = template.spec.subagentPolicy;
      expect(policy?.mode).toBe('registry_only');
      expect(policy?.maxDepth).toBe(1);
      expect(policy?.maxChildCalls ?? 99).toBeLessThanOrEqual(8);
      expect(policy?.maxParallel ?? 99).toBeLessThanOrEqual(4);
    }
  }));

  it('asks a person before an action with side effects, and denies it when nobody is there', withTemplates((template) => {
    const tools = template.spec.clientTools ?? [];
    if (tools.length === 0) return;
    const hitl = template.spec.humanInTheLoop;
    expect(hitl?.toolApproval?.enabled).toBe(true);
    expect(hitl?.toolApproval?.defaultPolicy).toBe('never');
    expect(hitl?.unattended).toBe('deny');
    const names = tools.map((tool) => tool.name);
    for (const name of Object.keys(hitl?.toolApproval?.tools ?? {})) expect(names).toContain(name);
    expect(Object.values(hitl?.toolApproval?.tools ?? {})).toContain('always');
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[A-Za-z0-9_]{1,64}$/);
      expect(tool.description.trim()).not.toBe('');
    }
  }));

  it('gives the sandbox template the sandbox and asks nothing else of the project', withTemplates((template) => {
    if (!template.requires.sandbox) return expect(template.spec.sandbox).toBeUndefined();
    expect(template.spec.sandbox?.enabled).toBe(true);
    expect(template.requires).toEqual({ sandbox: 'required' });
  }));
});

describe('variables', () => {
  it('are declared validly, at most 8 per template', withTemplates((template) => {
    const variables = template.spec.variables ?? [];
    expect(variables.length).toBeLessThanOrEqual(8);
    expect(validateVariableDeclaration(variables)).toEqual([]);
    for (const variable of variables) {
      expect(variable.label?.trim(), `${variable.name} label`).toBeTruthy();
      expect(variable.description?.trim(), `${variable.name} description`).toBeTruthy();
    }
  }));

  it('never make a chat message fail: each has a default or is optional', withTemplates((template) => {
    if (!template.surfaces.includes('chat')) return;
    for (const variable of template.spec.variables ?? []) {
      expect(variable.required === true && variable.default === undefined, `${variable.name} is required without a default`).toBe(false);
    }
  }));

  it('are used by the prompt as {{variables.name}}, and only declared ones are (JSON ones may be read from the Variables block)', withTemplates((template) => {
    const declared = new Map((template.spec.variables ?? []).map((variable) => [variable.name, variable]));
    const used = new Set(referencedVariables(template.spec.systemPrompt ?? ''));
    for (const name of used) expect([...declared.keys()], `{{variables.${name}}} is not declared`).toContain(name);
    for (const [name, variable] of declared) {
      if (variable.type !== 'json') expect(used.has(name), `${name} is never used in the prompt`).toBe(true);
    }
  }));

  it('resolve to the values of an empty request (every default is valid)', withTemplates((template) => {
    const resolved = resolveRunVariables(template.spec.variables, null);
    expect(resolved.ok, JSON.stringify(resolved)).toBe(true);
  }));

  it('have a sample message (and sample values) that fit them', withTemplates((template) => {
    if (!template.tryIt) return;
    expect(template.tryIt.message.trim()).not.toBe('');
    const resolved = resolveRunVariables(template.spec.variables, template.tryIt.variables ?? null);
    expect(resolved.ok, JSON.stringify(resolved)).toBe(true);
  }));
});

describe('structured output', () => {
  it('is strict-compatible: strict, every object closed, every property required', withTemplates((template) => {
    const output = template.spec.structuredOutput;
    if (!output) return;
    expect(output.enabled).toBe(true);
    expect(output.strict).toBe(true);
    expect(output.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(isObject(output.schema) && output.schema.type === 'object').toBe(true);
    expect(strictSchemaProblems(output.schema)).toEqual([]);
  }));

  it('has client tool arguments that are closed objects too', withTemplates((template) => {
    for (const tool of template.spec.clientTools ?? []) expect(strictSchemaProblems(tool.inputSchema), tool.name).toEqual([]);
  }));
});

describe('suggested triggers', () => {
  it('are schedules, webhooks, connector events or manual, valid as the trigger API would take them', withTemplates((template) => {
    for (const trigger of template.triggers ?? []) {
      expect(trigger.name.trim()).not.toBe('');
      expect(['schedule', 'webhook', 'manual', 'connector']).toContain(trigger.type);
      expect(trigger.prompt.length).toBeLessThanOrEqual(32_000);
      expect(JSON.stringify(trigger)).not.toContain('received_at');
      if (trigger.type === 'schedule') {
        expect(trigger.webhook).toBeUndefined();
        expect(validateTriggerCron(trigger.schedule?.cron)).toBeNull();
        const resolved = resolveRunVariables(template.spec.variables, trigger.variables ?? null);
        expect(resolved.ok, JSON.stringify(resolved)).toBe(true);
        expect(trigger.prompt.trim()).not.toBe('');
      }
      if (trigger.type === 'connector') {
        expect(trigger.schedule).toBeUndefined();
        expect(trigger.webhook).toBeUndefined();
        expect(trigger.connector?.package).toMatch(/^[a-z0-9]+(\.[a-z0-9_-]+)+$/);
        expect(trigger.connector?.trigger).toMatch(/^[a-z][a-z0-9_]*$/);
        const filter = parseFilterRules(trigger.connector?.filter ?? []);
        expect(filter.ok, JSON.stringify(filter)).toBe(true);
        expect(templateProblem(trigger.prompt)).toBeNull();
        expect(variableMappingProblems(template.spec.variables, trigger.variables)).toEqual([]);
        expect(trigger.prompt.trim() !== '' || trigger.connector?.includePayload === true).toBe(true);
      }
      if (trigger.type === 'webhook') {
        expect(trigger.schedule).toBeUndefined();
        expect(trigger.connector).toBeUndefined();
        expect(WEBHOOK_PRESETS).toContain(trigger.webhook?.preset);
        const filter = parseFilterRules(trigger.webhook?.filter ?? []);
        expect(filter.ok, JSON.stringify(filter)).toBe(true);
        expect(templateProblem(trigger.prompt)).toBeNull();
        expect(variableMappingProblems(template.spec.variables, trigger.variables)).toEqual([]);
        // The prompt reads the delivery: the payload alone may be the whole message, but then it must be included.
        expect(trigger.prompt.trim() !== '' || trigger.webhook?.include_payload === true).toBe(true);
      }
    }
  }));
});

describe('as an agent', () => {
  beforeEach(() => {
    db.findModelByKey.mockResolvedValue({ key: 'chat-model', category: 'llm', pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 } });
    db.findSkillByKey.mockImplementation(async (key: string) => ({ key, status: 'active' }));
  });

  const config = (template: AgentTemplate) => buildTemplateConfig(template, { modelKey: 'chat-model', sandboxTemplateKey: 'multi-base' });

  it('becomes a manifest the importer accepts', withTemplates((template) => {
    const manifest: AgentManifest = {
      apiVersion: AGENT_MANIFEST_API_VERSION,
      kind: 'Agent',
      metadata: { key: template.key, name: template.key, exportedAt: new Date(0).toISOString() },
      spec: config(template),
      dependencies: [],
      ...(template.resources ? { resources: template.resources } : {}),
    };
    expect(validateAgentManifest(manifest)).toEqual([]);
  }));

  it('passes the validation a Studio save runs, with a model, its skills and the sandbox in place', async () => {
    for (const template of AGENT_TEMPLATES) {
      const result = await validateAgentConfig({ tenantDbName: 'tenant', tenantId: 'tenant-1', projectId: 'project-1', config: config(template) });
      expect(result.errors, template.key).toEqual([]);
    }
  });

  it('is not changed by being turned into an agent', () => {
    const before = JSON.stringify(AGENT_TEMPLATES);
    for (const template of AGENT_TEMPLATES) {
      buildTemplateConfig(template, { modelKey: 'chat-model', knowledgeKeys: ['a', 'b'], guardrailKeys: ['g'], sandboxTemplateKey: 'multi-base', skillKeys: { 'tpl-support-tone': 'tpl-support-tone-2' } });
    }
    expect(JSON.stringify(AGENT_TEMPLATES)).toBe(before);
  });
});
