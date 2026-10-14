/**
 * What a client needs to know before it offers a paperclip: can this agent take
 * files right now (switched on AND a bucket that works), what are the limits, and
 * does its model read images. Built for the client API's agent resource and for
 * the portal's per-agent metadata, so a screen can hide the attach button — or
 * warn that an image will not be seen — instead of finding out from a refusal.
 */

import { getDatabase, type IAgentConfig } from '@/lib/database';
import { resolveModelCapabilities } from '@/lib/services/models/modelCapabilities';
import { attachmentsAvailability } from './sessionFilesConfig';
import { inspectFileBucket } from './sessionFilesBucket';

export interface AgentAttachmentInfo {
    /** Takes files now: switched on, a bucket named, and that bucket can take a file. */
    enabled: boolean;
    maxFiles: number;
    maxFileSizeMb: number;
    allowedMimeTypes: string[];
    /** The agent's model reads images (an image sent to it is seen, not replaced by a note). */
    acceptsImages: boolean;
}

export async function describeAgentAttachments(input: {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    config: IAgentConfig;
}): Promise<AgentAttachmentInfo> {
    const { config } = input;
    const db = await getDatabase();
    await db.switchToTenant(input.tenantDbName);

    let acceptsImages = false;
    if (config.modelKey && !(config.kind === 'external' && config.connection)) {
        const model = await db.findModelByKey(config.modelKey, input.projectId).catch(() => null);
        acceptsImages = model ? resolveModelCapabilities(model).inputModalities.includes('image') : false;
    }

    const availability = attachmentsAvailability(config);
    // Limits are shown even when files are off, so a client can render them without a second call.
    const limits = availability.available ? availability.cfg : null;
    let enabled = false;
    if (availability.available) {
        const inspection = await inspectFileBucket(db, input.tenantId, input.projectId, availability.cfg.bucketKey).catch(() => null);
        enabled = inspection?.usable === true;
    }
    return {
        enabled,
        maxFiles: limits?.maxFiles ?? 0,
        maxFileSizeMb: limits?.maxFileSizeMb ?? 0,
        allowedMimeTypes: limits?.allowedMimeTypes ?? [],
        acceptsImages,
    };
}
