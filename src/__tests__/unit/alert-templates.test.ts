/**
 * Alert rule templates: the rule each template creates, what `AlertTemplateService.apply` / `list` /
 * `createFromTemplate` / `seedDefaultAlertRules` do to a project (states, availability, default set vs keys,
 * the project lock) and that two applies at the same time still add each template once. Runs the real alert
 * service over a mocked tenant database; the catalog itself is checked in alert-template-catalog.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

/** The mock db with every method as a plain vitest mock: tests feed it partial rows. */
type LooseDb = Record<string, import('vitest').Mock>;

const h = vi.hoisted(() => ({
  logLines: [] as Array<{ level: string; message: string; meta: unknown }>,
  /** What the tenant scope hands its callback (the mock db of the test). */
  scopeDb: undefined as unknown,
  /** The cache the lock goes through: a test replaces `acquireLock` / `releaseLock`. */
  cache: { acquireLock: undefined as unknown, releaseLock: undefined as unknown } as {
    acquireLock: (key: string, ttl: number) => Promise<string | undefined>;
    releaseLock: (key: string, token: string) => Promise<void>;
  },
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  getTenantDatabase: vi.fn(),
  runWithTenantScope: vi.fn(async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(h.scopeDb)),
}));
vi.mock('@/lib/core/cache', () => ({
  getCache: vi.fn(async () => h.cache),
}));
vi.mock('@/lib/license/tenantLicense', () => ({
  isTenantEnterpriseLicensed: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/lib/email/mailer', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/services/alerts/channels', () => ({
  dispatchNotification: vi.fn(),
}));
vi.mock('@/lib/services/alerts/alertEvaluator', () => ({
  evaluateRuleTargets: vi.fn(),
}));
vi.mock('@/lib/services/entityMetrics/entityHealthService', () => ({
  listActiveEntityKeys: vi.fn(),
}));
vi.mock('@/lib/core/logger', () => {
  const write = (level: string) => (message: string, meta?: unknown) => { h.logLines.push({ level, message, meta }); };
  const logger = { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
  return { createLogger: () => logger };
});

import { MemoryCacheProvider } from '@/lib/core/cache/memoryCacheProvider';
import { reloadConfig } from '@/lib/core/config';
import { getDatabase, getTenantDatabase } from '@/lib/database';
import type { IAlertRule } from '@/lib/database';
import { AlertApiError } from '@/lib/services/alerts/alertApiError';
import { validateRuleInput } from '@/lib/services/alerts/alertService';
import { resetAlertEmailUserCache } from '@/lib/services/alerts/channels/emailChannel';
import { getMetricDef } from '@/lib/services/alerts/metricCatalog';
import { isTenantEnterpriseLicensed } from '@/lib/license/tenantLicense';
import {
  __resetAlertExtensionsForTests,
  registerEntityBaselineProvider,
  registerSloBurnEvaluator,
} from '@/enterprise/alert-extensions';
import {
  ALERT_TEMPLATE_CATALOG_VERSION,
  ALERT_TEMPLATES,
  AlertTemplateService,
  DEFAULT_ALERT_TEMPLATE_KEYS,
  defaultAlertRulesOnCreate,
  getAlertTemplate,
  seedDefaultAlertRules,
  templateRuleInput,
  withAlertTemplateLock,
} from '@/lib/services/alerts/alertTemplates';

const DB_NAME = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'proj-1';
const OTHER_PROJECT_ID = 'proj-2';
const USER_ID = 'user-1';

const KEYS = [...DEFAULT_ALERT_TEMPLATE_KEYS];
const DEFAULT_TEMPLATES = ALERT_TEMPLATES.filter((def) => def.default);
const CATALOG_KEYS = ALERT_TEMPLATES.map((def) => def.key);

function storedRule(over: Partial<IAlertRule> & { _id: string }): IAlertRule {
  return {
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    name: 'Some rule',
    module: 'agents',
    metric: 'agent_error_rate',
    condition: { operator: 'gt', threshold: 5 },
    windowMinutes: 15,
    cooldownMinutes: 60,
    enabled: true,
    entity: { entityType: 'agent', mode: 'all' },
    channels: [{ id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: ['ops@acme.com'] }],
    createdBy: 'user-9',
    ...over,
  };
}

/**
 * An in-memory `alert_rules` table behind the mock db. `createAlertRule` yields to the event loop, so two
 * unguarded applies would both read an empty project before either one wrote.
 */
function useRuleStore(db: LooseDb, initial: IAlertRule[] = []): IAlertRule[] {
  const rules = [...initial];
  let seq = 0;
  db.listAlertRules.mockImplementation(async (_tenantId: string, filter?: { projectId?: string }) => {
    await Promise.resolve();
    return rules
      .filter((rule) => filter?.projectId === undefined || rule.projectId === filter.projectId)
      .map((rule) => ({ ...rule }));
  });
  db.createAlertRule.mockImplementation(async (rule: Record<string, unknown>) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    seq += 1;
    const created = { ...rule, _id: `rule-${seq}` } as unknown as IAlertRule;
    rules.push(created);
    return created;
  });
  return rules;
}

async function failure(run: () => Promise<unknown>): Promise<AlertApiError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(AlertApiError);
    return error as AlertApiError;
  }
  throw new Error('expected an AlertApiError');
}

let db: LooseDb;
let cache: MemoryCacheProvider;

beforeEach(() => {
  vi.clearAllMocks();
  h.logLines.length = 0;
  resetAlertEmailUserCache();
  delete process.env.ALERT_DEFAULT_RULES_ON_CREATE;
  reloadConfig();
  db = createMockDb() as unknown as LooseDb;
  (getTenantDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  h.scopeDb = db;
  cache = new MemoryCacheProvider(300, 3600);
  h.cache = cache;
  __resetAlertExtensionsForTests();
  (isTenantEnterpriseLicensed as ReturnType<typeof vi.fn>).mockResolvedValue(true);
});

afterEach(async () => {
  vi.useRealTimers();
  await cache.destroy();
  delete process.env.ALERT_DEFAULT_RULES_ON_CREATE;
  reloadConfig();
});

// ── The rule a template creates ─────────────────────────────────────────────

describe('templateRuleInput', () => {
  it.each(DEFAULT_TEMPLATES.map((def) => [def.key, def] as const))('%s: is a rule the validator accepts', (_key, def) => {
    const rule = validateRuleInput(templateRuleInput(def), { mode: 'create' });
    expect(rule).toMatchObject({
      name: def.name,
      description: def.description,
      module: def.module,
      metric: def.metric,
      windowMinutes: 30,
      cooldownMinutes: 120,
      severity: 'auto',
      notifyOnResolve: true,
      renotifyMinutes: 0,
      enabled: true,
      entity: { entityType: getMetricDef(def.metric)?.entityType, mode: 'all' },
      condition: { mode: 'threshold', operator: 'gt', threshold: def.condition.threshold, forMinutes: 10, minSamples: 20 },
    });
    expect(rule.channels).toEqual([{ type: 'email', recipients: [], audience: 'project_admins' }]);
  });

  it('gives a legacy metric no entity and no scope: it watches the whole project', () => {
    const input = templateRuleInput(getAlertTemplate('guardrail-blocks')!);
    expect(input).not.toHaveProperty('entity');
    expect(input).not.toHaveProperty('scope');
    expect(input).toMatchObject({ module: 'guardrails', metric: 'guardrail_block_rate', condition: { mode: 'threshold', operator: 'gt', threshold: 20 } });
  });

  it('keeps a well-formed operator and threshold in the modes that ignore them', () => {
    expect(templateRuleInput(getAlertTemplate('agent-traffic-stopped')!).condition).toEqual({
      mode: 'absence', operator: 'gt', threshold: 0, forMinutes: 0, minSamples: 1, absence: { lookbackHours: 24, minExpectedPerWindow: 5 },
    });
    expect(templateRuleInput(getAlertTemplate('agent-error-budget')!).condition).toMatchObject({
      mode: 'slo_burn', operator: 'gt', threshold: 0, slo: { objectivePct: 99, windowDays: 30, burnRate: 14.4, longWindowMinutes: 60, shortWindowMinutes: 5 },
    });
  });

  it('builds a fresh object every time, so a caller cannot change the catalog through it', () => {
    const def = DEFAULT_TEMPLATES[0];
    const first = templateRuleInput(def);
    (first.channels as Array<{ recipients: string[] }>)[0].recipients.push('x@acme.com');
    first.condition.threshold = 99;
    expect(templateRuleInput(def).channels).toEqual([{ type: 'email', recipients: [], audience: 'project_admins' }]);
    expect(templateRuleInput(def).condition.threshold).toBe(def.condition.threshold);
    const slo = templateRuleInput(getAlertTemplate('agent-error-budget')!);
    slo.condition.slo!.burnRate = 1;
    expect(templateRuleInput(getAlertTemplate('agent-error-budget')!).condition.slo!.burnRate).toBe(14.4);
  });

  it('looks a template up by key, and only by a key', () => {
    for (const key of CATALOG_KEYS) expect(getAlertTemplate(key)?.key).toBe(key);
    for (const nope of ['nope', '', undefined, null, 5, {}, ['agent-errors'], 'constructor', '__proto__', 'AGENT-ERRORS']) {
      expect(getAlertTemplate(nope)).toBeUndefined();
    }
  });
});

// ── apply ───────────────────────────────────────────────────────────────────

describe('AlertTemplateService.apply', () => {
  it('creates all five rules in an empty project, each marked with its key and version and enabled', async () => {
    useRuleStore(db);
    const result = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);

    expect(result.skipped).toEqual([]);
    expect(result.created).toHaveLength(5);
    expect(result.created.map((rule) => rule.template)).toEqual(DEFAULT_TEMPLATES.map((def) => ({ key: def.key, version: def.version })));
    expect(getTenantDatabase).toHaveBeenCalledWith(DB_NAME);

    const written = db.createAlertRule.mock.calls.map((call) => call[0] as Record<string, unknown>);
    expect(written).toHaveLength(5);
    written.forEach((rule, index) => {
      const def = DEFAULT_TEMPLATES[index];
      expect(rule).toMatchObject({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        createdBy: USER_ID,
        enabled: true,
        template: { key: def.key, version: def.version },
        name: def.name,
        description: def.description,
        module: def.module,
        metric: def.metric,
        windowMinutes: 30,
        cooldownMinutes: 120,
        severity: 'auto',
        notifyOnResolve: true,
        renotifyMinutes: 0,
        entity: { entityType: getMetricDef(def.metric)?.entityType, mode: 'all' },
        condition: { mode: 'threshold', operator: 'gt', threshold: def.condition.threshold, forMinutes: 10, minSamples: 20 },
      });
      expect(rule.channels).toEqual([
        { id: expect.stringMatching(/^ch_[0-9a-f]{12}$/), type: 'email', recipients: [], audience: 'project_admins' },
      ]);
    });
  });

  it('returns the rules masked, with the marker and the audience', async () => {
    useRuleStore(db);
    const { created } = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    expect(created[0]).toMatchObject({
      _id: 'rule-1',
      template: { key: 'agent-errors', version: 1 },
      channels: [{ type: 'email', recipients: [], audience: 'project_admins' }],
    });
    expect(JSON.stringify(created)).not.toContain('sealed');
  });

  it('only reads the rules of the project it adds to', async () => {
    useRuleStore(db);
    await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    expect(db.listAlertRules).toHaveBeenCalledWith(TENANT_ID, { projectId: PROJECT_ID });
  });

  it('a second apply creates nothing and says each template exists', async () => {
    const rules = useRuleStore(db);
    await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    db.createAlertRule.mockClear();

    const again = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    expect(again.created).toEqual([]);
    expect(again.skipped).toEqual(KEYS.map((key) => ({ key, reason: 'exists' })));
    expect(db.createAlertRule).not.toHaveBeenCalled();
    expect(rules).toHaveLength(5);
  });

  it('never adds a template twice, even when its rule was disabled or edited since', async () => {
    useRuleStore(db, [
      storedRule({ _id: 'r-off', name: 'Mine now', enabled: false, template: { key: 'agent-errors', version: 1 } }),
      storedRule({
        _id: 'r-edit', name: 'Edited', module: 'models', metric: 'model_error_rate', condition: { operator: 'gt', threshold: 99 },
        entity: { entityType: 'model', mode: 'selected', keys: ['gpt'] }, template: { key: 'model-errors', version: 1 },
      }),
    ]);
    const result = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    expect(result.skipped).toEqual([{ key: 'agent-errors', reason: 'exists' }, { key: 'model-errors', reason: 'exists' }]);
    expect(result.created.map((rule) => rule.template?.key)).toEqual(['kb-errors', 'mcp-errors', 'tool-errors']);
  });

  it('adds only what is missing and reports the rest in catalog order', async () => {
    useRuleStore(db, [
      storedRule({ _id: 'r-added', template: { key: 'agent-errors', version: 1 } }),
      storedRule({ _id: 'r-covers', module: 'models', metric: 'model_error_rate', entity: { entityType: 'model', mode: 'all' } }),
    ]);
    const result = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    expect(result.skipped).toEqual([{ key: 'agent-errors', reason: 'exists' }, { key: 'model-errors', reason: 'covered' }]);
    expect(result.created.map((rule) => rule.template?.key)).toEqual(['kb-errors', 'mcp-errors', 'tool-errors']);
  });

  describe('a rule of the project that already watches the metric', () => {
    it('covers its template: skipped as covered without keys', async () => {
      useRuleStore(db, [storedRule({ _id: 'r-mine', name: 'Our own agent alert' })]);
      const result = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
      expect(result.skipped).toEqual([{ key: 'agent-errors', reason: 'covered' }]);
      expect(result.created.map((rule) => rule.template?.key)).toEqual(['model-errors', 'kb-errors', 'mcp-errors', 'tool-errors']);
      expect(db.createAlertRule).toHaveBeenCalledTimes(4);
    });

    it('does not cover it when asked for it by key: that creates the template next to the rule', async () => {
      const rules = useRuleStore(db, [storedRule({ _id: 'r-mine', name: 'Our own agent alert' })]);
      const result = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: ['agent-errors'] });
      expect(result.skipped).toEqual([]);
      expect(result.created).toHaveLength(1);
      expect(result.created[0].template).toEqual({ key: 'agent-errors', version: 1 });
      expect(rules.map((rule) => rule._id)).toEqual(['r-mine', 'rule-1']);
    });

    it('covers its template when it has no entity scope at all (every entity)', async () => {
      useRuleStore(db, [storedRule({ _id: 'r-legacy', entity: undefined })]);
      const result = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
      expect(result.skipped).toEqual([{ key: 'agent-errors', reason: 'covered' }]);
    });

    it.each([
      ['is disabled', { enabled: false }],
      ['watches selected entities only', { entity: { entityType: 'agent' as const, mode: 'selected' as const, keys: ['Pulse Main'] } }],
      ['watches another metric of the module', { metric: 'agent_p95_duration_ms' as const }],
      ['belongs to another project', { projectId: OTHER_PROJECT_ID }],
    ])('does not cover it when it %s', async (_label, over) => {
      useRuleStore(db, [storedRule({ _id: 'r-other', ...over })]);
      const result = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
      expect(result.skipped).toEqual([]);
      expect(result.created.map((rule) => rule.template?.key)).toEqual(KEYS);
    });

    it('does not make a template of the same key in another project exist', async () => {
      useRuleStore(db, [storedRule({ _id: 'r-there', projectId: OTHER_PROJECT_ID, template: { key: 'agent-errors', version: 1 } })]);
      const result = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
      expect(result.created).toHaveLength(5);
    });
  });

  describe('with keys', () => {
    it('adds those templates only, and reports nothing about the others', async () => {
      useRuleStore(db);
      const result = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: ['kb-errors', 'model-errors'] });
      expect(result.created.map((rule) => rule.template?.key)).toEqual(['model-errors', 'kb-errors']);
      expect(result.skipped).toEqual([]);
      expect(db.createAlertRule).toHaveBeenCalledTimes(2);
    });

    it('adds a template named twice once', async () => {
      useRuleStore(db);
      const result = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: ['tool-errors', 'tool-errors'] });
      expect(result.created).toHaveLength(1);
    });

    it('still skips a template that was added before, reporting it as existing', async () => {
      useRuleStore(db, [storedRule({ _id: 'r-added', template: { key: 'mcp-errors', version: 1 }, module: 'mcp', metric: 'mcp_server_error_rate' })]);
      const result = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: ['mcp-errors', 'tool-errors'] });
      expect(result.skipped).toEqual([{ key: 'mcp-errors', reason: 'exists' }]);
      expect(result.created.map((rule) => rule.template?.key)).toEqual(['tool-errors']);
    });

    it('treats null like no keys at all', async () => {
      useRuleStore(db);
      const result = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: null });
      expect(result.created).toHaveLength(5);
    });
  });

  describe('keys that are not a list of template keys', () => {
    it.each([
      ['an unknown key', ['nope']],
      ['a known key next to an unknown one', ['agent-errors', 'nope']],
      ['an empty list', []],
      ['a key that is not a string', [5]],
      ['a nested list', [['agent-errors']]],
      ['null entries', [null]],
      ['a string instead of a list', 'agent-errors'],
      ['a number', 5],
      ['an object', { 'agent-errors': true }],
      ['more entries than there are templates', [...CATALOG_KEYS, 'agent-errors']],
    ])('refuses %s with 400 invalid_value and writes nothing', async (_label, keys) => {
      useRuleStore(db);
      const error = await failure(() => AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys }));
      expect(error).toMatchObject({ status: 400, code: 'invalid_value' });
      expect(db.createAlertRule).not.toHaveBeenCalled();
    });

    it('names the unknown key in the message', async () => {
      const error = await failure(() => AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: ['agent-errors', 'nope'] }));
      expect(error.message).toBe('Unknown template key: nope');
    });

    it('does not even read the project', async () => {
      useRuleStore(db);
      await failure(() => AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: [] }));
      expect(db.listAlertRules).not.toHaveBeenCalled();
    });
  });

  describe('when a write fails', () => {
    it('keeps what was added and a retry completes the set without duplicates', async () => {
      const rules = useRuleStore(db);
      const create = db.createAlertRule.getMockImplementation()!;
      db.createAlertRule.mockImplementationOnce(create);
      db.createAlertRule.mockImplementationOnce(create);
      db.createAlertRule.mockRejectedValueOnce(new Error('db down'));

      await expect(AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID)).rejects.toThrow('db down');
      expect(rules.map((rule) => rule.template?.key)).toEqual(['agent-errors', 'model-errors']);

      const retry = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
      expect(retry.skipped).toEqual([{ key: 'agent-errors', reason: 'exists' }, { key: 'model-errors', reason: 'exists' }]);
      expect(retry.created.map((rule) => rule.template?.key)).toEqual(['kb-errors', 'mcp-errors', 'tool-errors']);
      expect(rules.map((rule) => rule.template?.key)).toEqual(KEYS);
    });
  });
});

// ── concurrency ─────────────────────────────────────────────────────────────

describe('applying at the same time', () => {
  it('two applies on one project create each template once', async () => {
    const rules = useRuleStore(db);
    const [first, second] = await Promise.all([
      AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID),
      AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID),
    ]);
    expect(db.createAlertRule).toHaveBeenCalledTimes(5);
    expect(rules.map((rule) => rule.template?.key)).toEqual(KEYS);
    // the one that got there first adds them, the other finds them
    expect(first.created).toHaveLength(5);
    expect(first.skipped).toEqual([]);
    expect(second.created).toEqual([]);
    expect(second.skipped).toEqual(KEYS.map((key) => ({ key, reason: 'exists' })));
  });

  it('many applies and seeds at once still add each template once', async () => {
    const rules = useRuleStore(db);
    const outcomes = await Promise.all([
      AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID),
      seedDefaultAlertRules(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID),
      AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: ['agent-errors', 'kb-errors'] }),
      seedDefaultAlertRules(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID),
      AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID),
    ]);
    expect(rules).toHaveLength(5);
    expect(new Set(rules.map((rule) => rule.template?.key)).size).toBe(5);
    // apply answers with the rules it created, seed with how many it added (null: it failed)
    const addedTotal = outcomes.reduce<number>((sum, outcome) => {
      if (outcome === null) return sum;
      return sum + (typeof outcome === 'number' ? outcome : outcome.created.length);
    }, 0);
    expect(outcomes).not.toContain(null);
    expect(addedTotal).toBe(5);
  });

  it('applies of two projects do not wait for each other', async () => {
    useRuleStore(db);
    const store = db.listAlertRules.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    db.listAlertRules.mockImplementation(async (tenantId: string, filter?: { projectId?: string }) => {
      if (filter?.projectId === PROJECT_ID) await gate;
      return store(tenantId, filter);
    });

    const blocked = AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    const other = await AlertTemplateService.apply(DB_NAME, TENANT_ID, OTHER_PROJECT_ID, USER_ID);
    expect(other.created).toHaveLength(5);
    expect(db.createAlertRule.mock.calls.every((call) => (call[0] as { projectId: string }).projectId === OTHER_PROJECT_ID)).toBe(true);

    release();
    expect((await blocked).created).toHaveLength(5);
  });

  it('a failed apply does not block the next one on the same project', async () => {
    const rules = useRuleStore(db);
    // the first read fails, every later one is answered by the store
    db.listAlertRules.mockRejectedValueOnce(new Error('db down'));

    const [failed, next] = await Promise.allSettled([
      AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID),
      AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID),
    ]);
    expect(failed).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'db down' }) });
    expect(next.status).toBe('fulfilled');
    expect((next as PromiseFulfilledResult<{ created: unknown[] }>).value.created).toHaveLength(5);
    expect(rules).toHaveLength(5);
  });
});

// ── list ────────────────────────────────────────────────────────────────────

describe('AlertTemplateService.list', () => {
  it('lists the whole catalog of a project without rules, in catalog order, the community-buildable ones as available', async () => {
    useRuleStore(db);
    const list = await AlertTemplateService.list(DB_NAME, TENANT_ID, PROJECT_ID);
    expect(list.version).toBe(ALERT_TEMPLATE_CATALOG_VERSION);
    expect(list.items.map((item) => item.key)).toEqual(CATALOG_KEYS);
    for (const item of list.items) {
      expect(item.state).toBe('available');
      expect(item).not.toHaveProperty('rule');
    }
    expect(list.items.filter((item) => item.default).map((item) => item.key)).toEqual(KEYS);
    expect(db.listAlertRules).toHaveBeenCalledWith(TENANT_ID, { projectId: PROJECT_ID });
  });

  it('describes every template with its category, mode and the input that adds it', async () => {
    useRuleStore(db);
    const { items } = await AlertTemplateService.list(DB_NAME, TENANT_ID, PROJECT_ID);
    items.forEach((item, index) => {
      const def = ALERT_TEMPLATES[index];
      expect(item).toMatchObject({
        key: def.key,
        version: def.version,
        category: def.category,
        module: def.module,
        metric: def.metric,
        mode: def.condition.mode,
        default: def.default === true,
        name: def.name,
        description: def.description,
      });
      expect(item.input).toEqual(templateRuleInput(def));
    });
  });

  it('marks a template added, covered or available, with the rule that says so', async () => {
    useRuleStore(db, [
      storedRule({ _id: 'r-added', name: 'Agent error rate above 20%', enabled: false, template: { key: 'agent-errors', version: 1 } }),
      storedRule({ _id: 'r-covers', name: 'Our model alert', module: 'models', metric: 'model_error_rate', entity: { entityType: 'model', mode: 'all' } }),
      storedRule({ _id: 'r-partial', name: 'Only my KB', module: 'rag', metric: 'kb_error_rate', entity: { entityType: 'kb', mode: 'selected', keys: ['faq'] } }),
      storedRule({ _id: 'r-off', name: 'Disabled MCP alert', module: 'mcp', metric: 'mcp_server_error_rate', enabled: false, entity: { entityType: 'mcp', mode: 'all' } }),
    ]);
    const { items } = await AlertTemplateService.list(DB_NAME, TENANT_ID, PROJECT_ID);
    const byKey = Object.fromEntries(items.map((item) => [item.key, item]));
    expect(byKey['agent-errors']).toMatchObject({ state: 'added', rule: { id: 'r-added', name: 'Agent error rate above 20%', enabled: false } });
    expect(byKey['model-errors']).toMatchObject({ state: 'covered', rule: { id: 'r-covers', name: 'Our model alert', enabled: true } });
    expect(byKey['kb-errors'].state).toBe('available');
    expect(byKey['mcp-errors'].state).toBe('available');
    expect(byKey['tool-errors'].state).toBe('available');
    expect(byKey['kb-errors']).not.toHaveProperty('rule');
  });

  it('says added, not covered, when the template rule and another rule watch the same metric', async () => {
    useRuleStore(db, [
      storedRule({ _id: 'r-other', name: 'Other' }),
      storedRule({ _id: 'r-template', name: 'Template', template: { key: 'agent-errors', version: 1 } }),
    ]);
    const { items } = await AlertTemplateService.list(DB_NAME, TENANT_ID, PROJECT_ID);
    expect(items[0]).toMatchObject({ key: 'agent-errors', state: 'added', rule: { id: 'r-template' } });
  });

  it('reports the default set as added after an apply, and the rest as available', async () => {
    useRuleStore(db);
    await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    const { items } = await AlertTemplateService.list(DB_NAME, TENANT_ID, PROJECT_ID);
    expect(items.slice(0, 5).map((item) => item.state)).toEqual(['added', 'added', 'added', 'added', 'added']);
    expect(items.slice(0, 5).map((item) => item.rule?.id)).toEqual(['rule-1', 'rule-2', 'rule-3', 'rule-4', 'rule-5']);
    expect(items.slice(5).every((item) => item.state === 'available')).toBe(true);
  });

  it('keeps the projects apart', async () => {
    useRuleStore(db, [storedRule({ _id: 'r-there', projectId: OTHER_PROJECT_ID, template: { key: 'agent-errors', version: 1 } })]);
    const { items } = await AlertTemplateService.list(DB_NAME, TENANT_ID, PROJECT_ID);
    expect(items.every((item) => item.state === 'available')).toBe(true);
  });

  describe('projectAdminRecipients', () => {
    const users = [
      { _id: 'owner', email: 'owner@acme.test', role: 'owner' },
      { _id: 'ada', email: 'ada@acme.test', role: 'user' },
      { _id: 'bob', email: 'bob@acme.test', role: 'user' },
      { _id: 'off', email: 'off@acme.test', role: 'user', status: 'disabled' },
      { _id: 'plain', email: 'plain@acme.test', role: 'user' },
    ];

    it('is 0 for a project without admins (its default alert rules then mail the owners and admins)', async () => {
      useRuleStore(db);
      db.listUsers.mockResolvedValue(users);
      db.listUserProjectsByProject.mockResolvedValue([{ userId: 'plain', projectId: PROJECT_ID, role: 'member' }]);
      expect((await AlertTemplateService.list(DB_NAME, TENANT_ID, PROJECT_ID)).projectAdminRecipients).toBe(0);
    });

    it('counts the admins the rules would mail, from every source, without disabled accounts', async () => {
      useRuleStore(db);
      db.listUsers.mockResolvedValue(users);
      db.listUserProjectsByProject.mockResolvedValue([
        { userId: 'ada', projectId: PROJECT_ID, role: 'project_admin' },
        { userId: 'off', projectId: PROJECT_ID, role: 'project_admin' },
        { userId: 'plain', projectId: PROJECT_ID, role: 'member' },
      ]);
      db.listGroupProjectsByProject.mockResolvedValue([{ groupId: 'g1', projectId: PROJECT_ID, role: 'project_admin' }]);
      db.listGroupMembers.mockResolvedValue([{ userId: 'bob' }, { userId: 'ada' }]);
      expect((await AlertTemplateService.list(DB_NAME, TENANT_ID, PROJECT_ID)).projectAdminRecipients).toBe(2);
      expect(db.listUserProjectsByProject).toHaveBeenCalledWith(PROJECT_ID);
    });

    it('is 0, not an error, when the memberships cannot be read', async () => {
      useRuleStore(db);
      db.listUsers.mockResolvedValue(users);
      db.listUserProjectsByProject.mockRejectedValue(new Error('db down'));
      expect((await AlertTemplateService.list(DB_NAME, TENANT_ID, PROJECT_ID)).projectAdminRecipients).toBe(0);
    });
  });

  describe('defaultRulesOnNewProjects', () => {
    it('is on by default', async () => {
      useRuleStore(db);
      expect((await AlertTemplateService.list(DB_NAME, TENANT_ID, PROJECT_ID)).defaultRulesOnNewProjects).toBe(true);
    });

    it.each([['false'], ['0'], ['no']])('is off when ALERT_DEFAULT_RULES_ON_CREATE is %j', async (value) => {
      useRuleStore(db);
      process.env.ALERT_DEFAULT_RULES_ON_CREATE = value;
      reloadConfig();
      expect((await AlertTemplateService.list(DB_NAME, TENANT_ID, PROJECT_ID)).defaultRulesOnNewProjects).toBe(false);
    });

    it.each([['true'], ['1']])('is on when ALERT_DEFAULT_RULES_ON_CREATE is %j', async (value) => {
      useRuleStore(db);
      process.env.ALERT_DEFAULT_RULES_ON_CREATE = value;
      reloadConfig();
      expect((await AlertTemplateService.list(DB_NAME, TENANT_ID, PROJECT_ID)).defaultRulesOnNewProjects).toBe(true);
    });
  });
});

describe('defaultAlertRulesOnCreate', () => {
  it('follows ALERT_DEFAULT_RULES_ON_CREATE: on unless it says false', () => {
    expect(defaultAlertRulesOnCreate()).toBe(true);
    process.env.ALERT_DEFAULT_RULES_ON_CREATE = '';
    reloadConfig();
    expect(defaultAlertRulesOnCreate()).toBe(true);
    process.env.ALERT_DEFAULT_RULES_ON_CREATE = 'false';
    reloadConfig();
    expect(defaultAlertRulesOnCreate()).toBe(false);
    process.env.ALERT_DEFAULT_RULES_ON_CREATE = 'true';
    reloadConfig();
    expect(defaultAlertRulesOnCreate()).toBe(true);
  });
});

// ── seedDefaultAlertRules ───────────────────────────────────────────────────────

describe('seedDefaultAlertRules', () => {
  it('returns how many rules it added to a new project', async () => {
    useRuleStore(db);
    expect(await seedDefaultAlertRules(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID)).toBe(5);
    expect(db.createAlertRule).toHaveBeenCalledTimes(5);
    expect(db.createAlertRule.mock.calls[0][0]).toMatchObject({ tenantId: TENANT_ID, projectId: PROJECT_ID, createdBy: USER_ID });
  });

  it('returns 0 when the project already has them, and counts only the new ones otherwise', async () => {
    useRuleStore(db, [storedRule({ _id: 'r-mine', name: 'Ours' })]);
    expect(await seedDefaultAlertRules(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID)).toBe(4);
    expect(await seedDefaultAlertRules(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID)).toBe(0);
  });

  it('returns null, and does not throw, when the rules cannot be read', async () => {
    db.listAlertRules.mockRejectedValue(new Error('db down'));
    await expect(seedDefaultAlertRules(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID)).resolves.toBeNull();
    expect(db.createAlertRule).not.toHaveBeenCalled();
  });

  it('returns null, and does not throw, when the database cannot be opened', async () => {
    (getTenantDatabase as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no connection'));
    await expect(seedDefaultAlertRules(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID)).resolves.toBeNull();
  });

  it('returns null, and does not throw, when a rule cannot be written', async () => {
    useRuleStore(db);
    db.createAlertRule.mockRejectedValue(new Error('write failed'));
    await expect(seedDefaultAlertRules(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID)).resolves.toBeNull();
  });

  it('logs the failure with the project and the message only', async () => {
    db.listAlertRules.mockRejectedValue(new Error('db down'));
    await seedDefaultAlertRules(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    const errors = h.logLines.filter((line) => line.level === 'error');
    expect(errors).toEqual([{ level: 'error', message: 'Adding the default alert rules failed', meta: { projectId: PROJECT_ID, error: 'db down' } }]);
  });

  it('does not log a success', async () => {
    useRuleStore(db);
    await seedDefaultAlertRules(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    expect(h.logLines.filter((line) => line.level === 'error')).toEqual([]);
  });
});

// ── states: covered by mode, retargeted, legacy ─────────────────────────────

describe('template states', () => {
  const stateOf = async (key: string) => {
    const { items } = await AlertTemplateService.list(DB_NAME, TENANT_ID, PROJECT_ID);
    return items.find((item) => item.key === key)!;
  };

  it('an slo_burn rule on the metric does not cover the threshold template', async () => {
    useRuleStore(db, [
      storedRule({
        _id: 'r-slo',
        condition: { operator: 'gt', threshold: 0, mode: 'slo_burn', slo: { objectivePct: 99, windowDays: 30, burnRate: 14.4, longWindowMinutes: 60, shortWindowMinutes: 5 } },
      }),
    ]);
    expect((await stateOf('agent-errors')).state).toBe('available');
    expect((await stateOf('agent-error-budget')).state).toBe('covered');
  });

  it('a rule without a mode is a threshold rule', async () => {
    useRuleStore(db, [storedRule({ _id: 'r-plain', condition: { operator: 'lt', threshold: 1 } })]);
    expect(await stateOf('agent-errors')).toMatchObject({ state: 'covered', rule: { id: 'r-plain' } });
    expect((await stateOf('agent-error-budget')).state).toBe('available');
  });

  it('a rule retargeted to another metric is no longer the template rule', async () => {
    useRuleStore(db, [
      storedRule({
        _id: 'r-moved', name: 'Was agent errors', metric: 'agent_p95_duration_ms',
        template: { key: 'agent-errors', version: 1 },
      }),
    ]);
    expect((await stateOf('agent-errors')).state).toBe('available');
    const result = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: ['agent-errors'] });
    expect(result.created).toHaveLength(1);
  });

  it('a legacy metric is covered by an enabled rule that has no scope, and only by it', async () => {
    const legacy = { module: 'guardrails' as const, metric: 'guardrail_block_rate' as const, entity: undefined };
    useRuleStore(db, [storedRule({ _id: 'r-scoped', ...legacy, scope: { guardrailKey: 'pii' } })]);
    expect((await stateOf('guardrail-blocks')).state).toBe('available');

    useRuleStore(db, [storedRule({ _id: 'r-open', ...legacy, scope: {} }), storedRule({ _id: 'r-blank', ...legacy, scope: { guardrailKey: '' } })]);
    expect(await stateOf('guardrail-blocks')).toMatchObject({ state: 'covered', rule: { id: 'r-open' } });

    useRuleStore(db, [storedRule({ _id: 'r-off', ...legacy, scope: {}, enabled: false })]);
    expect((await stateOf('guardrail-blocks')).state).toBe('available');
  });

  it('a legacy template is added by its mark', async () => {
    useRuleStore(db, [
      storedRule({ _id: 'r-mine', module: 'redteam', metric: 'redteam_attack_success_rate', entity: undefined, template: { key: 'redteam-attack-success', version: 1 } }),
    ]);
    expect(await stateOf('redteam-attack-success')).toMatchObject({ state: 'added', rule: { id: 'r-mine' } });
  });
});

// ── availability ────────────────────────────────────────────────────────────

describe('template availability', () => {
  const availabilityOf = async (key: string) => {
    const { items } = await AlertTemplateService.list(DB_NAME, TENANT_ID, PROJECT_ID);
    return items.find((item) => item.key === key)!.availability;
  };
  const provide = () => {
    registerEntityBaselineProvider({ evaluate: vi.fn(), band: vi.fn() } as never);
    registerSloBurnEvaluator(vi.fn());
  };

  it('threshold and absence templates are available in any build', async () => {
    useRuleStore(db);
    (isTenantEnterpriseLicensed as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    expect(await availabilityOf('agent-errors')).toEqual({ available: true });
    expect(await availabilityOf('agent-traffic-stopped')).toEqual({ available: true });
    expect(await availabilityOf('guardrail-blocks')).toEqual({ available: true });
  });

  it('baseline and slo_burn templates say not_enterprise_build when the build lacks the provider', async () => {
    useRuleStore(db);
    expect(await availabilityOf('agent-cost-spike')).toEqual({ available: false, reason: 'not_enterprise_build' });
    expect(await availabilityOf('model-error-budget')).toEqual({ available: false, reason: 'not_enterprise_build' });
  });

  it('and license_required when the provider is there but the tenant has no licence', async () => {
    useRuleStore(db);
    provide();
    (isTenantEnterpriseLicensed as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    expect(await availabilityOf('agent-cost-spike')).toEqual({ available: false, reason: 'license_required' });
    expect(await availabilityOf('agent-error-budget')).toEqual({ available: false, reason: 'license_required' });
  });

  it('and available with both', async () => {
    useRuleStore(db);
    provide();
    expect(await availabilityOf('agent-cost-spike')).toEqual({ available: true });
    expect(await availabilityOf('model-error-budget')).toEqual({ available: true });
  });

  it('asks for the licence once per list, however many templates need it', async () => {
    useRuleStore(db);
    provide();
    await AlertTemplateService.list(DB_NAME, TENANT_ID, PROJECT_ID);
    expect(isTenantEnterpriseLicensed).toHaveBeenCalledTimes(1);
  });

  it('is separate from the state: an added template can be unavailable', async () => {
    useRuleStore(db, [storedRule({ _id: 'r-slo', template: { key: 'agent-error-budget', version: 1 } })]);
    const { items } = await AlertTemplateService.list(DB_NAME, TENANT_ID, PROJECT_ID);
    expect(items.find((item) => item.key === 'agent-error-budget')).toMatchObject({
      state: 'added',
      availability: { available: false, reason: 'not_enterprise_build' },
    });
  });
});

// ── apply: default set, picks, skip reasons ─────────────────────────────────

describe('AlertTemplateService.apply: the default set and explicit picks', () => {
  it('without keys adds the default set only, never the rest of the catalog', async () => {
    useRuleStore(db);
    const result = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    expect(result.created.map((rule) => rule.template?.key)).toEqual(KEYS);
    expect(db.createAlertRule).toHaveBeenCalledTimes(5);
  });

  it('with keys adds picks from the whole catalog, in catalog order, without duplicates', async () => {
    useRuleStore(db);
    const result = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, {
      keys: ['guardrail-blocks', 'agent-slow-runs', 'agent-errors', 'guardrail-blocks', 'agent-traffic-stopped'],
    });
    expect(result.created.map((rule) => rule.template?.key)).toEqual(['agent-errors', 'agent-slow-runs', 'agent-traffic-stopped', 'guardrail-blocks']);
    expect(result.skipped).toEqual([]);
    const slow = db.createAlertRule.mock.calls.map((call) => call[0] as Record<string, unknown>).find((rule) => rule.metric === 'agent_p95_duration_ms');
    expect(slow).toMatchObject({ windowMinutes: 60, cooldownMinutes: 240, condition: { mode: 'threshold', operator: 'gt', threshold: 120_000, forMinutes: 15, minSamples: 20 } });
  });

  it('creates a legacy template with no entity and an empty scope', async () => {
    useRuleStore(db);
    await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: ['kb-ingestion-failures'] });
    const written = db.createAlertRule.mock.calls[0][0] as Record<string, unknown>;
    expect(written).toMatchObject({ module: 'rag', metric: 'rag_failed_documents', scope: {}, windowMinutes: 60, cooldownMinutes: 360 });
    expect(written).not.toHaveProperty('entity');
  });

  it('skips an unavailable template as unavailable, with or without keys, and creates the rest', async () => {
    useRuleStore(db);
    const result = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: ['agent-errors', 'agent-cost-spike', 'model-error-budget'] });
    expect(result.created.map((rule) => rule.template?.key)).toEqual(['agent-errors']);
    expect(result.skipped).toEqual([{ key: 'model-error-budget', reason: 'unavailable' }, { key: 'agent-cost-spike', reason: 'unavailable' }].sort((a, b) => CATALOG_KEYS.indexOf(a.key) - CATALOG_KEYS.indexOf(b.key)));
  });

  it('creates an Enterprise template once the build and licence have it', async () => {
    useRuleStore(db);
    registerEntityBaselineProvider({ evaluate: vi.fn(), band: vi.fn() } as never);
    const result = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: ['agent-cost-spike'] });
    expect(result.skipped).toEqual([]);
    expect(result.created[0]).toMatchObject({
      template: { key: 'agent-cost-spike', version: 1 },
      condition: { mode: 'baseline', baseline: { direction: 'up', minRatio: 2, minZ: 3, minDelta: 1, lookbackDays: 14, seasonality: 'daily' } },
    });
  });

  it('reports exists before unavailable, and covered ones are created when picked but skipped by the default set', async () => {
    useRuleStore(db, [
      storedRule({ _id: 'r-slo', template: { key: 'agent-error-budget', version: 1 } }),
      storedRule({ _id: 'r-open', name: 'Ours', metric: 'tool_error_rate', module: 'tools', entity: { entityType: 'tool', mode: 'all' } }),
    ]);
    const picked = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: ['agent-error-budget', 'tool-errors'] });
    expect(picked.skipped).toEqual([{ key: 'agent-error-budget', reason: 'exists' }]);
    expect(picked.created.map((rule) => rule.template?.key)).toEqual(['tool-errors']);

    const defaults = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    expect(defaults.skipped).toContainEqual({ key: 'tool-errors', reason: 'exists' });
  });

  it('keys too long, or an unknown key among known ones, change nothing', async () => {
    useRuleStore(db);
    for (const keys of [[...CATALOG_KEYS, 'agent-errors'], ['agent-errors', 'nope']]) {
      const error = await failure(() => AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys }));
      expect(error).toMatchObject({ status: 400, code: 'invalid_value' });
    }
    expect(db.createAlertRule).not.toHaveBeenCalled();
  });

  it('accepts every key of the catalog at once (the longest allowed list)', async () => {
    useRuleStore(db);
    registerEntityBaselineProvider({ evaluate: vi.fn(), band: vi.fn() } as never);
    registerSloBurnEvaluator(vi.fn());
    const result = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: [...CATALOG_KEYS].reverse() });
    expect(result.created.map((rule) => rule.template?.key)).toEqual(CATALOG_KEYS);
  });
});

// ── the project lock ────────────────────────────────────────────────────────

describe('withAlertTemplateLock', () => {
  const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

  it('a second apply waits for the first and then skips what it added (exists)', async () => {
    const rules = useRuleStore(db);
    const order: string[] = [];
    const first = withAlertTemplateLock(DB_NAME, PROJECT_ID, async () => {
      order.push('first:start');
      await tick(20);
      order.push('first:end');
    });
    const second = AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID).then((result) => {
      order.push('second:done');
      return result;
    });
    // the first holds the lock: nothing of the second has been written yet
    await tick(5);
    expect(rules).toHaveLength(0);
    await first;
    const result = await second;
    expect(order).toEqual(['first:start', 'first:end', 'second:done']);
    expect(result.created).toHaveLength(5);
  });

  it('two applies through the cache lock add each template once', async () => {
    const rules = useRuleStore(db);
    const [one, two] = await Promise.all([
      AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID),
      AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID),
    ]);
    expect(rules).toHaveLength(5);
    expect(one.created.length + two.created.length).toBe(5);
    expect([one, two].find((result) => result.created.length === 0)!.skipped).toEqual(KEYS.map((key) => ({ key, reason: 'exists' })));
  });

  it('takes the cache lock under a key of the tenant and project, and releases it with its token', async () => {
    useRuleStore(db);
    const acquire = vi.spyOn(cache, 'acquireLock');
    const release = vi.spyOn(cache, 'releaseLock');
    await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    expect(acquire).toHaveBeenCalledWith(`alerts:templates:${DB_NAME}:${PROJECT_ID}`, 60);
    expect(release).toHaveBeenCalledTimes(1);
    const token = await acquire.mock.results[0].value;
    expect(release).toHaveBeenCalledWith(`alerts:templates:${DB_NAME}:${PROJECT_ID}`, token);
  });

  it('releases the cache lock when the work fails', async () => {
    const release = vi.spyOn(cache, 'releaseLock');
    await expect(withAlertTemplateLock(DB_NAME, PROJECT_ID, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(release).toHaveBeenCalledTimes(1);
    // and the next one is not blocked
    await expect(withAlertTemplateLock(DB_NAME, PROJECT_ID, async () => 'ok')).resolves.toBe('ok');
  });

  it('a release that throws does not fail the work', async () => {
    vi.spyOn(cache, 'releaseLock').mockRejectedValue(new Error('redis gone'));
    await expect(withAlertTemplateLock(DB_NAME, PROJECT_ID, async () => 'ok')).resolves.toBe('ok');
  });

  it('another project is not held up by a held lock', async () => {
    const held = await cache.acquireLock(`alerts:templates:${DB_NAME}:${PROJECT_ID}`, 60);
    expect(held).toBeDefined();
    await expect(withAlertTemplateLock(DB_NAME, OTHER_PROJECT_ID, async () => 'other')).resolves.toBe('other');
  });

  it('waits for a lock another process holds and goes on once it is released', async () => {
    const key = `alerts:templates:${DB_NAME}:${PROJECT_ID}`;
    const token = (await cache.acquireLock(key, 60))!;
    let ran = false;
    const pending = withAlertTemplateLock(DB_NAME, PROJECT_ID, async () => { ran = true; return 'done'; });
    await tick(250);
    expect(ran).toBe(false);
    await cache.releaseLock(key, token);
    await expect(pending).resolves.toBe('done');
    expect(ran).toBe(true);
  });

  it('answers 409 busy when the cache lock stays held for the whole wait', async () => {
    vi.useFakeTimers();
    await cache.acquireLock(`alerts:templates:${DB_NAME}:${PROJECT_ID}`, 600);
    const outcome = withAlertTemplateLock(DB_NAME, PROJECT_ID, async () => 'never').catch((error) => error);
    await vi.advanceTimersByTimeAsync(5_500);
    const error = await outcome;
    expect(error).toBeInstanceOf(AlertApiError);
    expect(error).toMatchObject({ status: 409, code: 'busy', message: 'Rule templates are being added to this project. Try again in a moment.' });
  });

  it('a busy apply writes nothing', async () => {
    vi.useFakeTimers();
    useRuleStore(db);
    await cache.acquireLock(`alerts:templates:${DB_NAME}:${PROJECT_ID}`, 600);
    const outcome = AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID).catch((error) => error);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(await outcome).toMatchObject({ status: 409, code: 'busy' });
    expect(db.createAlertRule).not.toHaveBeenCalled();
  });

  it('a cache that never grants a lock falls back to the in-process lock, with one warning, and does not hang', async () => {
    h.cache = { acquireLock: async () => undefined, releaseLock: async () => undefined };
    const rules = useRuleStore(db);
    const [one, two] = await Promise.all([
      AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID),
      AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID),
    ]);
    expect(rules).toHaveLength(5);
    expect(one.created.length + two.created.length).toBe(5);
    // the warning is logged once per process, not once per apply
    const warnings = () => h.logLines.filter((line) => line.level === 'warn' && line.message.includes('serialised within this process only')).length;
    const afterFirstBurst = warnings();
    expect(afterFirstBurst).toBeLessThanOrEqual(1);
    await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    expect(warnings()).toBe(afterFirstBurst);
  });

  it('a cache whose lock call throws also falls back, and the apply goes through', async () => {
    h.cache = { acquireLock: async () => { throw new Error('redis down'); }, releaseLock: async () => undefined };
    const rules = useRuleStore(db);
    const result = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    expect(result.created).toHaveLength(5);
    expect(rules).toHaveLength(5);
  });

  it('a cache that cannot be opened also falls back', async () => {
    const { getCache } = await import('@/lib/core/cache');
    (getCache as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no redis url'));
    useRuleStore(db);
    const result = await AlertTemplateService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    expect(result.created).toHaveLength(5);
  });
});

// ── createFromTemplate ──────────────────────────────────────────────────────

describe('AlertTemplateService.createFromTemplate', () => {
  const customised = () => ({ ...templateRuleInput(getAlertTemplate('agent-errors')!), name: 'Agent errors (tighter)', condition: { mode: 'threshold' as const, operator: 'gt' as const, threshold: 5 } });

  it('creates the customised rule and stores the template mark', async () => {
    useRuleStore(db);
    const rule = await AlertTemplateService.createFromTemplate(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, customised(), 'agent-errors');
    expect(rule).toMatchObject({ _id: 'rule-1', name: 'Agent errors (tighter)', template: { key: 'agent-errors', version: 1 } });
    expect(db.createAlertRule.mock.calls[0][0]).toMatchObject({
      projectId: PROJECT_ID,
      createdBy: USER_ID,
      template: { key: 'agent-errors', version: 1 },
      condition: { threshold: 5 },
    });
  });

  it('refuses an unknown key with 400 invalid_value', async () => {
    useRuleStore(db);
    for (const key of ['nope', 5, null, {}]) {
      const error = await failure(() => AlertTemplateService.createFromTemplate(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, customised(), key));
      expect(error).toMatchObject({ status: 400, code: 'invalid_value' });
    }
    expect(db.createAlertRule).not.toHaveBeenCalled();
  });

  it('refuses a rule on another metric than the template with 400 invalid_value', async () => {
    useRuleStore(db);
    const error = await failure(() => AlertTemplateService.createFromTemplate(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { ...customised(), metric: 'agent_p95_duration_ms' }, 'agent-errors'));
    expect(error).toMatchObject({ status: 400, code: 'invalid_value', message: 'templateKey "agent-errors" needs the metric agent_error_rate' });
    expect(db.createAlertRule).not.toHaveBeenCalled();
  });

  it('answers 409 template_exists when the project already has the template', async () => {
    useRuleStore(db, [storedRule({ _id: 'r-added', template: { key: 'agent-errors', version: 1 } })]);
    const error = await failure(() => AlertTemplateService.createFromTemplate(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, customised(), 'agent-errors'));
    expect(error).toMatchObject({ status: 409, code: 'template_exists', message: 'This template is already added to the project' });
    expect(db.createAlertRule).not.toHaveBeenCalled();
  });

  it('does not count a template mark of another project, or of a rule moved to another metric', async () => {
    useRuleStore(db, [
      storedRule({ _id: 'r-there', projectId: OTHER_PROJECT_ID, template: { key: 'agent-errors', version: 1 } }),
      storedRule({ _id: 'r-moved', metric: 'agent_p95_duration_ms', template: { key: 'agent-errors', version: 1 } }),
    ]);
    const rule = await AlertTemplateService.createFromTemplate(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, customised(), 'agent-errors');
    expect(rule.template).toEqual({ key: 'agent-errors', version: 1 });
  });

  it('a covering rule does not stop a customised copy', async () => {
    useRuleStore(db, [storedRule({ _id: 'r-mine' })]);
    const rule = await AlertTemplateService.createFromTemplate(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, customised(), 'agent-errors');
    expect(rule._id).toBe('rule-1');
  });

  it('two at once create it once: the second gets template_exists', async () => {
    const rules = useRuleStore(db);
    const outcomes = await Promise.allSettled([
      AlertTemplateService.createFromTemplate(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, customised(), 'agent-errors'),
      AlertTemplateService.createFromTemplate(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, customised(), 'agent-errors'),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: 'template_exists' });
    expect(rules).toHaveLength(1);
  });

  it('still validates the rule: an invalid body is refused by the rule validator', async () => {
    useRuleStore(db);
    const error = await failure(() => AlertTemplateService.createFromTemplate(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { ...customised(), windowMinutes: 7 }, 'agent-errors'));
    expect(error).toMatchObject({ status: 400, code: 'invalid_window' });
  });
});

// ── seeding binds the tenant scope ──────────────────────────────────────────

describe('seedDefaultAlertRules and the tenant scope', () => {
  it('runs the whole apply inside runWithTenantScope of the tenant', async () => {
    const { runWithTenantScope } = await import('@/lib/database');
    useRuleStore(db);
    const inside: boolean[] = [];
    let open = false;
    (runWithTenantScope as ReturnType<typeof vi.fn>).mockImplementationOnce(async (_name: string, fn: (db: unknown) => unknown) => {
      open = true;
      try { return await fn(db); } finally { open = false; }
    });
    db.listAlertRules.mockImplementation(async () => { inside.push(open); return []; });
    db.createAlertRule.mockImplementation(async (rule: Record<string, unknown>) => { inside.push(open); return { ...rule, _id: 'r' }; });

    expect(await seedDefaultAlertRules(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID)).toBe(5);
    expect(runWithTenantScope).toHaveBeenCalledWith(DB_NAME, expect.any(Function));
    expect(inside).toHaveLength(6);
    expect(inside.every(Boolean)).toBe(true);
  });

  it('returns null when the scope itself cannot be opened', async () => {
    const { runWithTenantScope } = await import('@/lib/database');
    (runWithTenantScope as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no tenant'));
    await expect(seedDefaultAlertRules(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID)).resolves.toBeNull();
  });

  it('adds the default set only', async () => {
    const rules = useRuleStore(db);
    await seedDefaultAlertRules(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    expect(rules.map((rule) => rule.template?.key)).toEqual(KEYS);
  });
});
