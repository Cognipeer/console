/**
 * Agent templates, dashboard side: what the gallery shows for a search and the
 * filters, what the detail lists, when "Use template" may be submitted, the
 * exact body it sends (timezone included), and how the answer is read - the
 * webhook secret reaches the screen from the one response that carries it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AGENT_TEMPLATES } from '@/lib/services/agents/templates/catalog';
import type {
  AgentTemplateDetail,
  AgentTemplateSummary,
  InstantiateTemplateResult,
} from '@/lib/services/agents/templates/types';
import { agentTemplatesEn } from '@/lib/i18n/messages/agentTemplates.en';
import { agentTemplatesTr } from '@/lib/i18n/messages/agentTemplates.tr';
import {
  EMPTY_GALLERY_FILTER,
  InstantiateRequestError,
  buildInstantiateBody,
  connectorPackages,
  describeContents,
  describeTrigger,
  filterTemplates,
  formBlockers,
  groupTemplates,
  initialForm,
  instantiateTemplateRequest,
  isFilterActive,
  isUsable,
  manualConnectorTriggers,
  selectedConnector,
  skippedTriggers,
  webhookTriggers,
  type GalleryFilter,
} from '@/components/agents/templates/templatesModel';

function summaryOf(key: string, status: 'ready' | 'needs_setup' | 'unavailable' = 'ready'): AgentTemplateSummary {
  const template = AGENT_TEMPLATES.find((candidate) => candidate.key === key)!;
  return {
    key: template.key,
    version: template.version,
    category: template.category,
    icon: template.icon,
    featured: Boolean(template.featured),
    capabilities: template.capabilities,
    modelHint: template.modelHint,
    requires: template.requires,
    surfaces: template.surfaces,
    availability: {
      status,
      items: status === 'unavailable' ? [{ code: 'sandbox_unavailable', severity: 'blocker', detail: 'license' }] : [],
    },
  };
}

function detailOf(key: string, status: 'ready' | 'needs_setup' | 'unavailable' = 'ready'): AgentTemplateDetail {
  const template = AGENT_TEMPLATES.find((candidate) => candidate.key === key)!;
  return {
    ...summaryOf(key, status),
    spec: template.spec,
    resources: template.resources ?? null,
    triggers: template.triggers ?? [],
    tryIt: template.tryIt ?? null,
  };
}

const all = AGENT_TEMPLATES.map((template) => summaryOf(template.key));
const nameOf = (key: string) => (agentTemplatesEn.items as Record<string, { name: string; summary: string }>)[key];
const searchText = (template: AgentTemplateSummary) => `${template.key} ${nameOf(template.key).name} ${nameOf(template.key).summary}`;
const filter = (patch: Partial<GalleryFilter>): GalleryFilter => ({ ...EMPTY_GALLERY_FILTER, ...patch });

describe('gallery search and filters', () => {
  it('lists everything when nothing is asked', () => {
    expect(filterTemplates(all, EMPTY_GALLERY_FILTER, searchText)).toHaveLength(all.length);
    expect(isFilterActive(EMPTY_GALLERY_FILTER)).toBe(false);
  });

  it('finds a template by a word of its name, case-insensitively, and needs every word', () => {
    const hits = filterTemplates(all, filter({ query: 'PULL request' }), searchText).map((template) => template.key);
    expect(hits).toContain('pr-reviewer');
    expect(filterTemplates(all, filter({ query: 'pull zzzznothing' }), searchText)).toEqual([]);
  });

  it('narrows by category', () => {
    const hits = filterTemplates(all, filter({ category: 'engineering' }), searchText);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((template) => template.category === 'engineering')).toBe(true);
  });

  it('keeps only templates that carry every chosen capability', () => {
    const hits = filterTemplates(all, filter({ capabilities: new Set(['webhook', 'structured_output'] as const) }), searchText);
    expect(hits.length).toBeGreaterThan(0);
    for (const template of hits) {
      expect(template.capabilities).toEqual(expect.arrayContaining(['webhook', 'structured_output']));
    }
    expect(isFilterActive(filter({ capabilities: new Set(['webhook'] as const) }))).toBe(true);
  });

  it('groups featured templates first and the rest by category in catalog order', () => {
    const groups = groupTemplates(all);
    expect(groups.featured.every((template) => template.featured)).toBe(true);
    expect(groups.featured.length).toBeGreaterThan(0);
    const order = groups.categories.map((group) => group.category);
    expect(order[0]).toBe('support');
    expect(new Set(order).size).toBe(order.length);
    expect(groups.categories.flatMap((group) => group.templates)).toHaveLength(all.length);
  });
});

describe('what a template will create', () => {
  it('lists skills by title, sub-agents with their headers, variables and output fields', () => {
    const pr = describeContents(detailOf('pr-reviewer'));
    expect(pr.skills).toEqual([{ key: 'tpl-code-review-checklist', title: 'Code review checklist' }]);
    expect(pr.variables.map((variable) => variable.name)).toEqual(['repository', 'focus']);
    expect(pr.variables.find((variable) => variable.name === 'repository')?.default).toBeNull();
    expect(pr.variables.find((variable) => variable.name === 'focus')?.default).toBe('correctness, security, tests');
    expect(pr.outputFields).toEqual(expect.arrayContaining(['summary', 'findings', 'verdict']));

    const router = describeContents(detailOf('support-router'));
    expect(router.subagents.map((sub) => sub.name)).toEqual(expect.arrayContaining(['billing', 'technical', 'sales']));
    expect(router.subagents.every((sub) => sub.header.length > 0)).toBe(true);
  });

  it('names the tools the app has to run for a client-tool template', () => {
    expect(describeContents(detailOf('refund-approval')).clientTools).toEqual(expect.arrayContaining(['lookup_order', 'issue_refund']));
  });

  it('describes triggers by type', () => {
    const lines = detailOf('pr-reviewer').triggers.map(describeTrigger);
    expect(lines[0]).toMatchObject({ kind: 'connector', package: 'cognipeer.github', trigger: 'pull_request' });
    const generic = AGENT_TEMPLATES.flatMap((template) => template.triggers ?? []).find((trigger) => trigger.type === 'webhook')!;
    expect(describeTrigger(generic)).toMatchObject({ kind: 'webhook', preset: 'generic' });
    const scheduled = AGENT_TEMPLATES.flatMap((template) => template.triggers ?? []).find((trigger) => trigger.type === 'schedule')!;
    expect(describeTrigger(scheduled)).toMatchObject({ kind: 'schedule', cron: scheduled.schedule!.cron });
  });
});

describe('the use-template form', () => {
  const models = ['gpt-main'];

  it('starts with the browser timezone, triggers on, publish off and the only model picked', () => {
    const form = initialForm(detailOf('pr-reviewer'), { models, sandboxTemplates: [] }, 'Europe/Istanbul');
    expect(form).toMatchObject({ timezone: 'Europe/Istanbul', createTriggers: true, publish: false, modelKey: 'gpt-main' });
    expect(initialForm(detailOf('pr-reviewer'), { models: ['a', 'b'], sandboxTemplates: [] }).modelKey).toBeNull();
  });

  it('defaults the sandbox template to multi-base when the tenant has it', () => {
    const analyst = detailOf('data-analyst');
    expect(initialForm(analyst, { models, sandboxTemplates: ['py', 'multi-base'] }).sandboxTemplateKey).toBe('multi-base');
    expect(initialForm(analyst, { models, sandboxTemplates: ['py'] }).sandboxTemplateKey).toBe('py');
    expect(initialForm(detailOf('pr-reviewer'), { models, sandboxTemplates: ['py'] }).sandboxTemplateKey).toBeNull();
  });

  it('blocks on name, model, a required knowledge base (unless set up later) and the sandbox template', () => {
    const support = detailOf('knowledge-qa');
    expect(support.requires.knowledge).toBe('required');
    const empty = initialForm(support, { models: [], sandboxTemplates: [] });
    expect(formBlockers(support, empty)).toEqual(['name', 'model', 'knowledge']);
    expect(formBlockers(support, { ...empty, name: 'Support', modelKey: 'm', knowledgeKeys: ['kb'] })).toEqual([]);
    expect(formBlockers(support, { ...empty, name: 'Support', modelKey: 'm', knowledgeLater: true })).toEqual([]);

    const analyst = detailOf('data-analyst');
    const noSandbox = initialForm(analyst, { models, sandboxTemplates: [] });
    expect(formBlockers(analyst, { ...noSandbox, name: 'A' })).toEqual(['sandbox']);
  });

  it('rejects a malformed key', () => {
    const pr = detailOf('pr-reviewer');
    const form = { ...initialForm(pr, { models, sandboxTemplates: [] }), name: 'PR' };
    expect(formBlockers(pr, { ...form, key: 'Bad Key' })).toEqual(['key']);
    expect(formBlockers(pr, { ...form, key: 'good-key_2' })).toEqual([]);
  });

  it('cannot be used when the template is unavailable', () => {
    const analyst = detailOf('data-analyst', 'unavailable');
    expect(isUsable(analyst)).toBe(false);
    expect(isUsable(detailOf('data-analyst', 'needs_setup'))).toBe(true);
    const form = { ...initialForm(analyst, { models, sandboxTemplates: ['multi-base'] }), name: 'A' };
    expect(formBlockers(analyst, form)).toEqual(['unavailable']);
  });

  it('builds the request body, with the browser timezone', () => {
    const pr = detailOf('pr-reviewer');
    const form = { ...initialForm(pr, { models, sandboxTemplates: [] }, 'Europe/Istanbul'), name: ' PR bot ', guardrailKeys: ['g1'], publish: true };
    expect(buildInstantiateBody(pr, form)).toEqual({
      name: 'PR bot',
      modelKey: 'gpt-main',
      guardrailKeys: ['g1'],
      createTriggers: true,
      timezone: 'Europe/Istanbul',
      publish: true,
    });
  });

  it('sends knowledge, key and sandbox only where the template asks for them', () => {
    const support = detailOf('customer-support');
    const body = buildInstantiateBody(support, {
      ...initialForm(support, { models, sandboxTemplates: [] }, 'UTC'),
      name: 'Support', key: 'support-eu', knowledgeKeys: ['kb1', 'kb2'], createTriggers: false,
    });
    expect(body).toMatchObject({ key: 'support-eu', knowledgeKeys: ['kb1', 'kb2'], timezone: 'UTC', publish: false });
    expect(body).not.toHaveProperty('sandboxTemplateKey');

    const analyst = detailOf('data-analyst');
    const analystBody = buildInstantiateBody(analyst, { ...initialForm(analyst, { models, sandboxTemplates: ['multi-base'] }), name: 'A' });
    expect(analystBody.sandboxTemplateKey).toBe('multi-base');
    expect(analystBody).not.toHaveProperty('knowledgeKeys');
    expect(analystBody).not.toHaveProperty('key');
  });
});

describe('connector triggers in the use-template form', () => {
  const models = ['gpt-main'];
  const pr = detailOf('pr-reviewer');
  const formFor = (template: AgentTemplateDetail, patch: Partial<ReturnType<typeof initialForm>> = {}) =>
    ({ ...initialForm(template, { models, sandboxTemplates: [] }, 'UTC'), name: 'Bot', ...patch });

  it('knows which connector packages a template listens to', () => {
    expect(connectorPackages(pr)).toEqual(['cognipeer.github']);
    expect(connectorPackages(detailOf('ci-failure-triage'))).toEqual(['cognipeer.github']);
    expect(connectorPackages(detailOf('customer-support'))).toEqual([]);
  });

  it('takes the picked connector, else the only one the project has, else none', () => {
    const form = formFor(pr);
    expect(selectedConnector(form, 'cognipeer.github', ['c1'])).toBe('c1');
    expect(selectedConnector(form, 'cognipeer.github', ['c1', 'c2'])).toBeNull();
    expect(selectedConnector(form, 'cognipeer.github', [])).toBeNull();
    expect(selectedConnector({ connectors: { 'cognipeer.github': 'c2' } }, 'cognipeer.github', ['c1', 'c2'])).toBe('c2');
    // Cleared on purpose: the only connector is not used behind the user’s back.
    expect(selectedConnector({ connectors: { 'cognipeer.github': null } }, 'cognipeer.github', ['c1'])).toBeNull();
    // A connector that is no longer in the project is not sent.
    expect(selectedConnector({ connectors: { 'cognipeer.github': 'gone' } }, 'cognipeer.github', ['c1'])).toBeNull();
  });

  it('sends the connector per connector trigger, by the trigger’s name in the template', () => {
    const body = buildInstantiateBody(pr, formFor(pr), { 'cognipeer.github': ['c1'] });
    expect(body.connector_ids).toEqual({ 'Review pull requests': 'c1' });
    expect(buildInstantiateBody(pr, formFor(pr, { connectors: { 'cognipeer.github': 'c2' } }), { 'cognipeer.github': ['c1', 'c2'] }).connector_ids)
      .toEqual({ 'Review pull requests': 'c2' });
  });

  it('sends none when there is none to pick (the server then skips the trigger), or when no triggers are asked for', () => {
    expect(buildInstantiateBody(pr, formFor(pr), {})).not.toHaveProperty('connector_ids');
    expect(buildInstantiateBody(pr, formFor(pr), { 'cognipeer.github': ['c1', 'c2'] })).not.toHaveProperty('connector_ids');
    expect(buildInstantiateBody(pr, formFor(pr, { createTriggers: false }), { 'cognipeer.github': ['c1'] })).not.toHaveProperty('connector_ids');
  });

  it('gives only the connector triggers a connector, not the generic webhook next to them', () => {
    const ci = detailOf('ci-failure-triage');
    const connectorTrigger = ci.triggers.find((trigger) => trigger.type === 'connector')!;
    const body = buildInstantiateBody(ci, formFor(ci), { 'cognipeer.github': ['c1'] });
    expect(body.connector_ids).toEqual({ [connectorTrigger.name]: 'c1' });
    expect(ci.triggers.some((trigger) => trigger.type === 'webhook')).toBe(true);
  });

  it('reads the skipped triggers and the manual connector setups from the answer', () => {
    const answer = {
      triggers: [
        { id: 't1', name: 'A', type: 'connector', enabled: false, connector: { connectorId: 'c1', trigger: 'pull_request', subscription: { subscription_id: 's', status: 'manual', kind: 'webhook', callback_url: 'https://c.example/h', secret: 'once', bindings: 1 } } },
        { id: 't2', name: 'B', type: 'connector', enabled: false, connector: { connectorId: 'c1', trigger: 'issues', subscription: { subscription_id: 's2', status: 'active', kind: 'webhook', callback_url: 'https://c.example/h2', bindings: 1 } } },
        { id: 't3', name: 'C', type: 'manual', enabled: false },
      ],
      skipped_triggers: [{ name: 'D', reason: 'connector_required', package: 'cognipeer.github' }],
    } as unknown as InstantiateTemplateResult;
    expect(manualConnectorTriggers(answer).map((trigger) => trigger.id)).toEqual(['t1']);
    expect(skippedTriggers(answer)).toEqual([{ name: 'D', reason: 'connector_required', package: 'cognipeer.github' }]);
    expect(skippedTriggers({} as InstantiateTemplateResult)).toEqual([]);
  });
});

describe('creating the agent', () => {
  const created: InstantiateTemplateResult = {
    agent: { _id: 'a1', key: 'pr-reviewer', name: 'PR bot' } as unknown as InstantiateTemplateResult['agent'],
    template: { key: 'pr-reviewer', version: 1, catalogVersion: 1 },
    triggers: [
      { id: 't1', name: 'Review pull requests', type: 'webhook', enabled: false, webhook: { url: 'https://c.example/hooks/x', preset: 'generic', auth: 'bearer', secret: 'whsec_once' } },
      { id: 't2', name: 'Manual', type: 'manual', enabled: false },
    ],
    skipped_triggers: [],
    setup: [{ code: 'webhook_secret', severity: 'info', message: '' }],
    warnings: [],
  };

  it('posts the body as JSON to the instantiate route and returns the answer, secret included', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(created), { status: 201 }));
    const body = { name: 'PR bot', modelKey: 'm', timezone: 'Europe/Istanbul', publish: false };
    const result = await instantiateTemplateRequest('pr-reviewer', body, fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/agents/templates/pr-reviewer/instantiate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(body);

    const hooks = webhookTriggers(result);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].webhook).toMatchObject({ url: 'https://c.example/hooks/x', secret: 'whsec_once' });
  });

  it('throws the server\'s own message and code when it refuses', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'The key is taken', code: 'key_taken' }), { status: 409 }));
    const failure = await instantiateTemplateRequest('pr-reviewer', { name: 'x', modelKey: 'm' }, fetchMock as unknown as typeof fetch).catch((error) => error);
    expect(failure).toBeInstanceOf(InstantiateRequestError);
    expect(failure).toMatchObject({ message: 'The key is taken', status: 409, code: 'key_taken' });
  });

  it('falls back to the status when the answer has no message', async () => {
    const fetchMock = vi.fn(async () => new Response('not json', { status: 502 }));
    await expect(instantiateTemplateRequest('pr-reviewer', { name: 'x', modelKey: 'm' }, fetchMock as unknown as typeof fetch)).rejects.toThrow('HTTP 502');
  });
});

describe('screens and strings', () => {
  const root = join(__dirname, '../../components/agents');
  const read = (file: string) => readFileSync(join(root, file), 'utf8');

  it('keeps the ui strings in step between English and Turkish', () => {
    const flat = (node: unknown, prefix = ''): string[] =>
      typeof node === 'object' && node !== null
        ? Object.entries(node).flatMap(([key, value]) => flat(value, `${prefix}${key}.`))
        : [prefix];
    expect(flat(agentTemplatesTr.ui).sort()).toEqual(flat(agentTemplatesEn.ui).sort());
  });

  it('shows the secret exactly where the shell renders the created agent, with the one-time warning', () => {
    const shell = read('templates/UseAgentTemplateShell.tsx');
    expect(shell).toContain('ui.created.secretOnce');
    expect(shell).toContain('trigger.webhook!.secret');
  });

  it('uses real toggle buttons for the filters and links the gallery from the agents list', () => {
    expect(read('templates/AgentTemplatesPage.tsx')).toContain('aria-pressed');
    const list = read('AgentsPage.tsx');
    expect(list).toContain("router.push('/dashboard/agents/templates')");
    expect(list).toContain('ui.entry.menuTitle');
    expect(list).toContain('ui.entry.browse');
  });
});
