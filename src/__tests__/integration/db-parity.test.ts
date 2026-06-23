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
