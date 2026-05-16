/**
 * Integration tests — SQLite Database Provider
 *
 * Runs against a real temp-directory SQLite database. Tests the core
 * mixin operations: tenant CRUD, user CRUD, project CRUD, model CRUD,
 * API tokens, provider configs, and switchToTenant lifecycle.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { hashApiToken } from '@/lib/services/apiTokens/tokenHashing';

let db: SQLiteProvider;
let tmpDir: string;

const TEST_TENANT_SLUG = 'test-company';
const TEST_DB_NAME = `tenant_${TEST_TENANT_SLUG}`;
let tenantId: string;
let userId: string;
let projectId: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-console-sqlite-test-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
});

afterAll(async () => {
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Connection lifecycle ──────────────────────────────────────────────────

describe('Connection lifecycle', () => {
  it('connects successfully', () => {
    expect(db.getMainDbHandle()).not.toBeNull();
  });

  it('health check works', () => {
    const handle = db.getMainDbHandle()!;
    const result = handle.prepare('SELECT 1 as ok').get() as { ok: number };
    expect(result.ok).toBe(1);
  });
});

// ── Tenant operations ─────────────────────────────────────────────────────

describe('Tenant CRUD', () => {
  it('creates a tenant', async () => {
    const tenant = await db.createTenant({
      companyName: 'Test Company',
      slug: TEST_TENANT_SLUG,
      dbName: TEST_DB_NAME,
      licenseType: 'FREE',
      ownerId: 'owner-placeholder',
    });

    expect(tenant._id).toBeTruthy();
    expect(tenant.slug).toBe(TEST_TENANT_SLUG);
    expect(tenant.companyName).toBe('Test Company');
    expect(tenant.licenseType).toBe('FREE');
    tenantId = tenant._id as string;
  });

  it('finds a tenant by slug', async () => {
    const tenant = await db.findTenantBySlug(TEST_TENANT_SLUG);
    expect(tenant).not.toBeNull();
    expect(tenant!._id).toBe(tenantId);
  });

  it('finds a tenant by id', async () => {
    const tenant = await db.findTenantById(tenantId);
    expect(tenant).not.toBeNull();
    expect(tenant!.slug).toBe(TEST_TENANT_SLUG);
  });

  it('lists tenants', async () => {
    const tenants = await db.listTenants();
    expect(tenants.length).toBeGreaterThanOrEqual(1);
    const found = tenants.find((t) => t.slug === TEST_TENANT_SLUG);
    expect(found).toBeDefined();
  });

  it('updates a tenant', async () => {
    const updated = await db.updateTenant(tenantId, {
      companyName: 'Updated Company',
    });
    expect(updated).not.toBeNull();
    expect(updated!.companyName).toBe('Updated Company');
  });

  it('returns null for non-existent slug', async () => {
    const tenant = await db.findTenantBySlug('nonexistent');
    expect(tenant).toBeNull();
  });
});

// ── Tenant switching ──────────────────────────────────────────────────────

describe('Tenant switching', () => {
  it('switches to tenant database', async () => {
    await db.switchToTenant(TEST_DB_NAME);
    // No error means success
  });

  it('throws without connect', async () => {
    const db2 = new SQLiteProvider(tmpDir, 'other_main');
    await expect(db2.switchToTenant('some_db')).rejects.toThrow(
      /not connected/i,
    );
  });
});

// ── User operations (requires switchToTenant) ─────────────────────────────

describe('User CRUD', () => {
  it('creates a user', async () => {
    await db.switchToTenant(TEST_DB_NAME);

    const user = await db.createUser({
      email: 'admin@test.com',
      password: 'hashed-pw-123',
      name: 'Admin User',
      role: 'owner',
      tenantId,
      licenseId: 'free',
    });

    expect(user._id).toBeTruthy();
    expect(user.email).toBe('admin@test.com');
    expect(user.role).toBe('owner');
    userId = user._id as string;
  });

  it('finds user by email', async () => {
    const user = await db.findUserByEmail('admin@test.com');
    expect(user).not.toBeNull();
    expect(user!._id).toBe(userId);
  });

  it('finds user by id', async () => {
    const user = await db.findUserById(userId);
    expect(user).not.toBeNull();
    expect(user!.email).toBe('admin@test.com');
  });

  it('lists users', async () => {
    const users = await db.listUsers();
    expect(users.length).toBeGreaterThanOrEqual(1);
  });

  it('updates a user', async () => {
    const updated = await db.updateUser(userId, { name: 'Updated Admin' });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('Updated Admin');
  });

  it('updates user service permissions', async () => {
    const updated = await db.updateUser(userId, {
      servicePermissions: { models: 'read', audit: 'admin' },
    });
    expect(updated).not.toBeNull();
    expect(updated!.servicePermissions?.models).toBe('read');
    expect(updated!.servicePermissions?.audit).toBe('admin');

    const found = await db.findUserById(userId);
    expect(found?.servicePermissions?.models).toBe('read');
  });

  it('returns null for non-existent email', async () => {
    const user = await db.findUserByEmail('nobody@test.com');
    expect(user).toBeNull();
  });
});

// ── Audit log operations ─────────────────────────────────────────────────

describe('Audit logs', () => {
  it('creates and lists audit events', async () => {
    await db.switchToTenant(TEST_DB_NAME);

    const created = await db.createAuditLog({
      action: 'write',
      actorEmail: 'admin@test.com',
      actorRole: 'owner',
      actorType: 'user',
      actorUserId: userId,
      event: 'POST /api/projects',
      method: 'POST',
      outcome: 'success',
      path: '/api/projects',
      service: 'projects',
      statusCode: 201,
      tenantId,
    });

    expect(created._id).toBeTruthy();

    const logs = await db.listAuditLogs({ service: 'projects' });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].event).toBe('POST /api/projects');
  });
});

// ── Project operations ────────────────────────────────────────────────────

describe('Project CRUD', () => {
  it('creates a project', async () => {
    await db.switchToTenant(TEST_DB_NAME);

    const project = await db.createProject({
      key: 'default',
      name: 'Default Project',
      tenantId,
      createdBy: userId,
    });

    expect(project._id).toBeTruthy();
    expect(project.key).toBe('default');
    expect(project.name).toBe('Default Project');
    projectId = project._id as string;
  });

  it('finds project by key', async () => {
    const project = await db.findProjectByKey(tenantId, 'default');
    expect(project).not.toBeNull();
    expect(project!._id).toBe(projectId);
  });

  it('lists projects', async () => {
    const projects = await db.listProjects(tenantId);
    expect(projects.length).toBeGreaterThanOrEqual(1);
  });

  it('updates a project', async () => {
    const updated = await db.updateProject(projectId, {
      name: 'Renamed Project',
    });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('Renamed Project');
  });
});

// ── API Token operations ──────────────────────────────────────────────────

describe('API Token CRUD', () => {
  let tokenId: string;
  const rawToken = 'tk-test-123456';
  const tokenHash = hashApiToken(rawToken);

  it('creates an API token', async () => {
    await db.switchToTenant(TEST_DB_NAME);

    const token = await db.createApiToken({
      label: 'Test Token',
      tokenHash,
      tokenPrefix: rawToken.slice(0, 16),
      userId,
      tenantId,
      projectId,
    });

    expect(token._id).toBeTruthy();
    expect(token.label).toBe('Test Token');
    tokenId = token._id as string;
  });

  it('finds token by value', async () => {
    const token = await db.findApiTokenByHash(tokenHash);
    expect(token).not.toBeNull();
    expect(token!._id).toBe(tokenId);
  });

  it('lists project tokens', async () => {
    const tokens = await db.listProjectApiTokens(tenantId, projectId);
    expect(tokens.length).toBeGreaterThanOrEqual(1);
  });

  it('updates token last used', async () => {
    await db.updateTokenLastUsedByHash(tokenHash);
    // Just verify it doesn't throw
  });

  it('deletes a project token', async () => {
    const result = await db.deleteProjectApiToken(tokenId, tenantId, projectId);
    expect(result).toBe(true);

    const found = await db.findApiTokenByHash(tokenHash);
    expect(found).toBeNull();
  });
});

// ── Model operations ──────────────────────────────────────────────────────

describe('Model CRUD', () => {
  let modelId: string;

  it('creates a model', async () => {
    await db.switchToTenant(TEST_DB_NAME);

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

    expect(model._id).toBeTruthy();
    expect(model.key).toBe('gpt-4o');
    modelId = model._id as string;
  });

  it('finds model by key', async () => {
    const model = await db.findModelByKey('gpt-4o');
    expect(model).not.toBeNull();
    expect(model!._id).toBe(modelId);
  });

  it('lists models', async () => {
    const models = await db.listModels();
    expect(models.length).toBeGreaterThanOrEqual(1);
  });

  it('updates a model', async () => {
    const updated = await db.updateModel(modelId, { name: 'GPT-4o Updated' });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('GPT-4o Updated');
  });

  it('deletes a model', async () => {
    const result = await db.deleteModel(modelId);
    expect(result).toBe(true);

    const found = await db.findModelByKey('gpt-4o');
    expect(found).toBeNull();
  });
});

// ── Provider config operations ────────────────────────────────────────────

describe('Provider CRUD', () => {
  let providerKey: string;

  it('creates a provider', async () => {
    await db.switchToTenant(TEST_DB_NAME);

    const provider = await db.createProvider({
      key: 'my-openai',
      driver: 'openai',
      type: 'model',
      label: 'My OpenAI',
      tenantId,
      projectId,
      credentialsEnc: JSON.stringify({ apiKey: 'sk-test' }),
      settings: {},
      status: 'active',
      createdBy: userId,
    });

    expect(provider._id).toBeTruthy();
    expect(provider.key).toBe('my-openai');
    providerKey = provider.key;
  });

  it('finds provider by key', async () => {
    const provider = await db.findProviderByKey(tenantId, providerKey, projectId);
    expect(provider).not.toBeNull();
    expect(provider!.driver).toBe('openai');
  });

  it('lists providers', async () => {
    const providers = await db.listProviders(tenantId, { projectId });
    expect(providers.length).toBeGreaterThanOrEqual(1);
  });

  it('updates a provider', async () => {
    const provider = await db.findProviderByKey(tenantId, providerKey, projectId);
    const updated = await db.updateProvider(provider!._id as string, {
      label: 'Updated OpenAI',
    });
    expect(updated).not.toBeNull();
    expect(updated!.label).toBe('Updated OpenAI');
  });

  it('deletes a provider', async () => {
    const provider = await db.findProviderByKey(tenantId, providerKey, projectId);
    const result = await db.deleteProvider(provider!._id as string);
    expect(result).toBe(true);
  });
});

// ── Agent tracing operations ─────────────────────────────────────────────

describe('Agent tracing SQLite round-trip', () => {
  const tracingSessionId = 'trace-session-1';
  const tracingTraceId = '0123456789abcdef0123456789abcdef';
  const tracingRootSpanId = 'abcdef0123456789';
  const tracingEventId = 'evt_0002_test';
  const tracingSpanId = '1111222233334444';
  const tracingParentSpanId = tracingRootSpanId;

  it('persists session and event trace identifiers', async () => {
    await db.switchToTenant(TEST_DB_NAME);

    await db.createAgentTracingSession({
      sessionId: tracingSessionId,
      traceId: tracingTraceId,
      rootSpanId: tracingRootSpanId,
      threadId: 'thread-tracing-1',
      tenantId,
      projectId,
      source: 'custom',
      agent: { name: 'Trace Agent' },
      agentName: 'Trace Agent',
      summary: { eventCounts: { ai_call: 1 } },
      status: 'success',
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      totalEvents: 1,
      totalInputTokens: 21,
      totalOutputTokens: 13,
    });

    await db.updateAgentTracingSession(
      tracingSessionId,
      {
        traceId: tracingTraceId,
        rootSpanId: tracingRootSpanId,
        source: 'custom',
        endedAt: new Date('2026-01-01T00:00:02.000Z'),
      },
      projectId,
    );

    await db.createAgentTracingEvent({
      sessionId: tracingSessionId,
      traceId: tracingTraceId,
      spanId: tracingSpanId,
      parentSpanId: tracingParentSpanId,
      tenantId,
      projectId,
      id: tracingEventId,
      type: 'ai_call',
      label: 'Assistant Response #2',
      sequence: 2,
      timestamp: new Date('2026-01-01T00:00:01.000Z'),
      status: 'success',
      actor: { scope: 'agent', role: 'assistant' },
      sections: [{ kind: 'message', label: 'Assistant Message', role: 'assistant', content: 'ok' }],
      model: 'gpt-4o',
      inputTokens: 21,
      outputTokens: 13,
      totalTokens: 34,
    });

    const storedSession = await db.findAgentTracingSessionById(tracingSessionId, projectId);
    const storedEvents = await db.listAgentTracingEvents(tracingSessionId, projectId);

    expect(storedSession).not.toBeNull();
    expect(storedSession?.traceId).toBe(tracingTraceId);
    expect(storedSession?.rootSpanId).toBe(tracingRootSpanId);
    expect(storedSession?.source).toBe('custom');

    expect(storedEvents).toHaveLength(1);
    expect(storedEvents[0]?.id).toBe(tracingEventId);
    expect(storedEvents[0]?.type).toBe('ai_call');
    expect(storedEvents[0]?.traceId).toBe(tracingTraceId);
    expect(storedEvents[0]?.spanId).toBe(tracingSpanId);
    expect(storedEvents[0]?.parentSpanId).toBe(tracingParentSpanId);

    const aggregate = await db.aggregateAgentTracingDashboard(
      {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T23:59:59.999Z',
      },
      projectId,
    );

    expect(aggregate.analytics.totals.sessionsCount).toBe(1);
    expect(aggregate.analytics.totals.totalTokens).toBe(34);
    expect(aggregate.recentSessions[0]?.sessionId).toBe(tracingSessionId);
    expect(aggregate.recentAgents[0]?.name).toBe('Trace Agent');
  });
});

// ── Cross-tenant user directory ───────────────────────────────────────────

describe('Cross-tenant user directory', () => {
  it('registers a user in directory', async () => {
    await db.registerUserInDirectory({
      email: 'admin@test.com',
      tenantId,
      tenantSlug: TEST_TENANT_SLUG,
      tenantDbName: TEST_DB_NAME,
      tenantCompanyName: 'Test Company',
    });
    // No throw = success
  });

  it('lists tenants for user email', async () => {
    const tenants = await db.listTenantsForUser('admin@test.com');
    expect(tenants.length).toBeGreaterThanOrEqual(1);
    const found = tenants.find((t) => t.tenantId === tenantId);
    expect(found).toBeDefined();
    expect(found!.tenantSlug).toBe(TEST_TENANT_SLUG);
  });

  it('unregisters user from directory', async () => {
    await db.unregisterUserFromDirectory('admin@test.com', tenantId);
    const tenants = await db.listTenantsForUser('admin@test.com');
    const found = tenants.find((t) => t.tenantId === tenantId);
    expect(found).toBeUndefined();
  });
});

// ── Disconnect ────────────────────────────────────────────────────────────

describe('Disconnect', () => {
  it('disconnects cleanly', async () => {
    // Create a separate instance to test disconnect
    const db2 = new SQLiteProvider(tmpDir, 'disconnect_test');
    await db2.connect();
    await db2.disconnect();
    expect(db2.getMainDbHandle()).toBeNull();
  });
});
