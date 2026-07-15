import { getDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  createProviderConfig,
  updateProviderConfig,
} from './providerService';
import { createFileBucket } from '@/lib/services/files';

/**
 * Built-in zero-configuration providers.
 *
 * Every tenant/project gets a local vector provider (SQLite) and a local
 * file provider (server filesystem) without any manual setup, so knowledge
 * bases can be created out of the box — no external services, credentials
 * or settings required. Data lives under DATA_DIR (the mounted app-data
 * volume in Docker).
 */

export const BUILTIN_VECTOR_PROVIDER_KEY = 'builtin-vector';
export const BUILTIN_FILE_PROVIDER_KEY = 'builtin-files';
export const BUILTIN_FILE_BUCKET_KEY = 'builtin-storage';

const logger = createLogger('builtin-providers');

// Skip repeated lookups once a tenant/project pair has been ensured by this
// process. Cheap re-checks happen again after a restart, which also heals
// records deleted while the process was down.
const ensured = new Set<string>();

interface BuiltinProviderSpec {
  key: string;
  type: 'vector' | 'file';
  driver: string;
  label: string;
  description: string;
}

const BUILTIN_PROVIDER_SPECS: BuiltinProviderSpec[] = [
  {
    key: BUILTIN_VECTOR_PROVIDER_KEY,
    type: 'vector',
    driver: 'sqlite-vector',
    label: 'Built-in Vector Store',
    description:
      'Local persistent vector store (SQLite). No external service or credentials required.',
  },
  {
    key: BUILTIN_FILE_PROVIDER_KEY,
    type: 'file',
    driver: 'local-filesystem',
    label: 'Built-in File Storage',
    description:
      'Local persistent file storage on the server disk. No external service or credentials required.',
  },
];

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && /already exists/i.test(error.message);
}

async function ensureProviderRecord(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  userId: string,
  spec: BuiltinProviderSpec,
): Promise<void> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  // Provider keys are tenant-level; look the record up without a project
  // filter so an existing record only needs its project assignment extended.
  const existing = await db.findProviderByKey(tenantId, spec.key);

  if (!existing) {
    try {
      await createProviderConfig(tenantDbName, tenantId, {
        projectId,
        key: spec.key,
        type: spec.type,
        driver: spec.driver,
        label: spec.label,
        description: spec.description,
        credentials: {},
        settings: {},
        createdBy: userId,
      });
      logger.info('Provisioned built-in provider', {
        key: spec.key,
        tenantId,
        projectId,
      });
    } catch (error) {
      // Lost a concurrent-create race — the record exists now, which is all
      // this function is responsible for.
      if (!isAlreadyExistsError(error)) throw error;
    }
    return;
  }

  const assignedProjects = existing.projectIds ?? [];
  const isAssigned =
    assignedProjects.includes(projectId) || existing.projectId === projectId;

  if (!isAssigned && existing._id) {
    await updateProviderConfig(tenantDbName, String(existing._id), {
      projectIds: [...assignedProjects, projectId],
      updatedBy: userId,
    });
    logger.info('Assigned built-in provider to project', {
      key: spec.key,
      tenantId,
      projectId,
    });
  }
}

async function ensureBuiltinBucket(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  userId: string,
): Promise<void> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const existing = await db.findFileBucketByKey(
    tenantId,
    BUILTIN_FILE_BUCKET_KEY,
    projectId,
  );
  if (existing) return;

  try {
    await createFileBucket(tenantDbName, tenantId, projectId, {
      key: BUILTIN_FILE_BUCKET_KEY,
      name: 'Built-in Storage',
      providerKey: BUILTIN_FILE_PROVIDER_KEY,
      description: 'Default bucket on the built-in local file storage.',
      createdBy: userId,
    });
    logger.info('Provisioned built-in file bucket', { tenantId, projectId });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
}

/**
 * Idempotently creates the built-in vector/file providers and the default
 * file bucket for a tenant project. Safe to call on read paths: failures are
 * logged and swallowed so listings never break because provisioning did.
 */
export async function ensureBuiltinProviders(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  userId: string,
): Promise<void> {
  const memoKey = `${tenantDbName}:${projectId}`;
  if (ensured.has(memoKey)) return;

  try {
    for (const spec of BUILTIN_PROVIDER_SPECS) {
      await ensureProviderRecord(tenantDbName, tenantId, projectId, userId, spec);
    }
    await ensureBuiltinBucket(tenantDbName, tenantId, projectId, userId);
    ensured.add(memoKey);
  } catch (error) {
    logger.warn('Failed to provision built-in providers', {
      tenantId,
      projectId,
      error: error instanceof Error ? error.message : error,
    });
  }
}
