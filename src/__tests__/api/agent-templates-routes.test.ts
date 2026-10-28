/**
 * The agent templates API of the dashboard over its real Fastify handlers and a
 * REAL SQLite store:
 *
 *   GET  /api/agents/templates                            the gallery, with what each template still needs
 *   GET  /api/agents/templates/:templateKey               one template in full
 *   POST /api/agents/templates/:templateKey/instantiate   create the agent
 *
 * The session context is given (authentication and the service check are the
 * gate's own tests); the sandbox module is stood in for by `hoisted.sandbox`.
 * Everything else is the product's code: the model, knowledge and guardrail
 * lookups, the Studio's new-agent validation, the trigger parser, the skill
 * library and the agent store. Two stores are made to fail on demand to prove
 * that a half-made agent is never left behind.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  db: { current: null as unknown },
  session: { current: null as unknown },
  /** What `resolveSandboxAvailability` answers. */
  sandbox: { current: null as unknown },
  failures: { failTriggerCall: 0, triggerCalls: 0, publish: false },
}));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(hoisted.db.current),
  };
});
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  type Handler = (request: unknown, reply: unknown) => unknown;
  return {
    ...actual,
    // Authentication and the service check are the gate's (its own tests); here the caller is given.
    withApiRequestContext: (handler: Handler) => async (request: unknown, reply: unknown) => handler(request, reply),
    requireProjectContextForRequest: vi.fn(async () => hoisted.session.current),
  };
});
vi.mock('@/server/api/plugins/agent-config-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/plugins/agent-config-write')>();
  return { ...actual, redactAgent: vi.fn(actual.redactAgent) };
});
vi.mock('@/lib/services/agents/agentSandboxTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/agents/agentSandboxTools')>();
  return { ...actual, resolveSandboxAvailability: vi.fn(async () => hoisted.sandbox.current) };
});
vi.mock('@/lib/services/agents/agentTriggers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/agents/agentTriggers')>();
  return {
    ...actual,
    createAgentTriggerHosted: async (...args: Parameters<typeof actual.createAgentTriggerHosted>) => {
      hoisted.failures.triggerCalls += 1;
      if (hoisted.failures.failTriggerCall === hoisted.failures.triggerCalls) throw new Error('the trigger store is down');
      return actual.createAgentTriggerHosted(...args);
    },
  };
});
vi.mock('@/lib/services/agents/agentService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/agents/agentService')>();
  return {
    ...actual,
    publishAgent: async (...args: Parameters<typeof actual.publishAgent>) => {
      if (hoisted.failures.publish) throw new Error('the version store is down');
      return actual.publishAgent(...args);
    },
  };
});

import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import type { IAgent } from '@/lib/database';
import { agentTemplatesEn } from '@/lib/i18n/messages/agentTemplates.en';
import { authorizeServiceRequest, getPermissionServiceForPath, getRequiredPermissionLevel } from '@/lib/security/rbac';
import { resolveSandboxAvailability } from '@/lib/services/agents/agentSandboxTools';
import { listAgentTriggers, serializeAgentTrigger } from '@/lib/services/agents/agentTriggers';
import { listSkills, updateSkill } from '@/lib/services/agents/skillService';
import { AGENT_TEMPLATE_CATALOG_VERSION, AGENT_TEMPLATES, findAgentTemplate } from '@/lib/services/agents/templates/catalog';
import { AgentTemplateError, instantiateTemplate, type AgentTemplateWriteDeps } from '@/lib/services/agents/templates/agentTemplateService';
import { createGuardrail } from '@/lib/services/guardrail';
import { agentsApiPlugin } from '@/server/api/plugins/agents';
import { redactAgent } from '@/server/api/plugins/agent-config-write';
import { agentTemplatesApiPlugin } from '@/server/api/plugins/agent-templates';
import { prepareTriggerWrite } from '@/server/api/plugins/agent-triggers';
import { __resetConnectorTriggerHostForTests, registerConnectorTriggerHost } from '@/enterprise/connector-triggers';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { createFakeConnectorHost } from '../helpers/fakeConnectorHost';

const DB_NAME = 'tenant_template_routes';
const PROJECT_ID = 'proj-1';
const OTHER_PROJECT_ID = 'proj-2';
const MODEL = 'gpt-main';

/** The `config.authz` each templates route registered with. */
const declared: Record<string, unknown> = {};

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const json = (res: { body: string }) => parseJsonBody<Json>(res.body);

const read = (suffix = '') => app.inject({ method: 'GET', url: `/api/agents/templates${suffix}` });
const instantiate = (templateKey: string, payload?: unknown) => app.inject({
  method: 'POST',
  url: `/api/agents/templates/${templateKey}/instantiate`,
  ...(payload !== undefined ? { payload: payload as never } : {}),
});
/** The body every happy path starts from. */
const pick = (extra: Json = {}) => ({ modelKey: MODEL, ...extra });

const sandboxWith = (...templateKeys: string[]) => ({
  available: true,
  runner: { listTemplates: async () => templateKeys.map((key) => ({ key, name: key })) },
});
const noSandbox = (reason: 'edition' | 'license' = 'edition') => ({ available: false, reason });

const asUser = (role: string) => {
  hoisted.session.current = {
    projectId: PROJECT_ID,
    user: { _id: 'user-1', role },
    session: { tenantDbName: DB_NAME, tenantId, userId: 'user-1', licenseType: 'FREE' },
  };
};

// ── Fixtures of the project ──────────────────────────────────────────────

const addModel = (key: string, overrides: Json = {}) => db.createModel({
  tenantId, projectId: PROJECT_ID, key, name: key, providerKey: 'openai-main', providerDriver: 'openai', category: 'llm', modelId: `${key}-id`,
  isMultimodal: false, supportsToolCalls: true, settings: {}, pricing: { currency: 'USD', inputTokenPer1M: 1, outputTokenPer1M: 2, cachedTokenPer1M: 0 },
  metadata: {}, createdBy: 'user-1', ...overrides,
} as never);
const addKnowledge = (key: string, projectId: string | undefined = PROJECT_ID) => db.createRagModule({
  tenantId, projectId, key, name: key, embeddingModelKey: 'embed', vectorProviderKey: 'qdrant', vectorIndexKey: `idx-${key}`,
  chunkConfig: { strategy: 'recursive_character', chunkSize: 1000, chunkOverlap: 200 }, status: 'active', createdBy: 'user-1',
});
const addWebSearch = (overrides: Json = {}) => db.createProvider({
  tenantId, projectId: PROJECT_ID, key: 'brave', type: 'websearch', driver: 'brave-search', label: 'Brave', status: 'active',
  credentialsEnc: 'sealed', settings: {}, createdBy: 'user-1', ...overrides,
} as never);
const addGuardrail = (name: string, projectId?: string) => createGuardrail(DB_NAME, tenantId, 'user-1', { name, type: 'preset', action: 'block', ...(projectId ? { projectId } : {}) });
const addAgent = (key: string, projectId = PROJECT_ID) => db.createAgent({
  tenantId, projectId, key, name: key, status: 'active', createdBy: 'user-1', config: { modelKey: MODEL },
});

const agentsOfTenant = () => db.listAgents();
const skillsOfProject = () => listSkills(DB_NAME, PROJECT_ID);
const scope = () => ({ tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID });
const triggersOf = (agent: Pick<IAgent, 'key'>) => listAgentTriggers(scope(), agent.key);

/** Nothing of a template was made: no agent, no skill, no trigger. */
async function expectNothingCreated() {
  expect(await agentsOfTenant()).toEqual([]);
  expect(await skillsOfProject()).toEqual([]);
  expect(await listAgentTriggers(scope())).toEqual([]);
}

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.failures.failTriggerCall = 0;
  hoisted.failures.triggerCalls = 0;
  hoisted.failures.publish = false;
  tmpDir = mkdtempSync(path.join(tmpdir(), 'template-routes-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  hoisted.db.current = db;
  const tenant = await db.createTenant({ companyName: 'Acme', slug: 'acme-template-routes', dbName: DB_NAME, licenseType: 'FREE', ownerId: 'owner-1' });
  tenantId = String(tenant._id);
  await db.switchToTenant(DB_NAME);
  hoisted.sandbox.current = noSandbox();
  asUser('owner');
  // The agents plugin is mounted first, as in the product: it owns `/agents/:agentId`, which the static `/agents/templates` routes must win over.
  const both: FastifyPluginAsync = async (instance) => {
    await instance.register(agentsApiPlugin);
    instance.addHook('onRoute', (route) => {
      const url = route.url.replace(/^\/api/, '');
      const method = String(route.method);
      // Fastify adds a HEAD twin to every GET; it carries the same config.
      if (url.startsWith('/agents/templates') && method !== 'HEAD') declared[`${method} ${url}`] = route.config?.authz;
    });
    await instance.register(agentTemplatesApiPlugin);
  };
  app = await createFastifyApiTestApp(both);
});

afterEach(async () => {
  __resetConnectorTriggerHostForTests();
  await app?.close();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── GET /agents/templates ────────────────────────────────────────────────

describe('GET /agents/templates', () => {
  const byKey = (body: Json) => Object.fromEntries((body.templates as Json[]).map((template) => [template.key, template])) as Record<string, Json>;

  it('lists the whole catalog, structure only (no spec, no texts), and is not taken for an agent id', async () => {
    const res = await read();
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.catalogVersion).toBe(AGENT_TEMPLATE_CATALOG_VERSION);
    expect((body.templates as Json[]).map((template) => template.key)).toEqual(AGENT_TEMPLATES.map((template) => template.key));
    for (const template of body.templates as Json[]) {
      expect(Object.keys(template).sort()).toEqual(
        ['availability', 'capabilities', 'category', 'featured', 'icon', 'key', 'modelHint', 'requires', 'surfaces', 'version'],
      );
      expect(template.featured).toBeTypeOf('boolean');
    }
  });

  it('a project with no chat model needs one for every template; the sandbox one is unavailable here', async () => {
    const templates = byKey(json(await read()));
    for (const [key, template] of Object.entries(templates)) {
      expect(template.availability.items, key).toContainEqual({ code: 'no_llm_model', severity: 'blocker' });
      expect(template.availability.status, key).toBe(key === 'data-analyst' ? 'unavailable' : 'needs_setup');
    }
  });

  it('a chat model of another project, or a model that is not a chat model, does not count', async () => {
    await addModel('other-project-model', { projectId: OTHER_PROJECT_ID });
    await addModel('embedder', { category: 'embedding' });
    const templates = byKey(json(await read()));
    expect(templates['release-notes-writer']!.availability).toEqual({ status: 'needs_setup', items: [{ code: 'no_llm_model', severity: 'blocker' }] });
  });

  it('with a chat model, what an optional part would use is a warning and a required part is a blocker', async () => {
    await addModel(MODEL);
    const templates = byKey(json(await read()));
    expect(templates['release-notes-writer']!.availability).toEqual({ status: 'ready', items: [] });
    expect(templates['customer-support']!.availability).toEqual({ status: 'ready', items: [{ code: 'knowledge_missing', severity: 'warning' }] });
    expect(templates['lead-qualifier']!.availability).toEqual({ status: 'ready', items: [{ code: 'web_search_unavailable', severity: 'warning' }] });
    expect(templates['knowledge-qa']!.availability).toEqual({ status: 'needs_setup', items: [{ code: 'knowledge_missing', severity: 'blocker' }] });
    expect(templates['deep-research']!.availability).toEqual({ status: 'needs_setup', items: [{ code: 'web_search_unavailable', severity: 'blocker' }] });
    expect(templates['data-analyst']!.availability).toEqual({ status: 'unavailable', items: [{ code: 'sandbox_unavailable', severity: 'blocker', detail: 'edition' }] });
  });

  it('a knowledge base, an active web search provider and the sandbox make those templates ready', async () => {
    await addModel(MODEL);
    await addKnowledge('faq');
    await addWebSearch();
    hoisted.sandbox.current = sandboxWith('multi-base');
    const templates = byKey(json(await read()));
    for (const key of ['knowledge-qa', 'customer-support', 'deep-research', 'lead-qualifier', 'data-analyst']) {
      expect(templates[key]!.availability, key).toEqual({ status: 'ready', items: [] });
    }
  });

  it('a web search provider that is disabled, or assigned to another project, does not count', async () => {
    await addModel(MODEL);
    await addWebSearch({ status: 'disabled' });
    await addWebSearch({ key: 'brave-other', projectId: OTHER_PROJECT_ID });
    expect(byKey(json(await read()))['deep-research']!.availability.items).toEqual([{ code: 'web_search_unavailable', severity: 'blocker' }]);
  });

  it('says why the sandbox is not there: this edition has no module, or the license has no sandbox', async () => {
    await addModel(MODEL);
    hoisted.sandbox.current = noSandbox('license');
    expect(byKey(json(await read()))['data-analyst']!.availability.items).toEqual([{ code: 'sandbox_unavailable', severity: 'blocker', detail: 'license' }]);
  });

  it('a sandbox with no template yet needs one set up', async () => {
    await addModel(MODEL);
    hoisted.sandbox.current = sandboxWith();
    expect(byKey(json(await read()))['data-analyst']!.availability).toEqual({ status: 'needs_setup', items: [{ code: 'sandbox_template_missing', severity: 'blocker' }] });
  });

  it('a sandbox whose templates cannot be listed is still offered (the create checks the one picked)', async () => {
    await addModel(MODEL);
    hoisted.sandbox.current = { available: true, runner: { listTemplates: async () => { throw new Error('runner is down'); } } };
    const res = await read();
    expect(res.statusCode).toBe(200);
    expect(byKey(json(res))['data-analyst']!.availability).toEqual({ status: 'ready', items: [] });
  });

  it('a sandbox lookup that fails does not fail the gallery: the sandbox templates read as unavailable', async () => {
    await addModel(MODEL);
    hoisted.sandbox.current = null;
    vi.mocked(resolveSandboxAvailability).mockRejectedValueOnce(new Error('license service is down'));
    const res = await read();
    expect(res.statusCode).toBe(200);
    expect(byKey(json(res))['data-analyst']!.availability.status).toBe('unavailable');
    expect(byKey(json(res))['release-notes-writer']!.availability.status).toBe('ready');
  });

  it('a web search or knowledge lookup that fails does not fail the gallery: that part reads as missing', async () => {
    await addModel(MODEL);
    await addKnowledge('faq');
    await addWebSearch();
    vi.spyOn(db, 'listProviders').mockRejectedValueOnce(new Error('the provider store is down'));
    vi.spyOn(db, 'listRagModules').mockRejectedValueOnce(new Error('the knowledge store is down'));
    const res = await read();
    expect(res.statusCode).toBe(200);
    const templates = byKey(json(res));
    expect(templates['deep-research']!.availability.items).toEqual([{ code: 'web_search_unavailable', severity: 'blocker' }]);
    expect(templates['knowledge-qa']!.availability.items).toEqual([{ code: 'knowledge_missing', severity: 'blocker' }]);
    expect(templates['release-notes-writer']!.availability.status).toBe('ready');
  });
});

// ── GET /agents/templates/:templateKey ───────────────────────────────────

describe('GET /agents/templates/:templateKey', () => {
  it('returns the template with its spec (no model, no project keys), skills, triggers and sample message', async () => {
    await addModel(MODEL);
    const res = await read('/ci-failure-triage');
    expect(res.statusCode).toBe(200);
    const { template } = json(res);
    expect(template).toMatchObject({ key: 'ci-failure-triage', category: 'engineering', availability: { status: 'ready', items: [] } });
    expect(template.spec).not.toHaveProperty('modelKey');
    expect(template.spec.systemPrompt).toEqual(expect.any(String));
    expect(template.triggers).toHaveLength(2);
    expect(template.triggers.map((trigger: Json) => trigger.type)).toEqual(['connector', 'webhook']);
    expect(template.triggers[0].connector).toMatchObject({ package: 'cognipeer.github', trigger: 'workflow_run' });
    expect(template.resources).toBeNull();
    expect(template.tryIt).toEqual(expect.objectContaining({ message: expect.any(String) }));
  });

  it('carries the skills a template creates with the agent', async () => {
    const { template } = json(await read('/customer-support'));
    expect(template.resources.skills.map((skill: Json) => skill.key)).toEqual(['tpl-support-tone']);
    expect(template.triggers).toEqual([]);
  });

  it('is a 404 with a stable code for a template that does not exist', async () => {
    const res = await read('/no-such-template');
    expect(res.statusCode).toBe(404);
    expect(json(res)).toMatchObject({ code: 'template_not_found' });
  });
});

// ── POST /agents/templates/:templateKey/instantiate ──────────────────────

describe('POST instantiate: the agent', () => {
  beforeEach(async () => {
    await addModel(MODEL);
  });

  it('creates an active agent in the caller\'s project from the template, as the Studio would store it', async () => {
    const res = await instantiate('customer-support', pick());
    expect(res.statusCode).toBe(201);
    const body = json(res);
    const copy = agentTemplatesEn.items['customer-support'];
    expect(body.agent).toMatchObject({
      key: 'customer-support',
      name: copy.name,
      description: copy.summary,
      status: 'active',
      projectId: PROJECT_ID,
      createdBy: 'user-1',
      metadata: { template: { key: 'customer-support', version: 1, catalogVersion: AGENT_TEMPLATE_CATALOG_VERSION } },
    });
    expect(body.template).toEqual({ key: 'customer-support', version: 1, catalogVersion: AGENT_TEMPLATE_CATALOG_VERSION });
    expect(body.agent.config.modelKey).toBe(MODEL);
    expect(body.agent.config.systemPrompt).toBe(findAgentTemplate('customer-support')!.spec.systemPrompt);
    // The template says how its agent asks before acting; the dashboard's own default is not laid over it.
    expect(body.agent.config.humanInTheLoop).toEqual(findAgentTemplate('customer-support')!.spec.humanInTheLoop);

    const stored = await db.findAgentByKey('customer-support', PROJECT_ID);
    expect(stored).toMatchObject({ name: copy.name, status: 'active', config: { modelKey: MODEL } });
    expect(String(stored!._id)).toBe(String(body.agent._id));
  });

  it('is unpublished unless asked, and says so in the setup list', async () => {
    const body = json(await instantiate('customer-support', pick()));
    expect(body.agent.publishedVersion ?? 0).toBe(0);
    expect(body.setup.map((item: Json) => item.code)).toContain('publish_needed');
  });

  it('publish: true publishes version 1 and drops the reminder', async () => {
    const body = json(await instantiate('customer-support', pick({ publish: true })));
    expect(body.agent.publishedVersion).toBe(1);
    expect(body.setup.map((item: Json) => item.code)).not.toContain('publish_needed');
    const version = await db.findLatestAgentVersion(String(body.agent._id));
    expect(version).toMatchObject({ version: 1, agentKey: 'customer-support', snapshot: { config: { modelKey: MODEL } } });
  });

  it('names the agent as asked (trimmed), else with the template\'s name', async () => {
    const named = json(await instantiate('translator', pick({ name: '  Legal translator  ' })));
    expect(named.agent.name).toBe('Legal translator');
    const plain = json(await instantiate('translator', pick()));
    expect(plain.agent.name).toBe(agentTemplatesEn.items.translator.name);
  });

  it('describes the agent as asked (trimmed), else with the template\'s summary', async () => {
    const described = json(await instantiate('translator', pick({ description: '  Our legal translator  ' })));
    expect(described.agent.description).toBe('Our legal translator');
    const plain = json(await instantiate('translator', pick()));
    expect(plain.agent.description).toBe(agentTemplatesEn.items.translator.summary);
  });

  it('the first free key: the template key, then -2, -3 ... (a key of another project counts, the stores keep one per tenant)', async () => {
    expect(json(await instantiate('translator', pick())).agent.key).toBe('translator');
    expect(json(await instantiate('translator', pick())).agent.key).toBe('translator-2');
    await addAgent('translator-3', OTHER_PROJECT_ID);
    expect(json(await instantiate('translator', pick())).agent.key).toBe('translator-4');
  });

  it('a key that was asked for is used, and refused with a 409 when it is taken (here or in another project)', async () => {
    expect(json(await instantiate('translator', pick({ key: 'legal-translator' }))).agent.key).toBe('legal-translator');

    const clash = await instantiate('translator', pick({ key: 'legal-translator' }));
    expect(clash.statusCode).toBe(409);
    expect(json(clash)).toMatchObject({ code: 'agent_key_conflict' });

    await addAgent('taken-elsewhere', OTHER_PROJECT_ID);
    expect((await instantiate('translator', pick({ key: 'taken-elsewhere' }))).statusCode).toBe(409);
    expect(await agentsOfTenant()).toHaveLength(2);
  });

  it('a refused key takes nothing away from the skill the project already has', async () => {
    expect((await instantiate('customer-support', pick({ key: 'support-eu' }))).statusCode).toBe(201);
    expect((await instantiate('customer-support', pick({ key: 'support-eu' }))).statusCode).toBe(409);
    expect((await skillsOfProject()).map((skill) => skill.key)).toEqual(['tpl-support-tone']);
    expect((await agentsOfTenant()).map((agent) => agent.key)).toEqual(['support-eu']);
  });

  it('applies the knowledge bases picked: one is bound plainly, several get the tool mode', async () => {
    await addKnowledge('faq');
    await addKnowledge('policies');
    const one = json(await instantiate('knowledge-qa', pick({ knowledgeKeys: ['faq'] })));
    expect(one.agent.config.knowledgeBindings).toEqual([{ key: 'faq' }]);
    expect(one.agent.config).not.toHaveProperty('knowledgeToolMode');
    expect(one.agent.config).not.toHaveProperty('knowledgeEngineKey');
    expect(one.setup.map((item: Json) => item.code)).not.toContain('knowledge_not_bound');

    const two = json(await instantiate('knowledge-qa', pick({ knowledgeKeys: ['faq', 'policies', 'faq'] })));
    expect(two.agent.config.knowledgeBindings).toEqual([{ key: 'faq' }, { key: 'policies' }]);
    expect(two.agent.config.knowledgeToolMode).toBe('combined');
  });

  it('without a knowledge base the agent is still made, with a warning to bind one', async () => {
    const res = await instantiate('knowledge-qa', pick());
    expect(res.statusCode).toBe(201);
    expect(json(res).agent.config).not.toHaveProperty('knowledgeBindings');
    expect(json(res).setup).toContainEqual(expect.objectContaining({ code: 'knowledge_not_bound', severity: 'warning' }));
  });

  it('binds the guardrails picked, and drops the "recommended" reminder', async () => {
    const guardrail = await addGuardrail('Support guard', PROJECT_ID);
    const body = json(await instantiate('customer-support', pick({ guardrailKeys: [guardrail.key] })));
    expect(body.agent.config.guardrails).toEqual([{ key: guardrail.key }]);
    expect(body.setup.map((item: Json) => item.code)).not.toContain('guardrails_recommended');

    const without = json(await instantiate('customer-support', pick()));
    expect(without.setup.map((item: Json) => item.code)).toContain('guardrails_recommended');
  });

  it('says what is missing for a template that searches the web, as a warning when it needs it and a note when it only uses it', async () => {
    const needs = json(await instantiate('deep-research', pick()));
    expect(needs.setup).toContainEqual(expect.objectContaining({ code: 'web_search_unavailable', severity: 'warning' }));
    const uses = json(await instantiate('lead-qualifier', pick()));
    expect(uses.setup).toContainEqual(expect.objectContaining({ code: 'web_search_unavailable', severity: 'info' }));

    await addWebSearch();
    const provided = json(await instantiate('deep-research', pick()));
    expect((provided.setup as Json[]).map((item) => item.code)).not.toContain('web_search_unavailable');
  });

  it('reminds to bind a knowledge base as a note for a template that can do without one', async () => {
    const { setup } = json(await instantiate('customer-support', pick()));
    expect(setup).toContainEqual(expect.objectContaining({ code: 'knowledge_not_bound', severity: 'info' }));
  });

  it('answers with the agent as every agent route does, through the redaction of secrets', async () => {
    await instantiate('customer-support', pick());
    expect(redactAgent).toHaveBeenCalledWith(expect.objectContaining({ key: 'customer-support' }));
  });

  it('names the client tools the integration has to answer, and where the playground can answer them', async () => {
    const { setup } = json(await instantiate('customer-support', pick()));
    const item = (setup as Json[]).find((entry) => entry.code === 'client_tools')!;
    expect(item).toMatchObject({ severity: 'info', detail: 'create_ticket' });
    expect(item.message).toContain('create_ticket');
  });
});

describe('POST instantiate: skills', () => {
  beforeEach(async () => {
    await addModel(MODEL);
  });

  it('creates the embedded skill in the project and points the agent at it', async () => {
    const body = json(await instantiate('customer-support', pick()));
    expect(body.agent.config.skills).toEqual(['tpl-support-tone']);
    const skills = await skillsOfProject();
    expect(skills.map((skill) => skill.key)).toEqual(['tpl-support-tone']);
    expect(skills[0]).toMatchObject({ projectId: PROJECT_ID, status: 'active', createdBy: 'user-1' });
  });

  it('a skill the project already has is reused as it is (it may have been edited), not created twice', async () => {
    await instantiate('customer-support', pick());
    const [existing] = await skillsOfProject();
    await updateSkill(DB_NAME, PROJECT_ID, String(existing!._id), 'user-1', { title: 'Our tone of voice' });

    const second = json(await instantiate('customer-support', pick()));
    expect(second.agent.key).toBe('customer-support-2');
    expect(second.agent.config.skills).toEqual(['tpl-support-tone']);
    const skills = await skillsOfProject();
    expect(skills).toHaveLength(1);
    expect(skills[0]!.title).toBe('Our tone of voice');
  });

  it('another project\'s skill of the same key is not this project\'s: the project gets its own', async () => {
    await db.createSkill({
      tenantId, projectId: OTHER_PROJECT_ID, key: 'tpl-support-tone', title: 'Theirs', header: 'h', body: 'b', status: 'active', createdBy: 'user-9', updatedBy: 'user-9',
    });
    const body = json(await instantiate('customer-support', pick()));
    expect(body.agent.config.skills).toEqual(['tpl-support-tone']);
    expect((await skillsOfProject()).map((skill) => skill.title)).not.toContain('Theirs');
    expect(await skillsOfProject()).toHaveLength(1);
  });
});

describe('POST instantiate: triggers', () => {
  beforeEach(async () => {
    await addModel(MODEL);
  });

  it('creates the suggested generic webhook trigger disabled and unpinned, with the URL and the secret shown once; the connector one is left out', async () => {
    const res = await instantiate('ci-failure-triage', pick());
    expect(res.statusCode).toBe(201);
    const body = json(res);
    expect(body.triggers).toHaveLength(1);
    expect(body.skipped_triggers).toEqual([
      { name: findAgentTemplate('ci-failure-triage')!.triggers![0]!.name, reason: 'connector_required', package: 'cognipeer.github' },
    ]);
    const [trigger] = body.triggers as Json[];
    expect(trigger).toMatchObject({ type: 'webhook', enabled: false, webhook: { preset: 'generic', auth: 'bearer' } });
    expect(trigger.webhook.url).toMatch(new RegExp(`/api/public/hooks/${tenantId}/wh_[A-Za-z0-9_-]{24}$`));
    expect(trigger.webhook.secret).toEqual(expect.any(String));
    expect(trigger.webhook.secret.length).toBeGreaterThanOrEqual(16);

    const stored = await triggersOf(body.agent);
    expect(stored).toHaveLength(1);
    const [row] = stored;
    expect(row).toMatchObject({ enabled: false, type: 'webhook', projectId: PROJECT_ID, agentKey: 'ci-failure-triage' });
    expect(row.version ?? null).toBeNull();
    expect(row.nextFireAt ?? null).toBeNull();
    if (row.type !== 'webhook') throw new Error('expected a webhook trigger');
    // The row holds the secret sealed, and a read of it shows the hint (its last four characters) only.
    const secret = trigger.webhook.secret as string;
    expect(JSON.stringify(row)).not.toContain(secret);
    const view = serializeAgentTrigger(row) as Json;
    expect(view.webhook).not.toHaveProperty('secret');
    expect(view.webhook.secret_hint).toBe(secret.slice(-4));
  });

  it('creates the connector trigger too when a connector of its package is given (by id for all, or by trigger name)', async () => {
    const fake = createFakeConnectorHost();
    registerConnectorTriggerHost(fake.host);
    const res = await instantiate('ci-failure-triage', pick({ connector_id: 'conn-1' }));
    expect(res.statusCode).toBe(201);
    const body = json(res);
    expect(body.skipped_triggers).toEqual([]);
    expect(body.triggers.map((trigger: Json) => trigger.type)).toEqual(['connector', 'webhook']);
    expect(body.triggers[0]).toMatchObject({ enabled: false, connector: { connectorId: 'conn-1', trigger: 'workflow_run', subscription: { status: 'active' } } });
    const stored = await triggersOf(body.agent);
    const connectorRow = stored.find((row) => row.type === 'connector');
    if (!connectorRow || connectorRow.type !== 'connector') throw new Error('expected a connector trigger');
    expect(connectorRow).toMatchObject({ enabled: false, connector: { connectorId: 'conn-1', trigger: 'workflow_run', events: ['workflow_run.completed'], packageId: 'cognipeer.github' } });
    expect(connectorRow.connector.subscriptionId).toMatch(/^sub_/);
    expect(fake.calls.filter((call) => call.startsWith('attach:'))).toHaveLength(1);

    const byName = json(await instantiate('ci-failure-triage', pick({ connector_ids: { [findAgentTemplate('ci-failure-triage')!.triggers![0]!.name]: 'conn-1' } })));
    expect(byName.skipped_triggers).toEqual([]);
    expect(byName.triggers).toHaveLength(2);
  });

  it('leaves a connector trigger out when the picked connector does not fit it, or the module is absent; the agent is still made', async () => {
    const absent = json(await instantiate('pr-reviewer', pick({ connector_id: 'conn-1' })));
    expect(absent.triggers).toEqual([]);
    expect(absent.skipped_triggers).toEqual([expect.objectContaining({ reason: 'connector_required', package: 'cognipeer.github' })]);
    expect(await triggersOf(absent.agent)).toEqual([]);

    registerConnectorTriggerHost(createFakeConnectorHost().host);
    const unknown = json(await instantiate('pr-reviewer', pick({ connector_id: 'conn-missing' })));
    expect(unknown.triggers).toEqual([]);
    expect(unknown.skipped_triggers).toHaveLength(1);
    expect(await triggersOf(unknown.agent)).toEqual([]);
  });

  it('refuses a malformed connector_id or connector_ids with a 400', async () => {
    expect((await instantiate('pr-reviewer', pick({ connector_id: 5 }))).statusCode).toBe(400);
    expect((await instantiate('pr-reviewer', pick({ connector_ids: ['x'] }))).statusCode).toBe(400);
    expect((await instantiate('pr-reviewer', pick({ connector_ids: { a: '' } }))).statusCode).toBe(400);
  });

  describe('connector triggers whose package trigger needs parameters (the GitHub ones need a repository)', () => {
    const PR_TRIGGER = findAgentTemplate('pr-reviewer')!.triggers![0]!.name;
    const CI_TRIGGER = findAgentTemplate('ci-failure-triage')!.triggers![0]!.name;
    let fake: ReturnType<typeof createFakeConnectorHost>;

    beforeEach(() => {
      fake = createFakeConnectorHost();
      registerConnectorTriggerHost(fake.host);
    });

    it('creates the trigger on the given repository, with the template\'s events and filter, still disabled', async () => {
      const res = await instantiate('pr-reviewer', pick({ connector_id: 'conn-gh', connector_params: { [PR_TRIGGER]: { repository: 'acme/api' } } }));
      expect(res.statusCode, res.body).toBe(201);
      const body = json(res);
      expect(body.skipped_triggers).toEqual([]);
      expect(body.triggers).toEqual([expect.objectContaining({ type: 'connector', enabled: false, connector: expect.objectContaining({ connectorId: 'conn-gh', trigger: 'pull_request' }) })]);
      const [row] = await triggersOf(body.agent);
      if (!row || row.type !== 'connector') throw new Error('expected a connector trigger');
      expect(row).toMatchObject({
        enabled: false,
        connector: {
          connectorId: 'conn-gh', trigger: 'pull_request', params: { repository: 'acme/api' }, packageId: 'cognipeer.github',
          events: ['pull_request.opened', 'pull_request.reopened', 'pull_request.synchronize', 'pull_request.ready_for_review'],
          filter: [
            { path: 'payload.action', op: 'in', value: ['opened', 'synchronize', 'reopened', 'ready_for_review'] },
            { path: 'payload.draft', op: 'eq', value: false },
          ],
          includePayload: true,
        },
      });
      // Core asked the module once with the parameters in the body, and the hook was registered once.
      expect(fake.calls.filter((call) => call === 'prepare')).toHaveLength(1);
      expect(fake.calls.filter((call) => call.startsWith('attach:'))).toHaveLength(1);
    });

    it('leaves the trigger out as params_required when the repository is missing, naming the field; the agent is still made', async () => {
      const res = await instantiate('pr-reviewer', pick({ connector_id: 'conn-gh' }));
      expect(res.statusCode, res.body).toBe(201);
      const body = json(res);
      expect(body.triggers).toEqual([]);
      expect(body.skipped_triggers).toEqual([{
        name: PR_TRIGGER, reason: 'params_required', package: 'cognipeer.github',
        errors: [{ field: 'connector.params.repository', message: 'repository is required' }],
      }]);
      expect(await triggersOf(body.agent)).toEqual([]);
      // Nothing was registered at the vendor for it.
      expect(fake.calls.filter((call) => call.startsWith('attach:'))).toEqual([]);
      expect(fake.subscriptions.size).toBe(0);
    });

    it('reads blank values as not given', async () => {
      const res = json(await instantiate('pr-reviewer', pick({ connector_id: 'conn-gh', connector_params: { [PR_TRIGGER]: { repository: '' } } })));
      expect(res.triggers).toEqual([]);
      expect(res.skipped_triggers).toEqual([expect.objectContaining({ reason: 'params_required' })]);
      const nothing = json(await instantiate('pr-reviewer', pick({ connector_id: 'conn-gh', connector_params: { [PR_TRIGGER]: {} } })));
      expect(nothing.skipped_triggers).toEqual([expect.objectContaining({ reason: 'params_required' })]);
    });

    it('names a parameter the package does not take as invalid_params, with what it said', async () => {
      const res = json(await instantiate('pr-reviewer', pick({
        connector_id: 'conn-gh', connector_params: { [PR_TRIGGER]: { repository: 'acme/api', branch: 'main' } },
      })));
      expect(res.triggers).toEqual([]);
      expect(res.skipped_triggers).toEqual([{
        name: PR_TRIGGER, reason: 'invalid_params', package: 'cognipeer.github',
        errors: [{ field: 'connector.params.branch', message: 'branch is not a parameter of this trigger' }],
      }]);
      expect(await triggersOf(res.agent)).toEqual([]);
    });

    it('a missing connector stays connector_required, with no field errors, even when parameters were given', async () => {
      const res = json(await instantiate('pr-reviewer', pick({ connector_id: 'conn-missing', connector_params: { [PR_TRIGGER]: { repository: 'acme/api' } } })));
      expect(res.skipped_triggers).toEqual([{ name: PR_TRIGGER, reason: 'connector_required', package: 'cognipeer.github' }]);
      expect(fake.calls.filter((call) => call === 'prepare')).toHaveLength(1);
      // Without a connector at all the module is not even asked.
      fake.calls.length = 0;
      const none = json(await instantiate('pr-reviewer', pick({ connector_params: { [PR_TRIGGER]: { repository: 'acme/api' } } })));
      expect(none.skipped_triggers).toEqual([{ name: PR_TRIGGER, reason: 'connector_required', package: 'cognipeer.github' }]);
      expect(fake.calls).toEqual([]);
    });

    it('another package\'s connector is connector_required: the trigger does not exist there', async () => {
      const res = json(await instantiate('pr-reviewer', pick({ connector_id: 'conn-poll', connector_params: { [PR_TRIGGER]: { repository: 'acme/api' } } })));
      expect(res.skipped_triggers).toEqual([{ name: PR_TRIGGER, reason: 'connector_required', package: 'cognipeer.github' }]);
    });

    it('takes parameters per trigger name and creates the others next to a skipped one', async () => {
      const res = json(await instantiate('ci-failure-triage', pick({
        connector_ids: { [CI_TRIGGER]: 'conn-gh' }, connector_params: { [CI_TRIGGER]: { repository: 'acme/web' }, 'No such trigger': { repository: 'ignored/repo' } },
      })));
      expect(res.skipped_triggers).toEqual([]);
      expect(res.triggers.map((trigger: Json) => trigger.type)).toEqual(['connector', 'webhook']);
      const connectorRow = (await triggersOf(res.agent)).find((row) => row.type === 'connector');
      if (!connectorRow || connectorRow.type !== 'connector') throw new Error('expected a connector trigger');
      expect(connectorRow.connector).toMatchObject({
        trigger: 'workflow_run', params: { repository: 'acme/web' }, events: ['workflow_run.completed'],
        filter: [{ path: 'payload.action', op: 'eq', value: 'completed' }, { path: 'payload.conclusion', op: 'in', value: ['failure', 'timed_out'] }],
      });
    });

    it('the generic webhook trigger next to a skipped connector one is still created', async () => {
      const res = json(await instantiate('ci-failure-triage', pick({ connector_id: 'conn-gh' })));
      expect(res.skipped_triggers).toEqual([expect.objectContaining({ name: CI_TRIGGER, reason: 'params_required' })]);
      expect(res.triggers.map((trigger: Json) => trigger.type)).toEqual(['webhook']);
      expect((await triggersOf(res.agent)).map((row) => row.type)).toEqual(['webhook']);
    });

    it('a lenient connector (no required parameters) still takes the trigger without any', async () => {
      const res = json(await instantiate('pr-reviewer', pick({ connector_id: 'conn-1' })));
      expect(res.skipped_triggers).toEqual([]);
      expect(res.triggers).toHaveLength(1);
    });

    it('the events or schedule the module refuses are invalid_params, and say so', async () => {
      const wrapped = fake.host.prepare;
      fake.host.prepare = async (scope, input) => {
        const asked = await wrapped(scope, input);
        return asked.ok ? { ok: false, errors: [{ field: 'connector.events', message: 'Not an event of this trigger: pull_request.opened' }] } : asked;
      };
      const res = json(await instantiate('pr-reviewer', pick({ connector_id: 'conn-gh', connector_params: { [PR_TRIGGER]: { repository: 'acme/api' } } })));
      expect(res.skipped_triggers).toEqual([{
        name: PR_TRIGGER, reason: 'invalid_params', package: 'cognipeer.github',
        errors: [{ field: 'connector.events', message: 'Not an event of this trigger: pull_request.opened' }],
      }]);
    });

    it('a refusal about the template itself (not the connector or the parameters) fails the create and undoes it', async () => {
      fake.host.prepare = async () => ({ ok: false, errors: [{ field: 'connector.include_payload', message: 'include_payload must be a boolean' }] });
      const res = await instantiate('pr-reviewer', pick({ connector_id: 'conn-gh', connector_params: { [PR_TRIGGER]: { repository: 'acme/api' } } }));
      expect(res.statusCode).toBe(400);
      expect(json(res)).toMatchObject({ code: 'invalid_template_trigger', issues: [{ field: 'connector.include_payload' }] });
      await expectNothingCreated();
    });

    it('refuses malformed connector_params with a 400 before anything is made', async () => {
      for (const bad of [['x'], 'x', { [PR_TRIGGER]: 'acme/api' }, { [PR_TRIGGER]: ['acme/api'] }, { [PR_TRIGGER]: null }]) {
        const res = await instantiate('pr-reviewer', pick({ connector_id: 'conn-gh', connector_params: bad }));
        expect(res.statusCode, JSON.stringify(bad)).toBe(400);
        expect(json(res).code, JSON.stringify(bad)).toBe('invalid_request');
      }
      await expectNothingCreated();
    });

    it('createTriggers: false ignores the parameters', async () => {
      const res = json(await instantiate('pr-reviewer', pick({ createTriggers: false, connector_id: 'conn-gh', connector_params: { [PR_TRIGGER]: { repository: 'acme/api' } } })));
      expect(res.triggers).toEqual([]);
      expect(res.skipped_triggers).toEqual([]);
      expect(fake.calls).toEqual([]);
    });
  });

  it('puts the schedule in the timezone that was sent (UTC when none), still disabled', async () => {
    const istanbul = json(await instantiate('daily-briefing', pick({ timezone: 'Europe/Istanbul' })));
    expect(istanbul.triggers).toEqual([expect.objectContaining({
      type: 'schedule', enabled: false, schedule: { cron: findAgentTemplate('daily-briefing')!.triggers![0]!.schedule!.cron, timezone: 'Europe/Istanbul' },
    })]);
    const utc = json(await instantiate('daily-briefing', pick()));
    expect(utc.triggers[0].schedule.timezone).toBe('UTC');
    for (const row of [...await triggersOf(istanbul.agent), ...await triggersOf(utc.agent)]) {
      expect(row.enabled).toBe(false);
      expect(row.nextFireAt ?? null).toBeNull();
    }
  });

  it('lists the triggers by name in the setup, and the webhook secret reminder only when there is a webhook', async () => {
    const webhook = json(await instantiate('ci-failure-triage', pick()));
    const codes = (webhook.setup as Json[]).map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining(['triggers_disabled', 'webhook_secret']));
    expect((webhook.setup as Json[]).find((item) => item.code === 'triggers_disabled')!.detail).toBe(findAgentTemplate('ci-failure-triage')!.triggers![1]!.name);

    registerConnectorTriggerHost(createFakeConnectorHost().host);
    const connector = json(await instantiate('pr-reviewer', pick({ connector_id: 'conn-1' })));
    const connectorCodes = (connector.setup as Json[]).map((item) => item.code);
    expect(connectorCodes).toContain('triggers_disabled');
    expect(connectorCodes).not.toContain('webhook_secret');

    const schedule = json(await instantiate('daily-briefing', pick()));
    const scheduleCodes = (schedule.setup as Json[]).map((item) => item.code);
    expect(scheduleCodes).toContain('triggers_disabled');
    expect(scheduleCodes).not.toContain('webhook_secret');
  });

  it('createTriggers: false creates none', async () => {
    const body = json(await instantiate('ci-failure-triage', pick({ createTriggers: false })));
    expect(body.triggers).toEqual([]);
    expect(await listAgentTriggers(scope())).toEqual([]);
    expect(body.setup.map((item: Json) => item.code)).not.toContain('triggers_disabled');
  });

  it('a template without triggers has none to create', async () => {
    expect(json(await instantiate('translator', pick())).triggers).toEqual([]);
  });
});

describe('POST instantiate: the sandbox', () => {
  beforeEach(async () => {
    await addModel(MODEL);
  });

  it('is refused with a 409 where there is no sandbox (the edition, or the license), and nothing is made', async () => {
    const edition = await instantiate('data-analyst', pick());
    expect(edition.statusCode).toBe(409);
    expect(json(edition)).toMatchObject({ code: 'sandbox_unavailable', reason: 'edition' });

    hoisted.sandbox.current = noSandbox('license');
    const license = await instantiate('data-analyst', pick());
    expect(license.statusCode).toBe(409);
    expect(json(license)).toMatchObject({ code: 'sandbox_unavailable', reason: 'license' });
    expect(json(license).error).toContain('Enterprise');
    await expectNothingCreated();
  });

  it('turns the sandbox on with multi-base by default, the first template when there is none of that name, else the one picked', async () => {
    hoisted.sandbox.current = sandboxWith('python', 'multi-base');
    expect(json(await instantiate('data-analyst', pick())).agent.config.sandbox).toMatchObject({ enabled: true, templateKey: 'multi-base' });
    expect(json(await instantiate('data-analyst', pick({ sandboxTemplateKey: 'python' }))).agent.config.sandbox).toMatchObject({ enabled: true, templateKey: 'python' });

    hoisted.sandbox.current = sandboxWith('python', 'node');
    expect(json(await instantiate('data-analyst', pick())).agent.config.sandbox.templateKey).toBe('python');
  });

  it('refuses a sandbox template that does not exist, and a tenant that has none to pick', async () => {
    hoisted.sandbox.current = sandboxWith('multi-base');
    const unknown = await instantiate('data-analyst', pick({ sandboxTemplateKey: 'ghost' }));
    expect(unknown.statusCode).toBe(400);
    expect(json(unknown)).toMatchObject({ code: 'sandbox_template_not_found' });

    hoisted.sandbox.current = sandboxWith();
    const none = await instantiate('data-analyst', pick());
    expect(none.statusCode).toBe(400);
    expect(json(none)).toMatchObject({ code: 'sandbox_template_required' });
    await expectNothingCreated();
  });

  it('a template that does not use the sandbox ignores the choice', async () => {
    hoisted.sandbox.current = sandboxWith('multi-base');
    const body = json(await instantiate('translator', pick({ sandboxTemplateKey: 'multi-base' })));
    expect(body.agent.config).not.toHaveProperty('sandbox');
  });
});

describe('POST instantiate: what is refused, and that nothing is left behind', () => {
  beforeEach(async () => {
    await addModel(MODEL);
  });

  const refused = async (templateKey: string, payload: unknown, status: number, code: string) => {
    const res = await instantiate(templateKey, payload);
    expect(res.statusCode, res.body).toBe(status);
    expect(json(res)).toMatchObject({ code, error: expect.any(String) });
    await expectNothingCreated();
  };

  it('an unknown template is a 404', async () => {
    await refused('no-such-template', pick(), 404, 'template_not_found');
  });

  it('a body that is missing, not JSON, or not an object is a 400', async () => {
    await refused('translator', undefined, 400, 'invalid_request');
    await refused('translator', ['modelKey'], 400, 'invalid_request');
    const raw = (payload: string, contentType: string) => app.inject({
      method: 'POST', url: '/api/agents/templates/translator/instantiate', headers: { 'content-type': contentType }, payload,
    });
    // The product's JSON parser hands the body over as text and the route parses it; a body that is no object or no JSON is the caller's mistake.
    for (const [payload, contentType] of [['{not json', 'text/plain'], ['42', 'application/json'], ['null', 'application/json']] as const) {
      const res = await raw(payload, contentType);
      expect(res.statusCode, payload).toBe(400);
      expect(json(res), payload).toMatchObject({ code: 'invalid_request' });
    }
    await expectNothingCreated();
  });

  it('a model is required, and has to be a chat model of this project', async () => {
    await refused('translator', {}, 400, 'invalid_model');
    await refused('translator', { modelKey: '   ' }, 400, 'invalid_model');
    await refused('translator', { modelKey: 'ghost' }, 400, 'invalid_model');
    await addModel('embedder', { category: 'embedding' });
    await refused('translator', { modelKey: 'embedder' }, 400, 'invalid_model');
    await addModel('their-model', { projectId: OTHER_PROJECT_ID });
    await refused('translator', { modelKey: 'their-model' }, 400, 'invalid_model');
  });

  it('checks the shape of every field', async () => {
    await refused('translator', pick({ key: 'Not A Key!' }), 400, 'invalid_key');
    await refused('translator', pick({ key: '-leading-dash' }), 400, 'invalid_key');
    await refused('translator', pick({ key: 'a'.repeat(65) }), 400, 'invalid_key');
    await refused('translator', pick({ timezone: 'Mars/Olympus' }), 400, 'invalid_timezone');
    await refused('translator', pick({ name: 42 }), 400, 'invalid_request');
    await refused('translator', pick({ name: 'x'.repeat(201) }), 400, 'invalid_request');
    await refused('translator', pick({ description: 7 }), 400, 'invalid_request');
    await refused('translator', pick({ description: 'x'.repeat(1001) }), 400, 'invalid_request');
    await refused('translator', pick({ knowledgeKeys: 'faq' }), 400, 'invalid_request');
    await refused('translator', pick({ guardrailKeys: [1] }), 400, 'invalid_request');
    await refused('knowledge-qa', pick({ knowledgeKeys: Array.from({ length: 11 }, (_, index) => `kb-${index}`) }), 400, 'invalid_request');
    await refused('translator', pick({ createTriggers: 'yes' }), 400, 'invalid_request');
    await refused('translator', pick({ publish: 1 }), 400, 'invalid_request');
  });

  it('a knowledge base that is not in the project, or a template that has no use for one, is refused', async () => {
    await addKnowledge('theirs', OTHER_PROJECT_ID);
    await refused('knowledge-qa', pick({ knowledgeKeys: ['ghost'] }), 400, 'knowledge_not_found');
    await refused('knowledge-qa', pick({ knowledgeKeys: ['theirs'] }), 400, 'knowledge_not_found');
    await addKnowledge('faq');
    await refused('translator', pick({ knowledgeKeys: ['faq'] }), 400, 'knowledge_not_supported');
  });

  it('a guardrail that is not in the project is refused for a member and accepted for an owner (as Studio looks it up)', async () => {
    const theirs = await addGuardrail('Their guard', OTHER_PROJECT_ID);
    await refused('customer-support', pick({ guardrailKeys: ['ghost'] }), 400, 'guardrail_not_found');

    asUser('user');
    await refused('customer-support', pick({ guardrailKeys: [theirs.key] }), 400, 'guardrail_not_found');
    const tenantWide = await addGuardrail('Tenant wide guard');
    expect((await instantiate('customer-support', pick({ guardrailKeys: [tenantWide.key] }))).statusCode).toBe(201);

    asUser('owner');
    const res = await instantiate('customer-support', pick({ guardrailKeys: [theirs.key] }));
    expect(res.statusCode).toBe(201);
    expect(json(res).agent.config.guardrails).toEqual([{ key: theirs.key }]);
  });

  it('a failure after the agent was made removes the agent, its triggers and the skills it added', async () => {
    registerConnectorTriggerHost(createFakeConnectorHost().host);
    hoisted.failures.failTriggerCall = 2;
    const res = await instantiate('ci-failure-triage', pick({ connector_id: 'conn-1' }));
    expect(res.statusCode).toBe(500);
    expect(json(res)).toEqual({ error: expect.any(String) });
    expect(hoisted.failures.triggerCalls).toBe(2);
    await expectNothingCreated();

    // The same template goes through once the store is back, under the key the failed try would have had.
    hoisted.failures.failTriggerCall = 0;
    const retry = await instantiate('ci-failure-triage', pick({ connector_id: 'conn-1' }));
    expect(retry.statusCode).toBe(201);
    expect(json(retry).agent.key).toBe('ci-failure-triage');
    expect(await triggersOf(json(retry).agent)).toHaveLength(2);
  });

  it('a failed publish removes everything too, the skill included, and leaves the key free', async () => {
    hoisted.failures.publish = true;
    const res = await instantiate('customer-support', pick({ publish: true }));
    expect(res.statusCode).toBe(500);
    await expectNothingCreated();

    hoisted.failures.publish = false;
    const retry = await instantiate('customer-support', pick({ publish: true }));
    expect(retry.statusCode).toBe(201);
    expect(json(retry).agent).toMatchObject({ key: 'customer-support', publishedVersion: 1 });
  });

  it('what an earlier create left in the project is not touched by a failed one', async () => {
    const first = json(await instantiate('customer-support', pick()));
    hoisted.failures.publish = true;
    expect((await instantiate('customer-support', pick({ publish: true }))).statusCode).toBe(500);
    expect((await agentsOfTenant()).map((agent) => agent.key)).toEqual(['customer-support']);
    expect((await skillsOfProject()).map((skill) => skill.key)).toEqual(['tpl-support-tone']);
    expect(String((await db.findAgentByKey('customer-support', PROJECT_ID))!._id)).toBe(String(first.agent._id));
  });
});

describe('every template in the catalog', () => {
  it('becomes an agent in a project that has what it needs, with its triggers made disabled', async () => {
    await addModel(MODEL);
    await addKnowledge('faq');
    await addWebSearch();
    hoisted.sandbox.current = sandboxWith('multi-base');
    const guardrail = await addGuardrail('Guard', PROJECT_ID);

    for (const template of AGENT_TEMPLATES) {
      const res = await instantiate(template.key, pick({
        ...(template.requires.knowledge ? { knowledgeKeys: ['faq'] } : {}),
        guardrailKeys: [guardrail.key],
      }));
      expect(res.statusCode, `${template.key}: ${res.body}`).toBe(201);
      const body = json(res);
      expect(body.agent, template.key).toMatchObject({ key: template.key, status: 'active', metadata: { template: { key: template.key, version: template.version } } });
      expect(body.agent.config.modelKey, template.key).toBe(MODEL);
      const connectorSuggestions = template.triggers?.filter((trigger) => trigger.type === 'connector').length ?? 0;
      expect(body.triggers, template.key).toHaveLength((template.triggers?.length ?? 0) - connectorSuggestions);
      expect(body.skipped_triggers, template.key).toHaveLength(connectorSuggestions);
      for (const trigger of body.triggers as Json[]) expect(trigger.enabled, template.key).toBe(false);
      for (const row of await triggersOf(body.agent)) {
        expect(row.enabled, template.key).toBe(false);
        expect(row.version ?? null, template.key).toBeNull();
      }
    }
    expect(await agentsOfTenant()).toHaveLength(AGENT_TEMPLATES.length);
    expect((await skillsOfProject()).map((skill) => skill.key).sort()).toEqual(
      AGENT_TEMPLATES.flatMap((template) => (template.resources?.skills ?? []).map((skill) => skill.key)).sort(),
    );
  });

  it('answers requests that arrive together with one agent each, under distinct keys', async () => {
    await addModel(MODEL);
    const responses = await Promise.all([1, 2, 3].map(() => instantiate('meeting-notes', pick())));
    expect(responses.map((res) => res.statusCode)).toEqual([201, 201, 201]);
    expect(responses.map((res) => json(res).agent.key).sort()).toEqual(['meeting-notes', 'meeting-notes-2', 'meeting-notes-3']);
    expect(await agentsOfTenant()).toHaveLength(3);
  });

  it('can be made again and again: each time under the next free key', async () => {
    await addModel(MODEL);
    for (const attempt of [1, 2, 3]) {
      const body = json(await instantiate('meeting-notes', pick()));
      expect(body.agent.key).toBe(attempt === 1 ? 'meeting-notes' : `meeting-notes-${attempt}`);
    }
  });
});

// ── The service, with the API-layer pieces replaced ──────────────────────

describe('instantiateTemplate with its own pieces', () => {
  beforeEach(async () => {
    await addModel(MODEL);
  });

  const deps = (overrides: Partial<AgentTemplateWriteDeps> = {}): AgentTemplateWriteDeps => ({
    guardrailExists: async () => true,
    prepareAgentConfig: async (config) => ({ config, warnings: [] }),
    prepareTriggerWrite: ({ body, agent, actorId }) => prepareTriggerWrite({ body, agent, scope: scope(), actorId }),
    ...overrides,
  });
  const make = (templateKey: string, input: Json, overrides?: Partial<AgentTemplateWriteDeps>) =>
    instantiateTemplate(scope(), templateKey, input, 'user-1', deps(overrides));
  const failure = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AgentTemplateError);
    return error as AgentTemplateError;
  };

  it('a config the validation refuses is a 400 with its issues, and the skill made for it is removed again', async () => {
    const issues = [{ field: 'modelKey', message: 'Model "gpt-main" cannot be used' }];
    const error = await failure(make('customer-support', pick(), {
      prepareAgentConfig: async () => ({ badRequest: { error: 'Invalid agent config - modelKey: nope', validation: { errors: issues, warnings: [] } } }),
    }));
    expect(error).toMatchObject({ status: 400, code: 'invalid_template_config', extra: { issues } });
    await expectNothingCreated();
  });

  it('a config the caller may not write is a 403 with the answer it gave, and nothing is left', async () => {
    const error = await failure(make('customer-support', pick(), {
      prepareAgentConfig: async () => ({ forbidden: { error: 'Files write access is required', code: 'files_write_required' } }),
    }));
    expect(error).toMatchObject({ status: 403, code: 'forbidden', message: 'Files write access is required', extra: { code: 'files_write_required' } });
    await expectNothingCreated();
  });

  it('a trigger the parser refuses is a 400 naming the trigger; the agent and the triggers before it are removed', async () => {
    registerConnectorTriggerHost(createFakeConnectorHost().host);
    let calls = 0;
    const error = await failure(make('ci-failure-triage', pick({ connector_id: 'conn-1' }), {
      prepareTriggerWrite: async (input) => {
        calls += 1;
        return calls === 1 ? prepareTriggerWrite({ body: input.body, agent: input.agent, scope: scope(), actorId: input.actorId }) : { ok: false, errors: [{ field: 'prompt', message: 'unknown variable' }] };
      },
    }));
    expect(error).toMatchObject({ status: 400, code: 'invalid_template_trigger', extra: { issues: [{ field: 'prompt', message: 'unknown variable' }] } });
    expect(error.message).toContain(findAgentTemplate('ci-failure-triage')!.triggers![1]!.name);
    await expectNothingCreated();
  });

  it('a key that is taken while the config is being checked is skipped for an automatic key, and refused for one that was asked for', async () => {
    const takeKey = (key: string): Partial<AgentTemplateWriteDeps> => ({
      prepareAgentConfig: async (config) => {
        await addAgent(key);
        return { config, warnings: [] };
      },
    });
    const automatic = await make('customer-support', pick(), takeKey('customer-support'));
    expect(automatic.agent.key).toBe('customer-support-2');
    expect((await skillsOfProject()).map((skill) => skill.key)).toEqual(['tpl-support-tone']);

    const asked = await failure(make('customer-support', pick({ key: 'my-support' }), takeKey('my-support')));
    expect(asked).toMatchObject({ status: 409, code: 'agent_key_conflict' });
    expect((await agentsOfTenant()).map((agent) => agent.key).sort()).toEqual(['customer-support', 'customer-support-2', 'my-support']);
  });

  it('a key that another server process takes between the check and the insert is a 409, and the skill made meanwhile is removed', async () => {
    await addAgent('customer-support');
    // The tenant-wide check (first call) finds it free; the insert's own check of the project finds it taken.
    vi.spyOn(db, 'findAgentByKey').mockResolvedValueOnce(null);
    const error = await failure(make('customer-support', pick()));
    expect(error).toMatchObject({ status: 409, code: 'agent_key_conflict' });
    expect((await agentsOfTenant()).map((agent) => agent.key)).toEqual(['customer-support']);
    expect(await skillsOfProject()).toEqual([]);
  });

  it('requests for the same template at the same moment each get their own key', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => make('customer-support', pick())));
    expect(results.map((result) => result.agent.key).sort()).toEqual(['customer-support', 'customer-support-2', 'customer-support-3', 'customer-support-4']);
    expect(await skillsOfProject()).toHaveLength(1);
  });

  it('a request that fails does not hold up the ones behind it, and what it made is gone', async () => {
    const boom: Partial<AgentTemplateWriteDeps> = { prepareTriggerWrite: async () => { throw new Error('boom'); } };
    const [first, second] = await Promise.allSettled([
      make('ci-failure-triage', pick(), boom),
      make('ci-failure-triage', pick()),
    ]);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
    const kept = second.status === 'fulfilled' ? second.value.agent.key : '';
    expect(kept).toMatch(/^ci-failure-triage(-\d+)?$/);
    expect((await agentsOfTenant()).map((agent) => agent.key)).toEqual([kept]);
    expect(await listAgentTriggers(scope())).toHaveLength(1);
  });

  it('passes the notes of the validation on without stopping the create', async () => {
    const warnings = [{ field: 'additionalModels[0]', message: 'Model does not support tool calls' }];
    const result = await make('translator', pick(), { prepareAgentConfig: async (config) => ({ config, warnings }) });
    expect(result.warnings).toEqual(warnings);
    expect(result.agent.key).toBe('translator');
  });

  it('creates straight through the service the way the API does', async () => {
    const result = await make('release-notes-writer', pick({ name: 'Notes' }));
    expect(result.agent).toMatchObject({ key: 'release-notes-writer', name: 'Notes', status: 'active' });
    expect(result.template).toEqual({ key: 'release-notes-writer', version: 1, catalogVersion: AGENT_TEMPLATE_CATALOG_VERSION });
  });
});

// ── Who may use it ───────────────────────────────────────────────────────

describe('RBAC route mapping', () => {
  it('declares each route as the agents service itself, rather than leaving it to the path map', () => {
    expect(declared).toEqual({
      'GET /agents/templates': { kind: 'service', service: 'agents' },
      'GET /agents/templates/:templateKey': { kind: 'service', service: 'agents' },
      'POST /agents/templates/:templateKey/instantiate': { kind: 'service', service: 'agents' },
    });
  });

  it('maps the templates routes to the agents service: reading needs read, creating needs write', () => {
    for (const url of ['/api/agents/templates', '/api/agents/templates/customer-support', '/api/agents/templates/customer-support/instantiate']) {
      expect(getPermissionServiceForPath(url), url).toBe('agents');
    }
    expect(getRequiredPermissionLevel('GET', 'agents')).toBe('read');
    expect(getRequiredPermissionLevel('POST', 'agents')).toBe('write');
  });

  it('a member with read access can browse the gallery but not create from it', () => {
    const reader = { role: 'user', servicePermissions: { agents: 'read' } } as never;
    expect(authorizeServiceRequest(reader, 'GET', '/api/agents/templates').allowed).toBe(true);
    expect(authorizeServiceRequest(reader, 'GET', '/api/agents/templates/customer-support').allowed).toBe(true);
    expect(authorizeServiceRequest(reader, 'POST', '/api/agents/templates/customer-support/instantiate').allowed).toBe(false);
    const writer = { role: 'user', servicePermissions: { agents: 'write' } } as never;
    expect(authorizeServiceRequest(writer, 'POST', '/api/agents/templates/customer-support/instantiate').allowed).toBe(true);
    const nobody = { role: 'user', servicePermissions: { agents: 'none' } } as never;
    expect(authorizeServiceRequest(nobody, 'GET', '/api/agents/templates').allowed).toBe(false);
  });
});
