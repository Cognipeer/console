/**
 * Storage for sandbox seed files: uploads into the agent's attachments bucket
 * under `agent-assets/<agentKey>/` and deletes them again. The agent config
 * keeps the reference (`sandbox.seedFiles`); see agentSandboxSeedFiles.ts.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { IAgent, IAgentSandboxSeedFile } from '@/lib/database';
import { getDatabase } from '@/lib/database';
import { deleteFile, generateFileRelativeKey, uploadFile } from '@/lib/services/files';
import { AgentAttachmentError } from './agentErrors';
import { inspectFileBucket, storageNotConfiguredError, storageUnavailableError } from './sessionFilesBucket';
import {
    SEED_MAX_FILES,
    SEED_MAX_FILE_BYTES,
    SEED_MAX_TOTAL_BYTES,
    defaultSeedPath,
    isOwnedObjectKey,
    seedObjectPrefix,
} from './agentSandboxSeedFiles';

const sha256Hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export interface SeedStorageScope { tenantDbName: string; tenantId: string; projectId: string }

export async function uploadSeedFile(input: {
    scope: SeedStorageScope;
    agent: Pick<IAgent, 'key' | 'config'>;
    fileName: string;
    contentType?: string;
    data: Buffer;
    userId: string;
}): Promise<IAgentSandboxSeedFile> {
    const { scope, agent, data } = input;
    const held = agent.config?.sandbox?.seedFiles ?? [];
    if (held.length >= SEED_MAX_FILES) {
        throw new AgentAttachmentError(409, 'too_many_files', `An agent can preload at most ${SEED_MAX_FILES} files.`);
    }
    if (data.length === 0) throw new AgentAttachmentError(400, 'empty_file', 'The file is empty.');
    if (data.length > SEED_MAX_FILE_BYTES) {
        throw new AgentAttachmentError(413, 'file_too_large', 'A preloaded file can be at most 25 MB.');
    }
    if (held.reduce((sum, file) => sum + (file.size || 0), 0) + data.length > SEED_MAX_TOTAL_BYTES) {
        throw new AgentAttachmentError(413, 'file_too_large', 'Preloaded files can be at most 100 MB in total.');
    }
    const bucketKey = agent.config?.attachments?.bucketKey?.trim();
    if (!bucketKey) throw storageNotConfiguredError();
    const db = await getDatabase();
    await db.switchToTenant(scope.tenantDbName);
    const inspection = await inspectFileBucket(db, scope.tenantId, scope.projectId, bucketKey);
    if (!inspection.usable) throw storageUnavailableError(inspection);

    const contentType = input.contentType && input.contentType !== 'application/json' ? input.contentType : 'application/octet-stream';
    const result = await uploadFile(scope.tenantDbName, scope.tenantId, scope.projectId, {
        bucketKey,
        fileName: input.fileName,
        contentType,
        data,
        createdBy: input.userId,
        convertToMarkdown: false,
        keyHint: `${seedObjectPrefix(agent.key)}${generateFileRelativeKey(input.fileName)}`,
    });
    return {
        id: randomUUID(),
        name: input.fileName,
        path: defaultSeedPath(input.fileName),
        fileRef: { bucketKey, objectKey: result.record.key },
        size: data.length,
        mimeType: contentType,
        sha256: sha256Hex(data),
    };
}

/** Deletes an uploaded seed file. Only objects under this agent's `agent-assets/` prefix are touched. */
export async function deleteSeedFile(input: {
    scope: SeedStorageScope;
    agent: Pick<IAgent, 'key'>;
    bucketKey: string;
    objectKey: string;
    userId: string;
}): Promise<boolean> {
    if (!isOwnedObjectKey(input.objectKey, input.agent.key)) {
        throw new AgentAttachmentError(400, 'invalid_object_key', 'Not a file uploaded for this agent.');
    }
    try {
        return await deleteFile(input.scope.tenantDbName, input.scope.tenantId, input.scope.projectId, input.bucketKey, input.objectKey, input.userId);
    } catch (error) {
        if (error instanceof Error && /not found/i.test(error.message)) return false;
        throw error;
    }
}
