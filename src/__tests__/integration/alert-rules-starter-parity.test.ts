/**
 * The starter mark of an alert rule (`IAlertRule.starter`: which starter, at which version) and the email channel's
 * `project_admins` audience, run against BOTH providers: SQLite keeps the mark in a JSON column, MongoDB in the
 * document. Also: a SQLite tenant DB created before starter rules gains the column when it is opened.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import type { IAlertRule } from '@/lib/database';
import { describeForEachProvider } from './db-parity.helper';

type Seed = { tenantId: string; projectId: string; otherProjectId: string };

const STARTER = { key: 'agent-errors', version: 1 };

function rule(seed: Seed, over: Partial<IAlertRule> = {}): Omit<IAlertRule, '_id' | 'createdAt' | 'updatedAt'> {
  return {
    tenantId: seed.tenantId,
    projectId: seed.projectId,
    name: 'Agent error rate above 20%',
    module: 'agents',
    enabled: true,
    metric: 'agent_error_rate',
    condition: { mode: 'threshold', operator: 'gt', threshold: 20, forMinutes: 10, minSamples: 20 },
    windowMinutes: 30,
    cooldownMinutes: 120,
    entity: { entityType: 'agent', mode: 'all' },
    channels: [{ id: 'ch_000000000001', type: 'email', recipients: [], audience: 'project_admins' }],
    createdBy: 'user-1',
    ...over,
  };
}

describeForEachProvider('Alert rule starter mark', (getDb) => {
  let seed: Seed;

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const db = getDb();
    const slug = `starter-${unique}`;
    const dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({
      companyName: 'Starter',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    await db.switchToTenant(dbName);
    seed = { tenantId: String(tenant._id), projectId: `proj-${unique}`, otherProjectId: `other-${unique}` };
  });

  it('reads the mark back by id and in the project list', async () => {
    const db = getDb();
    const created = await db.createAlertRule(rule(seed, { starter: STARTER }));
    expect(created.starter).toEqual(STARTER);

    const found = await db.findAlertRuleById(String(created._id));
    expect(found?.starter).toEqual(STARTER);
    // scoped to the project, too
    expect((await db.findAlertRuleById(String(created._id), seed.projectId))?.starter).toEqual(STARTER);

    const listed = await db.listAlertRules(seed.tenantId, { projectId: seed.projectId });
    expect(listed).toHaveLength(1);
    expect(String(listed[0]._id)).toBe(String(created._id));
    expect(listed[0].starter).toEqual(STARTER);
  });

  it('keeps the version the rule was added at', async () => {
    const db = getDb();
    const created = await db.createAlertRule(rule(seed, { starter: { key: 'model-errors', version: 3 } }));
    expect((await db.findAlertRuleById(String(created._id)))?.starter).toEqual({ key: 'model-errors', version: 3 });
  });

  it('reads a rule created without the mark as having none', async () => {
    const db = getDb();
    const created = await db.createAlertRule(rule(seed));
    expect(created.starter ?? null).toBeNull();

    const found = await db.findAlertRuleById(String(created._id));
    expect(found?.starter ?? null).toBeNull();
    const listed = await db.listAlertRules(seed.tenantId, { projectId: seed.projectId });
    expect(listed[0].starter ?? null).toBeNull();
  });

  it('lists marked and unmarked rules of a project side by side, each with its own mark', async () => {
    const db = getDb();
    const a = await db.createAlertRule(rule(seed, { name: 'A', starter: STARTER }));
    const b = await db.createAlertRule(rule(seed, { name: 'B' }));
    const c = await db.createAlertRule(rule(seed, { name: 'C', metric: 'model_error_rate', module: 'models', starter: { key: 'model-errors', version: 1 } }));
    await db.createAlertRule(rule(seed, { name: 'Other project', projectId: seed.otherProjectId, starter: STARTER }));

    const listed = await db.listAlertRules(seed.tenantId, { projectId: seed.projectId });
    const byId = new Map(listed.map((r) => [String(r._id), r]));
    expect(listed).toHaveLength(3);
    expect(byId.get(String(a._id))?.starter).toEqual(STARTER);
    expect(byId.get(String(b._id))?.starter ?? null).toBeNull();
    expect(byId.get(String(c._id))?.starter).toEqual({ key: 'model-errors', version: 1 });
  });

  it('keeps the mark when the rule is edited without touching it', async () => {
    const db = getDb();
    const created = await db.createAlertRule(rule(seed, { starter: STARTER }));
    const id = String(created._id);

    const updated = await db.updateAlertRule(id, { name: 'Renamed', enabled: false, windowMinutes: 60 }, seed.projectId);
    expect(updated).toMatchObject({ name: 'Renamed', enabled: false, windowMinutes: 60 });
    expect(updated?.starter).toEqual(STARTER);
    expect((await db.findAlertRuleById(id))?.starter).toEqual(STARTER);

    // the evaluator's bookkeeping write does not touch it either
    await db.updateAlertRule(id, { lastEvaluation: { at: new Date(), targets: 3, noDataTargets: 0 } });
    expect((await db.findAlertRuleById(id))?.starter).toEqual(STARTER);
  });

  it('clears the mark when an update sets it to null', async () => {
    const db = getDb();
    const created = await db.createAlertRule(rule(seed, { starter: STARTER }));
    const id = String(created._id);

    const updated = await db.updateAlertRule(id, { starter: null });
    expect(updated?.starter ?? null).toBeNull();
    expect((await db.findAlertRuleById(id))?.starter ?? null).toBeNull();
    expect((await db.listAlertRules(seed.tenantId, { projectId: seed.projectId }))[0].starter ?? null).toBeNull();
  });

  it('puts a mark on a rule that had none, and replaces a mark', async () => {
    const db = getDb();
    const created = await db.createAlertRule(rule(seed));
    const id = String(created._id);

    await db.updateAlertRule(id, { starter: STARTER });
    expect((await db.findAlertRuleById(id))?.starter).toEqual(STARTER);

    await db.updateAlertRule(id, { starter: { key: 'tool-errors', version: 2 } });
    expect((await db.findAlertRuleById(id))?.starter).toEqual({ key: 'tool-errors', version: 2 });
  });

  it('lets only the rule\'s own project change the mark', async () => {
    const db = getDb();
    const created = await db.createAlertRule(rule(seed, { starter: STARTER }));
    const id = String(created._id);

    expect(await db.updateAlertRule(id, { starter: null }, seed.otherProjectId)).toBeNull();
    expect((await db.findAlertRuleById(id))?.starter).toEqual(STARTER);
    expect((await db.updateAlertRule(id, { starter: null }, seed.projectId))?.starter ?? null).toBeNull();
  });

  it('marks each rule on its own: clearing one leaves the others', async () => {
    const db = getDb();
    const a = await db.createAlertRule(rule(seed, { name: 'A', starter: STARTER }));
    const b = await db.createAlertRule(rule(seed, { name: 'B', starter: { key: 'kb-errors', version: 1 } }));

    await db.updateAlertRule(String(a._id), { starter: null });
    expect((await db.findAlertRuleById(String(a._id)))?.starter ?? null).toBeNull();
    expect((await db.findAlertRuleById(String(b._id)))?.starter).toEqual({ key: 'kb-errors', version: 1 });
  });

  it('removes the mark with the rule, so a deleted starter can be added again', async () => {
    const db = getDb();
    const created = await db.createAlertRule(rule(seed, { starter: STARTER }));
    expect(await db.deleteAlertRule(String(created._id), seed.projectId)).toBe(true);
    expect(await db.listAlertRules(seed.tenantId, { projectId: seed.projectId })).toEqual([]);

    const again = await db.createAlertRule(rule(seed, { starter: STARTER }));
    expect((await db.findAlertRuleById(String(again._id)))?.starter).toEqual(STARTER);
  });

  it('round-trips an email channel with the project_admins audience and no listed recipient', async () => {
    const db = getDb();
    const created = await db.createAlertRule(rule(seed, {
      channels: [
        { id: 'ch_000000000001', type: 'email', recipients: [], audience: 'project_admins' },
        { id: 'ch_000000000002', type: 'email', recipients: ['ops@example.com'] },
      ],
    }));

    const found = await db.findAlertRuleById(String(created._id));
    expect(found?.channels).toEqual([
      { id: 'ch_000000000001', type: 'email', recipients: [], audience: 'project_admins' },
      { id: 'ch_000000000002', type: 'email', recipients: ['ops@example.com'] },
    ]);
    // a channel without an audience stays without one
    expect(found?.channels[1]).not.toHaveProperty('audience');
  });

  it('updates the audience of a channel together with the channel list', async () => {
    const db = getDb();
    const created = await db.createAlertRule(rule(seed));
    const id = String(created._id);

    await db.updateAlertRule(id, { channels: [{ id: 'ch_000000000001', type: 'email', recipients: ['ops@example.com'] }] });
    expect((await db.findAlertRuleById(id))?.channels).toEqual([{ id: 'ch_000000000001', type: 'email', recipients: ['ops@example.com'] }]);

    await db.updateAlertRule(id, { channels: [{ id: 'ch_000000000001', type: 'email', recipients: ['ops@example.com'], audience: 'project_admins' }] });
    expect((await db.findAlertRuleById(id))?.channels).toEqual([
      { id: 'ch_000000000001', type: 'email', recipients: ['ops@example.com'], audience: 'project_admins' },
    ]);
  });
});

// ── SQLite: a tenant DB from before starter rules ────────────────────────────

describe('SQLite: a tenant DB created before starter rules', () => {
  const LEGACY_DB_NAME = 'tenant_legacy_starter_rules';
  const LEGACY_RULE_ID = 'legacy-rule-1';
  const TENANT_ID = 'tenant-legacy';
  const PROJECT_ID = 'project-legacy';
  let tmpDir: string;
  let provider: SQLiteProvider | null = null;

  afterAll(async () => {
    await provider?.disconnect();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('gains the starter column when it is opened, and keeps reading and writing its old rules', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-legacy-starter-'));
    // an alert_rules table of a DB created before starter rules, with a rule in it
    const legacy = new Database(path.join(tmpDir, `${LEGACY_DB_NAME}.db`));
    legacy.exec(`
      CREATE TABLE alert_rules (
        id TEXT PRIMARY KEY, tenantId TEXT NOT NULL, projectId TEXT NOT NULL, name TEXT NOT NULL,
        description TEXT, module TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, metric TEXT NOT NULL,
        condition TEXT NOT NULL DEFAULT '{}', windowMinutes INTEGER NOT NULL DEFAULT 5,
        cooldownMinutes INTEGER NOT NULL DEFAULT 15, scope TEXT DEFAULT '{}',
        channels TEXT NOT NULL DEFAULT '[]', lastTriggeredAt TEXT, createdBy TEXT NOT NULL,
        updatedBy TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    legacy.prepare(`
      INSERT INTO alert_rules (id, tenantId, projectId, name, module, enabled, metric, condition, windowMinutes,
                               cooldownMinutes, channels, createdBy, createdAt, updatedAt)
      VALUES (@id, @tenantId, @projectId, @name, @module, 1, @metric, @condition, 15, 60, @channels, 'user-1', @now, @now)
    `).run({
      id: LEGACY_RULE_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: 'Old rule',
      module: 'agents',
      metric: 'agent_error_rate',
      condition: JSON.stringify({ operator: 'gt', threshold: 5 }),
      channels: JSON.stringify([{ id: 'ch_000000000001', type: 'email', recipients: ['ops@example.com'] }]),
      now,
    });
    legacy.close();

    provider = new SQLiteProvider(tmpDir, 'legacy_starter_main');
    await provider.connect();
    await provider.switchToTenant(LEGACY_DB_NAME);

    const check = new Database(path.join(tmpDir, `${LEGACY_DB_NAME}.db`), { readonly: true });
    const columns = (check.prepare('PRAGMA table_info(alert_rules)').all() as Array<{ name: string }>).map((c) => c.name);
    check.close();
    expect(columns).toContain('starter');

    // the old rule reads back as it was, with no mark
    const old = await provider.findAlertRuleById(LEGACY_RULE_ID, PROJECT_ID);
    expect(old).toMatchObject({ name: 'Old rule', metric: 'agent_error_rate' });
    expect(old?.starter ?? null).toBeNull();

    // and takes a mark, like a rule created after the upgrade
    await provider.updateAlertRule(LEGACY_RULE_ID, { starter: STARTER });
    expect((await provider.findAlertRuleById(LEGACY_RULE_ID))?.starter).toEqual(STARTER);

    const created = await provider.createAlertRule(rule({ tenantId: TENANT_ID, projectId: PROJECT_ID, otherProjectId: 'x' }, { name: 'New starter', starter: { key: 'model-errors', version: 1 } }));
    const listed = await provider.listAlertRules(TENANT_ID, { projectId: PROJECT_ID });
    expect(listed).toHaveLength(2);
    expect(listed.find((r) => String(r._id) === String(created._id))?.starter).toEqual({ key: 'model-errors', version: 1 });
  });
});
