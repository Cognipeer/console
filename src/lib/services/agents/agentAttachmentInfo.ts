/**
 * What a client needs to know before it offers a paperclip: can this agent take
 * files right now (switched on AND a bucket that works), what are the limits, and
 * does its model read images. Built for the client API's agent resource and for
 * the portal's per-agent metadata, so a screen can hide the attach button — or
 * warn that an image will not be seen — instead of finding out from a refusal.
 */

import { getDatabase, type IAgentConfig } from '@/lib/database';
import { resolveModelCapabilities } from '@/lib/services/models/modelCapabilities';
import { attachmentsAvailability, attachmentsOcrActive, FILE_OUTPUT_EXTENSIONS, outputsAvailability, resolveOutputsConfig } from './sessionFilesConfig';
import { inspectFileBucket } from './sessionFilesBucket';

export interface AgentAttachmentInfo {
    /** Takes files now: switched on, a bucket named, and that bucket can take a file. */
    enabled: boolean;
    maxFiles: number;
    maxFileSizeMb: number;
    allowedMimeTypes: string[];
    /** Uploads are on (`enabled`) and the agent's model reads images (an image sent to it is seen, not replaced by a note). */
    acceptsImages: boolean;
    /**
     * Only for an agent that has OCR settings: whether uploads are read with OCR (scanned documents, and pictures when
     * the agent reads them), which needs files to be on too. Absent = no OCR configured.
     */
    ocr?: { enabled: boolean };
    /** Files the agent can write for the person (`session_files_create`), independent of uploads (on by default only together with them). */
    outputs: {
        /** Writes files now: switched on (by default with uploads), a bucket named, and that bucket can take a file. */
        enabled: boolean;
        maxFilesPerTurn: number;
        maxFileSizeMb: number;
        /** File extensions it may write, without the dot. */
        types: string[];
    };
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

    const availability = attachmentsAvailability(config);
    const outputsOn = outputsAvailability(config);
    const bucketUsable = async (key: string) =>
        (await inspectFileBucket(db, input.tenantId, input.projectId, key).catch(() => null))?.usable === true;
    const enabled = availability.available ? await bucketUsable(availability.cfg.bucketKey) : false;

    // An image reaches the model only through an upload, so with uploads off it accepts none.
    let acceptsImages = false;
    if (enabled && config.modelKey && !(config.kind === 'external' && config.connection)) {
        const model = await db.findModelByKey(config.modelKey, input.projectId).catch(() => null);
        acceptsImages = model ? resolveModelCapabilities(model).inputModalities.includes('image') : false;
    }

    // Limits are shown even when files are off, so a client can render them without a second call.
    const limits = availability.available ? availability.cfg : null;
    const outputs = resolveOutputsConfig(config.attachments);
    return {
        enabled,
        maxFiles: limits?.maxFiles ?? 0,
        maxFileSizeMb: limits?.maxFileSizeMb ?? 0,
        allowedMimeTypes: limits?.allowedMimeTypes ?? [],
        acceptsImages,
        ...(availability.available && availability.cfg.ocr ? { ocr: { enabled: enabled && attachmentsOcrActive(availability.cfg) } } : {}),
        outputs: {
            enabled: outputsOn.available ? await bucketUsable(outputsOn.cfg.bucketKey) : false,
            maxFilesPerTurn: outputs.maxFilesPerTurn,
            maxFileSizeMb: outputs.maxFileSizeMb,
            types: [...FILE_OUTPUT_EXTENSIONS],
        },
    };
}
