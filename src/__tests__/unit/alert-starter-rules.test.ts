/**
 * Starter alert rules: the catalog (one error-rate rule per entity module), the rule each definition creates,
 * what `StarterAlertService.apply` / `list` / `seedStarterAlerts` do to a project, and that two applies at the
 * same time still add each starter once. Runs the real alert service over a mocked tenant database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

/** The mock db with every method as a plain vitest mock: tests feed it partial rows. */
type LooseDb = Record<string, import('vitest').Mock>;

const h = vi.hoisted(() => ({
  logLines: [] as Array<{ level: string; message: string; meta: unknown }>,
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  getTenantDatabase: vi.fn(),
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

import { reloadConfig } from '@/lib/core/config';
import { getDatabase, getTenantDatabase } from '@/lib/database';
import type { IAlertRule } from '@/lib/database';
import { AlertApiError } from '@/lib/services/alerts/alertApiError';
import { validateRuleInput } from '@/lib/services/alerts/alertService';
import { resetAlertEmailUserCache } from '@/lib/services/alerts/channels/emailChannel';
import { ALERT_MODULE_METRICS, getMetricDef, MODULE_ENTITY_TYPE } from '@/lib/services/alerts/metricCatalog';
import {
  getStarterDefinition,
  seedStarterAlerts,
  STARTER_ALERT_KEYS,
  STARTER_ALERTS,
  STARTER_DEFAULTS,
  STARTER_SET_VERSION,
  StarterAlertService,
  starterAlertsOnCreate,
  starterRuleInput,
} from '@/lib/services/alerts/starterAlerts';

const DB_NAME = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'proj-1';
const OTHER_PROJECT_ID = 'proj-2';
const USER_ID = 'user-1';

const KEYS = [...STARTER_ALERT_KEYS];

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

beforeEach(() => {
  vi.clearAllMocks();
  h.logLines.length = 0;
  resetAlertEmailUserCache();
  delete process.env.ALERT_STARTER_RULES_ON_CREATE;
  reloadConfig();
  db = createMockDb() as unknown as LooseDb;
  (getTenantDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
});

afterEach(() => {
  delete process.env.ALERT_STARTER_RULES_ON_CREATE;
  reloadConfig();
});

// ── The catalog ─────────────────────────────────────────────────────────────

describe('the starter catalog', () => {
  it('has unique keys, and they are exactly STARTER_ALERT_KEYS', () => {
    const keys = STARTER_ALERTS.map((def) => def.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...STARTER_ALERT_KEYS].sort());
    expect(STARTER_ALERTS).toHaveLength(5);
  });

  it('gives each definition its own name and metric', () => {
    expect(new Set(STARTER_ALERTS.map((def) => def.name)).size).toBe(STARTER_ALERTS.length);
    expect(new Set(STARTER_ALERTS.map((def) => def.metric)).size).toBe(STARTER_ALERTS.length);
    expect(new Set(STARTER_ALERTS.map((def) => def.module)).size).toBe(STARTER_ALERTS.length);
  });

  it.each(STARTER_ALERTS.map((def) => [def.key, def] as const))('%s: the metric belongs to the module and to the entity type', (_key, def) => {
    expect(ALERT_MODULE_METRICS[def.module]).toContain(def.metric);
    const metric = getMetricDef(def.metric);
    expect(metric).toBeDefined();
    expect(metric?.module).toBe(def.module);
    expect(metric?.source).toBe('entity');
    expect(metric?.entityType).toBe(def.entityType);
    expect(MODULE_ENTITY_TYPE[def.module]).toBe(def.entityType);
    expect(metric?.unit).toBe('%');
    expect(metric?.modes).toContain('threshold');
  });

  it.each(STARTER_ALERTS.map((def) => [def.key, def] as const))('%s: the texts state the numbers the rule really uses', (_key, def) => {
    expect(def.name).toContain(`${def.threshold}%`);
    expect(def.description).toContain(`${def.threshold}%`);
    expect(def.description).toContain(`${STARTER_DEFAULTS.windowMinutes} minutes`);
    expect(def.description).toContain(`at least ${STARTER_DEFAULTS.minSamples}`);
    expect(def.name.length).toBeLessThanOrEqual(120);
    expect(def.description.length).toBeLessThanOrEqual(1000);
    expect(def.version).toBeGreaterThanOrEqual(1);
    expect(def.version).toBeLessThanOrEqual(STARTER_SET_VERSION);
  });

  it('uses the same window, hold, sample floor and cooldown for every rule', () => {
    expect(STARTER_DEFAULTS).toEqual({ windowMinutes: 30, forMinutes: 10, minSamples: 20, cooldownMinutes: 120 });
    expect(STARTER_SET_VERSION).toBe(1);
  });

  it('looks a definition up by key, and only by a key', () => {
    expect(getStarterDefinition('agent-errors')).toBe(STARTER_ALERTS.find((def) => def.key === 'agent-errors'));
    for (const key of KEYS) expect(getStarterDefinition(key)?.key).toBe(key);
    for (const nope of ['nope', '', undefined, null, 5, {}, ['agent-errors'], 'constructor', '__proto__', 'AGENT-ERRORS']) {
      expect(getStarterDefinition(nope)).toBeUndefined();
    }
  });
});

describe('starterRuleInput', () => {
  it.each(STARTER_ALERTS.map((def) => [def.key, def] as const))('%s: is a rule the validator accepts', (_key, def) => {
    const rule = validateRuleInput(starterRuleInput(def), { mode: 'create' });
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
      entity: { entityType: def.entityType, mode: 'all' },
      condition: { mode: 'threshold', operator: 'gt', threshold: def.threshold, forMinutes: 10, minSamples: 20 },
    });
    expect(rule.channels).toEqual([{ type: 'email', recipients: [], audience: 'project_admins' }]);
  });

  it.each(STARTER_ALERTS.map((def) => [def.key, def] as const))('%s: watches every entity over 30 minutes with a 20-sample floor and a 10-minute hold', (_key, def) => {
    const input = starterRuleInput(def);
    expect(input.windowMinutes).toBe(30);
    expect(input.cooldownMinutes).toBe(120);
    expect(input.condition).toEqual({ mode: 'threshold', operator: 'gt', threshold: def.threshold, forMinutes: 10, minSamples: 20 });
    expect(input.entity).toEqual({ entityType: def.entityType, mode: 'all' });
    expect(input.enabled).toBe(true);
    expect(input.channels).toEqual([{ type: 'email', recipients: [], audience: 'project_admins' }]);
    expect(input.channels).toHaveLength(1);
  });

  it('builds a fresh object every time, so a caller cannot change the catalog through it', () => {
    const def = STARTER_ALERTS[0];
    const first = starterRuleInput(def);
    (first.channels as Array<{ recipients: string[] }>)[0].recipients.push('x@acme.com');
    first.condition.threshold = 99;
    expect(starterRuleInput(def).channels).toEqual([{ type: 'email', recipients: [], audience: 'project_admins' }]);
    expect(starterRuleInput(def).condition.threshold).toBe(def.threshold);
  });
});

// ── apply ───────────────────────────────────────────────────────────────────

describe('StarterAlertService.apply', () => {
  it('creates all five rules in an empty project, each marked with its key and version and enabled', async () => {
    useRuleStore(db);
    const result = await StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);

    expect(result.skipped).toEqual([]);
    expect(result.created).toHaveLength(5);
    expect(result.created.map((rule) => rule.starter)).toEqual(STARTER_ALERTS.map((def) => ({ key: def.key, version: def.version })));
    expect(getTenantDatabase).toHaveBeenCalledWith(DB_NAME);

    const written = db.createAlertRule.mock.calls.map((call) => call[0] as Record<string, unknown>);
    expect(written).toHaveLength(5);
    written.forEach((rule, index) => {
      const def = STARTER_ALERTS[index];
      expect(rule).toMatchObject({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        createdBy: USER_ID,
        enabled: true,
        starter: { key: def.key, version: def.version },
        name: def.name,
        description: def.description,
        module: def.module,
        metric: def.metric,
        windowMinutes: 30,
        cooldownMinutes: 120,
        severity: 'auto',
        notifyOnResolve: true,
        renotifyMinutes: 0,
        entity: { entityType: def.entityType, mode: 'all' },
        condition: { mode: 'threshold', operator: 'gt', threshold: def.threshold, forMinutes: 10, minSamples: 20 },
      });
      expect(rule.channels).toEqual([
        { id: expect.stringMatching(/^ch_[0-9a-f]{12}$/), type: 'email', recipients: [], audience: 'project_admins' },
      ]);
    });
  });

  it('returns the rules masked, with the marker and the audience', async () => {
    useRuleStore(db);
    const { created } = await StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    expect(created[0]).toMatchObject({
      _id: 'rule-1',
      starter: { key: 'agent-errors', version: 1 },
      channels: [{ type: 'email', recipients: [], audience: 'project_admins' }],
    });
    expect(JSON.stringify(created)).not.toContain('sealed');
  });

  it('only reads the rules of the project it adds to', async () => {
    useRuleStore(db);
    await StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    expect(db.listAlertRules).toHaveBeenCalledWith(TENANT_ID, { projectId: PROJECT_ID });
  });

  it('a second apply creates nothing and says each starter exists', async () => {
    const rules = useRuleStore(db);
    await StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    db.createAlertRule.mockClear();

    const again = await StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    expect(again.created).toEqual([]);
    expect(again.skipped).toEqual(KEYS.map((key) => ({ key, reason: 'exists' })));
    expect(db.createAlertRule).not.toHaveBeenCalled();
    expect(rules).toHaveLength(5);
  });

  it('never adds a starter twice, even when its rule was disabled or edited since', async () => {
    useRuleStore(db, [
      storedRule({ _id: 'r-off', name: 'Mine now', enabled: false, starter: { key: 'agent-errors', version: 1 } }),
      storedRule({
        _id: 'r-edit', name: 'Edited', module: 'models', metric: 'model_error_rate', condition: { operator: 'gt', threshold: 99 },
        entity: { entityType: 'model', mode: 'selected', keys: ['gpt'] }, starter: { key: 'model-errors', version: 1 },
      }),
    ]);
    const result = await StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    expect(result.skipped).toEqual([{ key: 'agent-errors', reason: 'exists' }, { key: 'model-errors', reason: 'exists' }]);
    expect(result.created.map((rule) => rule.starter?.key)).toEqual(['kb-errors', 'mcp-errors', 'tool-errors']);
  });

  it('adds only what is missing and reports the rest in catalog order', async () => {
    useRuleStore(db, [
      storedRule({ _id: 'r-added', starter: { key: 'agent-errors', version: 1 } }),
      storedRule({ _id: 'r-covers', module: 'models', metric: 'model_error_rate', entity: { entityType: 'model', mode: 'all' } }),
    ]);
    const result = await StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    expect(result.skipped).toEqual([{ key: 'agent-errors', reason: 'exists' }, { key: 'model-errors', reason: 'covered' }]);
    expect(result.created.map((rule) => rule.starter?.key)).toEqual(['kb-errors', 'mcp-errors', 'tool-errors']);
  });

  describe('a rule of the project that already watches the metric', () => {
    it('covers its starter: skipped as covered without keys', async () => {
      useRuleStore(db, [storedRule({ _id: 'r-mine', name: 'Our own agent alert' })]);
      const result = await StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
      expect(result.skipped).toEqual([{ key: 'agent-errors', reason: 'covered' }]);
      expect(result.created.map((rule) => rule.starter?.key)).toEqual(['model-errors', 'kb-errors', 'mcp-errors', 'tool-errors']);
      expect(db.createAlertRule).toHaveBeenCalledTimes(4);
    });

    it('does not cover it when asked for it by key: that creates the starter next to the rule', async () => {
      const rules = useRuleStore(db, [storedRule({ _id: 'r-mine', name: 'Our own agent alert' })]);
      const result = await StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: ['agent-errors'] });
      expect(result.skipped).toEqual([]);
      expect(result.created).toHaveLength(1);
      expect(result.created[0].starter).toEqual({ key: 'agent-errors', version: 1 });
      expect(rules.map((rule) => rule._id)).toEqual(['r-mine', 'rule-1']);
    });

    it('covers its starter when it has no entity scope at all (every entity)', async () => {
      useRuleStore(db, [storedRule({ _id: 'r-legacy', entity: undefined })]);
      const result = await StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
      expect(result.skipped).toEqual([{ key: 'agent-errors', reason: 'covered' }]);
    });

    it.each([
      ['is disabled', { enabled: false }],
      ['watches selected entities only', { entity: { entityType: 'agent' as const, mode: 'selected' as const, keys: ['Pulse Main'] } }],
      ['watches another metric of the module', { metric: 'agent_p95_duration_ms' as const }],
      ['belongs to another project', { projectId: OTHER_PROJECT_ID }],
    ])('does not cover it when it %s', async (_label, over) => {
      useRuleStore(db, [storedRule({ _id: 'r-other', ...over })]);
      const result = await StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
      expect(result.skipped).toEqual([]);
      expect(result.created.map((rule) => rule.starter?.key)).toEqual(KEYS);
    });

    it('does not make a starter of the same key in another project exist', async () => {
      useRuleStore(db, [storedRule({ _id: 'r-there', projectId: OTHER_PROJECT_ID, starter: { key: 'agent-errors', version: 1 } })]);
      const result = await StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
      expect(result.created).toHaveLength(5);
    });
  });

  describe('with keys', () => {
    it('adds those starters only, and reports nothing about the others', async () => {
      useRuleStore(db);
      const result = await StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: ['kb-errors', 'model-errors'] });
      expect(result.created.map((rule) => rule.starter?.key)).toEqual(['model-errors', 'kb-errors']);
      expect(result.skipped).toEqual([]);
      expect(db.createAlertRule).toHaveBeenCalledTimes(2);
    });

    it('adds a starter named twice once', async () => {
      useRuleStore(db);
      const result = await StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: ['tool-errors', 'tool-errors'] });
      expect(result.created).toHaveLength(1);
    });

    it('still skips a starter that was added before, reporting it as existing', async () => {
      useRuleStore(db, [storedRule({ _id: 'r-added', starter: { key: 'mcp-errors', version: 1 }, module: 'mcp', metric: 'mcp_server_error_rate' })]);
      const result = await StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: ['mcp-errors', 'tool-errors'] });
      expect(result.skipped).toEqual([{ key: 'mcp-errors', reason: 'exists' }]);
      expect(result.created.map((rule) => rule.starter?.key)).toEqual(['tool-errors']);
    });

    it('treats null like no keys at all', async () => {
      useRuleStore(db);
      const result = await StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: null });
      expect(result.created).toHaveLength(5);
    });
  });

  describe('keys that are not a list of starter keys', () => {
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
      ['more entries than there are starters', [...STARTER_ALERT_KEYS, 'agent-errors']],
    ])('refuses %s with 400 invalid_value and writes nothing', async (_label, keys) => {
      useRuleStore(db);
      const error = await failure(() => StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys }));
      expect(error).toMatchObject({ status: 400, code: 'invalid_value' });
      expect(db.createAlertRule).not.toHaveBeenCalled();
    });

    it('names the valid keys in the message of an unknown one', async () => {
      const error = await failure(() => StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: ['nope'] }));
      for (const key of KEYS) expect(error.message).toContain(key);
    });

    it('does not even read the project', async () => {
      useRuleStore(db);
      await failure(() => StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: [] }));
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

      await expect(StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID)).rejects.toThrow('db down');
      expect(rules.map((rule) => rule.starter?.key)).toEqual(['agent-errors', 'model-errors']);

      const retry = await StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
      expect(retry.skipped).toEqual([{ key: 'agent-errors', reason: 'exists' }, { key: 'model-errors', reason: 'exists' }]);
      expect(retry.created.map((rule) => rule.starter?.key)).toEqual(['kb-errors', 'mcp-errors', 'tool-errors']);
      expect(rules.map((rule) => rule.starter?.key)).toEqual(KEYS);
    });
  });
});

// ── concurrency ─────────────────────────────────────────────────────────────

describe('applying at the same time', () => {
  it('two applies on one project create each starter once', async () => {
    const rules = useRuleStore(db);
    const [first, second] = await Promise.all([
      StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID),
      StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID),
    ]);
    expect(db.createAlertRule).toHaveBeenCalledTimes(5);
    expect(rules.map((rule) => rule.starter?.key)).toEqual(KEYS);
    // the one that got there first adds them, the other finds them
    expect(first.created).toHaveLength(5);
    expect(first.skipped).toEqual([]);
    expect(second.created).toEqual([]);
    expect(second.skipped).toEqual(KEYS.map((key) => ({ key, reason: 'exists' })));
  });

  it('many applies and seeds at once still add each starter once', async () => {
    const rules = useRuleStore(db);
    const outcomes = await Promise.all([
      StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID),
      seedStarterAlerts(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID),
      StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID, { keys: ['agent-errors', 'kb-errors'] }),
      seedStarterAlerts(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID),
      StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID),
    ]);
    expect(rules).toHaveLength(5);
    expect(new Set(rules.map((rule) => rule.starter?.key)).size).toBe(5);
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

    const blocked = StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    const other = await StarterAlertService.apply(DB_NAME, TENANT_ID, OTHER_PROJECT_ID, USER_ID);
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
      StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID),
      StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID),
    ]);
    expect(failed).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'db down' }) });
    expect(next.status).toBe('fulfilled');
    expect((next as PromiseFulfilledResult<{ created: unknown[] }>).value.created).toHaveLength(5);
    expect(rules).toHaveLength(5);
  });
});

// ── list ────────────────────────────────────────────────────────────────────

describe('StarterAlertService.list', () => {
  it('lists the five starters of a project without rules as available', async () => {
    useRuleStore(db);
    const list = await StarterAlertService.list(DB_NAME, TENANT_ID, PROJECT_ID);
    expect(list.version).toBe(STARTER_SET_VERSION);
    expect(list.items.map((item) => item.key)).toEqual(KEYS);
    for (const item of list.items) {
      expect(item.state).toBe('available');
      expect(item).not.toHaveProperty('rule');
    }
    expect(db.listAlertRules).toHaveBeenCalledWith(TENANT_ID, { projectId: PROJECT_ID });
  });

  it('describes every starter with its numbers and the input that adds it', async () => {
    useRuleStore(db);
    const { items } = await StarterAlertService.list(DB_NAME, TENANT_ID, PROJECT_ID);
    items.forEach((item, index) => {
      const def = STARTER_ALERTS[index];
      expect(item).toMatchObject({
        key: def.key,
        version: def.version,
        module: def.module,
        metric: def.metric,
        name: def.name,
        description: def.description,
        threshold: def.threshold,
        windowMinutes: 30,
        forMinutes: 10,
        minSamples: 20,
        cooldownMinutes: 120,
      });
      expect(item.input).toEqual(starterRuleInput(def));
    });
  });

  it('marks a starter added, covered or available, with the rule that says so', async () => {
    useRuleStore(db, [
      storedRule({ _id: 'r-added', name: 'Agent error rate above 20%', enabled: false, starter: { key: 'agent-errors', version: 1 } }),
      storedRule({ _id: 'r-covers', name: 'Our model alert', module: 'models', metric: 'model_error_rate', entity: { entityType: 'model', mode: 'all' } }),
      storedRule({ _id: 'r-partial', name: 'Only my KB', module: 'rag', metric: 'kb_error_rate', entity: { entityType: 'kb', mode: 'selected', keys: ['faq'] } }),
      storedRule({ _id: 'r-off', name: 'Disabled MCP alert', module: 'mcp', metric: 'mcp_server_error_rate', enabled: false, entity: { entityType: 'mcp', mode: 'all' } }),
    ]);
    const { items } = await StarterAlertService.list(DB_NAME, TENANT_ID, PROJECT_ID);
    const byKey = Object.fromEntries(items.map((item) => [item.key, item]));
    expect(byKey['agent-errors']).toMatchObject({ state: 'added', rule: { id: 'r-added', name: 'Agent error rate above 20%', enabled: false } });
    expect(byKey['model-errors']).toMatchObject({ state: 'covered', rule: { id: 'r-covers', name: 'Our model alert', enabled: true } });
    expect(byKey['kb-errors'].state).toBe('available');
    expect(byKey['mcp-errors'].state).toBe('available');
    expect(byKey['tool-errors'].state).toBe('available');
    expect(byKey['kb-errors']).not.toHaveProperty('rule');
  });

  it('says added, not covered, when the starter rule and another rule watch the same metric', async () => {
    useRuleStore(db, [
      storedRule({ _id: 'r-other', name: 'Other' }),
      storedRule({ _id: 'r-starter', name: 'Starter', starter: { key: 'agent-errors', version: 1 } }),
    ]);
    const { items } = await StarterAlertService.list(DB_NAME, TENANT_ID, PROJECT_ID);
    expect(items[0]).toMatchObject({ key: 'agent-errors', state: 'added', rule: { id: 'r-starter' } });
  });

  it('reports every starter added after an apply', async () => {
    useRuleStore(db);
    await StarterAlertService.apply(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    const { items } = await StarterAlertService.list(DB_NAME, TENANT_ID, PROJECT_ID);
    expect(items.map((item) => item.state)).toEqual(['added', 'added', 'added', 'added', 'added']);
    expect(items.map((item) => item.rule?.id)).toEqual(['rule-1', 'rule-2', 'rule-3', 'rule-4', 'rule-5']);
  });

  it('keeps the projects apart', async () => {
    useRuleStore(db, [storedRule({ _id: 'r-there', projectId: OTHER_PROJECT_ID, starter: { key: 'agent-errors', version: 1 } })]);
    const { items } = await StarterAlertService.list(DB_NAME, TENANT_ID, PROJECT_ID);
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

    it('is 0 for a project without admins (its starter rules then mail the owners and admins)', async () => {
      useRuleStore(db);
      db.listUsers.mockResolvedValue(users);
      db.listUserProjectsByProject.mockResolvedValue([{ userId: 'plain', projectId: PROJECT_ID, role: 'member' }]);
      expect((await StarterAlertService.list(DB_NAME, TENANT_ID, PROJECT_ID)).projectAdminRecipients).toBe(0);
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
      expect((await StarterAlertService.list(DB_NAME, TENANT_ID, PROJECT_ID)).projectAdminRecipients).toBe(2);
      expect(db.listUserProjectsByProject).toHaveBeenCalledWith(PROJECT_ID);
    });

    it('is 0, not an error, when the memberships cannot be read', async () => {
      useRuleStore(db);
      db.listUsers.mockResolvedValue(users);
      db.listUserProjectsByProject.mockRejectedValue(new Error('db down'));
      expect((await StarterAlertService.list(DB_NAME, TENANT_ID, PROJECT_ID)).projectAdminRecipients).toBe(0);
    });
  });

  describe('addedToNewProjects', () => {
    it('is on by default', async () => {
      useRuleStore(db);
      expect((await StarterAlertService.list(DB_NAME, TENANT_ID, PROJECT_ID)).addedToNewProjects).toBe(true);
    });

    it.each([['false'], ['0'], ['no']])('is off when ALERT_STARTER_RULES_ON_CREATE is %j', async (value) => {
      useRuleStore(db);
      process.env.ALERT_STARTER_RULES_ON_CREATE = value;
      reloadConfig();
      expect((await StarterAlertService.list(DB_NAME, TENANT_ID, PROJECT_ID)).addedToNewProjects).toBe(false);
    });

    it.each([['true'], ['1']])('is on when ALERT_STARTER_RULES_ON_CREATE is %j', async (value) => {
      useRuleStore(db);
      process.env.ALERT_STARTER_RULES_ON_CREATE = value;
      reloadConfig();
      expect((await StarterAlertService.list(DB_NAME, TENANT_ID, PROJECT_ID)).addedToNewProjects).toBe(true);
    });
  });
});

describe('starterAlertsOnCreate', () => {
  it('follows ALERT_STARTER_RULES_ON_CREATE: on unless it says false', () => {
    expect(starterAlertsOnCreate()).toBe(true);
    process.env.ALERT_STARTER_RULES_ON_CREATE = '';
    reloadConfig();
    expect(starterAlertsOnCreate()).toBe(true);
    process.env.ALERT_STARTER_RULES_ON_CREATE = 'false';
    reloadConfig();
    expect(starterAlertsOnCreate()).toBe(false);
    process.env.ALERT_STARTER_RULES_ON_CREATE = 'true';
    reloadConfig();
    expect(starterAlertsOnCreate()).toBe(true);
  });
});

// ── seedStarterAlerts ───────────────────────────────────────────────────────

describe('seedStarterAlerts', () => {
  it('returns how many rules it added to a new project', async () => {
    useRuleStore(db);
    expect(await seedStarterAlerts(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID)).toBe(5);
    expect(db.createAlertRule).toHaveBeenCalledTimes(5);
    expect(db.createAlertRule.mock.calls[0][0]).toMatchObject({ tenantId: TENANT_ID, projectId: PROJECT_ID, createdBy: USER_ID });
  });

  it('returns 0 when the project already has them, and counts only the new ones otherwise', async () => {
    useRuleStore(db, [storedRule({ _id: 'r-mine', name: 'Ours' })]);
    expect(await seedStarterAlerts(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID)).toBe(4);
    expect(await seedStarterAlerts(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID)).toBe(0);
  });

  it('returns null, and does not throw, when the rules cannot be read', async () => {
    db.listAlertRules.mockRejectedValue(new Error('db down'));
    await expect(seedStarterAlerts(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID)).resolves.toBeNull();
    expect(db.createAlertRule).not.toHaveBeenCalled();
  });

  it('returns null, and does not throw, when the database cannot be opened', async () => {
    (getTenantDatabase as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no connection'));
    await expect(seedStarterAlerts(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID)).resolves.toBeNull();
  });

  it('returns null, and does not throw, when a rule cannot be written', async () => {
    useRuleStore(db);
    db.createAlertRule.mockRejectedValue(new Error('write failed'));
    await expect(seedStarterAlerts(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID)).resolves.toBeNull();
  });

  it('logs the failure with the project and the message only', async () => {
    db.listAlertRules.mockRejectedValue(new Error('db down'));
    await seedStarterAlerts(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    const errors = h.logLines.filter((line) => line.level === 'error');
    expect(errors).toEqual([{ level: 'error', message: 'Adding the starter alert rules failed', meta: { projectId: PROJECT_ID, error: 'db down' } }]);
  });

  it('does not log a success', async () => {
    useRuleStore(db);
    await seedStarterAlerts(DB_NAME, TENANT_ID, PROJECT_ID, USER_ID);
    expect(h.logLines.filter((line) => line.level === 'error')).toEqual([]);
  });
});
