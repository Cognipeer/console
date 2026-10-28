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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  DatabaseProvider,
  GuardrailHooksConfig,
  IGuardrailBinding,
  IRagDocument,
  RagDocumentAccessFilter,
} from '@/lib/database/provider.interface';
import {
  ensureTenantCollectionIndexes,
  ensureTenantDbIndexes,
  TENANT_DB_INDEXES,
} from '@/lib/database/mongodb/indexManifest';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { describeForEachProvider, listTenantIndexNames } from './db-parity.helper';

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

describeForEachProvider('User lifecycle fields (disable / enable)', (getDb) => {
  let dbName: string;
  let tenantId: string;

  beforeEach(async () => {
    const slug = `life-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({
      companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  it('a fresh user has no status (= active); disable persists and enable clears with null', async () => {
    const db = getDb();
    const user = await db.createUser({
      tenantId, email: 'bob@example.com', name: 'Bob', password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [],
    });
    const id = String(user._id);
    expect((await db.findUserById(id))?.status).toBeUndefined();

    const disabledAt = new Date('2026-10-01T12:00:00.000Z');
    await db.updateUser(id, { status: 'disabled', disabledAt, disabledBy: 'admin-1', disabledReason: 'left' });
    const disabled = await db.findUserById(id);
    expect(disabled).toMatchObject({ status: 'disabled', disabledBy: 'admin-1', disabledReason: 'left' });
    expect(new Date(disabled!.disabledAt as Date).toISOString()).toBe(disabledAt.toISOString());

    // Unrelated updates must not reset the lifecycle state.
    await db.updateUser(id, { name: 'Bobby' });
    expect((await db.findUserById(id))?.status).toBe('disabled');

    await db.updateUser(id, { status: 'active', disabledAt: null, disabledBy: null, disabledReason: null });
    const enabled = await db.findUserById(id);
    expect(enabled?.status).toBe('active');
    // SQLite reads cleared columns back as undefined, Mongo as null: both mean "unset".
    expect(enabled?.disabledAt ?? undefined).toBeUndefined();
    expect(enabled?.disabledBy ?? undefined).toBeUndefined();
    expect(enabled?.disabledReason ?? undefined).toBeUndefined();
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

  it('aggregate counts findings from passed (redact) logs, not only failed ones', async () => {
    const db = getDb();
    const created = await db.createGuardrail({
      tenantId,
      key: `pii-redact-${Math.random().toString(36).slice(2, 8)}`,
      name: 'Customer PII Redaction',
      type: 'preset',
      target: 'input',
      action: 'redact',
      enabled: true,
      createdBy: 'user-1',
    });
    const guardrailId = String(created._id);

    // What the hook engine writes for a redact verdict: `passed` means "no
    // BLOCKING finding", so a redaction is passed=true WITH findings.
    await db.createGuardrailEvaluationLog({
      tenantId,
      guardrailId,
      guardrailKey: created.key,
      guardrailName: created.name,
      guardrailType: created.type,
      target: 'input.pre',
      action: 'redact',
      passed: true,
      findings: [
        { type: 'pii', category: 'email', severity: 'high', message: 'Email address detected', action: 'redact', block: false },
        { type: 'pii', category: 'phone', severity: 'medium', message: 'Phone number detected', action: 'redact', block: false },
      ],
      inputText: 'My email is [REDACTED:email] and phone [REDACTED:phone].',
      latencyMs: 1,
      source: 'parity-test',
      message: null,
    });

    const aggregate = await db.aggregateGuardrailEvaluations(guardrailId);
    expect(aggregate.passedCount).toBe(1);
    expect(aggregate.failedCount).toBe(0);
    expect(aggregate.findingsByType).toEqual({ pii: 2 });
    expect(aggregate.findingsBySeverity).toEqual({ high: 1, medium: 1 });
  });
});

/**
 * Hook plane persistence.
 *
 * This is the suite that catches a forgotten SQLite whitelist site. SQLite has
 * FOUR of them per table (INSERT column list, INSERT params, the per-field
 * UPDATE chain, the row mapper) and missing one fails SILENTLY: the INSERT is a
 * template string, `.run({...})` accepts a loose object, and updateGuardrail
 * re-reads the row it just failed to write — so the UI reports "saved" and the
 * config reverts on the next page load. MongoDB has none of those sites, so a
 * SQLite-only omission is invisible on SaaS and fatal on self-host, which is
 * the default deployment.
 *
 * The config below is deliberately maximal — every optional sub-object, nested
 * policy configs, and at least one entry in each nested map — because a partial
 * fixture round-trips fine through a mapper that drops half the blob.
 */
describeForEachProvider('Guardrail hook plane persistence', (getDb) => {
  const tenantId = 'tenant-guardrail-hooks-parity';
  const dbName = `tenant_guardrail_hooks_${Date.now()}`;

  /** Every field of GuardrailHooksConfig, populated. */
  const fullHooks: GuardrailHooksConfig = {
    contractVersion: 2,
    policies: [
      {
        id: 'chk-pii',
        family: 'pii',
        enabled: true,
        hooks: ['input.pre', 'output.pre', 'output.stream.delta'],
        schedule: { timing: 'sync', onFail: 'block' },
        action: 'redact',
        failMode: 'closed',
        timeoutMs: 1500,
        label: 'Customer PII',
        piiPolicyKey: 'pii-default',
        actionOverride: 'redact',
        locale: 'tr',
        detectObfuscated: true,
        legacyCategories: { email: true, tc_kimlik: true, phone: false },
      },
      {
        id: 'chk-secrets',
        family: 'secrets',
        enabled: true,
        hooks: ['output.pre', 'tool.post'],
        schedule: { timing: 'sync', onFail: 'block' },
        known: true,
        genericHighEntropy: true,
        minEntropy: 3.5,
        allowValues: ['sk-test-fixture'],
      },
      {
        id: 'chk-regex',
        family: 'regex',
        enabled: true,
        hooks: ['output.stream.delta'],
        schedule: { timing: 'sync', onFail: 'log' },
        rules: [
          {
            id: 'rule-iban',
            label: 'IBAN',
            pattern: 'TR\\d{24}',
            flags: 'gi',
            category: 'financial',
            severity: 'high',
            action: 'redact',
            captureGroup: 0,
            maxMatchChars: 26,
          },
        ],
      },
      {
        id: 'chk-tools',
        family: 'tool_access',
        enabled: true,
        hooks: ['tool.pre', 'tool.post'],
        schedule: { timing: 'sync', onFail: 'block' },
        allow: ['search'],
        deny: ['shell'],
        sideEffects: { search: 'read', deploy: 'destructive' },
        allowedRoles: { deploy: ['admin'] },
        allowedDomains: ['api.example.com'],
        deniedDomains: ['evil.example.com'],
        allowedPathPrefixes: ['/workspace'],
        deniedPathPrefixes: ['/etc'],
        argumentSchemas: {
          search: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } },
        },
        maxArgBytes: 65536,
        maxResultBytes: 262144,
        maxArgDepth: 32,
        urlArgPaths: { fetch: ['url'] },
        pathArgPaths: { readFile: ['path'] },
        scanUndeclaredStrings: false,
        fsRoot: '/workspace',
        denyPrivateNetworks: true,
        defaultSideEffect: 'read',
        sideEffectActions: { destructive: 'warn', external: 'flag' },
      },
      {
        id: 'chk-webhook',
        family: 'webhook',
        enabled: false,
        hooks: ['input.pre'],
        schedule: { timing: 'async', onFail: 'log' },
        url: 'https://hooks.example.com/guardrail',
        headers: { 'x-tenant': 'parity' },
        credentialProviderKey: 'webhook-bearer',
        signingSecretRef: 'guardrail.webhook.hmac',
        send: 'text',
        retries: 2,
      },
    ],
    bindings: {
      'input.pre': { enabled: true, schedule: { timing: 'sync', onFail: 'block' }, failMode: 'closed', timeoutMs: 3000 },
      'output.pre': { enabled: true, schedule: { timing: 'sync', onFail: 'log' }, timeoutMs: 0 },
      'output.stream.delta': { enabled: true, schedule: { timing: 'sync', onFail: 'block' } },
      'tool.pre': { enabled: true, schedule: { timing: 'sync', onFail: 'block' } },
      'tool.post': { enabled: false, schedule: { timing: 'async', onFail: 'log' } },
    },
    stream: {
      enabled: true,
      holdBackChars: 256,
      holdBackMs: 200,
      overlapChars: 64,
      maxHeldChars: 4000,
      onBudgetExceeded: 'release',
      onBlock: 'truncate',
    },
    blockedMessage: {
      mode: 'replace',
      templates: { pii: 'Kişisel veri tespit edildi.', tool_denied: 'Bu araç kullanılamaz.' },
      includeTraceId: true,
    },
    visibility: {
      headers: true,
      useVerdictStatusCodes: false,
      detailedHeaders: true,
      aegisCompatHeaders: true,
    },
    shortCircuit: true,
  };

  beforeEach(async () => {
    const db = getDb();
    await db.switchToTenant(dbName);
  });

  it('round-trips a full hooks config, nested policy configs included', async () => {
    const db = getDb();
    const created = await db.createGuardrail({
      tenantId,
      key: `gr-hooks-${Date.now()}`,
      name: 'Hooked',
      type: 'preset',
      target: 'input',
      action: 'block',
      enabled: true,
      hooks: fullHooks,
      hooksVersion: 1,
      mode: 'enforce',
      createdBy: 'user-1',
    });

    const found = await db.findGuardrailById(String(created._id));
    // Deep equality, not toMatchObject: the point is that NOTHING was dropped
    // on the way through, and toMatchObject would pass on a truncated blob.
    expect(found?.hooks).toEqual(fullHooks);
    expect(found?.hooksVersion).toBe(1);
    expect(found?.mode).toBe('enforce');

    // Spot-check the deepest nesting explicitly, so a failure names the level
    // that broke rather than dumping the whole config diff.
    const pii = found?.hooks?.policies.find((c) => c.id === 'chk-pii');
    expect(pii?.family === 'pii' ? pii.legacyCategories : undefined).toEqual({
      email: true,
      tc_kimlik: true,
      phone: false,
    });
    const tools = found?.hooks?.policies.find((c) => c.id === 'chk-tools');
    expect(tools?.family === 'tool_access' ? tools.argumentSchemas?.search : undefined).toEqual({
      type: 'object',
      required: ['q'],
      properties: { q: { type: 'string' } },
    });
    expect(found?.hooks?.bindings['output.stream.delta']?.schedule).toEqual({
      timing: 'sync',
      onFail: 'block',
    });
  });

  it('updates hooks/hooksVersion/mode in place and reads the new blob back', async () => {
    const db = getDb();
    const created = await db.createGuardrail({
      tenantId,
      key: `gr-hooks-upd-${Date.now()}`,
      name: 'Hook Update',
      type: 'preset',
      target: 'input',
      action: 'block',
      enabled: true,
      createdBy: 'user-1',
    });

    // A guardrail authored through the UI is created legacy-shaped and gains
    // its hooks on a later save — the exact path that silently reverted when
    // the per-field UPDATE chain was missing a whitelist entry.
    const narrowed: GuardrailHooksConfig = {
      contractVersion: 2,
      policies: [fullHooks.policies[0]],
      bindings: { 'input.pre': { enabled: true, schedule: { timing: 'sync', onFail: 'block' } } },
      stream: { enabled: false },
      shortCircuit: false,
    };

    const updated = await db.updateGuardrail(String(created._id), {
      hooks: narrowed,
      hooksVersion: 2,
      mode: 'monitor',
    });
    expect(updated?.hooks).toEqual(narrowed);
    expect(updated?.hooksVersion).toBe(2);
    expect(updated?.mode).toBe('monitor');

    // …and it survives a fresh read, not just the write-through return value.
    const reread = await db.findGuardrailById(String(created._id));
    expect(reread?.hooks).toEqual(narrowed);
    expect(reread?.hooks?.stream?.enabled).toBe(false);
    expect(reread?.hooks?.shortCircuit).toBe(false);
  });

  it('reads a row stored in the PRE-RENAME spelling back as a real config', async () => {
    const db = getDb();
    // `hooks.checks`, not `hooks.policies`: what every build before the
    // `check` -> `policy` rename wrote, and what is on disk in every tenant
    // that authored a guardrail before it. The SQLite mapper decides whether a
    // stored blob is a config AT ALL by looking for that array, so if it only
    // knows the new name the row comes back `undefined`, `ensureHooks` calls it
    // unauthored, and the operator's whole configuration is silently replaced
    // by the legacy preset lift. Mongo stores the document verbatim, so this
    // case is the one place the two providers could disagree.
    const created = await db.createGuardrail({
      tenantId,
      key: `gr-hooks-legacy-spelling-${Date.now()}`,
      name: 'Old Spelling',
      type: 'preset',
      target: 'input',
      action: 'block',
      enabled: true,
      hooks: {
        contractVersion: 2,
        checks: [
          {
            id: 'chk-tools',
            family: 'tool_policy',
            enabled: true,
            hooks: ['tool.pre'],
            schedule: { timing: 'sync', onFail: 'block' },
            deny: ['shell.exec'],
          },
        ],
        bindings: { 'tool.pre': { enabled: true, schedule: { timing: 'sync', onFail: 'block' } } },
      } as unknown as GuardrailHooksConfig,
      hooksVersion: 1,
      createdBy: 'user-1',
    });

    const found = await db.findGuardrailById(String(created._id));
    expect(found?.hooks).toBeDefined();
    expect(found?.hooksVersion).toBe(1);
    // Stored VERBATIM — nothing rewrites a row on read. Re-spelling is the read
    // path's job (`normalizeHooksConfig`), so what the provider owes here is
    // simply not to throw the config away.
    const stored = found?.hooks as unknown as { checks?: unknown[] };
    expect(stored.checks).toHaveLength(1);
  });

  it('reads an unauthored guardrail back with hooks UNDEFINED, never {}', async () => {
    const db = getDb();
    const created = await db.createGuardrail({
      tenantId,
      key: `gr-hooks-none-${Date.now()}`,
      name: 'No Hooks',
      type: 'preset',
      target: 'input',
      action: 'block',
      enabled: true,
      createdBy: 'user-1',
    });

    const found = await db.findGuardrailById(String(created._id));
    // ensureHooks() distinguishes "absent" from "authored": an empty object
    // reads as an authored config with zero policies, i.e. a guardrail that
    // enforces NOTHING. SQLite defaults the column to '{}', so the mapper has
    // to collapse it back to undefined for the two providers to agree here.
    expect(found?.hooks).toBeUndefined();
    expect(found?.hooksVersion ?? 0).toBe(0);
  });

  it('persists hook / decision / riskScore on evaluation logs', async () => {
    const db = getDb();
    const created = await db.createGuardrail({
      tenantId,
      key: `gr-hooks-log-${Date.now()}`,
      name: 'Hook Logged',
      type: 'preset',
      target: 'input',
      action: 'block',
      enabled: true,
      createdBy: 'user-1',
    });
    const guardrailId = String(created._id);

    // A tool.pre block: indistinguishable from an output.pre redaction in the
    // audit trail unless `hook` survives the round trip.
    await db.createGuardrailEvaluationLog({
      tenantId,
      guardrailId,
      guardrailKey: created.key,
      guardrailName: created.name,
      guardrailType: created.type,
      target: 'tool.pre',
      action: 'block',
      passed: false,
      findings: [
        { type: 'tool_access', category: 'denied_tool', severity: 'high', message: 'shell denied', action: 'block', block: true },
      ],
      hook: 'tool.pre',
      decision: 'block',
      riskScore: 87,
      source: 'parity-test',
    });

    const logs = await db.listGuardrailEvaluationLogs(guardrailId, { limit: 10 });
    expect(logs).toHaveLength(1);
    expect(logs[0].hook).toBe('tool.pre');
    expect(logs[0].target).toBe('tool.pre');
    expect(logs[0].decision).toBe('block');
    expect(logs[0].riskScore).toBe(87);
  });
});

describeForEachProvider('Multi-guardrail binding persistence (model + agent)', (getDb) => {
  const tenantId = 'tenant-guardrail-binding-parity';
  const dbName = `tenant_guardrail_binding_${Date.now()}`;
  let seq = 0;

  const bindings: IGuardrailBinding[] = [
    { key: 'gr-pii', hooks: ['input.pre', 'output.pre', 'output.stream.delta'] },
    { key: 'gr-tool-policy', hooks: ['tool.pre', 'tool.post'] },
    // No `hooks`: activates wherever the guardrail itself declares it runs.
    { key: 'gr-everything' },
  ];

  const modelBase = (key: string) => ({
    key,
    name: key,
    providerKey: 'openai',
    providerDriver: 'openai',
    category: 'llm' as const,
    modelId: 'gpt-4o',
    tenantId,
    settings: {},
    pricing: { inputTokenPer1M: 0, outputTokenPer1M: 0 },
  });

  const agentBase = (key: string) => ({
    tenantId,
    projectId: 'project-binding',
    key,
    name: key,
    status: 'active' as const,
    createdBy: 'tester',
  });

  beforeEach(async () => {
    const db = getDb();
    await db.switchToTenant(dbName);
    seq += 1;
  });

  it('round-trips model.guardrails, per-binding hook lists included', async () => {
    const db = getDb();
    const created = await db.createModel({
      ...modelBase(`m-bind-${Date.now()}-${seq}`),
      guardrails: bindings,
      // The deprecated slots stay written for one release; they must survive
      // alongside the array rather than being clobbered by it.
      inputGuardrailKey: 'gr-pii',
      outputGuardrailKey: 'gr-pii',
    });

    const found = await db.findModelById(String(created._id));
    expect(found?.guardrails).toEqual(bindings);
    expect(found?.guardrails?.[1].hooks).toEqual(['tool.pre', 'tool.post']);
    expect(found?.guardrails?.[2].hooks).toBeUndefined();
    expect(found?.inputGuardrailKey).toBe('gr-pii');
  });

  it('updates model.guardrails in place and reads the new array back', async () => {
    const db = getDb();
    const created = await db.createModel({
      ...modelBase(`m-bind-upd-${Date.now()}-${seq}`),
      guardrails: bindings,
    });
    const id = String(created._id);

    const narrowed: IGuardrailBinding[] = [{ key: 'gr-tool-policy', hooks: ['tool.pre'] }];
    const updated = await db.updateModel(id, { guardrails: narrowed });
    expect(updated?.guardrails).toEqual(narrowed);

    // Re-read, not just the update's return value: a mixin that forgets the
    // per-field UPDATE whitelist still returns the row it failed to change.
    expect((await db.findModelById(id))?.guardrails).toEqual(narrowed);
  });

  it('reads a model written without guardrails back as UNDEFINED, never []', async () => {
    // [] means "authored, bound to nothing". If an absent column mapped to []
    // instead of undefined, resolveBindings would stop falling back to the
    // legacy keys and every pre-upgrade model would be silently disarmed.
    const db = getDb();
    const created = await db.createModel({
      ...modelBase(`m-bind-none-${Date.now()}-${seq}`),
      inputGuardrailKey: 'gr-legacy',
    });

    const found = await db.findModelById(String(created._id));
    expect(found?.guardrails).toBeUndefined();
    expect(found?.inputGuardrailKey).toBe('gr-legacy');
  });

  it('keeps an explicitly EMPTY model binding list distinct from an absent one', async () => {
    const db = getDb();
    const created = await db.createModel({
      ...modelBase(`m-bind-empty-${Date.now()}-${seq}`),
      guardrails: [],
    });

    expect((await db.findModelById(String(created._id)))?.guardrails).toEqual([]);
  });

  it('round-trips agent config.guardrails alongside the deprecated slots', async () => {
    // The agent's bindings ride the existing `config` JSON column — no agents
    // table migration — so this asserts the blob is not lossy for the new key.
    const db = getDb();
    const created = await db.createAgent({
      ...agentBase(`a-bind-${Date.now()}-${seq}`),
      config: {
        modelKey: 'gpt-4o',
        guardrails: bindings,
        inputGuardrailKey: 'gr-pii',
        outputGuardrailKey: 'gr-pii',
      },
    });

    const found = await db.findAgentById(String(created._id));
    expect(found?.config.guardrails).toEqual(bindings);
    expect(found?.config.guardrails?.[1].hooks).toEqual(['tool.pre', 'tool.post']);
    expect(found?.config.inputGuardrailKey).toBe('gr-pii');
  });

  it('updates agent config.guardrails and reads the new array back', async () => {
    const db = getDb();
    const created = await db.createAgent({
      ...agentBase(`a-bind-upd-${Date.now()}-${seq}`),
      config: { modelKey: 'gpt-4o', guardrails: bindings },
    });
    const id = String(created._id);

    const narrowed: IGuardrailBinding[] = [{ key: 'gr-tool-policy', hooks: ['tool.post'] }];
    await db.updateAgent(id, { config: { modelKey: 'gpt-4o', guardrails: narrowed } });

    expect((await db.findAgentById(id))?.config.guardrails).toEqual(narrowed);
  });

  it('reads an agent written without guardrails back as UNDEFINED, never []', async () => {
    const db = getDb();
    const created = await db.createAgent({
      ...agentBase(`a-bind-none-${Date.now()}-${seq}`),
      config: { modelKey: 'gpt-4o', inputGuardrailKey: 'gr-legacy' },
    });

    const found = await db.findAgentById(String(created._id));
    expect(found?.config.guardrails).toBeUndefined();
    expect(found?.config.inputGuardrailKey).toBe('gr-legacy');
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
      { ...dims(), requests: 1, inputTokens: 100, outputTokens: 50, cachedWriteTokens: 25, totalTokens: 150, costUsd: 0.5, latencyMsSum: 200, latencyCount: 1, units: { toolCalls: 2 } },
    ]);
    await db.incrementUsageDaily([
      { ...dims(), requests: 1, errors: 1, inputTokens: 10, outputTokens: 5, cachedWriteTokens: 5, totalTokens: 15, costUsd: 0.1, latencyMsSum: 100, latencyCount: 1, units: { toolCalls: 1, pages: 3 } },
    ]);

    const rows = await db.listUsageDaily({ userId: 'user-1' });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.requests).toBe(2);
    expect(row.errors).toBe(1);
    expect(row.inputTokens).toBe(110);
    expect(row.outputTokens).toBe(55);
    expect(row.cachedWriteTokens).toBe(30);
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

  it('listRoutedUsageLogs returns child + decider rows a router caused, without payloads', async () => {
    const db = getDb();
    const base = {
      tenantId,
      projectId: 'proj-route',
      route: 'chat.completions',
      status: 'success' as const,
      providerRequest: { messages: ['secret'] },
      providerResponse: { ok: true },
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    };
    const routing = {
      routerKey: 'smart-router',
      strategy: 'rule-based' as const,
      decision: 'rule' as const,
      chosenModelKey: 'small',
      reason: 'matched',
    };
    await db.createModelUsageLog({ ...base, modelKey: 'small', requestId: 'c1', routing: { ...routing, role: 'child', baselineCostUsd: 0.5 } });
    await db.createModelUsageLog({ ...base, modelKey: 'decider', requestId: 'd1', routing: { ...routing, role: 'decider' } });
    await db.createModelUsageLog({ ...base, modelKey: 'smart-router', route: 'chat.completions.router', requestId: 'r1', routing: { ...routing, role: 'router' } });
    await db.createModelUsageLog({ ...base, modelKey: 'small', requestId: 'o1', routing: { ...routing, routerKey: 'other', role: 'child' } });
    await db.createModelUsageLog({ ...base, modelKey: 'small', requestId: 'n1' });

    const logs = await db.listRoutedUsageLogs('smart-router', {}, 'proj-route');
    expect(logs.map((l) => l.requestId).sort()).toEqual(['c1', 'd1']);
    const child = logs.find((l) => l.requestId === 'c1');
    expect(child?.routing?.baselineCostUsd).toBe(0.5);
    expect(child?.providerRequest).toEqual({});
  });

  it('persists the run attribution on usage rows and sums a turn\'s ledger', async () => {
    const db = getDb();
    const base = {
      tenantId, projectId: 'proj-ledger', modelKey: 'gpt-4o', route: 'agent.chat', status: 'success' as const,
      providerRequest: {}, providerResponse: {}, agentKey: 'helper', channel: 'dashboard', conversationId: 'conv-L', runId: 'run-L',
    };
    await db.createModelUsageLog({ ...base, requestId: 'L1', turnId: 'turn-1', traceSessionId: 'sess-L', inputTokens: 100, outputTokens: 20, cachedInputTokens: 10, cachedWriteTokens: 7, reasoningTokens: 5, totalTokens: 130, pricingSnapshot: { currency: 'USD', inputTokenPer1M: 1, outputTokenPer1M: 2, totalCost: 0.25 } });
    await db.createModelUsageLog({ ...base, requestId: 'L2', turnId: 'turn-1', status: 'error', inputTokens: 50, outputTokens: 0, totalTokens: 50, pricingSnapshot: { currency: 'USD', inputTokenPer1M: 1, outputTokenPer1M: 2, totalCost: 0.05 } });
    await db.createModelUsageLog({ ...base, requestId: 'L3', turnId: 'turn-2', inputTokens: 1, outputTokens: 1, totalTokens: 2 });

    const stored = (await db.listModelUsageLogs('gpt-4o', {}, 'proj-ledger')).find((row) => row.requestId === 'L1');
    expect(stored).toMatchObject({ agentKey: 'helper', channel: 'dashboard', conversationId: 'conv-L', turnId: 'turn-1', runId: 'run-L', traceSessionId: 'sess-L' });

    const turn = await db.summarizeModelUsageForTurn('conv-L', 'turn-1', 'proj-ledger');
    expect(turn).toMatchObject({ calls: 2, errorCalls: 1, inputTokens: 150, outputTokens: 20, cachedInputTokens: 10, cachedWriteTokens: 7, reasoningTokens: 5, totalTokens: 180 });
    expect(turn.costUsd).toBeCloseTo(0.3, 6);
    expect(turn.lastAt).toBeInstanceOf(Date);
    expect((await db.summarizeModelUsageForTurn('conv-L', 'turn-none')).calls).toBe(0);
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
    expect(agg.totalCachedWriteTokens).toBe(0);
    expect(agg.costSummary?.cacheWriteCost).toBe(0);
    expect(agg.costSummary).toBeDefined();
    expect(agg.costSummary?.currency).toBe('USD');
    expect(agg.costSummary?.totalCost).toBeCloseTo(0.006, 10);
    expect(agg.costSummary?.inputCost).toBeCloseTo(0.003, 10);
    expect(agg.costSummary?.outputCost).toBeCloseTo(0.003, 10);

    // The per-period buckets carry cost too — the usage chart reads them.
    const charted = (agg.timeseries ?? []).reduce((sum, point) => sum + (point.totalCost ?? 0), 0);
    expect(charted).toBeCloseTo(0.006, 10);
  });

  it('aggregateModelUsage sums cache-write tokens and cacheWriteCost identically on both providers', async () => {
    const db = getDb();
    const base = {
      tenantId,
      projectId: 'proj-write',
      modelKey: 'claude-write',
      route: 'chat.completions',
      status: 'success' as const,
      providerRequest: {},
      providerResponse: {},
    };
    await db.createModelUsageLog({
      ...base,
      requestId: 'w-1',
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: 400,
      cachedWriteTokens: 200,
      totalTokens: 1100,
      pricingSnapshot: { currency: 'USD', inputTokenPer1M: 3, outputTokenPer1M: 15, cacheWriteCost: 0.00075, totalCost: 0.01 },
    });
    // A legacy-shaped row: no write tokens, no cacheWriteCost.
    await db.createModelUsageLog({
      ...base,
      requestId: 'w-2',
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      pricingSnapshot: { currency: 'USD', inputTokenPer1M: 3, outputTokenPer1M: 15, totalCost: 0.001 },
    });

    const agg = await db.aggregateModelUsage('claude-write', { groupBy: 'day' }, 'proj-write');
    expect(agg.totalCachedInputTokens).toBe(400);
    expect(agg.totalCachedWriteTokens).toBe(200);
    expect(agg.costSummary?.cacheWriteCost).toBeCloseTo(0.00075, 10);
    expect((agg.timeseries ?? []).reduce((sum, p) => sum + (p.cachedWriteTokens ?? 0), 0)).toBe(200);
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

    const logs = await db.listMcpRequestLogs({
      serverId: 'nonexistent-server-id',
      serverKey: 'srv-a',
      projectId: 'proj-1',
    });
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

  it('pages and counts documents with the same filters, without repeating a row', async () => {
    const db = getDb();
    for (let i = 0; i < 7; i += 1) {
      await db.createRagDocument({
        tenantId,
        projectId: 'proj-1',
        ragModuleKey: 'km-paged',
        fileName: `${i % 2 === 0 ? 'report' : 'notes'}-${i}.txt`,
        status: i === 6 ? 'failed' : 'indexed',
        createdBy: 'tester',
      });
    }

    const seen: string[] = [];
    for (let offset = 0; offset < 9; offset += 3) {
      const page = await db.listRagDocuments('km-paged', { projectId: 'proj-1', limit: 3, offset });
      expect(page.length).toBe(offset < 6 ? 3 : 1);
      seen.push(...page.map((d) => String(d._id)));
    }
    expect(new Set(seen).size).toBe(7);

    expect(await db.countRagDocuments('km-paged', 'proj-1')).toBe(7);
    expect(await db.countRagDocuments('km-paged', 'proj-1', { search: 'report' })).toBe(4);
    expect(await db.countRagDocuments('km-paged', 'proj-1', { status: 'failed' })).toBe(1);
    const searched = await db.listRagDocuments('km-paged', { projectId: 'proj-1', search: 'notes', limit: 2, offset: 2 });
    expect(searched).toHaveLength(1);
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

  it('adds to the document/chunk totals atomically and clamps them at 0', async () => {
    const db = getDb();
    const created = await db.createRagModule(baseModule('m-totals', 'idx-shared', 'proj-1'));
    const id = String(created._id);

    // Concurrent ingests into one module: every increment has to land.
    await Promise.all(
      Array.from({ length: 20 }, () => db.incrementRagModuleTotals(id, { documents: 1, chunks: 3 })),
    );
    let found = await db.findRagModuleById(id);
    expect(found?.totalDocuments).toBe(20);
    expect(found?.totalChunks).toBe(60);

    await db.incrementRagModuleTotals(id, { documents: -25, chunks: -100 });
    found = await db.findRagModuleById(id);
    expect(found?.totalDocuments).toBe(0);
    expect(found?.totalChunks).toBe(0);
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

describeForEachProvider('RAG module clearable fields', (getDb) => {
  let dbName: string;
  let tenantId: string;

  beforeEach(async () => {
    const slug = `ragclr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({
      companyName: 'RAG Clear Co', slug, dbName, licenseType: 'FREE', ownerId: 'pending',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  it('clears an optional field on an explicit undefined, identically on both backends', async () => {
    const db = getDb();
    // The API sends null to clear; the service turns that into an explicit
    // undefined. A guard that skips undefined drops the clear while still
    // answering 200 — the module keeps a reranker the operator removed.
    const created = await db.createRagModule({
      tenantId,
      projectId: 'proj-1',
      key: 'km-clear',
      name: 'Clearable',
      embeddingModelKey: 'emb',
      vectorProviderKey: 'vec',
      vectorIndexKey: 'idx',
      chunkConfig: { strategy: 'recursive_character', chunkSize: 400, chunkOverlap: 40 },
      status: 'active',
      rerankerKey: 'rr-1',
      defaultTopK: 8,
      defaultMinScore: 0.6,
      responseDetail: 'text',
      isolateByModule: true,
      createdBy: 'tester',
    });

    const id = String(created._id);
    expect((await db.findRagModuleById(id))?.rerankerKey).toBe('rr-1');

    await db.updateRagModule(id, {
      rerankerKey: undefined,
      defaultTopK: undefined,
      defaultMinScore: undefined,
      responseDetail: undefined,
    });

    const cleared = await db.findRagModuleById(id);
    expect(cleared?.rerankerKey ?? null).toBeNull();
    expect(cleared?.defaultTopK ?? null).toBeNull();
    expect(cleared?.defaultMinScore ?? null).toBeNull();
    expect(cleared?.responseDetail ?? null).toBeNull();
    // Untouched keys must survive: presence decides, not truthiness.
    expect(cleared?.isolateByModule).toBe(true);
    expect(cleared?.name).toBe('Clearable');
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

  it('lets exactly one worker claim a run, and refuses the others without writing', async () => {
    const db = getDb();
    await db.createRagReindexRun(baseRun('rx-claim', 'km-1'));
    const stale = new Date(Date.now() - 90_000);

    const first = await db.claimRagReindexRun('rx-claim', 'pod-a', stale);
    expect(first?.claimedBy).toBe('pod-a');
    expect(first?.status).toBe('running');

    // The queue is in-process without Redis, so after a rolling restart every
    // replica's boot sweep sees this same run. Only one may take it.
    expect(await db.claimRagReindexRun('rx-claim', 'pod-b', stale)).toBeNull();
    expect((await db.findRagReindexRunByKey('rx-claim'))?.claimedBy).toBe('pod-a');

    // The holder re-claiming is idempotent — that is how a resume continues.
    expect((await db.claimRagReindexRun('rx-claim', 'pod-a', stale))?.claimedBy).toBe('pod-a');
  });

  it('lets another worker take over only once the holder stops heart-beating', async () => {
    const db = getDb();
    await db.createRagReindexRun(baseRun('rx-stale', 'km-1'));
    await db.claimRagReindexRun('rx-stale', 'pod-a', new Date(Date.now() - 90_000));

    // A live holder keeps its run even when the sweep runs again.
    expect(await db.claimRagReindexRun('rx-stale', 'pod-b', new Date(Date.now() - 90_000))).toBeNull();
    expect(await db.touchRagReindexRunClaim('rx-stale', 'pod-a')).toBe(true);

    // A SIGKILLed pod leaves a run claimed but silent; it must not strand.
    const takeover = await db.claimRagReindexRun('rx-stale', 'pod-b', new Date(Date.now() + 60_000));
    expect(takeover?.claimedBy).toBe('pod-b');

    // The evicted holder learns it lost the claim and can stop working.
    expect(await db.touchRagReindexRunClaim('rx-stale', 'pod-a')).toBe(false);
  });

  it('releases a claim only for its holder', async () => {
    const db = getDb();
    await db.createRagReindexRun(baseRun('rx-release', 'km-1'));
    const stale = new Date(Date.now() - 90_000);
    await db.claimRagReindexRun('rx-release', 'pod-a', stale);

    await db.releaseRagReindexRunClaim('rx-release', 'pod-b');
    expect((await db.findRagReindexRunByKey('rx-release'))?.claimedBy).toBe('pod-a');

    await db.releaseRagReindexRunClaim('rx-release', 'pod-a');
    expect((await db.findRagReindexRunByKey('rx-release'))?.claimedBy).toBeUndefined();
  });

  it('will not claim a run that has already finished', async () => {
    const db = getDb();
    await db.createRagReindexRun({ ...baseRun('rx-done', 'km-1'), status: 'completed' });
    expect(await db.claimRagReindexRun('rx-done', 'pod-a', new Date(Date.now() - 90_000))).toBeNull();
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

// ── Knowledge Engine access control ──────────────────────────────────────────
// Folders, permission entries, identity directories and the selection filters
// on documents. Everything is nullable and additive: a module or document that
// never heard of access control must read, list and count exactly as before.

type RawTenantHandle = {
  prepare?: (sql: string) => { run: (params: Record<string, unknown>) => unknown };
  collection?: (name: string) => { insertOne: (doc: Record<string, unknown>) => Promise<unknown> };
};

/** The provider's private tenant handle (a better-sqlite3 database or a MongoDB `Db`), test-only access. */
const rawTenantHandle = (db: DatabaseProvider): RawTenantHandle =>
  (db as unknown as { getTenantDb(): RawTenantHandle }).getTenantDb();

/** A valid 24-hex id that names no document (a MongoDB ObjectId string; any string to SQLite). */
const fakeId = (i: number) => i.toString(16).padStart(24, '0');

/** The indexes of the five access-control tables (SQLite) / collections (MongoDB), under the names each provider gives them. */
const accessIndexNames = (sqlite: boolean): Record<string, string[]> =>
  sqlite
    ? {
        rag_folders: ['idx_rag_folders_module_parent', 'idx_rag_folders_module_source'],
        rag_acl_entries: ['idx_rag_acl_entries_module_principal', 'idx_rag_acl_entries_module_node'],
        rag_identity_domains: ['idx_rag_identity_domains_key'],
        rag_identity_users: ['idx_rag_identity_users_domain_extid', 'idx_rag_identity_users_domain_email', 'idx_rag_identity_users_domain_upn'],
        rag_identity_links: ['idx_rag_identity_links_console', 'idx_rag_identity_links_external'],
      }
    : {
        rag_folders: ['idx_module_parent', 'idx_module_source'],
        rag_acl_entries: ['idx_module_principal', 'idx_module_node'],
        rag_identity_domains: ['idx_key'],
        rag_identity_users: ['idx_domain_extId', 'idx_domain_email', 'idx_domain_upn'],
        rag_identity_links: ['idx_console', 'idx_domain_external'],
      };

describeForEachProvider('RAG access: module + document fields and selection', (getDb) => {
  let dbName: string;
  let tenantId: string;

  beforeEach(async () => {
    const slug = `ragacc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({
      companyName: 'RAG Access Co', slug, dbName, licenseType: 'FREE', ownerId: 'pending',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  const baseModule = (key: string, over: Partial<Parameters<DatabaseProvider['createRagModule']>[0]> = {}) => ({
    tenantId,
    projectId: 'proj-1',
    key,
    name: key,
    embeddingModelKey: 'emb',
    vectorProviderKey: 'vec',
    vectorIndexKey: 'idx',
    chunkConfig: { strategy: 'recursive_character' as const, chunkSize: 400, chunkOverlap: 40 },
    status: 'active' as const,
    isolateByModule: true,
    createdBy: 'tester',
    ...over,
  });

  const makeDoc = (fileName: string, over: Partial<IRagDocument> = {}) =>
    getDb().createRagDocument({
      tenantId,
      projectId: 'proj-1',
      ragModuleKey: 'km-acl',
      fileName,
      status: 'indexed',
      createdBy: 'tester',
      ...over,
    });

  const namesOf = (docs: IRagDocument[]) => docs.map((d) => d.fileName);
  const sorted = (values: string[]) => [...values].sort();

  // ── module ──────────────────────────────────────────────────────────────

  it('keeps a module without access control exactly as it was', async () => {
    const db = getDb();
    const created = await db.createRagModule(baseModule('km-legacy'));
    expect(created.access).toBeUndefined();
    expect((await db.findRagModuleByKey('km-legacy', 'proj-1'))?.access).toBeUndefined();
    expect((await db.findRagModuleByKey('km-legacy', 'proj-1'))?.aclRevision).toBeUndefined();
    const listed = await db.listRagModules({ projectId: 'proj-1' });
    expect(listed).toHaveLength(1);
    expect(listed[0].access).toBeUndefined();
    expect(listed[0].aclRevision).toBeUndefined();

    // Changing something else does not conjure a value.
    const renamed = await db.updateRagModule(String(created._id), { name: 'Renamed' });
    expect(renamed?.name).toBe('Renamed');
    expect(renamed?.access).toBeUndefined();
    expect(renamed?.aclRevision).toBeUndefined();
  });

  it('sets, changes and clears the access settings; presence decides, not truthiness', async () => {
    const db = getDb();
    const created = await db.createRagModule(baseModule('km-access', { access: { enabled: true, adminBypass: false } }));
    const id = String(created._id);
    expect(created.access).toEqual({ enabled: true, adminBypass: false });
    expect((await db.findRagModuleById(id))?.access).toEqual({ enabled: true, adminBypass: false });

    // An update that does not mention it leaves it alone.
    await db.updateRagModule(id, { name: 'Other' });
    expect((await db.findRagModuleById(id))?.access).toEqual({ enabled: true, adminBypass: false });

    const changed = await db.updateRagModule(id, { access: { enabled: false } });
    expect(changed?.access).toEqual({ enabled: false });
    expect((await db.findRagModuleByKey('km-access', 'proj-1'))?.access).toEqual({ enabled: false });

    // The API's null becomes an explicit undefined: that switches the feature off again.
    const cleared = await db.updateRagModule(id, { access: undefined });
    expect(cleared?.access).toBeUndefined();
    expect((await db.findRagModuleById(id))?.access).toBeUndefined();
    expect(cleared?.name).toBe('Other');
    expect(cleared?.isolateByModule).toBe(true);

    const back = await db.updateRagModule(id, { access: { enabled: true } });
    expect(back?.access).toEqual({ enabled: true });
  });

  it('counts ACL revisions per module, atomically, and only through the bump', async () => {
    const db = getDb();
    const a = await db.createRagModule(baseModule('km-rev-a'));
    await db.createRagModule(baseModule('km-rev-b'));
    await db.createRagModule(baseModule('km-rev-a', { projectId: 'proj-2' }));
    const revisionOf = async (key: string, projectId: string) => (await db.findRagModuleByKey(key, projectId))?.aclRevision;

    expect(await revisionOf('km-rev-a', 'proj-1')).toBeUndefined();
    await db.bumpRagModuleAclRevision('km-rev-a', 'proj-1');
    expect(await revisionOf('km-rev-a', 'proj-1')).toBe(1);
    await db.bumpRagModuleAclRevision('km-rev-a', 'proj-1');
    expect(await revisionOf('km-rev-a', 'proj-1')).toBe(2);

    // Another module, and the same key in another project, are not touched.
    expect(await revisionOf('km-rev-b', 'proj-1')).toBeUndefined();
    expect(await revisionOf('km-rev-a', 'proj-2')).toBeUndefined();

    // Replicas bumping at the same moment all count.
    await Promise.all([1, 2, 3, 4, 5].map(() => db.bumpRagModuleAclRevision('km-rev-a', 'proj-1')));
    expect(await revisionOf('km-rev-a', 'proj-1')).toBe(7);

    // A write-back of a stale module row cannot lose a bump: update never moves it.
    const stale = await db.updateRagModule(String(a._id), { aclRevision: 100, name: 'Still renamed' });
    expect(stale?.aclRevision).toBe(7);
    expect(stale?.name).toBe('Still renamed');

    // Without a project, every module with that key counts (a tenant-wide caller).
    await db.bumpRagModuleAclRevision('km-rev-a');
    expect(await revisionOf('km-rev-a', 'proj-1')).toBe(8);
    expect(await revisionOf('km-rev-a', 'proj-2')).toBe(1);

    // A module that does not exist is a no-op.
    await expect(db.bumpRagModuleAclRevision('km-missing', 'proj-1')).resolves.toBeUndefined();
    expect(await db.findRagModuleByKey('km-missing', 'proj-1')).toBeNull();
  });

  // ── document fields ─────────────────────────────────────────────────────

  it('stores a document\'s folder and ACL fields and clears each on an explicit undefined', async () => {
    const db = getDb();
    const doc = await makeDoc('a.txt', { folderId: 'f-a', aclMode: 'own', aclManaged: 'sync', sourceText: 'the full text' });
    const id = String(doc._id);
    expect(await db.findRagDocumentById(id)).toMatchObject({ folderId: 'f-a', aclMode: 'own', aclManaged: 'sync' });

    // An update that does not mention them leaves them alone.
    const processing = await db.updateRagDocument(id, { status: 'processing' });
    expect(processing).toMatchObject({ status: 'processing', folderId: 'f-a', aclMode: 'own', aclManaged: 'sync' });

    expect(await db.updateRagDocument(id, { folderId: 'f-b' })).toMatchObject({ folderId: 'f-b', aclMode: 'own', aclManaged: 'sync' });

    const topLevel = await db.updateRagDocument(id, { folderId: undefined });
    expect(topLevel?.folderId).toBeUndefined();
    expect(topLevel?.aclMode).toBe('own');
    expect(topLevel?.aclManaged).toBe('sync');

    const inherit = await db.updateRagDocument(id, { aclMode: undefined, aclManaged: undefined });
    expect(inherit?.aclMode).toBeUndefined();
    expect(inherit?.aclManaged).toBeUndefined();

    // What storage holds, not just what the update answered.
    const stored = await db.findRagDocumentById(id);
    expect(stored?.folderId).toBeUndefined();
    expect(stored?.aclMode).toBeUndefined();
    expect(stored?.aclManaged).toBeUndefined();
    expect(stored?.fileName).toBe('a.txt');
    expect(stored?.sourceText).toBe('the full text');
    expect(stored?.status).toBe('processing');
  });

  it('reads, lists, counts and filters a legacy document (none of the new fields) as before', async () => {
    const db = getDb();
    const legacy = await makeDoc('legacy.txt');
    expect(legacy.folderId).toBeUndefined();
    const found = await db.findRagDocumentById(String(legacy._id));
    expect(found?.folderId).toBeUndefined();
    expect(found?.aclMode).toBeUndefined();
    expect(found?.aclManaged).toBeUndefined();

    // A row that stores explicit NULLs (what an older code path left behind) reads the same.
    const raw = rawTenantHandle(db);
    const now = new Date();
    if (typeof raw.collection === 'function') {
      await raw.collection('rag_documents').insertOne({
        tenantId, projectId: 'proj-1', ragModuleKey: 'km-acl', fileName: 'nulls.txt', status: 'indexed',
        folderId: null, aclMode: null, aclManaged: null, createdBy: 'tester', createdAt: now, updatedAt: now,
      });
    } else {
      raw.prepare!(
        `INSERT INTO rag_documents (id, tenantId, projectId, ragModuleKey, fileName, status, folderId, aclMode, aclManaged, createdBy, createdAt, updatedAt)
         VALUES (@id, @tenantId, 'proj-1', 'km-acl', 'nulls.txt', 'indexed', NULL, NULL, NULL, 'tester', @now, @now)`,
      ).run({ id: 'raw-nulls', tenantId, now: now.toISOString() });
    }

    const all = await db.listRagDocuments('km-acl', { projectId: 'proj-1' });
    expect(sorted(namesOf(all))).toEqual(['legacy.txt', 'nulls.txt']);
    for (const doc of all) {
      expect(doc.folderId).toBeUndefined();
      expect(doc.aclMode).toBeUndefined();
      expect(doc.aclManaged).toBeUndefined();
    }
    expect(await db.countRagDocuments('km-acl', 'proj-1')).toBe(2);

    // Both are "top level" and "inherit".
    expect(sorted(namesOf(await db.listRagDocuments('km-acl', { projectId: 'proj-1', folderId: null })))).toEqual(['legacy.txt', 'nulls.txt']);
    expect(await db.listRagDocuments('km-acl', { projectId: 'proj-1', folderId: 'f-a' })).toEqual([]);
    const topLevelOnly: RagDocumentAccessFilter = { ownAllowedIds: [], inheritFolderIds: [], includeTopLevel: true };
    expect(await db.countRagDocuments('km-acl', 'proj-1', { access: topLevelOnly })).toBe(2);
    expect(await db.countRagDocuments('km-acl', 'proj-1', { access: { ...topLevelOnly, includeTopLevel: false } })).toBe(0);
    // ...and the negation keeps exactly the complement, NULL columns included.
    expect(await db.countRagDocuments('km-acl', 'proj-1', { access: { ...topLevelOnly, negate: true } })).toBe(0);
    expect(await db.countRagDocuments('km-acl', 'proj-1', { access: { ...topLevelOnly, includeTopLevel: false, negate: true } })).toBe(2);
  });

  // ── selection: folder, ids, access ──────────────────────────────────────

  it('lists and counts by folder: a folder id, the top level (null), and nothing else', async () => {
    const db = getDb();
    await makeDoc('top.txt');
    await makeDoc('a1.txt', { folderId: 'fa' });
    await makeDoc('a2.txt', { folderId: 'fa' });
    await makeDoc('b1.txt', { folderId: 'fb', status: 'failed' });
    await makeDoc('other-module.txt', { ragModuleKey: 'km-other', folderId: 'fa' });
    await makeDoc('other-project.txt', { projectId: 'proj-2', folderId: 'fa' });
    const scope = { projectId: 'proj-1' };

    expect(namesOf(await db.listRagDocuments('km-acl', { ...scope, folderId: 'fa' }))).toEqual(['a2.txt', 'a1.txt']);
    expect(namesOf(await db.listRagDocuments('km-acl', { ...scope, folderId: 'fb' }))).toEqual(['b1.txt']);
    expect(namesOf(await db.listRagDocuments('km-acl', { ...scope, folderId: null }))).toEqual(['top.txt']);
    expect(namesOf(await db.listRagDocuments('km-acl', { ...scope, folderId: '' }))).toEqual(['top.txt']);
    expect(await db.listRagDocuments('km-acl', { ...scope, folderId: 'nope' })).toEqual([]);

    expect(await db.countRagDocuments('km-acl', 'proj-1', { folderId: 'fa' })).toBe(2);
    expect(await db.countRagDocuments('km-acl', 'proj-1', { folderId: 'fb' })).toBe(1);
    expect(await db.countRagDocuments('km-acl', 'proj-1', { folderId: null })).toBe(1);
    expect(await db.countRagDocuments('km-acl', 'proj-1', { folderId: 'nope' })).toBe(0);
    // Together with the existing filters, and with paging.
    expect(await db.countRagDocuments('km-acl', 'proj-1', { folderId: 'fa', search: 'a1' })).toBe(1);
    expect(await db.countRagDocuments('km-acl', 'proj-1', { folderId: 'fb', status: 'indexed' })).toBe(0);
    expect(namesOf(await db.listRagDocuments('km-acl', { ...scope, folderId: 'fa', limit: 1, offset: 1 }))).toEqual(['a1.txt']);
  });

  it('lists and counts by id: only those, newest first, nothing for an empty list', async () => {
    const db = getDb();
    const d1 = await makeDoc('d1.txt', { folderId: 'fa' });
    const d2 = await makeDoc('d2.txt', { folderId: 'fa' });
    const d3 = await makeDoc('d3.txt');
    await makeDoc('d4.txt');
    const scope = { projectId: 'proj-1' };

    const ids = [String(d1._id), String(d3._id), fakeId(7), 'not-an-id'];
    expect(namesOf(await db.listRagDocuments('km-acl', { ...scope, ids }))).toEqual(['d3.txt', 'd1.txt']);
    expect(await db.countRagDocuments('km-acl', 'proj-1', { ids })).toBe(2);
    expect(await db.listRagDocuments('km-acl', { ...scope, ids: [] })).toEqual([]);
    expect(await db.countRagDocuments('km-acl', 'proj-1', { ids: [] })).toBe(0);
    expect(await db.countRagDocuments('km-acl', 'proj-1', { ids: [fakeId(1)] })).toBe(0);

    // Combined with another filter.
    expect(namesOf(await db.listRagDocuments('km-acl', { ...scope, ids: [String(d1._id), String(d2._id), String(d3._id)], folderId: 'fa' }))).toEqual(['d2.txt', 'd1.txt']);

    // A long list does not need a bound variable per id.
    const many = [...Array.from({ length: 600 }, (_, i) => fakeId(1000 + i)), String(d2._id)];
    expect(namesOf(await db.listRagDocuments('km-acl', { ...scope, ids: many }))).toEqual(['d2.txt']);
    expect(await db.countRagDocuments('km-acl', 'proj-1', { ids: many })).toBe(1);
  });

  describe('by what an access scope may read', () => {
    /** d1 top; d2 d3 in fa; d4 in fb; d5 own at the top; d6 own in fa; d7 in the folder "" (= top). */
    const seed = async () => {
      const d = {
        d1: await makeDoc('d1', {}),
        d2: await makeDoc('d2', { folderId: 'fa' }),
        d3: await makeDoc('d3', { folderId: 'fa' }),
        d4: await makeDoc('d4', { folderId: 'fb' }),
        d5: await makeDoc('d5', { aclMode: 'own' }),
        d6: await makeDoc('d6', { aclMode: 'own', folderId: 'fa' }),
        d7: await makeDoc('d7', { folderId: '' }),
      };
      // Same folder, same ACL mode, but another module / project: never part of the answer.
      await makeDoc('x-module', { ragModuleKey: 'km-other', folderId: 'fa' });
      await makeDoc('x-project', { projectId: 'proj-2', folderId: 'fa' });
      return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, String(v._id)])) as Record<keyof typeof d, string>;
    };
    const everything = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];

    const matched = async (access: RagDocumentAccessFilter) => {
      const db = getDb();
      const listed = sorted(namesOf(await db.listRagDocuments('km-acl', { projectId: 'proj-1', access })));
      // Count and the id-only listing agree with the full listing.
      expect(await db.countRagDocuments('km-acl', 'proj-1', { access })).toBe(listed.length);
      const ids = await db.listRagDocumentIds('km-acl', { projectId: 'proj-1', access, limit: 100 });
      expect(ids).toHaveLength(listed.length);
      return listed;
    };

    it('matches each clause on its own', async () => {
      const d = await seed();
      // Own ACL: the id is allowed. An inheriting document with an allowed id is NOT an own match.
      expect(await matched({ ownAllowedIds: [d.d5], inheritFolderIds: [], includeTopLevel: false })).toEqual(['d5']);
      expect(await matched({ ownAllowedIds: [d.d5, d.d6], inheritFolderIds: [], includeTopLevel: false })).toEqual(['d5', 'd6']);
      expect(await matched({ ownAllowedIds: [d.d1, d.d2], inheritFolderIds: [], includeTopLevel: false })).toEqual([]);
      // Inheriting from an allowed folder: own documents of that folder do not follow it.
      expect(await matched({ ownAllowedIds: [], inheritFolderIds: ['fa'], includeTopLevel: false })).toEqual(['d2', 'd3']);
      expect(await matched({ ownAllowedIds: [], inheritFolderIds: ['fa', 'fb'], includeTopLevel: false })).toEqual(['d2', 'd3', 'd4']);
      expect(await matched({ ownAllowedIds: [], inheritFolderIds: ['nope'], includeTopLevel: false })).toEqual([]);
      // Inheriting from the top level (no folder, or the empty folder id); own documents do not.
      expect(await matched({ ownAllowedIds: [], inheritFolderIds: [], includeTopLevel: true })).toEqual(['d1', 'd7']);
    });

    it('unions the clauses, and answers the complement with negate', async () => {
      const d = await seed();
      const cases: Array<{ access: RagDocumentAccessFilter; expected: string[] }> = [
        { access: { ownAllowedIds: [d.d5], inheritFolderIds: ['fa'], includeTopLevel: false }, expected: ['d2', 'd3', 'd5'] },
        { access: { ownAllowedIds: [d.d6], inheritFolderIds: ['fb'], includeTopLevel: true }, expected: ['d1', 'd4', 'd6', 'd7'] },
        { access: { ownAllowedIds: [d.d5, d.d6], inheritFolderIds: ['fa', 'fb'], includeTopLevel: true }, expected: everything },
        { access: { ownAllowedIds: [], inheritFolderIds: [], includeTopLevel: false }, expected: [] },
      ];
      for (const { access, expected } of cases) {
        expect(await matched(access)).toEqual(expected);
        const denied = await matched({ ...access, negate: true });
        expect(denied).toEqual(everything.filter((name) => !expected.includes(name)));
        // negate: false is the same as no negate.
        expect(await matched({ ...access, negate: false })).toEqual(expected);
      }
    });

    it('keeps the access filter apart from the project scope, search and the other filters', async () => {
      const db = getDb();
      const d = await seed();
      const access: RagDocumentAccessFilter = { ownAllowedIds: [d.d5], inheritFolderIds: ['fa'], includeTopLevel: true };
      expect(namesOf(await db.listRagDocuments('km-acl', { projectId: 'proj-1', access, search: 'd3' }))).toEqual(['d3']);
      expect(namesOf(await db.listRagDocuments('km-acl', { projectId: 'proj-1', access, folderId: 'fa' }))).toEqual(['d3', 'd2']);
      expect(await db.countRagDocuments('km-acl', 'proj-1', { access, status: 'failed' })).toBe(0);
      expect(namesOf(await db.listRagDocuments('km-acl', { projectId: 'proj-1', access, ids: [d.d1, d.d2, d.d4] }))).toEqual(['d2', 'd1']);
      const allMatching = namesOf(await db.listRagDocuments('km-acl', { projectId: 'proj-1', access }));
      expect(allMatching).toHaveLength(5);
      expect(namesOf(await db.listRagDocuments('km-acl', { projectId: 'proj-1', access, limit: 2, offset: 1 }))).toEqual(allMatching.slice(1, 3));
      // Another module / project has its own documents even in the same folder.
      expect(namesOf(await db.listRagDocuments('km-other', { projectId: 'proj-1', access }))).toEqual(['x-module']);
      expect(await db.countRagDocuments('km-acl', 'proj-2', { access })).toBe(1);
    });

    it('keeps working on a module without a project, whose scope is itself an $or on MongoDB', async () => {
      const db = getDb();
      const mk = (fileName: string, over: Partial<IRagDocument> = {}) =>
        db.createRagDocument({ tenantId, ragModuleKey: 'km-noproj', fileName, status: 'indexed', createdBy: 'tester', ...over });
      const own = await mk('own', { aclMode: 'own' });
      await mk('inherit-fa', { folderId: 'fa' });
      await mk('top');
      await db.createRagDocument({ tenantId, projectId: 'proj-1', ragModuleKey: 'km-noproj', fileName: 'in-a-project', status: 'indexed', createdBy: 'tester' });

      const access: RagDocumentAccessFilter = { ownAllowedIds: [String(own._id)], inheritFolderIds: ['fa'], includeTopLevel: false };
      expect(sorted(namesOf(await db.listRagDocuments('km-noproj', { projectId: '', access })))).toEqual(['inherit-fa', 'own']);
      expect(sorted(namesOf(await db.listRagDocuments('km-noproj', { projectId: '', access: { ...access, negate: true } })))).toEqual(['top']);
      // The count of a module no project shares its key with (the two backends scope an unset project differently).
      const solo = (fileName: string, over: Partial<IRagDocument> = {}) =>
        db.createRagDocument({ tenantId, ragModuleKey: 'km-solo', fileName, status: 'indexed', createdBy: 'tester', ...over });
      const soloOwn = await solo('own', { aclMode: 'own' });
      await solo('inherit-fa', { folderId: 'fa' });
      await solo('top');
      const soloAccess: RagDocumentAccessFilter = { ownAllowedIds: [String(soloOwn._id)], inheritFolderIds: ['fa'], includeTopLevel: false };
      expect(await db.countRagDocuments('km-solo', undefined, { access: soloAccess })).toBe(2);
      expect(await db.countRagDocuments('km-solo', undefined, { access: { ...soloAccess, negate: true } })).toBe(1);
      const inFolder = await db.listRagDocuments('km-noproj', { projectId: '', folderId: 'fa' });
      expect(sorted(await db.listRagDocumentIds('km-noproj', { projectId: '', access, limit: 10 })))
        .toEqual(sorted([String(own._id), ...inFolder.map((x) => String(x._id))]));
    });

    it('withUnscoped adds the rows without a project to a project, and nothing else', async () => {
      const db = getDb();
      const mk = (fileName: string, over: Partial<IRagDocument> = {}) =>
        db.createRagDocument({ tenantId, ragModuleKey: 'km-legacy', fileName, status: 'indexed', createdBy: 'tester', ...over });
      const own = await mk('own-p1', { projectId: 'proj-1', aclMode: 'own' });
      await mk('fa-p1', { projectId: 'proj-1', folderId: 'fa' });
      await mk('legacy-top');
      await mk('legacy-fa', { folderId: 'fa' });
      await mk('other-project', { projectId: 'proj-2', folderId: 'fa' });

      expect(await db.countRagDocuments('km-legacy', 'proj-1')).toBe(2);
      expect(await db.countRagDocuments('km-legacy', 'proj-1', { withUnscoped: true })).toBe(4);
      expect(await db.countRagDocuments('km-legacy', 'proj-1', { withUnscoped: true, folderId: 'fa' })).toBe(2);
      const access: RagDocumentAccessFilter = { ownAllowedIds: [String(own._id)], inheritFolderIds: ['fa'], includeTopLevel: false };
      expect(await db.countRagDocuments('km-legacy', 'proj-1', { withUnscoped: true, access })).toBe(3);
      expect(await db.countRagDocuments('km-legacy', 'proj-1', { withUnscoped: true, access: { ...access, negate: true } })).toBe(1);
      expect(sorted(namesOf(await db.listRagDocuments('km-legacy', { projectId: 'proj-1', withUnscoped: true, access }))))
        .toEqual(['fa-p1', 'legacy-fa', 'own-p1']);
      expect((await db.listRagDocumentIds('km-legacy', { projectId: 'proj-1', withUnscoped: true, access, limit: 10 })).length).toBe(3);
      // Without a project the flag changes nothing.
      expect(await db.countRagDocuments('km-legacy', undefined, { withUnscoped: true }))
        .toBe(await db.countRagDocuments('km-legacy', undefined));
    });

    it('takes long lists without a bound variable per id', async () => {
      const d = await seed();
      const own = [...Array.from({ length: 600 }, (_, i) => fakeId(10_000 + i)), d.d5];
      const folders = [...Array.from({ length: 5000 }, (_, i) => `folder-${i}`), 'fb'];
      expect(await matched({ ownAllowedIds: own, inheritFolderIds: folders, includeTopLevel: false })).toEqual(['d4', 'd5']);
      expect(await matched({ ownAllowedIds: own, inheritFolderIds: folders, includeTopLevel: false, negate: true }))
        .toEqual(['d1', 'd2', 'd3', 'd6', 'd7']);
    });
  });

  // ── id-only and by-id reads ─────────────────────────────────────────────

  it('lists ids only, in the order of the full listing, with paging and every filter', async () => {
    const db = getDb();
    const made = [];
    for (let i = 0; i < 6; i += 1) {
      made.push(await makeDoc(`n${i}`, { folderId: i < 4 ? 'fa' : undefined, status: i === 5 ? 'failed' : 'indexed' }));
    }
    const scope = { projectId: 'proj-1' };
    const full = (await db.listRagDocuments('km-acl', scope)).map((d) => String(d._id));
    expect(full).toHaveLength(6);

    expect(await db.listRagDocumentIds('km-acl', { ...scope, limit: 100 })).toEqual(full);
    expect(await db.listRagDocumentIds('km-acl', { ...scope, limit: 2 })).toEqual(full.slice(0, 2));
    expect(await db.listRagDocumentIds('km-acl', { ...scope, limit: 2, offset: 2 })).toEqual(full.slice(2, 4));
    expect(await db.listRagDocumentIds('km-acl', { ...scope, limit: 2, offset: 5 })).toEqual(full.slice(5));
    expect(await db.listRagDocumentIds('km-acl', { ...scope, limit: 2, offset: 50 })).toEqual([]);
    // Nothing for a zero limit on either backend (MongoDB would read 0 as "no limit").
    expect(await db.listRagDocumentIds('km-acl', { ...scope, limit: 0 })).toEqual([]);

    expect((await db.listRagDocumentIds('km-acl', { ...scope, folderId: 'fa', limit: 10 })).sort())
      .toEqual(made.slice(0, 4).map((d) => String(d._id)).sort());
    expect(await db.listRagDocumentIds('km-acl', { ...scope, status: 'failed', limit: 10 })).toEqual([String(made[5]._id)]);
    expect(await db.listRagDocumentIds('km-acl', { ...scope, search: 'n3', limit: 10 })).toEqual([String(made[3]._id)]);
    expect(await db.listRagDocumentIds('km-acl', { ...scope, ids: [String(made[1]._id)], limit: 10 })).toEqual([String(made[1]._id)]);
    expect(await db.listRagDocumentIds('km-acl', { ...scope, ids: [], limit: 10 })).toEqual([]);
    expect(await db.listRagDocumentIds('km-acl', { projectId: 'proj-2', limit: 10 })).toEqual([]);
    expect(typeof full[0]).toBe('string');
  });

  it('reads several documents by id without their source text', async () => {
    const db = getDb();
    const big = 'lorem ipsum '.repeat(500);
    const d1 = await makeDoc('one', { sourceText: big, folderId: 'fa', aclMode: 'own', aclManaged: 'sync' });
    const d2 = await makeDoc('two', { sourceText: big });
    const d3 = await makeDoc('three', { sourceText: big });

    // Asked in a different order than stored; a duplicate, an unknown id and a non-id are skipped.
    const found = await db.findRagDocumentsByIds([String(d3._id), String(d1._id), String(d3._id), fakeId(99), 'not-an-id', String(d2._id)]);
    expect(namesOf(found)).toEqual(['three', 'one', 'two']);
    for (const doc of found) {
      expect(doc.sourceText).toBeUndefined();
      expect(doc._id).toEqual(expect.any(String));
    }
    expect(found[1]).toMatchObject({ fileName: 'one', folderId: 'fa', aclMode: 'own', aclManaged: 'sync', ragModuleKey: 'km-acl', tenantId });
    // The single read still returns the text.
    expect((await db.findRagDocumentById(String(d1._id)))?.sourceText).toBe(big);

    expect(await db.findRagDocumentsByIds([])).toEqual([]);
    expect(await db.findRagDocumentsByIds([fakeId(1), fakeId(2)])).toEqual([]);
    // Thousands of ids are one parameter / one $in.
    const many = [...Array.from({ length: 3000 }, (_, i) => fakeId(50_000 + i)), String(d2._id)];
    expect(namesOf(await db.findRagDocumentsByIds(many))).toEqual(['two']);
  });
});

describeForEachProvider('RAG access: folders and permission entries', (getDb) => {
  let dbName: string;
  let tenantId: string;

  beforeEach(async () => {
    const slug = `ragfld-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({
      companyName: 'RAG Folders Co', slug, dbName, licenseType: 'FREE', ownerId: 'pending',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  const folder = (name: string, over: Partial<Parameters<DatabaseProvider['createRagFolder']>[0]> = {}) =>
    getDb().createRagFolder({
      tenantId,
      projectId: 'proj-1',
      ragModuleKey: 'km-f',
      name,
      createdBy: 'tester',
      ...over,
    });

  const aclEntry = (principal: string, over: Record<string, unknown> = {}) => ({
    tenantId,
    projectId: 'proj-1',
    principal,
    createdBy: 'tester',
    ...over,
  });

  const sorted = (values: string[]) => [...values].sort();

  // ── folders ─────────────────────────────────────────────────────────────

  it('creates a folder with every field and reads it back by id', async () => {
    const db = getDb();
    const parent = await folder('Parent');
    const created = await folder('Child', {
      parentId: String(parent._id),
      ancestorIds: [String(parent._id)],
      aclMode: 'own',
      aclManaged: 'sync',
      source: { kind: 'connector', connectorId: 'c-1', sourceId: 'src-1', externalId: 'ext-9' },
      updatedBy: 'someone',
    });
    expect(created._id).toEqual(expect.any(String));
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);

    const found = await db.findRagFolderById(String(created._id));
    expect(found).toMatchObject({
      tenantId,
      projectId: 'proj-1',
      ragModuleKey: 'km-f',
      name: 'Child',
      parentId: String(parent._id),
      ancestorIds: [String(parent._id)],
      aclMode: 'own',
      aclManaged: 'sync',
      source: { kind: 'connector', connectorId: 'c-1', sourceId: 'src-1', externalId: 'ext-9' },
      createdBy: 'tester',
      updatedBy: 'someone',
    });
    expect(found?.createdAt).toBeInstanceOf(Date);

    // A top-level folder simply lacks the optional fields.
    const top = await db.findRagFolderById(String(parent._id));
    expect(top?.parentId).toBeUndefined();
    expect(top?.ancestorIds).toBeUndefined();
    expect(top?.aclMode).toBeUndefined();
    expect(top?.aclManaged).toBeUndefined();
    expect(top?.source).toBeUndefined();

    expect(await db.findRagFolderById(fakeId(404))).toBeNull();
    expect(await db.findRagFolderById('not-an-id')).toBeNull();
  });

  it('lists a module\'s folders by name then id, and narrows by parent, ancestor, ids and source', async () => {
    const db = getDb();
    const alpha = await folder('Alpha');
    const reports = await folder('Reports', { parentId: String(alpha._id), ancestorIds: [String(alpha._id)] });
    const year = await folder('2025', {
      parentId: String(reports._id),
      ancestorIds: [String(alpha._id), String(reports._id)],
    });
    const zed = await folder('Zed');
    await folder('beta');
    const shared = await folder('Shared', { source: { kind: 'connector', connectorId: 'c-1', sourceId: 'src-1', externalId: 'ext-1' } });
    await folder('Other module', { ragModuleKey: 'km-other' });
    await folder('Other project', { projectId: 'proj-2' });
    const scope = { projectId: 'proj-1' };
    const names = async (filters: Parameters<DatabaseProvider['listRagFolders']>[1]) =>
      (await db.listRagFolders('km-f', filters)).map((f) => f.name);

    // Binary order: digits, capitals, lower case.
    expect(await names(scope)).toEqual(['2025', 'Alpha', 'Reports', 'Shared', 'Zed', 'beta']);
    // No project given: every project's folders of the module.
    expect(await names({})).toEqual(['2025', 'Alpha', 'Other project', 'Reports', 'Shared', 'Zed', 'beta']);
    expect(await names(undefined)).toEqual(await names({}));
    expect(await names({ projectId: 'proj-2' })).toEqual(['Other project']);

    expect(await names({ ...scope, parentId: null })).toEqual(['Alpha', 'Shared', 'Zed', 'beta']);
    expect(await names({ ...scope, parentId: String(alpha._id) })).toEqual(['Reports']);
    expect(await names({ ...scope, parentId: String(reports._id) })).toEqual(['2025']);
    expect(await names({ ...scope, parentId: fakeId(1) })).toEqual([]);

    // The whole subtree below a folder, the folder itself excluded.
    expect(await names({ ...scope, ancestorId: String(alpha._id) })).toEqual(['2025', 'Reports']);
    expect(await names({ ...scope, ancestorId: String(reports._id) })).toEqual(['2025']);
    expect(await names({ ...scope, ancestorId: String(year._id) })).toEqual([]);

    expect(await names({ ...scope, ids: [String(zed._id), String(reports._id), fakeId(5)] })).toEqual(['Reports', 'Zed']);
    expect(await names({ ...scope, ids: [] })).toEqual([]);
    expect(await names({ ...scope, sourceId: 'src-1' })).toEqual(['Shared']);
    expect(await names({ ...scope, sourceId: 'src-none' })).toEqual([]);
    expect(await names({ ...scope, ancestorId: String(alpha._id), parentId: String(alpha._id) })).toEqual(['Reports']);

    // The same ordering on equal names falls back to the id.
    const twin1 = await folder('Twin');
    const twin2 = await folder('Twin');
    const twins = (await db.listRagFolders('km-f', { ...scope })).filter((f) => f.name === 'Twin').map((f) => String(f._id));
    expect(twins).toEqual(sorted([String(twin1._id), String(twin2._id)]));

    // A long id list is not a long parameter list.
    const manyIds = [...Array.from({ length: 5000 }, (_, i) => fakeId(100_000 + i)), String(shared._id)];
    expect(await names({ ...scope, ids: manyIds })).toEqual(['Shared']);
  });

  it('finds a connector\'s folder by its id in the source', async () => {
    const db = getDb();
    const mine = await folder('Docs', { source: { kind: 'connector', connectorId: 'c-1', sourceId: 'src-1', externalId: 'ext-1' } });
    await folder('Other external id', { source: { kind: 'connector', connectorId: 'c-1', sourceId: 'src-1', externalId: 'ext-2' } });
    await folder('Other source', { source: { kind: 'connector', connectorId: 'c-1', sourceId: 'src-2', externalId: 'ext-1' } });
    await folder('Other module', { ragModuleKey: 'km-other', source: { kind: 'connector', connectorId: 'c-1', sourceId: 'src-1', externalId: 'ext-1' } });
    const inProject2 = await folder('Other project', { projectId: 'proj-2', source: { kind: 'connector', connectorId: 'c-1', sourceId: 'src-1', externalId: 'ext-1' } });
    await folder('No source');

    expect((await db.findRagFolderBySource('km-f', 'src-1', 'ext-1', 'proj-1'))?._id).toBe(mine._id);
    expect((await db.findRagFolderBySource('km-f', 'src-1', 'ext-1', 'proj-2'))?._id).toBe(inProject2._id);
    expect((await db.findRagFolderBySource('km-f', 'src-1', 'ext-1', 'proj-3'))).toBeNull();
    expect((await db.findRagFolderBySource('km-f', 'src-1', 'ext-2', 'proj-1'))?.name).toBe('Other external id');
    expect((await db.findRagFolderBySource('km-f', 'src-2', 'ext-1', 'proj-1'))?.name).toBe('Other source');
    expect((await db.findRagFolderBySource('km-other', 'src-1', 'ext-1', 'proj-1'))?.name).toBe('Other module');
    expect(await db.findRagFolderBySource('km-f', 'src-1', 'ext-404', 'proj-1')).toBeNull();
    expect(await db.findRagFolderBySource('km-f', 'src-404', 'ext-1', 'proj-1')).toBeNull();
    // No project given: not narrowed (the oldest match answers).
    expect((await db.findRagFolderBySource('km-f', 'src-1', 'ext-1'))?._id).toBe(mine._id);
  });

  it('updates a folder and clears each optional field on an explicit undefined', async () => {
    const db = getDb();
    const parent = await folder('Parent');
    const created = await folder('Child', {
      parentId: String(parent._id),
      ancestorIds: [String(parent._id)],
      aclMode: 'own',
      aclManaged: 'sync',
      source: { kind: 'connector', connectorId: 'c-1', sourceId: 'src-1', externalId: 'ext-1' },
    });
    const id = String(created._id);

    const renamed = await db.updateRagFolder(id, { name: 'Renamed', updatedBy: 'editor' });
    expect(renamed).toMatchObject({ name: 'Renamed', updatedBy: 'editor', parentId: String(parent._id), aclMode: 'own', aclManaged: 'sync' });
    expect(renamed?.source?.externalId).toBe('ext-1');
    expect(renamed!.updatedAt!.getTime()).toBeGreaterThanOrEqual(created.updatedAt!.getTime());

    // An update that mentions neither leaves them, and `undefined` for name / updatedBy is "leave it".
    const untouched = await db.updateRagFolder(id, { name: undefined, updatedBy: undefined });
    expect(untouched).toMatchObject({ name: 'Renamed', updatedBy: 'editor' });

    const moved = await db.updateRagFolder(id, { parentId: fakeId(9), ancestorIds: [fakeId(8), fakeId(9)] });
    expect(moved).toMatchObject({ parentId: fakeId(9), ancestorIds: [fakeId(8), fakeId(9)] });

    // Back to the top level, to "inherit", out of the source's hands.
    const cleared = await db.updateRagFolder(id, {
      parentId: undefined,
      ancestorIds: undefined,
      aclMode: undefined,
      aclManaged: undefined,
      source: undefined,
    });
    expect(cleared?.parentId).toBeUndefined();
    expect(cleared?.ancestorIds).toBeUndefined();
    expect(cleared?.aclMode).toBeUndefined();
    expect(cleared?.aclManaged).toBeUndefined();
    expect(cleared?.source).toBeUndefined();
    const stored = await db.findRagFolderById(id);
    expect(stored?.parentId).toBeUndefined();
    expect(stored?.source).toBeUndefined();
    expect(stored?.name).toBe('Renamed');
    expect(stored?.updatedBy).toBe('editor');

    // A cleared source no longer answers the lookup, and a cleared parent is a top-level folder.
    expect(await db.findRagFolderBySource('km-f', 'src-1', 'ext-1', 'proj-1')).toBeNull();
    expect((await db.listRagFolders('km-f', { projectId: 'proj-1', parentId: null })).map((f) => f.name)).toEqual(['Parent', 'Renamed']);

    // And a source can be set again.
    const sourced = await db.updateRagFolder(id, { source: { kind: 'connector', connectorId: 'c-2', sourceId: 'src-7', externalId: 'ext-7' } });
    expect(sourced?.source).toEqual({ kind: 'connector', connectorId: 'c-2', sourceId: 'src-7', externalId: 'ext-7' });
    expect((await db.findRagFolderBySource('km-f', 'src-7', 'ext-7', 'proj-1'))?._id).toBe(created._id);

    expect(await db.updateRagFolder(fakeId(404), { name: 'x' })).toBeNull();
    expect(await db.updateRagFolder('not-an-id', { name: 'x' })).toBeNull();
  });

  it('deletes one folder with its permission entries, or all of a module\'s folders', async () => {
    const db = getDb();
    const gone = await folder('Gone');
    const stays = await folder('Stays');
    await folder('Other project', { projectId: 'proj-2' });
    await folder('Other module', { ragModuleKey: 'km-other' });
    await db.replaceRagAclEntries('km-f', { type: 'folder', id: String(gone._id) }, [aclEntry('everyone'), aclEntry('user:u1')], 'proj-1');
    await db.replaceRagAclEntries('km-f', { type: 'folder', id: String(stays._id) }, [aclEntry('user:u2')], 'proj-1');
    await db.replaceRagAclEntries('km-f', { type: 'module', id: 'km-f' }, [aclEntry('group:g1')], 'proj-1');

    expect(await db.deleteRagFolder(String(gone._id))).toBe(true);
    expect(await db.findRagFolderById(String(gone._id))).toBeNull();
    expect(await db.deleteRagFolder(String(gone._id))).toBe(false);
    expect(await db.deleteRagFolder('not-an-id')).toBe(false);
    // The deleted folder's entries went with it; nobody else's did.
    expect(await db.hasRagAclEntries('km-f', 'folder', String(gone._id), 'proj-1')).toBe(false);
    expect(await db.hasRagAclEntries('km-f', 'folder', String(stays._id), 'proj-1')).toBe(true);
    expect(await db.hasRagAclEntries('km-f', 'module', 'km-f', 'proj-1')).toBe(true);

    // Module teardown, scoped to the project like the documents are.
    expect(await db.deleteRagFoldersByModuleKey('km-f', 'proj-1')).toBe(1);
    expect(await db.listRagFolders('km-f', { projectId: 'proj-1' })).toEqual([]);
    expect((await db.listRagFolders('km-f', { projectId: 'proj-2' })).map((f) => f.name)).toEqual(['Other project']);
    expect((await db.listRagFolders('km-other', {})).map((f) => f.name)).toEqual(['Other module']);
    expect(await db.deleteRagFoldersByModuleKey('km-f', 'proj-1')).toBe(0);
    // Without a project: every project's folders of that key.
    expect(await db.deleteRagFoldersByModuleKey('km-f')).toBe(1);
    expect(await db.listRagFolders('km-f', {})).toEqual([]);
  });

  // ── permission entries ──────────────────────────────────────────────────

  it('replaces the entries of one node, in order, without touching any other node', async () => {
    const db = getDb();
    const node = { type: 'folder' as const, id: 'folder-1' };
    expect(await db.hasRagAclEntries('km-f', 'folder', 'folder-1', 'proj-1')).toBe(false);
    expect(await db.listRagAclEntries('km-f', { projectId: 'proj-1', nodeType: 'folder', nodeId: 'folder-1' })).toEqual([]);

    await db.replaceRagAclEntries('km-f', { type: 'folder', id: 'folder-2' }, [aclEntry('user:other')], 'proj-1');
    await db.replaceRagAclEntries('km-f', { type: 'document', id: 'folder-1' }, [aclEntry('user:same-id-other-type')], 'proj-1');
    await db.replaceRagAclEntries(
      'km-f',
      node,
      [
        aclEntry('everyone', { label: 'Everyone' }),
        aclEntry('user:u1', { label: 'Ada', managed: 'sync' }),
        aclEntry('email:ada@example.com'),
        aclEntry('user:u1', { label: 'duplicate, dropped' }),
        aclEntry('x:c-abc:g:grp-1'),
      ],
      'proj-1',
    );
    expect(await db.hasRagAclEntries('km-f', 'folder', 'folder-1', 'proj-1')).toBe(true);

    const first = await db.listRagAclEntries('km-f', { projectId: 'proj-1', nodeType: 'folder', nodeId: 'folder-1' });
    expect(first.map((e) => e.principal)).toEqual(['everyone', 'user:u1', 'email:ada@example.com', 'x:c-abc:g:grp-1']);
    expect(first[0]).toMatchObject({
      _id: expect.any(String), tenantId, projectId: 'proj-1', ragModuleKey: 'km-f', nodeType: 'folder', nodeId: 'folder-1',
      principal: 'everyone', label: 'Everyone', createdBy: 'tester',
    });
    expect(first[0].createdAt).toBeInstanceOf(Date);
    expect(first[0].managed).toBeUndefined();
    expect(first[1]).toMatchObject({ label: 'Ada', managed: 'sync' });

    // Replacing again drops what is no longer listed and keeps the new order.
    await db.replaceRagAclEntries('km-f', node, [aclEntry('group:g1'), aclEntry('user:u1')], 'proj-1');
    const second = await db.listRagAclEntries('km-f', { projectId: 'proj-1', nodeType: 'folder', nodeId: 'folder-1' });
    expect(second.map((e) => e.principal)).toEqual(['group:g1', 'user:u1']);

    // Other nodes (another folder, a document with the same id) are untouched.
    expect((await db.listRagAclEntries('km-f', { projectId: 'proj-1', nodeType: 'folder', nodeId: 'folder-2' })).map((e) => e.principal)).toEqual(['user:other']);
    expect((await db.listRagAclEntries('km-f', { projectId: 'proj-1', nodeType: 'document', nodeId: 'folder-1' })).map((e) => e.principal)).toEqual(['user:same-id-other-type']);

    // An empty list removes them all.
    await db.replaceRagAclEntries('km-f', node, [], 'proj-1');
    expect(await db.hasRagAclEntries('km-f', 'folder', 'folder-1', 'proj-1')).toBe(false);
    expect(await db.hasRagAclEntries('km-f', 'folder', 'folder-2', 'proj-1')).toBe(true);
  });

  it('never leaves a node without entries when two replaces of it overlap', async () => {
    const db = getDb();
    const node = { type: 'module' as const, id: 'km-f' };
    const listNode = async () =>
      (await db.listRagAclEntries('km-f', { projectId: 'proj-1', nodeType: 'module', nodeId: 'km-f' })).map((e) => e.principal);
    const setA = ['user:a1', 'group:a2'];
    const setB = ['user:b1', 'group:b2', 'email:b3@example.com'];

    for (let round = 0; round < 25; round++) {
      await db.replaceRagAclEntries('km-f', node, [aclEntry('user:old')], 'proj-1');
      await Promise.all([
        db.replaceRagAclEntries('km-f', node, setA.map((p) => aclEntry(p)), 'proj-1'),
        db.replaceRagAclEntries('km-f', node, setB.map((p) => aclEntry(p)), 'proj-1'),
      ]);
      const principals = await listNode();
      // One of the two wins, or - where the store cannot order them - both are
      // kept until the next save. The node is never empty (an empty module root
      // reads as "everyone") and what both replaced never survives.
      expect(principals.length).toBeGreaterThan(0);
      expect(principals).not.toContain('user:old');
      expect(principals.every((p) => setA.includes(p) || setB.includes(p))).toBe(true);
    }

    // The next save puts things right.
    await db.replaceRagAclEntries('km-f', node, [aclEntry('user:final')], 'proj-1');
    expect(await listNode()).toEqual(['user:final']);
  });

  it('lists entries by node type, node, nodes and principals, within the module and project', async () => {
    const db = getDb();
    await db.replaceRagAclEntries('km-f', { type: 'module', id: 'km-f' }, [aclEntry('user:u1'), aclEntry('group:g1')], 'proj-1');
    await db.replaceRagAclEntries('km-f', { type: 'folder', id: 'fo-1' }, [aclEntry('user:u1')], 'proj-1');
    await db.replaceRagAclEntries('km-f', { type: 'folder', id: 'fo-2' }, [aclEntry('user:u2')], 'proj-1');
    await db.replaceRagAclEntries('km-f', { type: 'document', id: 'doc-1' }, [aclEntry('everyone'), aclEntry('user:u2')], 'proj-1');
    await db.replaceRagAclEntries('km-f', { type: 'module', id: 'km-f' }, [aclEntry('user:p2', { projectId: 'proj-2' })], 'proj-2');
    await db.replaceRagAclEntries('km-other', { type: 'folder', id: 'fo-1' }, [aclEntry('user:u1')], 'proj-1');
    const entries = async (filters: Parameters<DatabaseProvider['listRagAclEntries']>[1]) =>
      (await db.listRagAclEntries('km-f', filters)).map((e) => `${e.nodeType}:${e.nodeId}=${e.principal}`);

    expect(sorted(await entries({ projectId: 'proj-1' }))).toEqual(sorted([
      'module:km-f=user:u1', 'module:km-f=group:g1', 'folder:fo-1=user:u1', 'folder:fo-2=user:u2',
      'document:doc-1=everyone', 'document:doc-1=user:u2',
    ]));
    expect(await entries({ projectId: 'proj-2' })).toEqual(['module:km-f=user:p2']);
    // No project: the module's entries in every project.
    expect(await entries({})).toHaveLength(7);

    expect(sorted(await entries({ projectId: 'proj-1', nodeType: 'folder' }))).toEqual(['folder:fo-1=user:u1', 'folder:fo-2=user:u2']);
    expect(sorted(await entries({ projectId: 'proj-1', nodeType: 'module', nodeId: 'km-f' }))).toEqual(['module:km-f=group:g1', 'module:km-f=user:u1']);
    expect(await entries({ projectId: 'proj-1', nodeId: 'fo-2' })).toEqual(['folder:fo-2=user:u2']);
    expect(sorted(await entries({ projectId: 'proj-1', nodeIds: ['fo-1', 'doc-1', 'nope'] }))).toEqual([
      'document:doc-1=everyone', 'document:doc-1=user:u2', 'folder:fo-1=user:u1',
    ]);
    expect(await entries({ projectId: 'proj-1', nodeIds: [] })).toEqual([]);
    expect(sorted(await entries({ projectId: 'proj-1', principals: ['user:u2'] }))).toEqual(['document:doc-1=user:u2', 'folder:fo-2=user:u2']);
    expect(sorted(await entries({ projectId: 'proj-1', principals: ['user:u2', 'everyone', 'user:nobody'] }))).toEqual([
      'document:doc-1=everyone', 'document:doc-1=user:u2', 'folder:fo-2=user:u2',
    ]);
    expect(await entries({ projectId: 'proj-1', principals: [] })).toEqual([]);
    expect(await entries({ projectId: 'proj-1', nodeType: 'folder', principals: ['user:u1'], nodeIds: ['fo-1', 'fo-2'] })).toEqual(['folder:fo-1=user:u1']);
    expect(await entries({ projectId: 'proj-1', nodeType: 'document', principals: ['user:u1'] })).toEqual([]);
  });

  it('answers which nodes hold any of a set of principals: distinct, ordered, module- and project-scoped', async () => {
    const db = getDb();
    await db.replaceRagAclEntries('km-f', { type: 'module', id: 'km-f' }, [aclEntry('everyone')], 'proj-1');
    await db.replaceRagAclEntries('km-f', { type: 'folder', id: 'fo-b' }, [aclEntry('user:u1'), aclEntry('group:g1'), aclEntry('email:u1@example.com')], 'proj-1');
    await db.replaceRagAclEntries('km-f', { type: 'folder', id: 'fo-a' }, [aclEntry('group:g1')], 'proj-1');
    await db.replaceRagAclEntries('km-f', { type: 'folder', id: 'fo-c' }, [aclEntry('user:u2')], 'proj-1');
    await db.replaceRagAclEntries('km-f', { type: 'document', id: 'doc-1' }, [aclEntry('user:u1')], 'proj-1');
    await db.replaceRagAclEntries('km-f', { type: 'document', id: 'doc-2' }, [aclEntry('user:u1', { projectId: 'proj-2' })], 'proj-2');
    await db.replaceRagAclEntries('km-other', { type: 'folder', id: 'fo-x' }, [aclEntry('user:u1')], 'proj-1');

    // fo-b holds three of the principals and still appears once.
    expect(await db.listRagAclNodesForPrincipals('km-f', ['everyone', 'user:u1', 'group:g1', 'email:u1@example.com'], 'proj-1')).toEqual([
      { nodeType: 'document', nodeId: 'doc-1' },
      { nodeType: 'folder', nodeId: 'fo-a' },
      { nodeType: 'folder', nodeId: 'fo-b' },
      { nodeType: 'module', nodeId: 'km-f' },
    ]);
    expect(await db.listRagAclNodesForPrincipals('km-f', ['user:u2'], 'proj-1')).toEqual([{ nodeType: 'folder', nodeId: 'fo-c' }]);
    expect(await db.listRagAclNodesForPrincipals('km-f', ['user:u1'], 'proj-2')).toEqual([{ nodeType: 'document', nodeId: 'doc-2' }]);
    expect(await db.listRagAclNodesForPrincipals('km-f', ['user:nobody'], 'proj-1')).toEqual([]);
    expect(await db.listRagAclNodesForPrincipals('km-f', [], 'proj-1')).toEqual([]);
    expect(await db.listRagAclNodesForPrincipals('km-other', ['user:u1'], 'proj-1')).toEqual([{ nodeType: 'folder', nodeId: 'fo-x' }]);
    // Without a project the module's nodes of every project count.
    expect(await db.listRagAclNodesForPrincipals('km-f', ['user:u1'])).toEqual([
      { nodeType: 'document', nodeId: 'doc-1' },
      { nodeType: 'document', nodeId: 'doc-2' },
      { nodeType: 'folder', nodeId: 'fo-b' },
    ]);
  });

  it('takes a scope with thousands of principals and nodes', async () => {
    const db = getDb();
    const entries = Array.from({ length: 300 }, (_, i) => aclEntry(`user:u${i}`));
    await db.replaceRagAclEntries('km-f', { type: 'folder', id: 'fo-big' }, entries, 'proj-1');
    await db.replaceRagAclEntries('km-f', { type: 'document', id: 'doc-needle' }, [aclEntry('user:needle')], 'proj-1');

    const principals = [...Array.from({ length: 2500 }, (_, i) => `user:ghost${i}`), 'user:u7', 'user:needle'];
    expect(await db.listRagAclNodesForPrincipals('km-f', principals, 'proj-1')).toEqual([
      { nodeType: 'document', nodeId: 'doc-needle' },
      { nodeType: 'folder', nodeId: 'fo-big' },
    ]);
    const nodeIds = [...Array.from({ length: 5000 }, (_, i) => `node-${i}`), 'doc-needle'];
    expect((await db.listRagAclEntries('km-f', { projectId: 'proj-1', nodeIds })).map((e) => e.principal)).toEqual(['user:needle']);
    expect(await db.listRagAclEntries('km-f', { projectId: 'proj-1', principals })).toHaveLength(2);
    expect(await db.listRagAclEntries('km-f', { projectId: 'proj-1', nodeType: 'folder', nodeId: 'fo-big' })).toHaveLength(300);
  });

  it('scopes a replace to its project and tolerates a module key shared by two projects', async () => {
    const db = getDb();
    await db.replaceRagAclEntries('km-f', { type: 'module', id: 'km-f' }, [aclEntry('user:one')], 'proj-1');
    await db.replaceRagAclEntries('km-f', { type: 'module', id: 'km-f' }, [aclEntry('user:two', { projectId: 'proj-2' })], 'proj-2');
    // Replacing project 1's root must not wipe project 2's.
    await db.replaceRagAclEntries('km-f', { type: 'module', id: 'km-f' }, [aclEntry('user:one-again')], 'proj-1');
    expect((await db.listRagAclEntries('km-f', { projectId: 'proj-1', nodeType: 'module' })).map((e) => e.principal)).toEqual(['user:one-again']);
    expect((await db.listRagAclEntries('km-f', { projectId: 'proj-2', nodeType: 'module' })).map((e) => e.principal)).toEqual(['user:two']);
    expect(await db.hasRagAclEntries('km-f', 'module', 'km-f', 'proj-2')).toBe(true);
    expect(await db.hasRagAclEntries('km-f', 'module', 'km-f', 'proj-3')).toBe(false);

    // The entry carries the project it was written for.
    expect((await db.listRagAclEntries('km-f', { projectId: 'proj-2' }))[0].projectId).toBe('proj-2');

    expect(await db.deleteRagAclEntriesByModuleKey('km-f', 'proj-1')).toBe(1);
    expect(await db.hasRagAclEntries('km-f', 'module', 'km-f', 'proj-1')).toBe(false);
    expect(await db.hasRagAclEntries('km-f', 'module', 'km-f', 'proj-2')).toBe(true);
    expect(await db.deleteRagAclEntriesByModuleKey('km-f')).toBe(1);
    expect(await db.listRagAclEntries('km-f', {})).toEqual([]);
  });

  it('deletes a module\'s entries and a document\'s entries go with the document', async () => {
    const db = getDb();
    const keep = await db.createRagDocument({ tenantId, projectId: 'proj-1', ragModuleKey: 'km-f', fileName: 'keep.txt', status: 'indexed', createdBy: 'tester', aclMode: 'own' });
    const drop = await db.createRagDocument({ tenantId, projectId: 'proj-1', ragModuleKey: 'km-f', fileName: 'drop.txt', status: 'indexed', createdBy: 'tester', aclMode: 'own' });
    await db.replaceRagAclEntries('km-f', { type: 'document', id: String(keep._id) }, [aclEntry('user:u1')], 'proj-1');
    await db.replaceRagAclEntries('km-f', { type: 'document', id: String(drop._id) }, [aclEntry('user:u1'), aclEntry('user:u2')], 'proj-1');
    await db.replaceRagAclEntries('km-f', { type: 'folder', id: String(drop._id) }, [aclEntry('user:same-id-but-a-folder')], 'proj-1');
    await db.replaceRagAclEntries('km-f', { type: 'module', id: 'km-f' }, [aclEntry('everyone')], 'proj-1');

    expect(await db.deleteRagDocument(String(drop._id))).toBe(true);
    expect(await db.hasRagAclEntries('km-f', 'document', String(drop._id), 'proj-1')).toBe(false);
    expect(await db.hasRagAclEntries('km-f', 'document', String(keep._id), 'proj-1')).toBe(true);
    // Only the document-type entries of that id went; a folder node is another thing.
    expect(await db.hasRagAclEntries('km-f', 'folder', String(drop._id), 'proj-1')).toBe(true);
    expect(await db.hasRagAclEntries('km-f', 'module', 'km-f', 'proj-1')).toBe(true);
    // A document that was already gone is still just false.
    expect(await db.deleteRagDocument(String(drop._id))).toBe(false);

    expect(await db.deleteRagAclEntriesByModuleKey('km-f', 'proj-1')).toBe(3);
    expect(await db.listRagAclEntries('km-f', {})).toEqual([]);
  });

  // ── deleting by principal prefix ────────────────────────────────────────

  it('deletes the entries whose principal starts with a prefix in every module and project, and says how many', async () => {
    const db = getDb();
    const put = (moduleKey: string, type: 'module' | 'folder' | 'document', nodeId: string, principals: string[], projectId = 'proj-1') =>
      db.replaceRagAclEntries(moduleKey, { type, id: nodeId }, principals.map((principal) => aclEntry(principal, { projectId })), projectId);
    const principalsOf = async (moduleKey: string) => sorted((await db.listRagAclEntries(moduleKey, {})).map((e) => e.principal));
    await put('km-f', 'folder', 'fo-1', ['x:qdms:u:1', 'x:qdms:g:2', 'x:qdmsx:u:1', 'user:u1', 'everyone']);
    await put('km-f', 'folder', 'fo-2', ['x:qdms:u:3'], 'proj-2');
    await put('km-f', 'module', 'km-f', ['x:qdms:']);
    await put('km-other', 'document', 'doc-1', ['x:qdms:u:4', 'group:g1']);
    const keptFolder = await folder('x:qdms:');

    // Two on one node, one in another project, one on the module root (a principal that is the prefix itself), one in another module.
    expect(await db.deleteRagAclEntriesByPrincipalPrefix('x:qdms:')).toBe(5);
    // A longer domain that merely starts the same way is another domain; other kinds of principal are untouched.
    expect(await principalsOf('km-f')).toEqual(sorted(['x:qdmsx:u:1', 'user:u1', 'everyone']));
    expect(await principalsOf('km-other')).toEqual(['group:g1']);
    expect((await db.listRagFolders('km-f', {})).map((f) => String(f._id))).toEqual([String(keptFolder._id)]);
    expect(await db.hasRagAclEntries('km-f', 'module', 'km-f', 'proj-1')).toBe(false);

    // Run again: nothing left. A prefix that is a whole principal removes just that one.
    expect(await db.deleteRagAclEntriesByPrincipalPrefix('x:qdms:')).toBe(0);
    expect(await db.deleteRagAclEntriesByPrincipalPrefix('x:qdmsx:u:1')).toBe(1);
    expect(await principalsOf('km-f')).toEqual(sorted(['user:u1', 'everyone']));

    // Nothing starts with a prefix longer than every principal. An empty prefix is not "everything", and neither is one
    // that no principal can start with (a control character, or no string at all): this delete spans the whole tenant.
    expect(await db.deleteRagAclEntriesByPrincipalPrefix('everyone-and-then-some')).toBe(0);
    expect(await db.deleteRagAclEntriesByPrincipalPrefix('')).toBe(0);
    expect(await db.deleteRagAclEntriesByPrincipalPrefix('user:\u0000')).toBe(0);
    expect(await db.deleteRagAclEntriesByPrincipalPrefix('user:\n')).toBe(0);
    expect(await db.deleteRagAclEntriesByPrincipalPrefix(undefined as unknown as string)).toBe(0);
    expect(await principalsOf('km-f')).toEqual(sorted(['user:u1', 'everyone']));
    expect(await principalsOf('km-other')).toEqual(['group:g1']);
  });

  it('reads the prefix literally: no wildcard, no pattern, and upper case is another letter', async () => {
    const db = getDb();
    // Each prefix with the look-alikes it must leave alone: what a SQL LIKE or an unescaped regular expression would also take.
    const cases: Array<{ prefix: string; stays: string[] }> = [
      { prefix: 'x:a_b:', stays: ['x:aXb:u:1'] },
      { prefix: 'x:100%:', stays: ['x:1000:u:1', 'x:100:u:1'] },
      { prefix: 'x:b.c:', stays: ['x:bXc:u:1'] },
      { prefix: 'x:d*:', stays: ['x:ddd:u:1'] },
      { prefix: 'x:e+:', stays: ['x:eee:u:1'] },
      { prefix: 'x:f?:', stays: ['x:f:u:1'] },
      { prefix: 'x:(g):', stays: ['x:g:u:1'] },
      { prefix: 'x:[hi]:', stays: ['x:h:u:1', 'x:i:u:1'] },
      { prefix: 'x:j{2}:', stays: ['x:jj:u:1'] },
      { prefix: '^x:k:', stays: ['x:k:u:1'] },
      { prefix: 'x:l|m:', stays: ['x:lzz:u:1', 'x:zzm:u:1'] },
      { prefix: 'x:n\\d:', stays: ['x:n5:u:1'] },
      { prefix: 'x:\u00e7al\u0131\u015fan:', stays: ['x:calisan:u:1'] },
      { prefix: 'x:case:', stays: ['x:Case:u:1', 'X:case:u:1', 'x:CASE:u:1'] },
    ];
    const goes = (prefix: string) => `${prefix}u:1`;
    await db.replaceRagAclEntries(
      'km-f',
      { type: 'folder', id: 'fo-literal' },
      cases.flatMap(({ prefix, stays }) => [goes(prefix), ...stays]).map((principal) => aclEntry(principal)),
      'proj-1',
    );
    const principals = async () => sorted((await db.listRagAclEntries('km-f', {})).map((e) => e.principal));

    for (const { prefix } of cases) {
      expect(await db.deleteRagAclEntriesByPrincipalPrefix(prefix), prefix).toBe(1);
      expect(await principals(), prefix).not.toContain(goes(prefix));
    }
    // Everything that only looked like a match is still there.
    expect(await principals()).toEqual(sorted(cases.flatMap(({ stays }) => stays)));
  });

  it('removes the entries of the tenant it runs in and none of another tenant', async () => {
    const db = getDb();
    const otherDbName = `tenant_ragfld-other-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // SQLite's runWithTenant also re-binds the provider's fallback handle, so every access names its tenant.
    const inTenant = <T>(name: string, work: () => Promise<T>) => db.runWithTenant!(name, work);
    const seed = () =>
      db.replaceRagAclEntries('km-f', { type: 'folder', id: 'fo-1' }, [aclEntry('x:qdms:u:1'), aclEntry('user:u1')], 'proj-1');
    const principalsIn = (name: string) =>
      inTenant(name, async () => sorted((await db.listRagAclEntries('km-f', {})).map((e) => e.principal)));
    await inTenant(dbName, seed);
    await inTenant(otherDbName, seed);

    expect(await inTenant(otherDbName, () => db.deleteRagAclEntriesByPrincipalPrefix('x:qdms:'))).toBe(1);
    expect(await principalsIn(otherDbName)).toEqual(['user:u1']);
    expect(await principalsIn(dbName)).toEqual(['user:u1', 'x:qdms:u:1']);
  });

  it('indexes the new collections only; the existing ones keep theirs', async () => {
    const db = getDb();
    await db.createRagModule({
      tenantId, projectId: 'proj-1', key: 'km-f', name: 'km-f', embeddingModelKey: 'emb', vectorProviderKey: 'vec', vectorIndexKey: 'idx',
      chunkConfig: { strategy: 'recursive_character', chunkSize: 400, chunkOverlap: 40 }, status: 'active', createdBy: 'tester',
    });
    await db.createRagDocument({ tenantId, projectId: 'proj-1', ragModuleKey: 'km-f', fileName: 'a.txt', status: 'indexed', createdBy: 'tester' });
    await folder('Indexed');
    await db.replaceRagAclEntries('km-f', { type: 'module', id: 'km-f' }, [aclEntry('everyone')], 'proj-1');
    await db.upsertRagIdentityDomain({ tenantId, key: 'dom', kind: 'generic', label: 'Dom', userMatch: [] });
    await db.upsertRagIdentityUsers('dom', [{ tenantId, extId: 'u1' }]);
    await db.createRagIdentityLink({ tenantId, domain: 'dom', externalKind: 'user', externalId: 'u1', consoleKind: 'user', consoleId: 'c1' });

    const raw = rawTenantHandle(db);
    // MongoDB builds its manifest indexes when a tenant database is first bound; the collections only exist now, so run it again under a fresh label.
    if (typeof raw.collection === 'function') {
      await ensureTenantDbIndexes(raw as unknown as Parameters<typeof ensureTenantDbIndexes>[0], `${dbName}-reindexed`);
    }
    const sqlite = typeof raw.prepare === 'function';
    for (const [table, names] of Object.entries(accessIndexNames(sqlite))) {
      expect(await listTenantIndexNames(db, table), table).toEqual(expect.arrayContaining(names));
    }

    // The existing collections gained no index of this feature.
    const documentIndexes = await listTenantIndexNames(db, 'rag_documents');
    expect(documentIndexes.filter((name) => /folder|acl|access/i.test(name))).toEqual([]);
    const moduleIndexes = await listTenantIndexNames(db, 'rag_modules');
    expect(moduleIndexes.filter((name) => /folder|acl|access/i.test(name))).toEqual([]);
  });

  it('builds the indexes of the new collections with their first write, not at the next restart', async () => {
    const db = getDb();
    // No index pass of any kind in between: MongoDB's boot-time pass skipped these collections, they did not exist when the tenant database was bound.
    await folder('First');
    await db.replaceRagAclEntries('km-f', { type: 'module', id: 'km-f' }, [aclEntry('everyone')], 'proj-1');
    await db.upsertRagIdentityDomain({ tenantId, key: 'dom', kind: 'generic', label: 'Dom', userMatch: [] });
    await db.upsertRagIdentityUsers('dom', [{ tenantId, extId: 'u1' }]);
    await db.createRagIdentityLink({ tenantId, domain: 'dom', externalKind: 'user', externalId: 'u1', consoleKind: 'user', consoleId: 'c1' });

    const sqlite = typeof rawTenantHandle(db).prepare === 'function';
    for (const [table, names] of Object.entries(accessIndexNames(sqlite))) {
      expect(await listTenantIndexNames(db, table), table).toEqual(expect.arrayContaining(names));
    }
  });
});

describeForEachProvider('RAG access: identity directory', (getDb) => {
  let dbName: string;
  let tenantId: string;

  beforeEach(async () => {
    const slug = `ragidn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({
      companyName: 'RAG Identity Co', slug, dbName, licenseType: 'FREE', ownerId: 'pending',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  const defaultMatch = [
    { console: 'email' as const, external: 'email' as const },
    { console: 'email' as const, external: 'upn' as const },
  ];
  const domain = (key: string, over: Partial<Parameters<DatabaseProvider['upsertRagIdentityDomain']>[0]> = {}) =>
    getDb().upsertRagIdentityDomain({ tenantId, key, kind: 'entra', label: `Label ${key}`, userMatch: defaultMatch, ...over });
  const user = (extId: string, over: Partial<Parameters<DatabaseProvider['upsertRagIdentityUsers']>[1][number]> = {}) => ({
    tenantId,
    extId,
    ...over,
  });
  const link = (over: Partial<Parameters<DatabaseProvider['createRagIdentityLink']>[0]> = {}) =>
    getDb().createRagIdentityLink({
      tenantId,
      domain: 'dom',
      externalKind: 'user',
      externalId: 'ext-1',
      consoleKind: 'user',
      consoleId: 'cu-1',
      createdBy: 'tester',
      ...over,
    });
  const extIds = (users: Array<{ extId: string }>) => users.map((u) => u.extId);

  /** Make MongoDB build the manifest's indexes for the collections written so far (a no-op on SQLite). */
  const ensureMongoIndexes = async (label: string) => {
    const raw = rawTenantHandle(getDb());
    if (typeof raw.collection === 'function') {
      await ensureTenantDbIndexes(raw as unknown as Parameters<typeof ensureTenantDbIndexes>[0], `${dbName}-${label}`);
    }
  };

  // ── domains ─────────────────────────────────────────────────────────────

  it('creates a domain and lists the domains by key', async () => {
    const db = getDb();
    const created = await domain('c-conn-1', {
      kind: 'qdms',
      source: { kind: 'connector', connectorId: 'conn-1' },
      matchGroupsByExternalId: false,
      createdBy: 'maker',
      userMatch: [{ console: 'externalId', external: 'attr:employee-id' }, ...defaultMatch],
    });
    expect(created._id).toEqual(expect.any(String));
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
    expect(created).toMatchObject({
      tenantId, key: 'c-conn-1', kind: 'qdms', label: 'Label c-conn-1', createdBy: 'maker',
      source: { kind: 'connector', connectorId: 'conn-1' }, matchGroupsByExternalId: false,
    });
    expect(created.userMatch).toEqual([{ console: 'externalId', external: 'attr:employee-id' }, ...defaultMatch]);

    const plain = await domain('a-manual', { kind: 'generic' });
    expect(plain.source).toBeUndefined();
    expect(plain.matchGroupsByExternalId).toBeUndefined();
    expect(plain.createdBy).toBeUndefined();

    expect((await db.findRagIdentityDomain('c-conn-1'))?._id).toBe(created._id);
    expect(await db.findRagIdentityDomain('nope')).toBeNull();
    expect((await db.listRagIdentityDomains()).map((d) => d.key)).toEqual(['a-manual', 'c-conn-1']);
  });

  it('upserts a domain by key: keeps who made it and when, replaces the rest', async () => {
    const db = getDb();
    const first = await domain('dom-1', {
      createdBy: 'maker',
      updatedBy: 'maker',
      source: { kind: 'connector', connectorId: 'conn-1' },
      matchGroupsByExternalId: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await domain('dom-1', {
      kind: 'generic',
      label: 'Renamed',
      userMatch: [{ console: 'email', external: 'id' }],
      createdBy: 'somebody-else',
      updatedBy: 'editor',
    });
    expect(second._id).toBe(first._id);
    expect(second.createdAt?.toISOString()).toBe(first.createdAt?.toISOString());
    expect(second.createdBy).toBe('maker');
    expect(second.updatedBy).toBe('editor');
    expect(second.updatedAt!.getTime()).toBeGreaterThan(first.updatedAt!.getTime());
    expect(second).toMatchObject({ kind: 'generic', label: 'Renamed', userMatch: [{ console: 'email', external: 'id' }] });
    // What the second call left out is cleared...
    expect(second.source).toBeUndefined();
    expect(second.matchGroupsByExternalId).toBeUndefined();
    // ...except who edited last, which stays when no editor is named.
    const third = await domain('dom-1', { label: 'Again' });
    expect(third.updatedBy).toBe('editor');
    expect(third.label).toBe('Again');

    expect(await db.listRagIdentityDomains()).toHaveLength(1);
    const stored = await db.findRagIdentityDomain('dom-1');
    expect(stored).toMatchObject({ label: 'Again', createdBy: 'maker', updatedBy: 'editor' });
    expect(stored?.source).toBeUndefined();
  });

  it('keeps one row when the same domain is created at the same moment', async () => {
    const db = getDb();
    await domain('seed', {});
    await ensureMongoIndexes('race-domain');
    await Promise.all(Array.from({ length: 8 }, (_, i) => domain('racing', { label: `writer ${i}` })));
    expect((await db.listRagIdentityDomains()).filter((d) => d.key === 'racing')).toHaveLength(1);
  });

  it('deletes a domain together with its users and links, and nothing of another domain', async () => {
    const db = getDb();
    await domain('gone');
    await domain('stays');
    await db.upsertRagIdentityUsers('gone', [user('u1'), user('u2')]);
    await db.upsertRagIdentityUsers('stays', [user('u1'), user('u3')]);
    await link({ domain: 'gone', externalId: 'g1' });
    await link({ domain: 'gone', externalId: 'g2', externalKind: 'group', consoleKind: 'group', consoleId: 'cg-1' });
    await link({ domain: 'stays', externalId: 's1' });

    expect(await db.deleteRagIdentityDomain('gone')).toBe(true);
    expect(await db.findRagIdentityDomain('gone')).toBeNull();
    expect((await db.listRagIdentityUsers('gone')).total).toBe(0);
    expect(await db.listRagIdentityLinks({ domain: 'gone' })).toEqual([]);
    expect((await db.listRagIdentityDomains()).map((d) => d.key)).toEqual(['stays']);
    expect(extIds((await db.listRagIdentityUsers('stays')).users).sort()).toEqual(['u1', 'u3']);
    expect(await db.listRagIdentityLinks({ domain: 'stays' })).toHaveLength(1);

    expect(await db.deleteRagIdentityDomain('gone')).toBe(false);
  });

  // ── directory users ─────────────────────────────────────────────────────

  it('stores directory users with identity values lower-cased, and reports how many it wrote', async () => {
    const db = getDb();
    await domain('d1');
    const written = await db.upsertRagIdentityUsers('d1', [
      user('Ext-1', {
        email: '  Ada.Lovelace@Example.COM ',
        upn: 'ADA@Corp.Example',
        name: 'Ada Lovelace',
        type: 'member',
        groups: ['g-1', 'g-2', 'g-1'],
        attrs: { employeeId: 'E-0042 ', Department: 'R&D' },
        syncRunId: 'run-1',
        syncedAt: new Date('2026-03-04T05:06:07.000Z'),
      }),
      user('Ext-2', { email: '   ', upn: undefined, type: 'guest' }),
    ]);
    expect(written).toBe(2);

    const found = await db.findRagIdentityUsers('d1', 'extId', ['Ext-1']);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      _id: expect.any(String),
      tenantId,
      domain: 'd1',
      extId: 'Ext-1',
      email: 'ada.lovelace@example.com',
      upn: 'ada@corp.example',
      name: 'Ada Lovelace',
      type: 'member',
      groups: ['g-1', 'g-2'],
      attrs: { employeeId: 'e-0042', Department: 'r&d' },
      syncRunId: 'run-1',
    });
    expect(found[0].syncedAt?.toISOString()).toBe('2026-03-04T05:06:07.000Z');

    const [blank] = await db.findRagIdentityUsers('d1', 'extId', ['Ext-2']);
    expect(blank.email).toBeUndefined();
    expect(blank.upn).toBeUndefined();
    expect(blank.name).toBeUndefined();
    expect(blank.groups).toBeUndefined();
    expect(blank.attrs).toBeUndefined();
    expect(blank.syncRunId).toBeUndefined();
    expect(blank.type).toBe('guest');
    expect(blank.syncedAt).toBeInstanceOf(Date);
  });

  it('writes a user once however often it is reported, replacing what was there', async () => {
    const db = getDb();
    await domain('d1');
    await domain('d2');
    await db.upsertRagIdentityUsers('d1', [
      user('u1', { email: 'one@example.com', upn: 'one@corp', name: 'One', type: 'member', groups: ['g'], attrs: { a: '1' }, syncRunId: 'r1' }),
    ]);
    const [before] = await db.findRagIdentityUsers('d1', 'extId', ['u1']);

    // Reported again with less: the missing fields are cleared, the row is the same row.
    const written = await db.upsertRagIdentityUsers('d1', [user('u1', { email: 'NEW@example.com' })]);
    expect(written).toBe(1);
    const [after] = await db.findRagIdentityUsers('d1', 'extId', ['u1']);
    expect(after._id).toBe(before._id);
    expect(after.email).toBe('new@example.com');
    for (const field of ['upn', 'name', 'type', 'groups', 'attrs', 'syncRunId'] as const) {
      expect(after[field], field).toBeUndefined();
    }
    expect((await db.listRagIdentityUsers('d1')).total).toBe(1);
    expect(await db.findRagIdentityUsers('d1', 'email', ['one@example.com'])).toEqual([]);

    // Twice in one batch: one row (the last one), counted once. A user without an id is skipped.
    const batch = await db.upsertRagIdentityUsers('d1', [
      user('dup', { name: 'first' }),
      user('other', { name: 'other' }),
      user('dup', { name: 'last' }),
      user('', { name: 'no id' }),
    ]);
    expect(batch).toBe(2);
    expect((await db.findRagIdentityUsers('d1', 'extId', ['dup']))[0].name).toBe('last');
    expect((await db.listRagIdentityUsers('d1')).total).toBe(3);
    expect(await db.upsertRagIdentityUsers('d1', [])).toBe(0);

    // The same external id in another domain is another user.
    await db.upsertRagIdentityUsers('d2', [user('u1', { name: 'in d2' })]);
    expect((await db.findRagIdentityUsers('d1', 'extId', ['u1']))[0].email).toBe('new@example.com');
    expect((await db.findRagIdentityUsers('d2', 'extId', ['u1']))[0].name).toBe('in d2');
  });

  it('drops attribute names that could never be looked up, and attribute values that are empty', async () => {
    const db = getDb();
    await db.upsertRagIdentityUsers('d1', [
      user('u1', { attrs: { fine: 'Yes', 'has space': 'x', $dollar: 'x', '': 'x', [`${'n'.repeat(65)}`]: 'x', empty: '  ', 'dotted.name': 'D', 'dash-name': 'H' } }),
    ]);
    const [stored] = await db.findRagIdentityUsers('d1', 'extId', ['u1']);
    expect(stored.attrs).toEqual({ fine: 'yes', 'dotted.name': 'd', 'dash-name': 'h' });
  });

  it('finds users by external id (exact) or by e-mail, UPN or an attribute (compared lower-cased)', async () => {
    const db = getDb();
    await db.upsertRagIdentityUsers('d1', [
      user('Ext-A', { email: 'a@example.com', upn: 'a@corp.example', attrs: { employeeId: 'E-1', 'ext.sap.id': 'SAP-9', 'cost-center': 'CC-1' } }),
      user('Ext-B', { email: 'b@example.com', upn: 'b@corp.example', attrs: { employeeId: 'E-2' } }),
      user('Ext-C', { email: 'c@example.com', attrs: { employeeId: 'E-1' } }),
    ]);
    await db.upsertRagIdentityUsers('d2', [user('Ext-A', { email: 'a@example.com' })]);
    const find = async (field: Parameters<DatabaseProvider['findRagIdentityUsers']>[1], values: string[]) =>
      extIds(await db.findRagIdentityUsers('d1', field, values));

    expect(await find('extId', ['Ext-B'])).toEqual(['Ext-B']);
    expect(await find('extId', ['ext-b'])).toEqual([]);
    expect(await find('extId', ['Ext-C', 'Ext-A', 'nope'])).toEqual(['Ext-A', 'Ext-C']);

    expect(await find('email', ['A@Example.COM'])).toEqual(['Ext-A']);
    expect(await find('email', ['a@example.com', ' B@EXAMPLE.com '])).toEqual(['Ext-A', 'Ext-B']);
    expect(await find('email', ['unknown@example.com'])).toEqual([]);
    expect(await find('upn', ['B@CORP.EXAMPLE'])).toEqual(['Ext-B']);
    expect(await find('upn', ['c@corp.example'])).toEqual([]);

    expect(await find('attr:employeeId', ['e-1'])).toEqual(['Ext-A', 'Ext-C']);
    expect(await find('attr:employeeId', ['E-2', 'nope'])).toEqual(['Ext-B']);
    expect(await find('attr:cost-center', ['cc-1'])).toEqual(['Ext-A']);
    expect(await find('attr:ext.sap.id', ['sap-9'])).toEqual(['Ext-A']);
    expect(await find('attr:ext.sap', ['sap-9'])).toEqual([]);
    expect(await find('attr:notThere', ['e-1'])).toEqual([]);
    expect(await find('attr:employeeId', ['E-3'])).toEqual([]);

    // Names outside the lookup alphabet match nothing - and are never put into a query.
    for (const field of ['attr:', 'attr:has space', 'attr:$where', 'attr:a"b', "attr:x') OR 1=1 --", 'attr:..', `attr:${'n'.repeat(65)}`, 'attr:a/b']) {
      expect(await find(field as `attr:${string}`, ['e-1', 'a@example.com']), field).toEqual([]);
    }
    // Nothing to look for.
    expect(await find('email', [])).toEqual([]);
    expect(await find('email', ['', '   '])).toEqual([]);
    expect(await find('extId', [''])).toEqual([]);
    // Another domain's user with the same id / e-mail is not found here, and an unknown domain has none.
    expect(extIds(await db.findRagIdentityUsers('d2', 'email', ['a@example.com']))).toEqual(['Ext-A']);
    expect(await db.findRagIdentityUsers('d3', 'email', ['a@example.com'])).toEqual([]);

    // A long value list is one parameter.
    const many = [...Array.from({ length: 4000 }, (_, i) => `ghost${i}@example.com`), 'c@example.com'];
    expect(await find('email', many)).toEqual(['Ext-C']);
  });

  it('lists a domain\'s users by e-mail then id, searches e-mail, UPN and name, and pages', async () => {
    const db = getDb();
    await db.upsertRagIdentityUsers('d1', [
      user('u1', { email: 'Ada.Lovelace@Example.com', upn: 'ada@corp.example', name: 'Ada Lovelace' }),
      user('u2', { email: 'grace@example.com', name: 'Grace Hopper', type: 'guest' }),
      user('u3', { upn: 'ismail@corp.example', name: 'İsmail Yılmaz' }),
      user('u4', { email: 'a.b@example.com', name: 'a.b (c) test' }),
      user('u5', { email: 'pct@example.com', name: '100%_done' }),
      user('u6', { email: 'axb@example.com', name: 'AXB' }),
      user('u0', {}),
    ]);
    await db.upsertRagIdentityUsers('d2', [user('other', { email: 'ada@other.example', name: 'Ada Other' })]);
    const search = async (term: string) => extIds((await db.listRagIdentityUsers('d1', { search: term })).users);

    // No e-mail first, then by e-mail (lower-cased on write), ties by id.
    const all = await db.listRagIdentityUsers('d1');
    expect(all.total).toBe(7);
    expect(extIds(all.users)).toEqual(['u0', 'u3', 'u4', 'u1', 'u6', 'u2', 'u5']);
    expect(all.users[3]).toMatchObject({ extId: 'u1', email: 'ada.lovelace@example.com', name: 'Ada Lovelace', domain: 'd1' });

    expect(await search('lovelace')).toEqual(['u1']);
    expect(await search('ADA')).toEqual(['u1']);
    expect(await search('  grace  ')).toEqual(['u2']);
    expect(await search('CORP.EXAMPLE')).toEqual(['u3', 'u1']);
    // Search covers the name as well as the address, and folds the Turkish i family.
    expect(await search('yilmaz')).toEqual(['u3']);
    expect(await search('YILMAZ')).toEqual(['u3']);
    expect(await search('yılmaz')).toEqual(['u3']);
    expect(await search('ISMAIL')).toEqual(['u3']);
    // Characters that are special to a regular expression or to LIKE are taken literally.
    expect(await search('a.b')).toEqual(['u4']);
    expect(await search('(c)')).toEqual(['u4']);
    expect(await search('.*')).toEqual([]);
    expect(await search('100%')).toEqual(['u5']);
    expect(await search('%')).toEqual(['u5']);
    expect(await search('_done')).toEqual(['u5']);
    expect(await search('_')).toEqual(['u5']);
    expect(await search('\\')).toEqual([]);
    expect(await search('nobody-by-this-name')).toEqual([]);
    // A blank search is no search.
    expect((await db.listRagIdentityUsers('d1', { search: '   ' })).total).toBe(7);
    expect((await db.listRagIdentityUsers('d1', { search: 'ada' })).total).toBe(1);
    expect((await db.listRagIdentityUsers('d1', { search: 'nobody-by-this-name' }))).toEqual({ users: [], total: 0 });

    // Paging keeps the total of the whole match.
    const page = await db.listRagIdentityUsers('d1', { limit: 3, offset: 2 });
    expect(extIds(page.users)).toEqual(['u4', 'u1', 'u6']);
    expect(page.total).toBe(7);
    expect(extIds((await db.listRagIdentityUsers('d1', { limit: 3, offset: 6 })).users)).toEqual(['u5']);
    expect((await db.listRagIdentityUsers('d1', { limit: 3, offset: 60 })).users).toEqual([]);
    expect((await db.listRagIdentityUsers('d1', { limit: 0 }))).toEqual({ users: [], total: 7 });
    expect((await db.listRagIdentityUsers('d3'))).toEqual({ users: [], total: 0 });
  });

  it('pages 50 users by default and never more than 200, and writes a large sync in one call', async () => {
    const db = getDb();
    const count = 2450;
    const users = Array.from({ length: count }, (_, i) => user(`bulk-${String(i).padStart(4, '0')}`, {
      email: `bulk${String(i).padStart(4, '0')}@example.com`,
      name: i % 2 === 0 ? 'Even Person' : 'Odd Person',
      groups: ['g-all'],
    }));
    expect(await db.upsertRagIdentityUsers('big', users)).toBe(count);
    // A second sync of the same users updates them in place.
    expect(await db.upsertRagIdentityUsers('big', users.slice(0, 1500))).toBe(1500);

    const defaultPage = await db.listRagIdentityUsers('big');
    expect(defaultPage.users).toHaveLength(50);
    expect(defaultPage.total).toBe(count);
    expect(defaultPage.users[0].email).toBe('bulk0000@example.com');
    expect((await db.listRagIdentityUsers('big', { limit: 1000 })).users).toHaveLength(200);
    expect((await db.listRagIdentityUsers('big', { limit: 7 })).users).toHaveLength(7);
    expect((await db.listRagIdentityUsers('big', { limit: -5 })).users).toEqual([]);
    expect(extIds((await db.listRagIdentityUsers('big', { limit: 5, offset: 2445 })).users)).toEqual([
      'bulk-2445', 'bulk-2446', 'bulk-2447', 'bulk-2448', 'bulk-2449',
    ]);
    expect((await db.listRagIdentityUsers('big', { search: 'even', limit: 1 })).total).toBe(count / 2);
    expect(extIds(await db.findRagIdentityUsers('big', 'extId', ['bulk-0999', 'bulk-2000']))).toEqual(['bulk-0999', 'bulk-2000']);
  });

  it('prunes the users a later sync run did not report, including those without a run', async () => {
    const db = getDb();
    await db.upsertRagIdentityUsers('d1', [user('A', { syncRunId: 'r1' }), user('B', { syncRunId: 'r1' })]);
    await db.upsertRagIdentityUsers('d1', [user('B', { syncRunId: 'r2' }), user('C', { syncRunId: 'r2' })]);
    await db.upsertRagIdentityUsers('d1', [user('D')]);
    await db.upsertRagIdentityUsers('d2', [user('A', { syncRunId: 'r1' }), user('Z')]);

    expect(await db.pruneRagIdentityUsers('d1', 'r2')).toBe(2);
    expect(extIds((await db.listRagIdentityUsers('d1')).users).sort()).toEqual(['B', 'C']);
    // Nothing left to prune; another domain was never touched.
    expect(await db.pruneRagIdentityUsers('d1', 'r2')).toBe(0);
    expect((await db.listRagIdentityUsers('d2')).total).toBe(2);
    // A run id nobody has removes everything of that domain.
    expect(await db.pruneRagIdentityUsers('d1', 'r-never')).toBe(2);
    expect((await db.listRagIdentityUsers('d1')).total).toBe(0);
    expect(await db.pruneRagIdentityUsers('d3', 'r1')).toBe(0);
  });

  it('keeps one row per user when two syncs write the same new users at the same moment', async () => {
    const db = getDb();
    const users = Array.from({ length: 5 }, (_, i) => user(`race-${i}`, { email: `race${i}@example.com` }));
    await db.upsertRagIdentityUsers('seed', [user('first')]);
    await ensureMongoIndexes('race-users');
    const counts = await Promise.all(Array.from({ length: 8 }, () => db.upsertRagIdentityUsers('race', users)));
    expect(counts).toEqual(Array(8).fill(5));
    expect((await db.listRagIdentityUsers('race')).total).toBe(5);
  });

  it('refuses a second row for the same user or domain key at the storage level', async () => {
    const db = getDb();
    await domain('dup');
    await db.upsertRagIdentityUsers('dup', [user('u1')]);
    await ensureMongoIndexes('unique');
    const raw = rawTenantHandle(db);
    const now = new Date();
    if (typeof raw.collection === 'function') {
      await expect(raw.collection('rag_identity_users').insertOne({ tenantId, domain: 'dup', extId: 'u1', syncedAt: now })).rejects.toThrow(/duplicate key/i);
      await expect(raw.collection('rag_identity_domains').insertOne({ tenantId, key: 'dup', kind: 'generic', label: 'x', userMatch: [], createdAt: now, updatedAt: now })).rejects.toThrow(/duplicate key/i);
    } else {
      expect(() => raw.prepare!(`INSERT INTO rag_identity_users (id, tenantId, domain, extId, syncedAt) VALUES ('dup-user', @tenantId, 'dup', 'u1', @now)`).run({ tenantId, now: now.toISOString() })).toThrow(/UNIQUE/);
      expect(() => raw.prepare!(`INSERT INTO rag_identity_domains (id, tenantId, key, kind, label, createdAt, updatedAt) VALUES ('dup-dom', @tenantId, 'dup', 'generic', 'x', @now, @now)`).run({ tenantId, now: now.toISOString() })).toThrow(/UNIQUE/);
    }
    expect((await db.listRagIdentityUsers('dup')).total).toBe(1);
  });

  // ── the very first writes ───────────────────────────────────────────────
  // MongoDB's boot-time index pass skips a collection that does not exist yet, so none of these
  // runs a manifest pass: the first write itself has to bring the unique keys.

  it('keeps one row when the same domain is created at the same moment for the first time', async () => {
    const db = getDb();
    await Promise.all(Array.from({ length: 8 }, (_, i) => domain('racing', { label: `writer ${i}` })));
    expect((await db.listRagIdentityDomains()).filter((d) => d.key === 'racing')).toHaveLength(1);
  });

  it('keeps one row per user when two syncs write the same new users at the same moment for the first time', async () => {
    const db = getDb();
    const users = Array.from({ length: 5 }, (_, i) => user(`first-${i}`, { email: `first${i}@example.com` }));
    const counts = await Promise.all(Array.from({ length: 8 }, () => db.upsertRagIdentityUsers('first', users)));
    expect(counts).toEqual(Array(8).fill(5));
    expect((await db.listRagIdentityUsers('first')).total).toBe(5);
  });

  it('refuses a second row for the same user or domain key right after the first write', async () => {
    const db = getDb();
    await domain('dup');
    await db.upsertRagIdentityUsers('dup', [user('u1')]);
    const raw = rawTenantHandle(db);
    // SQLite's schema carries its unique indexes from the start; this one is MongoDB's to prove.
    if (typeof raw.collection !== 'function') return;
    const now = new Date();
    await expect(raw.collection('rag_identity_users').insertOne({ tenantId, domain: 'dup', extId: 'u1', syncedAt: now })).rejects.toThrow(/duplicate key/i);
    await expect(raw.collection('rag_identity_domains').insertOne({ tenantId, key: 'dup', kind: 'generic', label: 'x', userMatch: [], createdAt: now, updatedAt: now })).rejects.toThrow(/duplicate key/i);
    expect((await db.listRagIdentityUsers('dup')).total).toBe(1);
  });

  // ── links ───────────────────────────────────────────────────────────────

  it('creates a link once per pair, lists them by domain, console kind and console ids, and deletes by id', async () => {
    const db = getDb();
    const first = await link();
    expect(first._id).toEqual(expect.any(String));
    expect(first.createdAt).toBeInstanceOf(Date);
    expect(first).toMatchObject({ tenantId, domain: 'dom', externalKind: 'user', externalId: 'ext-1', consoleKind: 'user', consoleId: 'cu-1', createdBy: 'tester' });

    // The same pair again answers with the first link (a duplicate would outlive the unlinking of the other).
    const again = await link({ createdBy: 'someone-else' });
    expect(again._id).toBe(first._id);
    expect(again.createdBy).toBe('tester');
    expect(await db.listRagIdentityLinks()).toHaveLength(1);

    const group = await link({ externalKind: 'group', externalId: 'grp-1', consoleKind: 'group', consoleId: 'cg-1' });
    const second = await link({ externalId: 'ext-2', consoleId: 'cu-2' });
    const otherDomain = await link({ domain: 'dom-2', externalId: 'ext-1', consoleId: 'cu-1' });
    // Same console user for another external user is a different link.
    const sameConsole = await link({ externalId: 'ext-3', consoleId: 'cu-1' });

    expect((await db.listRagIdentityLinks()).map((l) => l._id)).toEqual([first._id, group._id, second._id, otherDomain._id, sameConsole._id]);
    expect((await db.listRagIdentityLinks({ domain: 'dom' })).map((l) => l._id)).toEqual([first._id, group._id, second._id, sameConsole._id]);
    expect((await db.listRagIdentityLinks({ domain: 'dom-2' })).map((l) => l._id)).toEqual([otherDomain._id]);
    expect((await db.listRagIdentityLinks({ consoleKind: 'group' })).map((l) => l._id)).toEqual([group._id]);
    expect((await db.listRagIdentityLinks({ consoleKind: 'user', consoleIds: ['cu-1'] })).map((l) => l._id)).toEqual([first._id, otherDomain._id, sameConsole._id]);
    expect((await db.listRagIdentityLinks({ consoleIds: ['cu-2', 'cg-1', 'nobody'] })).map((l) => l._id)).toEqual([group._id, second._id]);
    expect(await db.listRagIdentityLinks({ consoleIds: [] })).toEqual([]);
    expect((await db.listRagIdentityLinks({ domain: 'dom', consoleKind: 'user', consoleIds: ['cu-1'] })).map((l) => l._id)).toEqual([first._id, sameConsole._id]);
    expect(await db.listRagIdentityLinks({ domain: 'nope' })).toEqual([]);
    const many = [...Array.from({ length: 5000 }, (_, i) => `ghost-${i}`), 'cg-1'];
    expect((await db.listRagIdentityLinks({ consoleIds: many })).map((l) => l._id)).toEqual([group._id]);

    expect(await db.deleteRagIdentityLink(String(first._id))).toBe(true);
    expect(await db.deleteRagIdentityLink(String(first._id))).toBe(false);
    expect(await db.deleteRagIdentityLink(fakeId(404))).toBe(false);
    expect(await db.deleteRagIdentityLink('not-an-id')).toBe(false);
    // After the unlink nothing of that pair is left.
    expect((await db.listRagIdentityLinks({ domain: 'dom', consoleIds: ['cu-1'] })).map((l) => l._id)).toEqual([sameConsole._id]);
    // And the pair can be linked afresh.
    const relinked = await link();
    expect(relinked._id).not.toBe(first._id);
  });

  it('two requests that link the same pair at the same moment leave one link', async () => {
    const db = getDb();
    const [a, b, c] = await Promise.all([link(), link({ createdBy: 'twin' }), link({ createdBy: 'triplet' })]);
    expect(new Set([a._id, b._id, c._id]).size).toBe(1);
    expect(await db.listRagIdentityLinks({ domain: 'dom' })).toHaveLength(1);
    // So unlinking it once leaves nothing that still grants.
    expect(await db.deleteRagIdentityLink(String(a._id))).toBe(true);
    expect(await db.listRagIdentityLinks({ domain: 'dom' })).toEqual([]);
  });
});

// ── MongoDB only: the indexes of a collection that its first write creates ─────────
// Against a plain `Db` double, no server: what `ensureTenantCollectionIndexes` asks the store for, and how often.

describe('MongoDB index manifest: collections created by their first write', () => {
  type IndexCall = { collection: string; name: string | undefined; unique: boolean; key: unknown };

  /** The memo behind `ensureTenantCollectionIndexes` is process-wide and keyed by database name, so every double gets a name of its own. */
  const fakeTenantDb = (options: { delayMs?: number } = {}) => {
    const calls: IndexCall[] = [];
    /** Names of the indexes the double refuses to build. */
    const failing = new Set<string>();
    const db = {
      databaseName: `fake_tenant_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      collection: (collection: string) => ({
        createIndex: async (key: unknown, indexOptions: { name?: string; unique?: boolean }) => {
          calls.push({ collection, name: indexOptions.name, unique: indexOptions.unique === true, key });
          if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
          if (indexOptions.name && failing.has(indexOptions.name)) throw new Error(`cannot build ${indexOptions.name}`);
          return indexOptions.name;
        },
      }),
    };
    return { db: db as unknown as Parameters<typeof ensureTenantCollectionIndexes>[0], calls, failing };
  };

  const accessCollections: Array<[string, Array<[name: string, unique: boolean]>]> = [
    ['rag_folders', [['idx_module_parent', false], ['idx_module_source', false]]],
    ['rag_acl_entries', [['idx_module_principal', false], ['idx_module_node', false]]],
    ['rag_identity_domains', [['idx_key', true]]],
    ['rag_identity_users', [['idx_domain_extId', true], ['idx_domain_email', false], ['idx_domain_upn', false]]],
    ['rag_identity_links', [['idx_console', false], ['idx_domain_external', false], ['idx_link_pair', true]]],
  ];

  it.each(accessCollections)('builds the manifest\'s indexes of %s, the unique ones unique', async (collection, expected) => {
    const { db, calls } = fakeTenantDb();
    await ensureTenantCollectionIndexes(db, collection);
    expect(calls.map((call) => [call.name, call.unique])).toEqual(expected);
    expect(calls.every((call) => call.collection === collection)).toBe(true);
    // The specs are the manifest's own, so a restart's pass and the first write can never disagree.
    expect(calls.map((call) => call.key)).toEqual(TENANT_DB_INDEXES[collection].map((index) => index.key));
  });

  it('builds a collection once per database, however often it is written', async () => {
    const { db, calls } = fakeTenantDb();
    await ensureTenantCollectionIndexes(db, 'rag_identity_domains');
    await ensureTenantCollectionIndexes(db, 'rag_identity_domains');
    expect(calls).toHaveLength(1);
    // Another collection of the same database, and the same collection of another database, each get their own turn.
    await ensureTenantCollectionIndexes(db, 'rag_identity_links');
    expect(calls).toHaveLength(4);
    const other = fakeTenantDb();
    await ensureTenantCollectionIndexes(other.db, 'rag_identity_domains');
    expect(other.calls).toHaveLength(1);
  });

  it('lets writers that start together share one build', async () => {
    const { db, calls } = fakeTenantDb({ delayMs: 10 });
    await Promise.all(Array.from({ length: 6 }, () => ensureTenantCollectionIndexes(db, 'rag_identity_users')));
    expect(calls).toHaveLength(3);
  });

  it('does not reject when an index fails, still tries the rest, and asks again at the next write', async () => {
    const { db, calls, failing } = fakeTenantDb();
    failing.add('idx_domain_extId');
    await expect(ensureTenantCollectionIndexes(db, 'rag_identity_users')).resolves.toBeUndefined();
    // The unique one failed and the two behind it were still tried...
    expect(calls.map((call) => call.name)).toEqual(['idx_domain_extId', 'idx_domain_email', 'idx_domain_upn']);
    // ...and nothing was remembered: the next write asks again, and once the store accepts it that is done for good.
    failing.clear();
    await ensureTenantCollectionIndexes(db, 'rag_identity_users');
    expect(calls).toHaveLength(6);
    await ensureTenantCollectionIndexes(db, 'rag_identity_users');
    expect(calls).toHaveLength(6);
  });

  it('leaves a collection the manifest does not list alone', async () => {
    const { db, calls } = fakeTenantDb();
    await ensureTenantCollectionIndexes(db, 'not_in_the_manifest');
    expect(calls).toEqual([]);
  });
});

// ── SQLite only: a tenant database made before access control existed ───────────

describe('SQLite migration: RAG access control columns', () => {
  it('adds the new columns to existing tables, keeps the old rows readable, and accepts new writes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cognipeer-rag-acl-migration-'));
    const tenantDb = 'tenant_pre_acl';
    try {
      // A tenant database as an earlier version left it: the new columns do not exist.
      const before = new SQLiteProvider(dir, 'migration_main');
      await before.connect();
      await before.switchToTenant(tenantDb);
      const legacyTenant = (before as unknown as { getTenantDb(): { exec(sql: string): void; prepare(sql: string): { run(p?: Record<string, unknown>): unknown; all(): Array<Record<string, unknown>> } } }).getTenantDb();
      await before.createRagModule({
        tenantId: 't1', projectId: 'p1', key: 'km-old', name: 'Old', embeddingModelKey: 'e', vectorProviderKey: 'v', vectorIndexKey: 'i',
        chunkConfig: { strategy: 'recursive_character', chunkSize: 400, chunkOverlap: 40 }, status: 'active', createdBy: 'tester',
      });
      await before.createRagDocument({ tenantId: 't1', projectId: 'p1', ragModuleKey: 'km-old', fileName: 'old.txt', status: 'indexed', createdBy: 'tester' });
      for (const column of ['access', 'aclRevision']) legacyTenant.exec(`ALTER TABLE rag_modules DROP COLUMN ${column}`);
      for (const column of ['folderId', 'aclMode', 'aclManaged']) legacyTenant.exec(`ALTER TABLE rag_documents DROP COLUMN ${column}`);
      const columns = (table: string) => legacyTenant.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name));
      expect(columns('rag_modules')).not.toContain('access');
      expect(columns('rag_documents')).not.toContain('folderId');
      await before.disconnect();

      // The new version opens it: the columns come back, nothing is rewritten.
      const after = new SQLiteProvider(dir, 'migration_main');
      await after.connect();
      await after.switchToTenant(tenantDb);
      const upgraded = (after as unknown as { getTenantDb(): { prepare(sql: string): { all(): Array<Record<string, unknown>> } } }).getTenantDb();
      const upgradedColumns = (table: string) => upgraded.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name));
      expect(upgradedColumns('rag_modules')).toEqual(expect.arrayContaining(['access', 'aclRevision']));
      expect(upgradedColumns('rag_documents')).toEqual(expect.arrayContaining(['folderId', 'aclMode', 'aclManaged']));

      const oldModule = await after.findRagModuleByKey('km-old', 'p1');
      expect(oldModule?.name).toBe('Old');
      expect(oldModule?.access).toBeUndefined();
      expect(oldModule?.aclRevision).toBeUndefined();
      const [oldDocument] = await after.listRagDocuments('km-old', { projectId: 'p1' });
      expect(oldDocument.fileName).toBe('old.txt');
      expect(oldDocument.folderId).toBeUndefined();
      expect(oldDocument.aclMode).toBeUndefined();
      expect(await after.countRagDocuments('km-old', 'p1', { folderId: null })).toBe(1);
      expect(await after.countRagDocuments('km-old', 'p1', { access: { ownAllowedIds: [], inheritFolderIds: [], includeTopLevel: true } })).toBe(1);

      // And the old rows take the new fields.
      const turnedOn = await after.updateRagModule(String(oldModule?._id), { access: { enabled: true } });
      expect(turnedOn?.access).toEqual({ enabled: true });
      await after.bumpRagModuleAclRevision('km-old', 'p1');
      expect((await after.findRagModuleByKey('km-old', 'p1'))?.aclRevision).toBe(1);
      const moved = await after.updateRagDocument(String(oldDocument._id), { folderId: 'f1', aclMode: 'own' });
      expect(moved).toMatchObject({ folderId: 'f1', aclMode: 'own' });
      await after.disconnect();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
