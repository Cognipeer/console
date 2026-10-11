/**
 * The bucket side of session files, against a real SQLite database: the picker's
 * listing, which agents use a bucket, and what a client is told about an agent's
 * attachments (can it take files now, what are the limits, does its model read
 * images).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return { ...actual, getDatabase: hoisted.getDatabase };
});

import type { IAgentConfig } from '@/lib/database';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { describeAgentAttachments } from '@/lib/services/agents/agentAttachmentInfo';
import {
  bucketInUseBody,
  findAgentsUsingBucket,
  inspectFileBucket,
  listAttachmentBuckets,
} from '@/lib/services/agents/sessionFilesBucket';

const DB_NAME = 'tenant_buckets';
const PROJECT = 'proj-1';
const OTHER_PROJECT = 'proj-2';

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;

const provider = (key: string, overrides: Record<string, unknown> = {}) => db.createProvider({
  tenantId, projectId: PROJECT, key, type: 'file', driver: 'aws-s3-files', label: `Provider ${key}`, status: 'active',
  credentialsEnc: '', settings: {}, createdBy: 'u1', ...overrides,
} as never);
const bucket = (key: string, providerKey: string, overrides: Record<string, unknown> = {}) => db.createFileBucket({
  tenantId, projectId: PROJECT, key, name: `Bucket ${key}`, providerKey, status: 'active', createdBy: 'u1', ...overrides,
} as never);

beforeEach(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-buckets-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  const tenant = await db.createTenant({ companyName: 'Acme', slug: 'acme-buckets', dbName: DB_NAME, licenseType: 'FREE', ownerId: 'owner-1' });
  tenantId = String(tenant._id);
  await db.switchToTenant(DB_NAME);
});

afterEach(async () => {
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('the picker’s buckets', () => {
  it('lists every bucket of the project with whether it can take a file now, and why not', async () => {
    await provider('s3-main');
    await provider('disk', { driver: 'local-filesystem', label: 'Server disk' });
    await provider('s3-off', { status: 'disabled' });
    // Exists in the tenant but is assigned to another project only.
    await db.createProvider({ tenantId, projectId: OTHER_PROJECT, key: 's3-elsewhere', type: 'file', driver: 'aws-s3-files', label: 'Elsewhere', status: 'active', credentialsEnc: '', settings: {}, createdBy: 'u1' });
    await bucket('uploads', 's3-main');
    await bucket('scratch', 'disk');
    await bucket('archived', 's3-main', { status: 'disabled' });
    await bucket('on-off-provider', 's3-off');
    await bucket('on-foreign-provider', 's3-elsewhere');
    await bucket('on-gone-provider', 'deleted-provider');
    // Another project's bucket is not offered.
    await db.createFileBucket({ tenantId, projectId: OTHER_PROJECT, key: 'theirs', name: 'Theirs', providerKey: 's3-main', status: 'active', createdBy: 'u1' });

    const options = await listAttachmentBuckets(DB_NAME, tenantId, PROJECT);

    // By name.
    expect(options.map((option) => option.key)).toEqual(['archived', 'on-foreign-provider', 'on-gone-provider', 'on-off-provider', 'scratch', 'uploads']);
    const by = Object.fromEntries(options.map((option) => [option.key, option]));
    expect(by.uploads).toEqual({
      id: expect.any(String), key: 'uploads', name: 'Bucket uploads', providerKey: 's3-main', providerLabel: 'Provider s3-main', driver: 'aws-s3-files',
      bucketStatus: 'active', providerStatus: 'active', usable: true, localDisk: false,
    });
    expect(by.scratch).toMatchObject({ usable: true, driver: 'local-filesystem', localDisk: true, providerLabel: 'Server disk' });
    expect(by.archived).toMatchObject({ usable: false, bucketStatus: 'disabled', reasonCode: 'bucket_disabled', reason: 'The bucket "archived" is disabled.' });
    expect(by['on-off-provider']).toMatchObject({ usable: false, providerStatus: 'disabled', reasonCode: 'provider_inactive' });
    expect(by['on-foreign-provider']).toMatchObject({ usable: false, reasonCode: 'provider_unassigned' });
    expect(by['on-gone-provider']).toMatchObject({ usable: false, providerStatus: 'missing', reasonCode: 'provider_missing', providerLabel: 'deleted-provider', driver: '' });
  });

  it('is empty for a project with no bucket yet', async () => {
    expect(await listAttachmentBuckets(DB_NAME, tenantId, PROJECT)).toEqual([]);
  });
});

describe('which agents use a bucket', () => {
  it('names the agents of the project whose attachments point at it — enabled or not — and no others', async () => {
    const agent = (key: string, config: IAgentConfig, projectId = PROJECT) => db.createAgent({
      tenantId, projectId, key, name: `Agent ${key}`, config, status: 'active', createdBy: 'u1',
    });
    await agent('a', { modelKey: 'm', attachments: { enabled: true, bucketKey: 'uploads' } });
    await agent('b', { modelKey: 'm', attachments: { enabled: false, bucketKey: 'uploads' } });
    await agent('c', { modelKey: 'm', attachments: { enabled: true, bucketKey: 'other' } });
    await agent('d', { modelKey: 'm' });
    await agent('e', { modelKey: 'm', attachments: { enabled: true, bucketKey: 'uploads' } }, OTHER_PROJECT);

    expect(await findAgentsUsingBucket(DB_NAME, PROJECT, 'uploads')).toEqual([{ key: 'a', name: 'Agent a' }, { key: 'b', name: 'Agent b' }]);
    expect(await findAgentsUsingBucket(DB_NAME, PROJECT, 'nobody')).toEqual([]);
    expect(await findAgentsUsingBucket(DB_NAME, OTHER_PROJECT, 'uploads')).toEqual([{ key: 'e', name: 'Agent e' }]);
  });

  it('also names an agent whose draft moved on but whose PUBLISHED version still keeps its files there', async () => {
    const make = (key: string, config: IAgentConfig) => db.createAgent({
      tenantId, projectId: PROJECT, key, name: `Agent ${key}`, config, status: 'active', createdBy: 'u1',
    });
    const publish = async (agentId: string, key: string, config: IAgentConfig, version: number) => {
      await db.createAgentVersion({
        tenantId, projectId: PROJECT, agentId, agentKey: key, version,
        snapshot: { name: key, config, status: 'active' }, publishedBy: 'u1',
      } as never);
      await db.updateAgent(agentId, { publishedVersion: version });
    };
    const onUploads: IAgentConfig = { modelKey: 'm', attachments: { enabled: true, bucketKey: 'uploads' } };
    const onScratch: IAgentConfig = { modelKey: 'm', attachments: { enabled: true, bucketKey: 'scratch' } };

    // Draft moved to `scratch`, version 1 (the one callers run) is still on `uploads`.
    const moved = await make('moved', onScratch);
    await publish(String(moved._id), 'moved', onUploads, 1);
    // Draft and published both on `uploads`: named once, as a plain use.
    const both = await make('both', onUploads);
    await publish(String(both._id), 'both', onUploads, 1);
    // A newer published version moved off; only an older, no longer published one named `uploads`.
    const left = await make('left', onScratch);
    await db.createAgentVersion({ tenantId, projectId: PROJECT, agentId: String(left._id), agentKey: 'left', version: 1, snapshot: { name: 'left', config: onUploads, status: 'active' }, publishedBy: 'u1' } as never);
    await publish(String(left._id), 'left', onScratch, 2);

    expect(await findAgentsUsingBucket(DB_NAME, PROJECT, 'uploads')).toEqual([
      { key: 'both', name: 'Agent both' },
      { key: 'moved', name: 'Agent moved', publishedOnly: true },
    ]);
    expect(bucketInUseBody('uploads', await findAgentsUsingBucket(DB_NAME, PROJECT, 'uploads'), 'delete').error)
      .toContain('Agent moved (its published version)');
  });
});

describe('inspecting one bucket', () => {
  it('returns the bucket and its provider when it can take a file', async () => {
    await provider('s3-main');
    await bucket('uploads', 's3-main');
    const inspection = await inspectFileBucket(db, tenantId, PROJECT, 'uploads');
    expect(inspection.usable).toBe(true);
    if (inspection.usable) expect(inspection.provider.key).toBe('s3-main');
  });

  it('a provider that is not a file provider is not a place for files', async () => {
    await db.createProvider({ tenantId, projectId: PROJECT, key: 'vec', type: 'vector', driver: 'x', label: 'V', status: 'active', credentialsEnc: '', settings: {}, createdBy: 'u1' });
    await bucket('weird', 'vec');
    expect(await inspectFileBucket(db, tenantId, PROJECT, 'weird')).toMatchObject({ usable: false, issue: 'provider_invalid' });
  });
});

describe('what a client is told about an agent’s attachments', () => {
  const model = (modelId: string, overrides: Record<string, unknown> = {}) => db.createModel({
    tenantId, projectId: PROJECT, key: 'main', name: 'Main', providerKey: 'llm', providerDriver: 'openai', category: 'llm', modelId,
    isMultimodal: false, supportsToolCalls: true, settings: {}, pricing: { currency: 'USD', inputTokenPer1M: 0, outputTokenPer1M: 0, cachedTokenPer1M: 0 },
    metadata: {}, createdBy: 'u1', ...overrides,
  } as never);
  const describeFor = (config: IAgentConfig) => describeAgentAttachments({ tenantDbName: DB_NAME, tenantId, projectId: PROJECT, config });

  it('files on with a working bucket: enabled, with the limits, and whether the model reads images', async () => {
    await provider('s3-main');
    await bucket('uploads', 's3-main');
    await model('gpt-6-luna');
    expect(await describeFor({ modelKey: 'main', attachments: { enabled: true, bucketKey: 'uploads', maxFiles: 4, maxFileSizeMb: 5, allowedMimeTypes: ['image/*'] } })).toEqual({
      enabled: true, maxFiles: 4, maxFileSizeMb: 5, allowedMimeTypes: ['image/*'], acceptsImages: true,
    });
  });

  it('files on but the bucket cannot take a file: not enabled — the paperclip stays hidden', async () => {
    await provider('s3-main', { status: 'disabled' });
    await bucket('uploads', 's3-main');
    await model('in-house-7b');
    expect(await describeFor({ modelKey: 'main', attachments: { enabled: true, bucketKey: 'uploads' } })).toMatchObject({ enabled: false, acceptsImages: false });
  });

  it('off by default, and not set up without a bucket', async () => {
    await model('gpt-4o');
    expect(await describeFor({ modelKey: 'main' })).toEqual({ enabled: false, maxFiles: 0, maxFileSizeMb: 0, allowedMimeTypes: [], acceptsImages: true });
    expect(await describeFor({ modelKey: 'main', attachments: { enabled: true } })).toMatchObject({ enabled: false });
  });

  it('an explicit "text only" on the model beats its name', async () => {
    await model('gpt-4o', { metadata: { capabilities: { inputModalities: ['text'] } } });
    expect((await describeFor({ modelKey: 'main' })).acceptsImages).toBe(false);
  });

  it('a model that is gone, or a connected agent, accepts no images', async () => {
    expect((await describeFor({ modelKey: 'nope' })).acceptsImages).toBe(false);
    await model('gpt-4o');
    expect((await describeFor({ kind: 'external', connection: { protocol: 'a2a', url: 'https://x' } } as never)).acceptsImages).toBe(false);
  });
});
