/**
 * Where a local disk provider may keep its files, through the REAL plugins over a real SQLite database and the real
 * local-disk driver. A caller who can write files can also create a file provider, so the folder a provider's files
 * live in cannot depend on what that caller typed:
 *
 *  - `POST /files/providers` (the files permission is enough) refuses a key that is not a folder name, a base directory
 *    (a directory of the server) and a subdirectory that goes up;
 *  - `POST /providers` and `PATCH /providers/:id` (owners and admins) take a base directory on a self-hosted deployment
 *    and refuse it on a shared one;
 *  - a provider saved before the key was checked (key `..`, which made the base directory its own root) no longer
 *    reaches outside its organization's folder: the files beside it are neither listed nor read.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));

import { encryptObject } from '@/lib/utils/crypto';
import { providersApiPlugin } from '@/server/api/plugins/providers';
import { createFastifyApiTestApp } from '../helpers/fastify-api';
import { createFilesStack, FILES_DB_NAME, type FilesStack, type Json } from '../helpers/filesRealStack';
import { ONPREM, restoreDeployment, SAAS, useDeployment as setDeployment } from '../helpers/providerNetworks';

let stack: FilesStack;
let providersApp: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let ownerId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  setDeployment(SAAS);
  stack = await createFilesStack(hoisted.getDatabase);
  await stack.db.switchToTenant(FILES_DB_NAME);
  const owner = await stack.db.createUser({ tenantId: stack.tenantId, email: 'owner@x.io', name: 'The Owner', password: '$2b$10$x', role: 'owner', licenseId: 'FREE', features: [] });
  ownerId = String(owner._id);
  providersApp = await createFastifyApiTestApp(providersApiPlugin);
  await providersApp.ready();
});

afterEach(async () => {
  restoreDeployment();
  await providersApp.close();
  await stack.close();
});

/** A request to the providers plugin as the owner of the organization. */
function asOwner(method: 'POST' | 'PATCH', url: string, payload: unknown) {
  return providersApp.inject({
    method,
    url: `/api${url}`,
    headers: {
      'content-type': 'application/json',
      'x-tenant-db-name': FILES_DB_NAME,
      'x-tenant-id': stack.tenantId,
      'x-tenant-slug': 'files-writes',
      'x-user-id': ownerId,
      'x-user-role': 'owner',
      'x-user-email': 'owner@x.io',
      'x-license-type': 'FREE',
    },
    payload: JSON.stringify(payload),
  });
}

const local = (over: Record<string, unknown> = {}) => ({ key: 'disk-2', driver: 'local-filesystem', label: 'Disk', credentials: {}, settings: {}, ...over });
const storedProvider = async (key: string) => {
  await stack.db.switchToTenant(FILES_DB_NAME);
  return stack.db.findProviderByKey(stack.tenantId, key);
};

describe('POST /files/providers (a caller who can write files)', () => {
  it('refuses a provider key that is not a folder name - nothing is stored', async () => {
    for (const key of ['..', '.', '../other-org/local', 'a/b']) {
      const res = await stack.request('POST', '/files/providers', local({ key, settings: { basePath: stack.dir } }));

      expect(res.statusCode, `${key}: ${res.body}`).toBe(400);
      expect(stack.json(res)).toMatchObject({ code: 'provider_settings_invalid', field: 'key' });
      expect(await storedProvider(key)).toBeNull();
    }
  });

  it('refuses a base directory, on a shared deployment and on a self-hosted one', async () => {
    for (const mode of [SAAS, ONPREM]) {
      setDeployment(mode);
      const res = await stack.request('POST', '/files/providers', local({ key: `disk-${mode.DEPLOYMENT_MODE}`, settings: { basePath: path.join(stack.dir, 'elsewhere') } }));

      expect(res.statusCode, res.body).toBe(400);
      expect(stack.json(res)).toMatchObject({ code: 'provider_settings_invalid', field: 'basePath' });
      expect(await storedProvider(`disk-${mode.DEPLOYMENT_MODE}`)).toBeNull();
    }
  });

  it('refuses a subdirectory that goes up, and takes one that stays inside', async () => {
    for (const subdirectory of ['..', '../elsewhere', '/etc']) {
      const res = await stack.request('POST', '/files/providers', local({ key: 'disk-up', settings: { subdirectory } }));
      expect(res.statusCode, `${subdirectory}: ${res.body}`).toBe(400);
      expect(stack.json(res)).toMatchObject({ field: 'subdirectory' });
    }
    expect(await storedProvider('disk-up')).toBeNull();

    const res = await stack.request('POST', '/files/providers', local({ key: 'disk-archive', settings: { subdirectory: 'archive/2026' } }));
    expect(res.statusCode, res.body).toBe(201);
    expect(stack.json(res).provider).toMatchObject({ key: 'disk-archive', driver: 'local-filesystem', settings: { subdirectory: 'archive/2026' } });
  });

  it('takes a local disk provider with no directory of the server in it', async () => {
    const res = await stack.request('POST', '/files/providers', local({ key: 'disk-plain' }));

    expect(res.statusCode, res.body).toBe(201);
    expect(await storedProvider('disk-plain')).toMatchObject({ driver: 'local-filesystem', type: 'file' });
  });
});

describe('POST /providers and PATCH /providers/:id (an owner)', () => {
  const create = (over: Record<string, unknown> = {}) => asOwner('POST', '/providers?scope=tenant', { type: 'file', ...local(), ...over });

  it('takes a base directory on a self-hosted deployment', async () => {
    setDeployment(ONPREM);
    const basePath = path.join(stack.dir, 'owner-chosen');

    const res = await create({ key: 'owner-disk', settings: { basePath } });

    expect(res.statusCode, res.body).toBe(201);
    expect(await storedProvider('owner-disk')).toMatchObject({ settings: { basePath } });
  });

  it('refuses a base directory on a shared deployment', async () => {
    const res = await create({ key: 'owner-disk', settings: { basePath: path.join(stack.dir, 'owner-chosen') } });

    expect(res.statusCode, res.body).toBe(400);
    expect(stack.json(res)).toMatchObject({ code: 'provider_settings_invalid', field: 'basePath' });
    expect(await storedProvider('owner-disk')).toBeNull();
  });

  it('refuses a key that is not a folder name', async () => {
    setDeployment(ONPREM);
    const res = await create({ key: '..', settings: { basePath: stack.dir } });

    expect(res.statusCode, res.body).toBe(400);
    expect(stack.json(res)).toMatchObject({ code: 'provider_settings_invalid', field: 'key' });
    expect(await storedProvider('..')).toBeNull();
  });

  it('takes a base directory in an edit on a self-hosted deployment, and not on a shared one', async () => {
    const created = await create({ key: 'owner-disk' });
    expect(created.statusCode, created.body).toBe(201);
    const id = String(stack.json(created).provider._id ?? stack.json(created).provider.id);
    const basePath = path.join(stack.dir, 'moved');

    const shared = await asOwner('PATCH', `/providers/${id}?scope=tenant`, { settings: { basePath } });
    expect(shared.statusCode, shared.body).toBe(400);
    expect(stack.json(shared)).toMatchObject({ field: 'basePath' });

    setDeployment(ONPREM);
    const selfHosted = await asOwner('PATCH', `/providers/${id}?scope=tenant`, { settings: { basePath } });
    expect(selfHosted.statusCode, selfHosted.body).toBe(200);
    expect(await storedProvider('owner-disk')).toMatchObject({ settings: { basePath } });
  });
});

describe('a provider saved before its key was checked', () => {
  it('no longer reaches the files beside its organization folder', async () => {
    // The probe: key ".." under a base directory made the root the base directory itself, so a bucket named after a
    // folder of it could list, read and delete what was never the organization's.
    mkdirSync(path.join(stack.dir, 'outside'), { recursive: true });
    const secret = path.join(stack.dir, 'outside', 'secret.txt');
    writeFileSync(secret, 'not yours');
    await stack.db.switchToTenant(FILES_DB_NAME);
    await stack.db.createProvider({
      tenantId: stack.tenantId, projectId: stack.projectId, key: '..', type: 'file', driver: 'local-filesystem', label: 'Older provider',
      status: 'active', credentialsEnc: encryptObject({}), settings: { basePath: stack.dir }, createdBy: 'x',
    });
    await stack.createBucket('esc', { name: 'Escape', providerKey: '..', prefix: 'outside' });

    const res = await stack.request('POST', '/files/buckets/esc/import', {});

    expect(res.statusCode, res.body).toBe(502);
    expect(stack.json(res)).toMatchObject({ code: 'storage_failure', field: 'key' });
    expect(res.body).not.toContain(stack.dir);
    expect(await stack.records('esc')).toEqual([]);
    expect(existsSync(secret)).toBe(true);
    expect(readFileSync(secret, 'utf8')).toBe('not yours');
  });

  it('still works when its key goes down into the organization folder', async () => {
    await stack.db.switchToTenant(FILES_DB_NAME);
    await stack.db.createProvider({
      tenantId: stack.tenantId, projectId: stack.projectId, key: 'team/a', type: 'file', driver: 'local-filesystem', label: 'Nested',
      status: 'active', credentialsEnc: encryptObject({}), settings: { basePath: stack.dir }, createdBy: 'x',
    });
    await stack.createBucket('nested', { name: 'Nested', providerKey: 'team/a', prefix: 'docs' });
    const target = path.join(stack.dir, stack.tenantId, 'team', 'a', 'docs', 'found.txt');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'inside');

    const res = await stack.request('POST', '/files/buckets/nested/import', {});

    expect(res.statusCode, res.body).toBe(200);
    expect((stack.json(res) as Json).imported).toBe(1);
  });
});
