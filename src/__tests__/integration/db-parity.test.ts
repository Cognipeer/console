/**
 * DB parity tests — run the same contract against BOTH SQLite and MongoDB.
 *
 * If either provider diverges (a method behaves differently, returns a
 * different shape, etc.) one of the two suites will fail. This is the test
 * we want to be loudest about, because provider drift is invisible until
 * production hits the other code path.
 *
 * Start with the most-used mixins (tenant, user, project, user-project) and
 * grow the list as new mixins are added. Each describeForEachProvider block
 * is automatically duplicated across both backends.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('Tenant CRUD', (getDb) => {
  let slug: string;

  beforeEach(() => {
    // Unique slug per test so the two providers don't fight over the same row.
    slug = `acme-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  it('creates a tenant and finds it by slug', async () => {
    const db = getDb();
    const tenant = await db.createTenant({
      companyName: 'Acme',
      slug,
      dbName: `tenant_${slug}`,
      licenseType: 'FREE',
      ownerId: 'owner-pending',
    });

    expect(tenant._id).toBeTruthy();
    expect(tenant.slug).toBe(slug);

    const found = await db.findTenantBySlug(slug);
    expect(found?.slug).toBe(slug);
    expect(found?.companyName).toBe('Acme');
  });

  it('returns null when slug does not exist', async () => {
    const db = getDb();
    expect(await db.findTenantBySlug('nonexistent-slug-xyz')).toBeNull();
  });

  it('updateTenant patches fields and returns the updated row', async () => {
    const db = getDb();
    const tenant = await db.createTenant({
      companyName: 'Acme',
      slug,
      dbName: `tenant_${slug}`,
      licenseType: 'FREE',
      ownerId: 'owner-pending',
    });

    const updated = await db.updateTenant(String(tenant._id), { ownerId: 'user-real' });
    expect(updated?.ownerId).toBe('user-real');
  });
});

describeForEachProvider('User + Project + UserProject', (getDb) => {
  let slug: string;
  let dbName: string;
  let tenantId: string;

  beforeEach(async () => {
    slug = `acme-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({
      companyName: 'Acme',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  it('creates a user and finds by email', async () => {
    const db = getDb();
    const user = await db.createUser({
      tenantId,
      email: 'alice@example.com',
      name: 'Alice',
      password: '$2b$10$x',
      role: 'owner',
      licenseId: 'FREE',
      features: [],
    });

    expect(user._id).toBeTruthy();
    const found = await db.findUserByEmail('alice@example.com');
    expect(found?._id).toBeTruthy();
    expect(found?.email).toBe('alice@example.com');
  });

  it('upserts a UserProject row and lists by user', async () => {
    const db = getDb();
    const user = await db.createUser({
      tenantId,
      email: 'bob@example.com',
      name: 'Bob',
      password: '$2b$10$x',
      role: 'user',
      licenseId: 'FREE',
      features: [],
    });
    const project = await db.createProject({
      tenantId,
      key: 'project-a',
      name: 'Project A',
      createdBy: String(user._id),
    });

    await db.upsertUserProject({
      tenantId,
      userId: String(user._id),
      projectId: String(project._id),
      role: 'member',
      servicePermissions: {},
    });

    const memberships = await db.listUserProjectsByUser(String(user._id));
    expect(memberships).toHaveLength(1);
    expect(memberships[0].projectId).toBe(String(project._id));
    expect(memberships[0].role).toBe('member');
  });

  it('deleteUserProject removes the membership', async () => {
    const db = getDb();
    const user = await db.createUser({
      tenantId,
      email: 'carol@example.com',
      name: 'Carol',
      password: '$2b$10$x',
      role: 'user',
      licenseId: 'FREE',
      features: [],
    });
    const project = await db.createProject({
      tenantId,
      key: 'project-b',
      name: 'Project B',
      createdBy: String(user._id),
    });

    await db.upsertUserProject({
      tenantId,
      userId: String(user._id),
      projectId: String(project._id),
      role: 'member',
      servicePermissions: {},
    });
    const removed = await db.deleteUserProject(String(user._id), String(project._id));
    expect(removed).toBe(true);

    expect(await db.listUserProjectsByUser(String(user._id))).toHaveLength(0);
  });
});

describeForEachProvider('Provider + Model CRUD + malformed-id safety', (getDb) => {
  let slug: string;
  let dbName: string;
  let tenantId: string;
  let projectId: string;

  beforeEach(async () => {
    slug = `acme-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({
      companyName: 'Acme',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
    const project = await db.createProject({
      tenantId,
      key: 'project-a',
      name: 'Project A',
      createdBy: 'tester',
    });
    projectId = String(project._id);
  });

  it('creates, finds, updates and deletes a provider by id', async () => {
    const db = getDb();
    const provider = await db.createProvider({
      key: 'my-openai',
      driver: 'openai',
      type: 'model',
      label: 'My OpenAI',
      tenantId,
      projectIds: [projectId],
      credentialsEnc: JSON.stringify({ apiKey: 'sk-test' }),
      settings: {},
      status: 'active',
      createdBy: 'tester',
    });
    const id = String(provider._id);

    expect((await db.findProviderById(id))?.key).toBe('my-openai');
    expect((await db.updateProvider(id, { label: 'Renamed' }))?.label).toBe('Renamed');
    expect(await db.deleteProvider(id)).toBe(true);
  });

  // Regression: malformed (non-ObjectId) ids must resolve to "not found" on BOTH
  // backends — never throw a BSONError. On Mongo (SaaS) an unguarded
  // `new ObjectId(id)` would 500; SQLite (on-prem) returns null. They must match.
  it('treats a malformed provider id as not-found (no throw) on every backend', async () => {
    const db = getDb();
    await expect(db.findProviderById('not-a-valid-id')).resolves.toBeNull();
    await expect(db.updateProvider('not-a-valid-id', { label: 'x' })).resolves.toBeNull();
    await expect(db.deleteProvider('not-a-valid-id')).resolves.toBe(false);
  });

  it('creates, finds, updates and deletes a model by id', async () => {
    const db = getDb();
    const model = await db.createModel({
      key: 'gpt-4o',
      name: 'GPT-4o',
      providerKey: 'openai',
      providerDriver: 'openai',
      category: 'llm',
      modelId: 'gpt-4o',
      projectId,
      tenantId,
      settings: {},
      pricing: { inputTokenPer1M: 0, outputTokenPer1M: 0 },
    });
    const id = String(model._id);

    expect((await db.findModelById(id))?.key).toBe('gpt-4o');
    expect((await db.updateModel(id, { name: 'GPT-4o v2' }))?.name).toBe('GPT-4o v2');
    expect(await db.deleteModel(id)).toBe(true);
  });

  it('treats a malformed model id as not-found (no throw) on every backend', async () => {
    const db = getDb();
    await expect(db.findModelById('not-a-valid-id')).resolves.toBeNull();
    await expect(db.updateModel('not-a-valid-id', { name: 'x' })).resolves.toBeNull();
    await expect(db.deleteModel('not-a-valid-id')).resolves.toBe(false);
  });

  // Regression: a duplicate provider key must be rejected at the DB layer on
  // BOTH backends (SQLite has idx_providers_key; Mongo gets the same unique
  // index lazily). This closes the concurrent-create race window.
  it('rejects a duplicate provider key at the DB layer on every backend', async () => {
    const db = getDb();
    const base = {
      key: 'dup-openai',
      driver: 'openai',
      type: 'model' as const,
      label: 'A',
      tenantId,
      projectIds: [projectId],
      credentialsEnc: JSON.stringify({ apiKey: 'sk' }),
      settings: {},
      status: 'active' as const,
      createdBy: 'tester',
    };
    await db.createProvider(base);
    await expect(db.createProvider({ ...base, label: 'B' })).rejects.toBeTruthy();
  });

  it('rejects a duplicate model key at the DB layer on every backend', async () => {
    const db = getDb();
    const base = {
      key: 'dup-gpt',
      name: 'GPT',
      providerKey: 'openai',
      providerDriver: 'openai',
      category: 'llm' as const,
      modelId: 'gpt-4o',
      projectId,
      tenantId,
      settings: {},
      pricing: { inputTokenPer1M: 0, outputTokenPer1M: 0 },
    };
    await db.createModel(base);
    await expect(db.createModel({ ...base, name: 'GPT2' })).rejects.toBeTruthy();
  });
});

describeForEachProvider('Guardrail CRUD + evaluation logs', (getDb) => {
  const tenantId = 'tenant-guardrail-parity';
  const dbName = `tenant_guardrail_${Date.now()}`;

  beforeEach(async () => {
    const db = getDb();
    await db.switchToTenant(dbName);
  });

  it('creates a guardrail with target and failMode and reads it back', async () => {
    const db = getDb();
    const created = await db.createGuardrail({
      tenantId,
      key: `gr-${Date.now()}`,
      name: 'Parity Guardrail',
      type: 'preset',
      target: 'input',
      action: 'block',
      enabled: true,
      failMode: 'closed',
      policy: {
        pii: { enabled: true, action: 'redact', categories: { email: true } },
        wordFilter: { enabled: true, action: 'block', words: ['forbidden'] },
      },
      createdBy: 'user-1',
    });

    expect(created._id).toBeTruthy();

    const found = await db.findGuardrailById(String(created._id));
    expect(found?.name).toBe('Parity Guardrail');
    expect(found?.target).toBe('input');
    expect(found?.failMode).toBe('closed');
    expect(found?.policy?.pii?.action).toBe('redact');
    expect(found?.policy?.wordFilter?.words).toEqual(['forbidden']);
  });

  it('updates failMode and action', async () => {
    const db = getDb();
    const created = await db.createGuardrail({
      tenantId,
      key: `gr-upd-${Date.now()}`,
      name: 'Updatable',
      type: 'preset',
      target: 'output',
      action: 'block',
      enabled: true,
      createdBy: 'user-1',
    });

    const updated = await db.updateGuardrail(String(created._id), {
      action: 'warn',
      failMode: 'closed',
    });
    expect(updated?.action).toBe('warn');
    expect(updated?.failMode).toBe('closed');
  });

  it('writes and lists evaluation logs, and aggregates pass rate', async () => {
    const db = getDb();
    const created = await db.createGuardrail({
      tenantId,
      key: `gr-log-${Date.now()}`,
      name: 'Logged',
      type: 'preset',
      target: 'input',
      action: 'block',
      enabled: true,
      createdBy: 'user-1',
    });
    const guardrailId = String(created._id);

    await db.createGuardrailEvaluationLog({
      tenantId,
      guardrailId,
      guardrailKey: created.key,
      guardrailName: created.name,
      guardrailType: created.type,
      target: 'input',
      action: 'block',
      passed: false,
      findings: [
        { type: 'pii', category: 'email', severity: 'high', message: 'Email detected', action: 'block', block: true },
      ],
      inputText: 'reach me at [REDACTED:email]',
      latencyMs: 12,
      source: 'parity-test',
      requestId: 'req-parity-1',
      message: 'Email detected',
    });
    await db.createGuardrailEvaluationLog({
      tenantId,
      guardrailId,
      guardrailKey: created.key,
      guardrailName: created.name,
      guardrailType: created.type,
      target: 'input',
      action: 'block',
      passed: true,
      findings: [],
      inputText: 'hello world',
      latencyMs: 3,
      source: 'parity-test',
      message: null,
    });

    const logs = await db.listGuardrailEvaluationLogs(guardrailId, { limit: 10 });
    expect(logs).toHaveLength(2);
    const failed = logs.find((l) => !l.passed);
    expect(failed?.findings).toHaveLength(1);
    expect(failed?.source).toBe('parity-test');

    const aggregate = await db.aggregateGuardrailEvaluations(guardrailId);
    expect(aggregate.totalEvaluations).toBe(2);
    expect(aggregate.passedCount).toBe(1);
    expect(aggregate.failedCount).toBe(1);
    expect(aggregate.passRate).toBe(50);
  });
});

describeForEachProvider('Guardrail word lists CRUD', (getDb) => {
  const tenantId = 'tenant-wordlist-parity';
  const dbName = `tenant_wordlist_${Date.now()}`;

  beforeEach(async () => {
    const db = getDb();
    await db.switchToTenant(dbName);
  });

  it('creates a word list and reads it back with words intact', async () => {
    const db = getDb();
    const created = await db.createGuardrailWordList({
      tenantId,
      key: `wl-${Date.now()}`,
      name: 'Competitors',
      description: 'Rakip markalar',
      language: 'tr',
      words: ['acme', 'rakip marka', 'çakma-ürün'],
      createdBy: 'user-1',
    });

    expect(created._id).toBeTruthy();

    const found = await db.findGuardrailWordListById(String(created._id));
    expect(found?.name).toBe('Competitors');
    expect(found?.language).toBe('tr');
    expect(found?.words).toEqual(['acme', 'rakip marka', 'çakma-ürün']);

    const byKey = await db.findGuardrailWordListByKey(created.key);
    expect(String(byKey?._id)).toBe(String(created._id));
  });

  it('updates words and lists summaries', async () => {
    const db = getDb();
    const created = await db.createGuardrailWordList({
      tenantId,
      key: `wl-upd-${Date.now()}`,
      name: 'Updatable',
      words: ['one'],
      createdBy: 'user-1',
    });

    const updated = await db.updateGuardrailWordList(String(created._id), {
      words: ['one', 'two'],
      name: 'Updated',
    });
    expect(updated?.words).toEqual(['one', 'two']);
    expect(updated?.name).toBe('Updated');

    const all = await db.listGuardrailWordLists();
    expect(all.some((l) => String(l._id) === String(created._id))).toBe(true);
  });

  it('deletes a word list', async () => {
    const db = getDb();
    const created = await db.createGuardrailWordList({
      tenantId,
      key: `wl-del-${Date.now()}`,
      name: 'Deletable',
      words: ['x'],
      createdBy: 'user-1',
    });

    expect(await db.deleteGuardrailWordList(String(created._id))).toBe(true);
    expect(await db.findGuardrailWordListById(String(created._id))).toBeNull();
  });
});

describeForEachProvider('Beta access codes', (getDb) => {
  let code: string;

  beforeEach(() => {
    code = `BETA-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  });

  it('creates a code normalized to uppercase and is idempotent', async () => {
    const db = getDb();
    const created = await db.createBetaAccessCode({ code: ` ${code.toLowerCase()} `, note: 'wave' });
    expect(created.code).toBe(code);
    expect(created.status).toBe('active');
    expect(created.note).toBe('wave');

    const again = await db.createBetaAccessCode({ code, note: 'other' });
    expect(again.note).toBe('wave');

    const found = await db.findBetaAccessCode(code.toLowerCase());
    expect(found?.status).toBe('active');
  });

  it('consumes an active code exactly once and releases it back', async () => {
    const db = getDb();
    await db.createBetaAccessCode({ code });

    expect(await db.consumeBetaAccessCode(code, { email: 'a@b.com' })).toBe(true);
    expect(await db.consumeBetaAccessCode(code, { email: 'c@d.com' })).toBe(false);

    const used = await db.findBetaAccessCode(code);
    expect(used?.status).toBe('used');
    expect(used?.usedByEmail).toBe('a@b.com');
    expect(used?.usedAt).toBeInstanceOf(Date);

    expect(await db.releaseBetaAccessCode(code)).toBe(true);
    const released = await db.findBetaAccessCode(code);
    expect(released?.status).toBe('active');
    expect(released?.usedByEmail).toBeNull();
    expect(released?.usedAt).toBeNull();

    expect(await db.consumeBetaAccessCode(code, { email: 'c@d.com' })).toBe(true);
  });

  it('does not consume unknown codes and lists by status', async () => {
    const db = getDb();
    expect(await db.consumeBetaAccessCode('NOPE-0000-0000', { email: 'a@b.com' })).toBe(false);

    await db.createBetaAccessCode({ code });
    const active = await db.listBetaAccessCodes({ status: 'active' });
    expect(active.map((c) => c.code)).toContain(code);
  });
});

describeForEachProvider('Usage daily rollup (incrementUsageDaily/listUsageDaily)', (getDb) => {
  let slug: string;
  let dbName: string;
  let tenantId: string;

  const dims = (overrides: Record<string, string> = {}) => ({
    tenantId,
    projectId: 'proj-1',
    userId: 'user-1',
    apiTokenId: 'tok-1',
    actorType: 'api_token',
    source: 'api',
    service: 'models',
    refKey: 'gpt-4o',
    day: '2026-07-15',
    ...overrides,
  });

  beforeEach(async () => {
    slug = `usage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({
      companyName: 'Usage Co',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  it('upserts additively on the same dimension tuple (incl. units merge)', async () => {
    const db = getDb();
    await db.incrementUsageDaily([
      { ...dims(), requests: 1, inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.5, latencyMsSum: 200, latencyCount: 1, units: { toolCalls: 2 } },
    ]);
    await db.incrementUsageDaily([
      { ...dims(), requests: 1, errors: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.1, latencyMsSum: 100, latencyCount: 1, units: { toolCalls: 1, pages: 3 } },
    ]);

    const rows = await db.listUsageDaily({ userId: 'user-1' });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.requests).toBe(2);
    expect(row.errors).toBe(1);
    expect(row.inputTokens).toBe(110);
    expect(row.outputTokens).toBe(55);
    expect(row.totalTokens).toBe(165);
    expect(row.costUsd).toBeCloseTo(0.6, 10);
    expect(row.latencyMsSum).toBe(300);
    expect(row.latencyCount).toBe(2);
    expect(row.units).toMatchObject({ toolCalls: 3, pages: 3 });
    expect(row.day).toBe('2026-07-15');
    // dayDate is the Date twin of `day` used by the reports engine.
    expect(row.dayDate).toBeInstanceOf(Date);
    expect(row.dayDate!.toISOString()).toBe('2026-07-15T00:00:00.000Z');
  });

  it('splits rows on differing dimensions and filters correctly', async () => {
    const db = getDb();
    await db.incrementUsageDaily([
      { ...dims(), requests: 1 },
      { ...dims({ userId: 'user-2', apiTokenId: '' }), requests: 2 },
      { ...dims({ service: 'websearch', refKey: 'srch-1' }), requests: 3 },
      { ...dims({ day: '2026-07-14' }), requests: 4 },
    ]);

    expect(await db.listUsageDaily({})).toHaveLength(4);
    expect(await db.listUsageDaily({ userId: 'user-2' })).toHaveLength(1);
    expect(await db.listUsageDaily({ service: 'websearch' })).toHaveLength(1);
    const ranged = await db.listUsageDaily({ fromDay: '2026-07-15', toDay: '2026-07-15' });
    expect(ranged).toHaveLength(3);
    const tokenRows = await db.listUsageDaily({ apiTokenId: 'tok-1' });
    expect(tokenRows.map((r) => r.requests).sort()).toEqual([1, 3, 4]);
  });

  it('handles empty-string sentinel dimensions without duplicating rows', async () => {
    const db = getDb();
    const anon = dims({ userId: '', apiTokenId: '', actorType: 'system', source: 'system' });
    await db.incrementUsageDaily([{ ...anon, requests: 1 }]);
    await db.incrementUsageDaily([{ ...anon, requests: 1 }]);

    const rows = await db.listUsageDaily({ userId: '' });
    expect(rows).toHaveLength(1);
    expect(rows[0].requests).toBe(2);
  });

  it('setUsageDailyCost overwrites costUsd by row id (retroactive reprice)', async () => {
    const db = getDb();
    await db.incrementUsageDaily([
      { ...dims(), requests: 1, totalTokens: 150, costUsd: 0 },
      { ...dims({ day: '2026-07-14' }), requests: 1, totalTokens: 100, costUsd: 0.2 },
    ]);

    const rows = await db.listUsageDaily({});
    const target = rows.find((row) => row.day === '2026-07-15')!;
    const updated = await db.setUsageDailyCost([{ id: String(target._id), costUsd: 1.25 }]);
    expect(updated).toBe(1);

    const after = await db.listUsageDaily({});
    expect(after.find((row) => row.day === '2026-07-15')!.costUsd).toBeCloseTo(1.25, 10);
    expect(after.find((row) => row.day === '2026-07-14')!.costUsd).toBeCloseTo(0.2, 10);
  });

  it('persists effective-dated external pricing versions round-trip', async () => {
    const db = getDb();
    const versions = [
      { effectiveFrom: '', pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 } },
      { effectiveFrom: '2026-08-01', pricing: { inputTokenPer1M: 3, outputTokenPer1M: 6 } },
    ];
    await db.upsertExternalModelPricing({
      tenantId,
      projectId: 'proj-1',
      modelName: 'Claude-Sonnet-4-5',
      pricing: versions[1].pricing,
      versions,
      updatedBy: 'user-1',
    });

    const entries = await db.listExternalModelPricing('proj-1');
    const entry = entries.find((item) => item.normalizedName === 'claude-sonnet-4-5')!;
    expect(entry.pricing.inputTokenPer1M).toBe(3);
    expect(entry.versions).toHaveLength(2);
    expect(entry.versions![0].effectiveFrom).toBe('');
    expect(entry.versions![1].pricing.outputTokenPer1M).toBe(6);

    // Upsert without versions (legacy caller) keeps the column nullable.
    await db.upsertExternalModelPricing({
      tenantId,
      projectId: 'proj-1',
      modelName: 'legacy-model',
      pricing: { inputTokenPer1M: 5, outputTokenPer1M: 5 },
    });
    const legacy = (await db.listExternalModelPricing('proj-1'))
      .find((item) => item.normalizedName === 'legacy-model')!;
    expect(legacy.versions ?? undefined).toBeUndefined();
  });
});

describeForEachProvider('Model usage log attribution roundtrip', (getDb) => {
  let slug: string;
  let dbName: string;
  let tenantId: string;

  beforeEach(async () => {
    slug = `attr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({
      companyName: 'Attr Co',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  it('persists and returns userId/apiTokenId/actorType on model usage logs', async () => {
    const db = getDb();
    await db.createModelUsageLog({
      tenantId,
      projectId: 'proj-1',
      modelKey: 'gpt-4o',
      requestId: 'req-1',
      route: 'chat.completions',
      status: 'success',
      providerRequest: {},
      providerResponse: {},
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      userId: 'user-9',
      apiTokenId: 'tok-9',
      actorType: 'api_token',
    });

    const logs = await db.listModelUsageLogs('gpt-4o', {}, 'proj-1');
    expect(logs).toHaveLength(1);
    expect(logs[0].userId).toBe('user-9');
    expect(logs[0].apiTokenId).toBe('tok-9');
    expect(logs[0].actorType).toBe('api_token');
  });

  // Regression: the SQLite provider used to omit every cost field from
  // aggregateModelUsage, so the Model Hub Spend column was permanently empty
  // on SQLite deployments (including the docker-compose quickstart) while the
  // numbers sat unread in the pricingSnapshot column.
  it('aggregateModelUsage sums the pricing snapshot into costSummary', async () => {
    const db = getDb();
    const base = {
      tenantId,
      projectId: 'proj-cost',
      modelKey: 'gpt-cost',
      route: 'chat.completions',
      status: 'success' as const,
      providerRequest: {},
      providerResponse: {},
    };

    await db.createModelUsageLog({
      ...base,
      requestId: 'cost-1',
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      pricingSnapshot: {
        currency: 'USD',
        inputTokenPer1M: 1,
        outputTokenPer1M: 2,
        inputCost: 0.001,
        outputCost: 0.001,
        cachedCost: 0,
        totalCost: 0.002,
      },
    });
    await db.createModelUsageLog({
      ...base,
      requestId: 'cost-2',
      inputTokens: 2000,
      outputTokens: 1000,
      totalTokens: 3000,
      pricingSnapshot: {
        currency: 'USD',
        inputTokenPer1M: 1,
        outputTokenPer1M: 2,
        inputCost: 0.002,
        outputCost: 0.002,
        cachedCost: 0,
        totalCost: 0.004,
      },
    });

    const agg = await db.aggregateModelUsage('gpt-cost', { groupBy: 'day' }, 'proj-cost');

    expect(agg.totalCalls).toBe(2);
    expect(agg.totalTokens).toBe(4500);
    expect(agg.costSummary).toBeDefined();
    expect(agg.costSummary?.currency).toBe('USD');
    expect(agg.costSummary?.totalCost).toBeCloseTo(0.006, 10);
    expect(agg.costSummary?.inputCost).toBeCloseTo(0.003, 10);
    expect(agg.costSummary?.outputCost).toBeCloseTo(0.003, 10);

    // The per-period buckets carry cost too — the usage chart reads them.
    const charted = (agg.timeseries ?? []).reduce((sum, point) => sum + (point.totalCost ?? 0), 0);
    expect(charted).toBeCloseTo(0.006, 10);
  });

  it('aggregateModelUsage omits costSummary when nothing is priced', async () => {
    const db = getDb();
    await db.createModelUsageLog({
      tenantId,
      projectId: 'proj-unpriced',
      modelKey: 'gpt-unpriced',
      requestId: 'unpriced-1',
      route: 'chat.completions',
      status: 'success',
      providerRequest: {},
      providerResponse: {},
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });

    const agg = await db.aggregateModelUsage('gpt-unpriced', {}, 'proj-unpriced');
    expect(agg.totalCalls).toBe(1);
    expect(agg.costSummary).toBeUndefined();
  });
});

describeForEachProvider('MCP Hub servers + audit logs', (getDb) => {
  let slug: string;
  let dbName: string;
  let tenantId: string;

  beforeEach(async () => {
    slug = `mcphub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({
      companyName: 'McpHub Co',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'owner-1',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  it('round-trips a multi-source server (remote + stdio + exposure + aegis + lastError)', async () => {
    const db = getDb();
    const created = await db.createMcpServer({
      tenantId,
      projectId: 'proj-1',
      key: 'remote-server',
      name: 'Remote server',
      sourceType: 'remote',
      remoteConfig: { url: 'https://mcp.example.com/mcp', transport: 'streamable-http' },
      stdioConfig: undefined,
      tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
      toolsDiscoveredAt: new Date('2026-07-15T10:00:00.000Z'),
      upstreamBaseUrl: undefined,
      upstreamAuth: { type: 'token', sealed: 'sealed-blob' },
      exposure: { protocols: ['streamable-http'], accessMode: 'public' },
      aegis: { mode: 'monitor', shieldId: 'shield-1' },
      status: 'active',
      endpointSlug: 'abcd1234abcd1234',
      totalRequests: 0,
      lastError: null,
      createdBy: 'user-1',
    });

    const found = await db.findMcpServerById(String(created._id));
    expect(found?.sourceType).toBe('remote');
    expect(found?.remoteConfig?.url).toBe('https://mcp.example.com/mcp');
    expect(found?.openApiSpec ?? undefined).toBeUndefined();
    expect(found?.upstreamBaseUrl ?? undefined).toBeUndefined();
    expect(found?.upstreamAuth.sealed).toBe('sealed-blob');
    expect(found?.exposure?.accessMode).toBe('public');
    expect(found?.exposure?.protocols).toEqual(['streamable-http']);
    expect(found?.aegis?.mode).toBe('monitor');

    const bySlug = await db.findMcpServerByEndpointSlug('abcd1234abcd1234');
    expect(String(bySlug?._id)).toBe(String(created._id));

    const updated = await db.updateMcpServer(String(created._id), {
      stdioConfig: {
        runtime: 'npx',
        packageName: '@x/y',
        executionMode: 'sandbox',
        envSealed: 'env-blob',
        sandbox: { resources: { cpuCores: 2, memoryMb: 1024 } },
      },
      lastError: { message: 'boom', at: new Date() },
    });
    expect(updated?.stdioConfig?.packageName).toBe('@x/y');
    expect(updated?.stdioConfig?.sandbox?.resources?.memoryMb).toBe(1024);
    expect(updated?.lastError?.message).toBe('boom');
  });

  it('persists extended request-log fields and lists recent logs project-wide', async () => {
    const db = getDb();
    await db.createMcpRequestLog({
      tenantId,
      projectId: 'proj-1',
      serverKey: 'srv-a',
      toolName: 'echo',
      status: 'success',
      latencyMs: 42,
      callerType: 'public',
      callerUserId: 'user-7',
      transport: 'jsonrpc',
      sourceType: 'stdio',
      sessionId: 'sess-1',
    });
    await db.createMcpRequestLog({
      tenantId,
      projectId: 'proj-2',
      serverKey: 'srv-b',
      toolName: 'other',
      status: 'error',
      errorMessage: 'nope',
    });

    const logs = await db.listMcpRequestLogs('srv-a');
    expect(logs).toHaveLength(1);
    expect(logs[0].callerType).toBe('public');
    expect(logs[0].transport).toBe('jsonrpc');
    expect(logs[0].sourceType).toBe('stdio');
    expect(logs[0].sessionId).toBe('sess-1');

    const recentP1 = await db.listRecentMcpRequestLogs({ projectId: 'proj-1' });
    expect(recentP1).toHaveLength(1);
    expect(recentP1[0].serverKey).toBe('srv-a');
  });

  it('creates and filters audit logs', async () => {
    const db = getDb();
    await db.createMcpAuditLog({
      tenantId,
      projectId: 'proj-1',
      serverId: 'id-1',
      serverKey: 'srv-a',
      action: 'create',
      changes: { name: { to: 'Server A' } },
      performedBy: 'user-1',
      ipAddress: '10.0.0.1',
      userAgent: 'vitest',
    });
    await db.createMcpAuditLog({
      tenantId,
      projectId: 'proj-1',
      serverKey: 'srv-b',
      action: 'secrets_change',
      performedBy: 'user-2',
    });

    const all = await db.listMcpAuditLogs({ projectId: 'proj-1' });
    expect(all).toHaveLength(2);

    const filtered = await db.listMcpAuditLogs({ serverKey: 'srv-a' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].action).toBe('create');
    expect(filtered[0].changes?.name?.to).toBe('Server A');
    expect(filtered[0].ipAddress).toBe('10.0.0.1');

    const byAction = await db.listMcpAuditLogs({ action: 'secrets_change' });
    expect(byAction).toHaveLength(1);
    expect(byAction[0].performedBy).toBe('user-2');
  });
});

describeForEachProvider('Evaluation target system-prompt override', (getDb) => {
  let dbName: string;
  let tenantId: string;

  beforeEach(async () => {
    const slug = `evaltgt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({
      companyName: 'Eval Target Co',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  it('round-trips an inline systemPrompt override', async () => {
    const db = getDb();
    const created = await db.createEvaluationTarget({
      tenantId,
      key: 'tgt-inline',
      name: 'Inline prompt target',
      kind: 'model',
      modelKey: 'gpt-test',
      systemPrompt: 'You are terse.',
      createdBy: 'tester',
    });
    const found = await db.findEvaluationTargetById(String(created._id));
    expect(found?.systemPrompt).toBe('You are terse.');
    expect(found?.promptKey).toBeUndefined();
  });

  it('round-trips a promptKey + promptVersion reference', async () => {
    const db = getDb();
    const created = await db.createEvaluationTarget({
      tenantId,
      key: 'tgt-promptkey',
      name: 'Managed prompt target',
      kind: 'model',
      modelKey: 'gpt-test',
      promptKey: 'support-tone',
      promptVersion: 3,
      createdBy: 'tester',
    });
    const found = await db.findEvaluationTargetById(String(created._id));
    expect(found?.promptKey).toBe('support-tone');
    expect(found?.promptVersion).toBe(3);
  });

  it('leaves the override fields undefined when never set', async () => {
    const db = getDb();
    const created = await db.createEvaluationTarget({
      tenantId,
      key: 'tgt-plain',
      name: 'Plain target',
      kind: 'model',
      modelKey: 'gpt-test',
      createdBy: 'tester',
    });
    const found = await db.findEvaluationTargetById(String(created._id));
    expect(found?.systemPrompt).toBeUndefined();
    expect(found?.promptKey).toBeUndefined();
    expect(found?.promptVersion).toBeUndefined();
  });

  it('updates and clears the override through updateEvaluationTarget', async () => {
    const db = getDb();
    const created = await db.createEvaluationTarget({
      tenantId,
      key: 'tgt-update',
      name: 'Updatable target',
      kind: 'model',
      modelKey: 'gpt-test',
      systemPrompt: 'first',
      createdBy: 'tester',
    });
    const id = String(created._id);

    const updated = await db.updateEvaluationTarget(id, { systemPrompt: 'second', promptVersion: 7 });
    expect(updated?.systemPrompt).toBe('second');
    expect(updated?.promptVersion).toBe(7);

    // An absent (undefined) field means "leave alone" on BOTH providers —
    // Mongo's $set would otherwise serialize undefined to null and wipe it.
    const untouched = await db.updateEvaluationTarget(id, { name: 'Renamed' });
    expect(untouched?.name).toBe('Renamed');
    expect(untouched?.systemPrompt).toBe('second');
    expect(untouched?.promptVersion).toBe(7);
  });
});

describeForEachProvider('Evaluation dataset items (separate collection)', (getDb) => {
  let dbName: string;
  let tenantId: string;

  beforeEach(async () => {
    const slug = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({
      companyName: 'Eval Co',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  it('routes inline items on create into the item collection and keeps itemCount', async () => {
    const db = getDb();
    const dataset = await db.createEvaluationDataset({
      tenantId,
      key: 'ds-routing',
      name: 'Routing DS',
      source: 'manual',
      items: [
        { id: 'i1', input: [{ role: 'user', content: 'one' }], tags: ['t'] },
        { id: 'i2', input: [{ role: 'user', content: 'two' }], expected: { reference: 'ref' } },
      ],
      createdBy: 'tester',
    });
    const datasetId = String(dataset._id);

    // The dataset document/row never carries items — only the count.
    const found = await db.findEvaluationDatasetById(datasetId);
    expect(found?.items).toBeUndefined();
    expect(found?.itemCount).toBe(2);

    const rows = await db.listEvaluationDatasetItems(datasetId);
    expect(rows.map((r) => r.id)).toEqual(['i1', 'i2']);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
    expect(rows[0].datasetId).toBe(datasetId);
    expect(rows[1].expected).toEqual({ reference: 'ref' });
    expect(await db.countEvaluationDatasetItems(datasetId)).toBe(2);
  });

  it('appends after the last position and rejects duplicate item ids', async () => {
    const db = getDb();
    const dataset = await db.createEvaluationDataset({
      tenantId,
      key: 'ds-append',
      name: 'Append DS',
      source: 'manual',
      items: [{ id: 'a', input: [{ role: 'user', content: 'a' }] }],
      createdBy: 'tester',
    });
    const datasetId = String(dataset._id);

    await db.createEvaluationDatasetItems(datasetId, [{ id: 'b', input: [{ role: 'user', content: 'b' }] }]);
    const rows = await db.listEvaluationDatasetItems(datasetId);
    expect(rows.map((r) => [r.id, r.position])).toEqual([['a', 0], ['b', 1]]);

    await expect(
      db.createEvaluationDatasetItems(datasetId, [{ id: 'a', input: [{ role: 'user', content: 'dup' }] }]),
    ).rejects.toThrow(/already exists/);

    const after = await db.findEvaluationDatasetById(datasetId);
    expect(after?.itemCount).toBe(2);
  });

  it('update-with-items replaces the full set; item update/delete stay consistent', async () => {
    const db = getDb();
    const dataset = await db.createEvaluationDataset({
      tenantId,
      key: 'ds-replace',
      name: 'Replace DS',
      source: 'manual',
      items: [
        { id: 'x1', input: [{ role: 'user', content: 'x1' }] },
        { id: 'x2', input: [{ role: 'user', content: 'x2' }] },
      ],
      createdBy: 'tester',
    });
    const datasetId = String(dataset._id);

    // Full replace through the legacy-compatible update path.
    const updated = await db.updateEvaluationDataset(datasetId, {
      items: [
        { id: 'y1', input: [{ role: 'user', content: 'y1' }] },
        { id: 'y2', input: [{ role: 'user', content: 'y2' }] },
        { id: 'y3', input: [{ role: 'user', content: 'y3' }] },
      ],
    });
    expect(updated?.itemCount).toBe(3);
    const replaced = await db.listEvaluationDatasetItems(datasetId);
    expect(replaced.map((r) => r.id)).toEqual(['y1', 'y2', 'y3']);

    // Item-level update.
    const patched = await db.updateEvaluationDatasetItem(datasetId, 'y2', {
      tags: ['patched'],
    });
    expect(patched?.tags).toEqual(['patched']);
    expect(patched?.position).toBe(1);

    // Item-level delete recounts.
    expect(await db.deleteEvaluationDatasetItem(datasetId, 'y1')).toBe(true);
    expect(await db.deleteEvaluationDatasetItem(datasetId, 'nope')).toBe(false);
    const afterDelete = await db.findEvaluationDatasetById(datasetId);
    expect(afterDelete?.itemCount).toBe(2);

    // search narrows list + count identically on both backends.
    const found = await db.listEvaluationDatasetItems(datasetId, { search: 'patched' });
    expect(found.map((r) => r.id)).toEqual(['y2']);
    expect(await db.countEvaluationDatasetItems(datasetId, 'patched')).toBe(1);
  });

  it('round-trips labels and filters items by label identically on both backends', async () => {
    const db = getDb();
    const dataset = await db.createEvaluationDataset({
      tenantId,
      key: 'ds-labels',
      name: 'Labels DS',
      source: 'manual',
      items: [
        { id: 'l1', input: [{ role: 'user', content: 'refund please' }] },
        { id: 'l2', input: [{ role: 'user', content: 'where is my order' }] },
        { id: 'l3', input: [{ role: 'user', content: 'unlabeled one' }] },
      ],
      createdBy: 'tester',
    });
    const datasetId = String(dataset._id);

    const labeled = await db.updateEvaluationDatasetItem(datasetId, 'l1', {
      labels: { intent: 'refund', escalated: true, turns: 3 },
      labelMeta: { source: 'ai', definitionKey: 'triage', runId: 'run-1', labeledAt: '2026-08-16T00:00:00.000Z' },
    });
    expect(labeled?.labels).toEqual({ intent: 'refund', escalated: true, turns: 3 });
    expect(labeled?.labelMeta?.source).toBe('ai');
    expect(labeled?.labelMeta?.definitionKey).toBe('triage');
    await db.updateEvaluationDatasetItem(datasetId, 'l2', {
      labels: { intent: 'order_status', escalated: false },
      labelMeta: { source: 'human', labeledBy: 'user-1' },
    });

    // Exact value match, including the boolean/number forms a query sends as text.
    const refunds = await db.listEvaluationDatasetItems(datasetId, { label: { key: 'intent', value: 'refund' } });
    expect(refunds.map((r) => r.id)).toEqual(['l1']);
    const escalated = await db.listEvaluationDatasetItems(datasetId, { label: { key: 'escalated', value: 'true' } });
    expect(escalated.map((r) => r.id)).toEqual(['l1']);
    const threeTurns = await db.listEvaluationDatasetItems(datasetId, { label: { key: 'turns', value: '3' } });
    expect(threeTurns.map((r) => r.id)).toEqual(['l1']);

    // Key-only match (any value) and the labeled/unlabeled split.
    const anyIntent = await db.listEvaluationDatasetItems(datasetId, { label: { key: 'intent' } });
    expect(anyIntent.map((r) => r.id)).toEqual(['l1', 'l2']);
    const unlabeled = await db.listEvaluationDatasetItems(datasetId, { labeled: false });
    expect(unlabeled.map((r) => r.id)).toEqual(['l3']);
    const anyLabeled = await db.listEvaluationDatasetItems(datasetId, { labeled: true });
    expect(anyLabeled.map((r) => r.id)).toEqual(['l1', 'l2']);

    // Counts must agree with the list, or pagination lies.
    expect(await db.countEvaluationDatasetItems(datasetId, undefined, { label: { key: 'intent', value: 'refund' } })).toBe(1);
    expect(await db.countEvaluationDatasetItems(datasetId, undefined, { labeled: false })).toBe(1);
    expect(await db.countEvaluationDatasetItems(datasetId, undefined, { labeled: true })).toBe(2);

    // Clearing labels puts the item back in the unlabeled bucket.
    const cleared = await db.updateEvaluationDatasetItem(datasetId, 'l2', { labels: null as never, labelMeta: null as never });
    expect(cleared?.labels ?? null).toBeNull();
    expect(await db.countEvaluationDatasetItems(datasetId, undefined, { labeled: false })).toBe(2);
  });

  it('round-trips the structured-output contract captured with an item', async () => {
    // The contract is what a replay has to reproduce: an item graded without
    // production's JSON schema is measuring a looser system. Mongo stores the
    // item as a document and gains the field for free; SQLite needs a column,
    // so only a parity test catches it going missing on-prem.
    const db = getDb();
    const schema = {
      type: 'object',
      properties: { total: { type: 'number' }, currency: { type: 'string' } },
      required: ['total', 'currency'],
      additionalProperties: false,
    };
    const dataset = await db.createEvaluationDataset({
      tenantId,
      key: 'ds-response-format',
      name: 'Response format DS',
      source: 'generated',
      items: [
        {
          id: 'rf1',
          input: [{ role: 'user', content: 'total this invoice' }],
          responseFormat: { type: 'json_schema', json_schema: { name: 'invoice', strict: true, schema } },
        },
        { id: 'rf2', input: [{ role: 'user', content: 'unconstrained' }] },
      ],
      createdBy: 'tester',
    });
    const datasetId = String(dataset._id);

    const items = await db.listEvaluationDatasetItems(datasetId);
    const withFormat = items.find((i) => i.id === 'rf1');
    // The SCHEMA has to survive intact — the contract's name alone cannot be
    // put back on the wire.
    expect(withFormat?.responseFormat).toEqual({
      type: 'json_schema',
      json_schema: { name: 'invoice', strict: true, schema },
    });
    // Absent stays absent: "no contract" and "contract not recorded" are
    // different facts, and an empty object would read as the former.
    expect(items.find((i) => i.id === 'rf2')?.responseFormat).toBeUndefined();

    const found = await db.findEvaluationDatasetItem(datasetId, 'rf1');
    expect(found?.responseFormat).toEqual(withFormat?.responseFormat);

    // Editable in place, and clearable back to nothing.
    const updated = await db.updateEvaluationDatasetItem(datasetId, 'rf1', {
      responseFormat: { type: 'json_object' },
    });
    expect(updated?.responseFormat).toEqual({ type: 'json_object' });
    const cleared = await db.updateEvaluationDatasetItem(datasetId, 'rf1', {
      responseFormat: null as never,
    });
    expect(cleared?.responseFormat ?? null).toBeNull();
  });

  it('deleting the dataset cascades its item rows', async () => {
    const db = getDb();
    const dataset = await db.createEvaluationDataset({
      tenantId,
      key: 'ds-cascade',
      name: 'Cascade DS',
      source: 'manual',
      items: [{ id: 'c1', input: [{ role: 'user', content: 'c1' }] }],
      createdBy: 'tester',
    });
    const datasetId = String(dataset._id);
    expect(await db.deleteEvaluationDataset(datasetId)).toBe(true);
    expect(await db.countEvaluationDatasetItems(datasetId)).toBe(0);
    expect(await db.listEvaluationDatasetItems(datasetId)).toHaveLength(0);
  });
});

describeForEachProvider('Evaluation dataset items — destructive-write safety', (getDb) => {
  let dbName: string;
  let tenantId: string;

  beforeEach(async () => {
    const slug = `evsafe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({
      companyName: 'Eval Safe Co',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  it('rejects a replace whose payload repeats an id WITHOUT destroying existing items', async () => {
    const db = getDb();
    const dataset = await db.createEvaluationDataset({
      tenantId,
      key: 'ds-safe-replace',
      name: 'Safe Replace DS',
      source: 'manual',
      items: [
        { id: 'keep-1', input: [{ role: 'user', content: 'one' }] },
        { id: 'keep-2', input: [{ role: 'user', content: 'two' }] },
      ],
      createdBy: 'tester',
    });
    const datasetId = String(dataset._id);

    await expect(
      db.updateEvaluationDataset(datasetId, {
        items: [
          { id: 'x', input: [{ role: 'user', content: 'x' }] },
          { id: 'x', input: [{ role: 'user', content: 'dup' }] },
        ],
      }),
    ).rejects.toThrow(/already exists/);

    // The original items and count survive the failed replace.
    const rows = await db.listEvaluationDatasetItems(datasetId);
    expect(rows.map((r) => r.id)).toEqual(['keep-1', 'keep-2']);
    expect(await db.countEvaluationDatasetItems(datasetId)).toBe(2);
  });

  it('rolls back the whole append batch when one id collides (no partial commit)', async () => {
    const db = getDb();
    const dataset = await db.createEvaluationDataset({
      tenantId,
      key: 'ds-safe-append',
      name: 'Safe Append DS',
      source: 'manual',
      items: [{ id: 'a', input: [{ role: 'user', content: 'a' }] }],
      createdBy: 'tester',
    });
    const datasetId = String(dataset._id);

    await expect(
      db.createEvaluationDatasetItems(datasetId, [
        { id: 'b', input: [{ role: 'user', content: 'b' }] },
        { id: 'a', input: [{ role: 'user', content: 'collides' }] },
      ]),
    ).rejects.toThrow(/already exists/);

    // Neither 'b' nor the colliding 'a' landed — the batch is atomic.
    const rows = await db.listEvaluationDatasetItems(datasetId);
    expect(rows.map((r) => r.id)).toEqual(['a']);
    const after = await db.findEvaluationDatasetById(datasetId);
    expect(after?.itemCount).toBe(1);
  });

  it('rejects duplicate ids on create without leaving a ghost dataset', async () => {
    const db = getDb();
    await expect(
      db.createEvaluationDataset({
        tenantId,
        key: 'ds-ghost',
        name: 'Ghost DS',
        source: 'manual',
        items: [
          { id: 'g', input: [{ role: 'user', content: 'g' }] },
          { id: 'g', input: [{ role: 'user', content: 'dup' }] },
        ],
        createdBy: 'tester',
      }),
    ).rejects.toThrow(/already exists/);
    // The key stays free for the corrected retry.
    expect(await db.findEvaluationDatasetByKey('ds-ghost')).toBeNull();
    const retried = await db.createEvaluationDataset({
      tenantId,
      key: 'ds-ghost',
      name: 'Ghost DS',
      source: 'manual',
      items: [{ id: 'g', input: [{ role: 'user', content: 'g' }] }],
      createdBy: 'tester',
    });
    expect(retried.itemCount).toBe(1);
  });
});

describeForEachProvider('Vector migrations + batch logs', (getDb) => {
  let dbName: string;
  let tenantId: string;

  beforeEach(async () => {
    const slug = `vecmig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({
      companyName: 'Vector Migration Co',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  const baseMigration = (key: string) => ({
    tenantId,
    projectId: 'proj-1',
    key,
    name: key,
    sourceProviderKey: 'src-provider',
    sourceIndexKey: 'src-index',
    sourceIndexName: 'Source index',
    destinationProviderKey: 'dst-provider',
    destinationIndexKey: 'dst-index',
    destinationIndexName: 'Destination index',
    status: 'pending' as const,
    attempt: 0,
    totalVectors: 0,
    migratedVectors: 0,
    failedVectors: 0,
    batchSize: 100,
    createdBy: 'tester',
  });

  it('creates, finds and lists by status', async () => {
    const db = getDb();
    const created = await db.createVectorMigration(baseMigration('mig-a'));
    expect(created._id).toBeTruthy();

    const found = await db.findVectorMigrationByKey('mig-a');
    expect(found?.sourceIndexName).toBe('Source index');
    expect(found?.status).toBe('pending');

    await db.createVectorMigration({ ...baseMigration('mig-b'), status: 'queued' });
    expect(await db.listVectorMigrations({ projectId: 'proj-1' })).toHaveLength(2);
    expect(await db.listVectorMigrations({ status: 'queued' })).toHaveLength(1);
    expect(
      await db.listVectorMigrations({ statuses: ['queued', 'running'] }),
    ).toHaveLength(1);
  });

  it('persists the resume checkpoint and clears fields on an explicit undefined', async () => {
    const db = getDb();
    await db.createVectorMigration(baseMigration('mig-resume'));

    await db.updateVectorMigration('mig-resume', {
      status: 'running',
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      errorMessage: 'transient',
      migratedVectors: 10,
      metadata: { progress: { cursor: 'c-1', batchIndex: 2 } },
    });

    const running = await db.findVectorMigrationByKey('mig-resume');
    expect(running?.status).toBe('running');
    expect(running?.migratedVectors).toBe(10);
    expect((running?.metadata?.progress as { cursor?: string })?.cursor).toBe('c-1');

    const restarted = await db.updateVectorMigration('mig-resume', {
      status: 'queued',
      errorMessage: undefined,
      startedAt: undefined,
      completedAt: undefined,
    });
    expect(restarted?.status).toBe('queued');
    expect(restarted?.errorMessage ?? undefined).toBeUndefined();
    expect(restarted?.startedAt ?? undefined).toBeUndefined();
    // Fields not mentioned keep their value on both providers.
    expect(restarted?.migratedVectors).toBe(10);
  });

  it('records batch logs and deletes them with the migration', async () => {
    const db = getDb();
    await db.createVectorMigration(baseMigration('mig-logs'));

    await db.createVectorMigrationLog({
      tenantId,
      projectId: 'proj-1',
      migrationKey: 'mig-logs',
      attempt: 1,
      batchIndex: 0,
      vectorIds: ['a', 'b'],
      status: 'success',
      migratedCount: 2,
      failedCount: 0,
      durationMs: 12,
    });
    await db.createVectorMigrationLog({
      tenantId,
      projectId: 'proj-1',
      migrationKey: 'mig-logs',
      attempt: 1,
      batchIndex: 1,
      vectorIds: [],
      status: 'failed',
      migratedCount: 0,
      failedCount: 2,
      errorMessage: 'upstream rejected batch',
    });

    const logs = await db.listVectorMigrationLogs('mig-logs');
    expect(logs.map((l) => l.batchIndex)).toEqual([0, 1]);
    expect(logs[0].vectorIds).toEqual(['a', 'b']);
    expect(await db.countVectorMigrationLogs('mig-logs')).toBe(2);
    expect(await db.countVectorMigrationLogs('mig-logs', 'failed')).toBe(1);

    expect(await db.deleteVectorMigration('mig-logs')).toBe(true);
    expect(await db.findVectorMigrationByKey('mig-logs')).toBeNull();
    expect(await db.listVectorMigrationLogs('mig-logs')).toHaveLength(0);
  });

  it('records vector query logs with the fields the analytics panel reads', async () => {
    const db = getDb();

    const created = await db.createVectorQueryLog({
      tenantId,
      projectId: 'proj-1',
      providerKey: 'my-provider',
      indexKey: 'my-index',
      topK: 5,
      matchCount: 3,
      latencyMs: 42,
      avgScore: 0.8125,
      filterApplied: true,
      userId: 'user-1',
      apiTokenId: 'token-1',
      actorType: 'user',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(created._id).toBeTruthy();
    expect(created.indexKey).toBe('my-index');
    expect(created.filterApplied).toBe(true);
    expect(created.avgScore).toBeCloseTo(0.8125);
  });

  it('aggregates query logs into daily buckets, totals and a topK histogram', async () => {
    const db = getDb();

    const log = (overrides: Partial<Parameters<typeof db.createVectorQueryLog>[0]>) =>
      db.createVectorQueryLog({
        tenantId,
        projectId: 'proj-1',
        providerKey: 'my-provider',
        indexKey: 'stats-index',
        topK: 5,
        matchCount: 2,
        latencyMs: 100,
        avgScore: 0.8,
        filterApplied: false,
        timestamp: new Date('2026-03-01T10:00:00.000Z'),
        ...overrides,
      });

    await log({});
    await log({ latencyMs: 200, avgScore: 0.6, filterApplied: true });
    await log({
      timestamp: new Date('2026-03-02T10:00:00.000Z'),
      latencyMs: 300,
      avgScore: undefined,
      topK: 10,
    });
    // Outside the window, and a different index — neither may leak in.
    await log({ timestamp: new Date('2026-02-01T10:00:00.000Z') });
    await log({ indexKey: 'other-index' });

    const stats = await db.aggregateVectorQueryStats({
      indexKey: 'stats-index',
      from: new Date('2026-03-01T00:00:00.000Z'),
      to: new Date('2026-03-31T23:59:59.999Z'),
    });

    expect(stats.daily).toHaveLength(2);
    expect(stats.daily[0].date).toBe('2026-03-01');
    expect(stats.daily[0].queryCount).toBe(2);
    expect(stats.daily[0].avgLatencyMs).toBeCloseTo(150);
    expect(stats.daily[0].avgScore).toBeCloseTo(0.7);
    expect(stats.daily[0].filterCount).toBe(1);

    expect(stats.daily[1].date).toBe('2026-03-02');
    expect(stats.daily[1].queryCount).toBe(1);
    // The only query that day carried no score, so the average is absent.
    expect(stats.daily[1].avgScore).toBeNull();

    expect(stats.totals.totalQueries).toBe(3);
    expect(stats.totals.minLatencyMs).toBe(100);
    expect(stats.totals.maxLatencyMs).toBe(300);
    expect(stats.totals.avgLatencyMs).toBeCloseTo(200);
    // Averaged over the two scored queries only.
    expect(stats.totals.avgScore).toBeCloseTo(0.7);

    expect(stats.topKDistribution).toEqual([
      { topK: 5, count: 2 },
      { topK: 10, count: 1 },
    ]);
  });

  it('returns empty stats for an index with no queries in the window', async () => {
    const db = getDb();

    const stats = await db.aggregateVectorQueryStats({
      indexKey: 'never-queried',
      from: new Date('2026-03-01T00:00:00.000Z'),
      to: new Date('2026-03-31T23:59:59.999Z'),
    });

    expect(stats.daily).toEqual([]);
    expect(stats.topKDistribution).toEqual([]);
    expect(stats.totals.totalQueries).toBe(0);
    expect(stats.totals.avgLatencyMs).toBeNull();
    expect(stats.totals.avgScore).toBeNull();
  });

  it('accepts a query log without a score or attribution', async () => {
    const db = getDb();

    const created = await db.createVectorQueryLog({
      tenantId,
      providerKey: 'my-provider',
      indexKey: 'empty-index',
      topK: 10,
      matchCount: 0,
      latencyMs: 7,
      filterApplied: false,
      timestamp: new Date('2026-01-02T00:00:00.000Z'),
    });

    expect(created._id).toBeTruthy();
    expect(created.matchCount).toBe(0);
  });

  it('groups a restarted migration\'s batch logs into their own run instead of mixing with the previous one', async () => {
    const db = getDb();
    await db.createVectorMigration(baseMigration('mig-restart'));

    // First run: two batches, then it fails/gets cancelled.
    await db.createVectorMigrationLog({
      tenantId,
      projectId: 'proj-1',
      migrationKey: 'mig-restart',
      attempt: 1,
      batchIndex: 0,
      vectorIds: ['a'],
      status: 'success',
      migratedCount: 1,
      failedCount: 0,
    });
    await db.createVectorMigrationLog({
      tenantId,
      projectId: 'proj-1',
      migrationKey: 'mig-restart',
      attempt: 1,
      batchIndex: 1,
      vectorIds: [],
      status: 'failed',
      migratedCount: 0,
      failedCount: 1,
    });

    // Restart bumps the attempt; batchIndex resets to 0 for the new run.
    await db.updateVectorMigration('mig-restart', { attempt: 2 });
    await db.createVectorMigrationLog({
      tenantId,
      projectId: 'proj-1',
      migrationKey: 'mig-restart',
      attempt: 2,
      batchIndex: 0,
      vectorIds: ['a', 'b'],
      status: 'success',
      migratedCount: 2,
      failedCount: 0,
    });

    const logs = await db.listVectorMigrationLogs('mig-restart');
    // Most recent run first, and never interleaved with the previous run.
    expect(logs.map((l) => ({ attempt: l.attempt, batchIndex: l.batchIndex }))).toEqual([
      { attempt: 2, batchIndex: 0 },
      { attempt: 1, batchIndex: 0 },
      { attempt: 1, batchIndex: 1 },
    ]);

    const restarted = await db.findVectorMigrationByKey('mig-restart');
    expect(restarted?.attempt).toBe(2);

    // Per-run summary drives the "pick a run" list — most recent run first.
    const runs = await db.listVectorMigrationRuns('mig-restart');
    expect(runs).toEqual([
      expect.objectContaining({ attempt: 2, batchCount: 1, migratedCount: 2, failedCount: 0, failedBatches: 0 }),
      expect.objectContaining({ attempt: 1, batchCount: 2, migratedCount: 1, failedCount: 1, failedBatches: 1 }),
    ]);

    // A run's own modal fetches just its logs, filtered server-side.
    const run1Logs = await db.listVectorMigrationLogs('mig-restart', { attempt: 1 });
    expect(run1Logs.map((l) => l.batchIndex)).toEqual([0, 1]);
    expect(await db.countVectorMigrationLogs('mig-restart', undefined, 1)).toBe(2);
    expect(await db.countVectorMigrationLogs('mig-restart', undefined, 2)).toBe(1);
  });
});


/**
 * createRagQueryLog stamps `createdAt` itself, so the only way to give two
 * logs a distinguishable timestamp — which every ordering and retention
 * assertion below depends on — is to actually let the clock move.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describeForEachProvider('RAG query log analytics', (getDb) => {
  let dbName: string;
  let tenantId: string;

  beforeEach(async () => {
    const slug = `ragqlog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({
      companyName: 'RAG Analytics Co',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  /** Six logs for `km-scores` plus one for a second module that must not leak. */
  const seedLogs = async () => {
    const db = getDb();
    const log = (overrides: Partial<Parameters<typeof db.createRagQueryLog>[0]>) =>
      db.createRagQueryLog({
        tenantId,
        projectId: 'proj-1',
        ragModuleKey: 'km-scores',
        query: 'q',
        topK: 5,
        matchCount: 1,
        latencyMs: 10,
        ...overrides,
      });

    await log({ query: 'strong hit', matchCount: 3, preFilterMatchCount: 3, topScore: 0.92, latencyMs: 10 });
    await tick();
    await log({ query: 'mid hit', matchCount: 2, preFilterMatchCount: 2, topScore: 0.35, latencyMs: 20 });
    await tick();
    await log({ query: 'mid hit again', matchCount: 1, preFilterMatchCount: 1, topScore: 0.35, latencyMs: 30 });
    await tick();
    await log({ query: 'perfect hit', matchCount: 1, preFilterMatchCount: 1, topScore: 1, latencyMs: 40 });
    await tick();
    // Candidates came back and minScore discarded every one — a tuning problem.
    await log({ query: 'threshold ate it', matchCount: 0, preFilterMatchCount: 4, topScore: 0, minScoreApplied: 0.8, latencyMs: 50 });
    await tick();
    // Nothing was retrieved at all, and pre-topScore logs carry no score.
    await log({ query: 'content gap', matchCount: 0, preFilterMatchCount: 0, latencyMs: 60 });
    await tick();
    await log({ ragModuleKey: 'km-other', query: 'other module', matchCount: 5, topScore: 0.5 });
  };

  it('keeps a same-key module in another project out of every analytics read', async () => {
    const db = getDb();
    await seedLogs();
    // Module keys are unique only within a project, so without a project scope
    // these rows — including their verbatim query text — would be counted,
    // charted and listed as if they belonged to proj-1.
    await db.createRagQueryLog({
      tenantId,
      projectId: 'proj-2',
      ragModuleKey: 'km-scores',
      query: 'other project secret',
      topK: 5,
      matchCount: 0,
      preFilterMatchCount: 0,
      topScore: 0.11,
      latencyMs: 70,
    });
    // A log with no project at all: written through /client/v1, or before
    // project stamping. Unattributable either way, so the owner still sees it.
    await db.createRagQueryLog({
      tenantId,
      ragModuleKey: 'km-scores',
      query: 'token-authed query',
      topK: 5,
      matchCount: 0,
      preFilterMatchCount: 0,
      topScore: 0.22,
      latencyMs: 80,
    });

    const scoped = await db.listRagQueryLogs('km-scores', { projectId: 'proj-1', limit: 50 });
    const texts = scoped.map((l) => l.query);
    expect(texts).not.toContain('other project secret');
    expect(texts).toContain('token-authed query');
    expect(texts).toContain('strong hit');

    const counts = await db.countRagQueryLogs('km-scores', { projectId: 'proj-1' });
    const unscoped = await db.countRagQueryLogs('km-scores');
    expect(counts.total).toBe(unscoped.total - 1);

    const buckets = await db.aggregateRagQueryScoreDistribution('km-scores', { projectId: 'proj-1' });
    // 0.11 is the other project's only score; nothing else lands in '0.1'.
    expect(buckets.find((b) => b.bucket === '0.1')?.count).toBe(0);
    expect(buckets.find((b) => b.bucket === '0.2')?.count).toBe(1);
  });

  it('lists only the queries that matched nothing when zeroOnly is set, newest first', async () => {
    const db = getDb();
    await seedLogs();

    const all = await db.listRagQueryLogs('km-scores');
    expect(all).toHaveLength(6);

    const zero = await db.listRagQueryLogs('km-scores', { zeroOnly: true });
    expect(zero.map((l) => l.query)).toEqual(['content gap', 'threshold ate it']);
    expect(zero.every((l) => l.matchCount === 0)).toBe(true);
    // Paging still applies on top of the filter.
    expect(
      (await db.listRagQueryLogs('km-scores', { zeroOnly: true, limit: 1 })).map((l) => l.query),
    ).toEqual(['content gap']);
  });

  it('round-trips the score fields a query log now carries', async () => {
    const db = getDb();
    await seedLogs();

    // Second-newest of the six: the query minScore emptied out.
    const [newest] = await db.listRagQueryLogs('km-scores', { limit: 1, skip: 1 });
    expect(newest.query).toBe('threshold ate it');
    expect(newest.preFilterMatchCount).toBe(4);
    expect(newest.topScore).toBe(0);
    expect(newest.minScoreApplied).toBeCloseTo(0.8);
    // Never written, so it must read back absent rather than as `false`.
    expect(newest.hybrid ?? undefined).toBeUndefined();

    const hybridLog = await db.createRagQueryLog({
      tenantId,
      ragModuleKey: 'km-hybrid',
      query: 'ERR-4021',
      topK: 5,
      matchCount: 2,
      preFilterMatchCount: 2,
      topScore: 0.7,
      avgScore: 0.61,
      hybrid: true,
    });
    expect(hybridLog._id).toBeTruthy();
    const [stored] = await db.listRagQueryLogs('km-hybrid');
    expect(stored.hybrid).toBe(true);
    expect(stored.avgScore).toBeCloseTo(0.61);
  });

  it('separates a content gap from a minScore threshold that ate every candidate', async () => {
    const db = getDb();
    await seedLogs();

    const counts = await db.countRagQueryLogs('km-scores');
    expect(counts).toEqual({
      total: 6,
      avgLatencyMs: 35,
      zeroMatchCount: 2,
      minScoreFilteredCount: 1,
    });

    // A module nobody has queried must not report NULL sums as anything but 0.
    expect(await db.countRagQueryLogs('km-never-queried')).toEqual({
      total: 0,
      avgLatencyMs: 0,
      zeroMatchCount: 0,
      minScoreFilteredCount: 0,
    });
  });

  it('buckets the best score per query into eleven ascending buckets, empties included', async () => {
    const db = getDb();
    await seedLogs();

    expect(await db.aggregateRagQueryScoreDistribution('km-scores')).toEqual([
      { bucket: '0.0', count: 1 },
      { bucket: '0.1', count: 0 },
      { bucket: '0.2', count: 0 },
      { bucket: '0.3', count: 2 },
      { bucket: '0.4', count: 0 },
      { bucket: '0.5', count: 0 },
      { bucket: '0.6', count: 0 },
      { bucket: '0.7', count: 0 },
      { bucket: '0.8', count: 0 },
      { bucket: '0.9', count: 1 },
      { bucket: '1.0', count: 1 },
    ]);

    // Same eleven buckets, all empty — never a shorter array.
    const empty = await db.aggregateRagQueryScoreDistribution('km-never-queried');
    expect(empty.map((b) => b.bucket)).toEqual([
      '0.0', '0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9', '1.0',
    ]);
    expect(empty.every((b) => b.count === 0)).toBe(true);
  });

  it('honours the date window on counts and on the histogram', async () => {
    const db = getDb();
    await seedLogs();

    const past = {
      from: new Date(Date.now() - 7_200_000),
      to: new Date(Date.now() - 3_600_000),
    };
    expect((await db.countRagQueryLogs('km-scores', past)).total).toBe(0);
    expect(
      (await db.aggregateRagQueryScoreDistribution('km-scores', past)).every((b) => b.count === 0),
    ).toBe(true);

    const now = { from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000) };
    expect((await db.countRagQueryLogs('km-scores', now)).total).toBe(6);
  });

  it('deletes only logs older than the cutoff, scoped to one module when asked', async () => {
    const db = getDb();
    const log = (ragModuleKey: string, query: string) =>
      db.createRagQueryLog({ tenantId, ragModuleKey, query, topK: 5, matchCount: 1 });

    await log('km-a', 'old a');
    await log('km-b', 'old b');
    await tick();
    const cutoff = new Date();
    await tick();
    await log('km-a', 'fresh a');
    await log('km-b', 'fresh b');

    // Module-scoped: the other module's old log survives.
    expect(await db.deleteRagQueryLogsOlderThan(cutoff, 'km-a')).toBe(1);
    expect((await db.listRagQueryLogs('km-a')).map((l) => l.query)).toEqual(['fresh a']);
    expect(await db.listRagQueryLogs('km-b')).toHaveLength(2);

    // Tenant-wide: still only what is older than the cutoff.
    expect(await db.deleteRagQueryLogsOlderThan(cutoff)).toBe(1);
    expect((await db.listRagQueryLogs('km-b')).map((l) => l.query)).toEqual(['fresh b']);
    expect(await db.deleteRagQueryLogsOlderThan(cutoff)).toBe(0);
  });
});

describeForEachProvider('RAG module teardown + shared index accounting', (getDb) => {
  let dbName: string;
  let tenantId: string;

  beforeEach(async () => {
    const slug = `ragdown-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({
      companyName: 'RAG Teardown Co',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  const baseModule = (key: string, vectorIndexKey: string, projectId?: string) => ({
    tenantId,
    projectId,
    key,
    name: key,
    embeddingModelKey: 'embed-3',
    vectorProviderKey: 'qdrant',
    vectorIndexKey,
    chunkConfig: { strategy: 'recursive_character' as const, chunkSize: 1000, chunkOverlap: 200 },
    status: 'active' as const,
    createdBy: 'tester',
  });

  it('cascades documents and chunks by module key and reports what it removed', async () => {
    const db = getDb();

    for (const [ragModuleKey, fileName] of [
      ['km-gone', 'a.pdf'],
      ['km-gone', 'b.pdf'],
      ['km-stays', 'c.pdf'],
    ] as const) {
      await db.createRagDocument({
        tenantId,
        projectId: 'proj-1',
        ragModuleKey,
        fileName,
        status: 'indexed',
        createdBy: 'tester',
      });
    }

    await db.bulkInsertRagChunks(
      ['km-gone', 'km-gone', 'km-gone', 'km-stays'].map((ragModuleKey, i) => ({
        tenantId,
        projectId: 'proj-1',
        ragModuleKey,
        documentId: `doc-${i}`,
        chunkIndex: 0,
        vectorId: `vec-${i}`,
        content: 'chunk text',
      })),
    );

    expect(await db.deleteRagChunksByModuleKey('km-gone')).toBe(3);
    expect(await db.deleteRagDocumentsByModuleKey('km-gone')).toBe(2);

    expect(await db.listRagDocuments('km-gone')).toHaveLength(0);
    expect(await db.listRagDocuments('km-stays')).toHaveLength(1);
    expect(await db.findRagChunksByVectorIds(['vec-0', 'vec-3']).then((c) => c.map((x) => x.vectorId)))
      .toEqual(['vec-3']);

    // Deleting a module with nothing left is a no-op, not an error.
    expect(await db.deleteRagChunksByModuleKey('km-gone')).toBe(0);
    expect(await db.deleteRagDocumentsByModuleKey('km-gone')).toBe(0);
  });

  it('counts the modules sharing a vector index, with and without excludeKey', async () => {
    const db = getDb();
    await db.createRagModule(baseModule('m1', 'idx-shared', 'proj-1'));
    await db.createRagModule(baseModule('m2', 'idx-shared', 'proj-1'));
    await db.createRagModule(baseModule('m3', 'idx-shared', 'proj-2'));
    await db.createRagModule(baseModule('m4', 'idx-other', 'proj-1'));

    expect(await db.countRagModulesByVectorIndexKey('idx-shared')).toBe(3);
    expect(await db.countRagModulesByVectorIndexKey('idx-shared', { projectId: 'proj-1' })).toBe(2);
    expect(await db.countRagModulesByVectorIndexKey('idx-shared', { excludeKey: 'm1' })).toBe(2);
    expect(
      await db.countRagModulesByVectorIndexKey('idx-shared', { projectId: 'proj-1', excludeKey: 'm1' }),
    ).toBe(1);
    expect(await db.countRagModulesByVectorIndexKey('idx-nobody')).toBe(0);
  });

  it('persists the retrieval controls and the re-index handshake on a module', async () => {
    const db = getDb();
    const created = await db.createRagModule({
      ...baseModule('m-controls', 'idx-shared', 'proj-1'),
      defaultTopK: 8,
      defaultMinScore: 0.45,
      defaultFilter: { tenant: 'acme' },
      filterableFields: ['tenant', 'lang'],
      hybrid: { enabled: true, mode: 'rrf', k: 60 },
      isolateByModule: true,
    });

    const found = await db.findRagModuleByKey('m-controls', 'proj-1');
    expect(found?.defaultTopK).toBe(8);
    expect(found?.defaultMinScore).toBeCloseTo(0.45);
    expect(found?.defaultFilter).toEqual({ tenant: 'acme' });
    expect(found?.filterableFields).toEqual(['tenant', 'lang']);
    expect(found?.hybrid).toEqual({ enabled: true, mode: 'rrf', k: 60 });
    expect(found?.isolateByModule).toBe(true);
    // Never set, so it must not read back as `false`.
    expect(found?.reindexRequired ?? undefined).toBeUndefined();

    await db.updateRagModule(String(created._id), {
      reindexRequired: true,
      activeReindexRunKey: 'rx-1',
    });
    const marked = await db.findRagModuleByKey('m-controls', 'proj-1');
    expect(marked?.reindexRequired).toBe(true);
    expect(marked?.activeReindexRunKey).toBe('rx-1');

    // The run finished: the pointer has to clear, or the module stays stuck on
    // a run that no longer exists.
    await db.updateRagModule(String(created._id), {
      reindexRequired: false,
      activeReindexRunKey: undefined,
      lastReindexAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    const done = await db.findRagModuleByKey('m-controls', 'proj-1');
    expect(done?.reindexRequired).toBe(false);
    expect(done?.activeReindexRunKey ?? undefined).toBeUndefined();
    expect(done?.lastReindexAt?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });
});

describeForEachProvider('RAG re-index runs', (getDb) => {
  let dbName: string;
  let tenantId: string;

  beforeEach(async () => {
    const slug = `ragrx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({
      companyName: 'RAG Reindex Co',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  const baseRun = (key: string, ragModuleKey: string) => ({
    tenantId,
    projectId: 'proj-1',
    key,
    ragModuleKey,
    status: 'pending' as const,
    reason: 'chunk-config' as const,
    attempt: 0,
    totalDocuments: 12,
    processedDocuments: 0,
    failedDocuments: 0,
    batchSize: 25,
    metadata: { requestedBy: 'ui' },
    createdBy: 'tester',
  });

  it('creates, finds by key and lists newest-first per module', async () => {
    const db = getDb();
    const created = await db.createRagReindexRun(baseRun('rx-1', 'km-1'));
    expect(created._id).toBeTruthy();
    await tick();
    await db.createRagReindexRun({ ...baseRun('rx-2', 'km-1'), status: 'running' });
    await tick();
    await db.createRagReindexRun(baseRun('rx-3', 'km-2'));

    const found = await db.findRagReindexRunByKey('rx-1');
    expect(found?.ragModuleKey).toBe('km-1');
    expect(found?.status).toBe('pending');
    expect(found?.reason).toBe('chunk-config');
    expect(found?.totalDocuments).toBe(12);
    expect(found?.batchSize).toBe(25);
    expect(found?.metadata).toEqual({ requestedBy: 'ui' });
    expect(await db.findRagReindexRunByKey('rx-missing')).toBeNull();

    expect((await db.listRagReindexRuns({ ragModuleKey: 'km-1' })).map((r) => r.key)).toEqual([
      'rx-2',
      'rx-1',
    ]);
    expect((await db.listRagReindexRuns({ projectId: 'proj-1' })).map((r) => r.key)).toEqual([
      'rx-3',
      'rx-2',
      'rx-1',
    ]);
    // The boot sweep asks for exactly the unfinished statuses.
    expect(
      (await db.listRagReindexRuns({ statuses: ['queued', 'running'] })).map((r) => r.key),
    ).toEqual(['rx-2']);
    expect((await db.listRagReindexRuns({ ragModuleKey: 'km-1', limit: 1 })).map((r) => r.key)).toEqual([
      'rx-2',
    ]);
  });

  it('carries the resume checkpoint and clears fields on an explicit undefined', async () => {
    const db = getDb();
    await db.createRagReindexRun(baseRun('rx-resume', 'km-1'));

    const running = await db.updateRagReindexRun('rx-resume', {
      status: 'running',
      startedAt: new Date('2026-02-01T00:00:00.000Z'),
      errorMessage: 'transient upstream failure',
      processedDocuments: 7,
      progress: { lastDocumentId: 'doc-42', heartbeatAt: '2026-02-01T00:05:00.000Z' },
    });
    expect(running?.status).toBe('running');
    expect(running?.processedDocuments).toBe(7);
    expect(running?.startedAt?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect((running?.progress as { lastDocumentId?: string })?.lastDocumentId).toBe('doc-42');

    const retried = await db.updateRagReindexRun('rx-resume', {
      status: 'queued',
      attempt: 1,
      errorMessage: undefined,
      startedAt: undefined,
      completedAt: undefined,
      progress: undefined,
    });
    expect(retried?.status).toBe('queued');
    expect(retried?.attempt).toBe(1);
    expect(retried?.errorMessage ?? undefined).toBeUndefined();
    expect(retried?.startedAt ?? undefined).toBeUndefined();
    expect(retried?.progress ?? undefined).toBeUndefined();
    // Fields not mentioned keep their value on both providers.
    expect(retried?.processedDocuments).toBe(7);

    expect(await db.updateRagReindexRun('rx-missing', { status: 'failed' })).toBeNull();
  });

  it('deletes a run by key', async () => {
    const db = getDb();
    await db.createRagReindexRun(baseRun('rx-delete', 'km-1'));

    expect(await db.deleteRagReindexRun('rx-delete')).toBe(true);
    expect(await db.findRagReindexRunByKey('rx-delete')).toBeNull();
    expect(await db.deleteRagReindexRun('rx-delete')).toBe(false);
  });
});
