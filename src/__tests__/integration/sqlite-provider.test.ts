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

  it('returns null for non-existent email', async () => {
    const user = await db.findUserByEmail('nobody@test.com');
    expect(user).toBeNull();
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

  it('creates an API token', async () => {
    await db.switchToTenant(TEST_DB_NAME);

    const token = await db.createApiToken({
      label: 'Test Token',
      token: 'tk-test-123456',
      userId,
      tenantId,
      projectId,
    });

    expect(token._id).toBeTruthy();
    expect(token.label).toBe('Test Token');
    tokenId = token._id as string;
  });

  it('finds token by value', async () => {
    const token = await db.findApiTokenByToken('tk-test-123456');
    expect(token).not.toBeNull();
    expect(token!._id).toBe(tokenId);
  });

  it('lists project tokens', async () => {
    const tokens = await db.listProjectApiTokens(tenantId, projectId);
    expect(tokens.length).toBeGreaterThanOrEqual(1);
  });

  it('updates token last used', async () => {
    await db.updateTokenLastUsed(tokenId);
    // Just verify it doesn't throw
  });

  it('deletes a project token', async () => {
    const result = await db.deleteProjectApiToken(tokenId, tenantId, projectId);
    expect(result).toBe(true);

    const found = await db.findApiTokenByToken('tk-test-123456');
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
