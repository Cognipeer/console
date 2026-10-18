/**
 * Session files: documents and images a user attaches to an agent session.
 *
 * A session file is an ordinary file record (`IFileRecord`) tagged
 * `purpose: 'conversation'` and the conversation it belongs to, stored in the
 * bucket the agent's `attachments.bucketKey` names, at
 * `<folder>/<agentKey>/<sessionId>/<unique name>`. There is no built-in
 * fallback storage: an agent without a usable bucket takes no files
 * (`sessionFilesBucket.ts`). The original is kept and converted to markdown by
 * the same file service every other upload uses, so the quota checks, the
 * provider drivers and the Files screens all apply.
 *
 * Using the files in a turn (`assembleTurnAttachments`):
 *  - The markdown of the files attached to THIS message is put in the user turn
 *    as `<document name="…" id="…">…</document>` blocks when it fits
 *    `inlineMaxTokens` (estimated chars / 4). Otherwise the turn carries a short
 *    note listing the files and the agent reads them in pages with
 *    `session_files_list` / `session_files_read`.
 *  - The block opens with a line naming EVERY attachment by kind (documents to
 *    read, images shown), whatever mix the message carries.
 *  - Images become image parts when the model accepts images, else a text note.
 *    An image part is a REFERENCE (`session-file://<id>`) with a text handle in
 *    front of it; the bytes are read from the bucket at the model call
 *    (`sessionImages.ts`), so the saved state and the traces carry no base64.
 *  - Everything added to the user text sits after `ATTACHMENT_BLOCK_MARKER`, so
 *    the transcript can persist the text the person typed
 *    (`stripAttachmentBlock`) while the model works from the full turn.
 *  - Files uploaded to the session that no message has carried yet ride along
 *    with the next message (`findUnsentSessionFiles`, `attachNewUploads`).
 *
 * The tools are present whenever the conversation has files — a later turn can
 * read an earlier upload — and all are read-only (`HITL_READ_ONLY_TOOLS`):
 * `session_files_list`, `session_files_read` and, while the session holds an
 * image and the model takes images, `session_files_view_image`.
 *
 * Every limit is a stored setting of the agent (`IAgentConfig.attachments`);
 * `SESSION_FILES_DEFAULTS` is only what an unset field falls back to.
 */

import { Buffer } from 'node:buffer';
import type { createTool as CreateSdkTool, ToolInterface as AgentSdkToolInterface } from '@cognipeer/agent-sdk';
import {
    getDatabase,
    type DatabaseProvider,
    type IAgentConfig,
    type IAgentConversation,
    type IAgentMessageAttachment,
    type IFileRecord,
} from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
    deleteFile,
    downloadFile,
    generateFileRelativeKey,
    replaceFileContent,
    uploadFile,
} from '@/lib/services/files';
import { checkPerRequestLimits, checkRateLimit, checkResourceQuota } from '@/lib/quota/quotaGuard';
import type { LicenseType } from '@/lib/license/license-manager';
import type { TraceToolDefinition } from '@/lib/services/tracingToolDefinitions';
import { withUploaderNames } from '@/lib/services/users/userDisplayNames';
import { AgentAttachmentError } from './agentErrors';
import {
    FILE_OUTPUT_TYPES,
    SESSION_FILES_DEFAULTS,
    SESSION_FILES_LIST_TOOL,
    SESSION_FILES_READ_TOOL,
    SESSION_FILES_VIEW_IMAGE_TOOL,
    agentTakesAttachments,
    attachmentsAvailability,
    attachmentsUnavailableMessage,
    fileTooLargeMessage,
    isImageMime,
    isMimeAllowed,
    isSendableImageMime,
    maxUploadBytes,
    resolveAttachmentsConfig,
    sendableImageType,
    type ResolvedAttachmentsConfig,
} from './sessionFilesConfig';
import {
    inspectFileBucket,
    sessionFileObjectKey,
    storageNotConfiguredError,
    storageUnavailableError,
} from './sessionFilesBucket';
import {
    ATTACHMENT_BLOCK_MARKER,
    attachmentSummaryLine,
    escapeAttribute,
    imageAnchorText,
    imageReferencePart,
    stripAttachmentBlock,
    unsupportedImageNote,
    viewImageToolResult,
    wrapAttachmentBlock,
    type ContentPart,
    type ImageReferencePart,
} from './sessionAttachmentText';
import type { SessionImageSource } from './sessionImages';

export { ATTACHMENT_BLOCK_MARKER, stripAttachmentBlock };

export {
    SESSION_FILES_DEFAULTS,
    SESSION_FILES_LIST_TOOL,
    SESSION_FILES_READ_TOOL,
    SESSION_FILES_VIEW_IMAGE_TOOL,
    agentTakesAttachments,
    attachmentsAvailability,
    attachmentsUnavailableMessage,
    isImageMime,
    isMimeAllowed,
    isSendableImageMime,
    resolveAttachmentsConfig,
    type ResolvedAttachmentsConfig,
};

const logger = createLogger('agent-session-files');

export interface SessionFileScope {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
}

/** Who uploads: the quota checks need the plan and, for a token, which token. */
export interface SessionFileActor {
    userId: string;
    licenseType: string;
    tokenId?: string;
}

/** A session file as the dashboard and the client API show it. */
export interface SessionFileView {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    /** `succeeded` = readable as text; `failed` / `skipped` = only the original exists; `pending` = converting. */
    conversionStatus: IFileRecord['markdownStatus'];
    conversionError?: string;
    /** Where it is stored: the bucket (Document Store key) and the object's path inside it. */
    bucketKey: string;
    path: string;
    createdAt?: Date;
    expiresAt?: Date | null;
    uploadedBy?: string;
    /** `uploadedBy` as a person's name, when it is a user of the tenant. */
    uploadedByName?: string;
}

export function toSessionFileView(record: Pick<
    IFileRecord,
    '_id' | 'name' | 'contentType' | 'size' | 'markdownStatus' | 'markdownError' | 'bucketKey' | 'key' | 'createdAt' | 'expiresAt' | 'uploadedBy'
> & { id?: string }): SessionFileView {
    return {
        id: record.id ?? String(record._id),
        name: record.name,
        mimeType: record.contentType ?? 'application/octet-stream',
        size: record.size,
        conversionStatus: record.markdownStatus,
        ...(record.markdownError ? { conversionError: record.markdownError } : {}),
        bucketKey: record.bucketKey,
        path: record.key,
        ...(record.createdAt ? { createdAt: record.createdAt } : {}),
        ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
        ...(record.uploadedBy ? { uploadedBy: record.uploadedBy } : {}),
    };
}

export function toMessageAttachment(record: Pick<IFileRecord, '_id' | 'name' | 'contentType' | 'size'> & { id?: string }): IAgentMessageAttachment {
    return {
        fileId: record.id ?? String(record._id),
        name: record.name,
        mimeType: record.contentType ?? 'application/octet-stream',
        size: record.size,
    };
}

// ── MIME handling ───────────────────────────────────────────────────────────

const MIME_BY_EXTENSION: Record<string, string> = {
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    html: 'text/html',
    xml: 'application/xml',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
};

/** The upload's MIME type: what the caller declared, else a guess from the file name. */
export function resolveUploadMimeType(declared: string | undefined, fileName: string): string {
    const base = declared?.split(';')[0]?.trim().toLowerCase();
    if (base && base !== 'application/octet-stream') return base;
    const extension = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
    return MIME_BY_EXTENSION[extension] ?? base ?? 'application/octet-stream';
}

/** Types whose bytes ARE the text, so a failed conversion can still be read. */
function isPlainTextMime(mimeType: string | undefined): boolean {
    if (!mimeType) return false;
    const mime = mimeType.toLowerCase();
    return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml');
}

// ── Paging ──────────────────────────────────────────────────────────────────

export interface TextPage {
    text: string;
    page: number;
    pages: number;
}

export function pageCount(totalChars: number, pageChars: number): number {
    return Math.max(1, Math.ceil(totalChars / Math.max(1, pageChars)));
}

/** One page (1-based) of `text`; null when `page` is past the end. */
export function pageText(text: string, page: number, pageChars: number): TextPage | null {
    const pages = pageCount(text.length, pageChars);
    if (!Number.isInteger(page) || page < 1 || page > pages) return null;
    return { text: text.slice((page - 1) * pageChars, page * pageChars), page, pages };
}

/** The token estimate the inline/paged decision uses: characters / 4. */
export function estimateTokens(chars: number): number {
    return Math.ceil(chars / 4);
}

// ── Storage ─────────────────────────────────────────────────────────────────

async function tenantDb(tenantDbName: string): Promise<DatabaseProvider> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db;
}

/**
 * The bucket new session files go to: the agent's own `attachments.bucketKey`,
 * checked to be usable now (it exists in the project, is active, and its
 * provider exists, is assigned to the project and is active). Refusals are typed
 * and tell the operator which bucket: `409 storage_not_configured` (no bucket
 * named — older data) and `409 storage_unavailable` (the named one cannot take a file).
 */
export async function resolveSessionFilesBucket(
    scope: SessionFileScope,
    cfg: ResolvedAttachmentsConfig,
): Promise<string> {
    if (!cfg.bucketKey) throw storageNotConfiguredError();
    const db = await tenantDb(scope.tenantDbName);
    const inspection = await inspectFileBucket(db, scope.tenantId, scope.projectId, cfg.bucketKey);
    if (!inspection.usable) throw storageUnavailableError(inspection);
    return cfg.bucketKey;
}

function decodeBase64(data: string): Buffer {
    const trimmed = data.trim();
    const dataUrl = trimmed.match(/^data:[^,]*;base64,([\s\S]*)$/);
    return Buffer.from(dataUrl ? dataUrl[1]! : trimmed, 'base64');
}

/** Bytes a base64 string decodes to, without decoding it. */
export function estimateBase64Size(data: string): number {
    const base64 = (data.includes('base64,') ? data.split('base64,').pop() ?? '' : data).replace(/\s/g, '');
    if (!base64) return 0;
    const padding = base64.match(/=+$/)?.[0].length ?? 0;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

interface FileQuotaCheck {
    scope: SessionFileScope;
    bucketKey: string;
    /** The file's size once stored: what the per-request size limit looks at. */
    bytes: number;
    /** What this write adds to the project's storage (the whole file for a new one, the growth for an append). */
    addedBytes: number;
    /** A new file (counts against the rate and total-files limits) or one that grows. */
    newFile: boolean;
    actor: { userId: string; licenseType?: string; tokenId?: string };
}

/**
 * The quota checks every write of a session file goes through (an upload, a file the agent wrote):
 * the plan's per-request limits, the files rate limit, the project's total files and its storage.
 * Refuses with `429 quota_exceeded` before anything is stored.
 */
async function assertFileQuotas(db: DatabaseProvider, check: FileQuotaCheck): Promise<void> {
    const { scope, actor } = check;
    const quotaContext = {
        domain: 'file' as const,
        ...(actor.licenseType ? { licenseType: actor.licenseType as LicenseType } : {}),
        projectId: scope.projectId,
        resourceKey: check.bucketKey,
        tenantDbName: scope.tenantDbName,
        tenantId: scope.tenantId,
        ...(actor.tokenId ? { tokenId: actor.tokenId } : {}),
        userId: actor.userId,
    };
    const perRequest = await checkPerRequestLimits(quotaContext, { fileSize: check.bytes, filesPerRequest: 1 });
    if (!perRequest.allowed) {
        throw new AgentAttachmentError(429, 'quota_exceeded', perRequest.reason || 'Quota exceeded');
    }
    const rate = await checkRateLimit(quotaContext, { files: check.newFile ? 1 : 0, requests: 1, storageBytes: check.addedBytes });
    if (!rate.allowed) {
        throw new AgentAttachmentError(429, 'quota_exceeded', rate.reason || 'Rate limit exceeded');
    }
    if (check.newFile) {
        const resource = await checkResourceQuota(quotaContext, 'filesTotal', await db.countFileRecords({ projectId: scope.projectId }));
        if (!resource.allowed) {
            throw new AgentAttachmentError(429, 'quota_exceeded', resource.reason || 'File quota exceeded');
        }
    }
    const storageLimit = perRequest.effectiveLimits.quotas?.maxStorageBytes;
    if (storageLimit !== undefined && storageLimit !== -1) {
        const projected = (await db.sumFileRecordBytes({ projectId: scope.projectId })) + check.addedBytes;
        if (projected > storageLimit) {
            throw new AgentAttachmentError(429, 'quota_exceeded', `storageBytes limit exceeded (${projected}/${storageLimit})`);
        }
    }
}

export interface UploadSessionFileInput {
    scope: SessionFileScope;
    conversation: Pick<IAgentConversation, '_id' | 'agentKey'>;
    agentConfig: IAgentConfig | undefined;
    fileName: string;
    contentType?: string;
    /** The file's bytes, or the same as base64 / a `data:` URL. */
    data: Buffer | string;
    actor: SessionFileActor;
}

/**
 * Stores one file on a session after the agent's limits and the project's file
 * quotas agree. Refusals are `AgentAttachmentError`s with the HTTP status to
 * answer (413 too large, 415 type, 409 count, 429 quota, 403 switched off).
 */
export async function uploadSessionFile(input: UploadSessionFileInput): Promise<SessionFileView> {
    const { scope, conversation, agentConfig, actor } = input;
    const availability = attachmentsAvailability(agentConfig);
    if (!availability.available) {
        throw new AgentAttachmentError(403, 'attachments_disabled', attachmentsUnavailableMessage(availability.reason));
    }
    const cfg = availability.cfg;

    const mimeType = resolveUploadMimeType(input.contentType, input.fileName);
    // A picture is also held to what one model request carries: past that it could never be shown.
    const maxBytes = maxUploadBytes(cfg, mimeType);
    const declaredBytes = typeof input.data === 'string' ? estimateBase64Size(input.data) : input.data.length;
    if (declaredBytes > maxBytes) {
        throw new AgentAttachmentError(413, 'file_too_large', fileTooLargeMessage(cfg, mimeType));
    }
    if (declaredBytes === 0) {
        throw new AgentAttachmentError(400, 'empty_file', 'The file is empty.');
    }

    if (!isMimeAllowed(mimeType, cfg.allowedMimeTypes)) {
        throw new AgentAttachmentError(415, 'unsupported_file_type', `Files of type "${mimeType}" are not accepted by this agent.`);
    }

    const conversationId = String(conversation._id);
    const db = await tenantDb(scope.tenantDbName);
    // What the agent wrote itself is not what a person attached: it does not use up the person's file count.
    const held = (await db.listFileRecordsByConversation(conversationId)).filter((record) => record.origin !== 'agent_output');
    if (held.length >= cfg.maxFiles) {
        throw new AgentAttachmentError(409, 'too_many_files', `A session holds at most ${cfg.maxFiles} files. Delete one to attach another.`);
    }

    const bucketKey = await resolveSessionFilesBucket(scope, cfg);
    await assertFileQuotas(db, { scope, bucketKey, bytes: declaredBytes, addedBytes: declaredBytes, newFile: true, actor });

    const buffer = typeof input.data === 'string' ? decodeBase64(input.data) : input.data;
    // The estimate above is for a string; the decoded size is what is stored.
    if (buffer.length > maxBytes) {
        throw new AgentAttachmentError(413, 'file_too_large', fileTooLargeMessage(cfg, mimeType));
    }

    const result = await uploadFile(scope.tenantDbName, scope.tenantId, scope.projectId, {
        bucketKey,
        fileName: input.fileName,
        contentType: mimeType,
        data: buffer,
        createdBy: actor.userId,
        // An image has no text to convert; the model reads the original.
        convertToMarkdown: !isImageMime(mimeType),
        // <folder>/<agentKey>/<sessionId>/<unique name>; the file service puts the bucket's own prefix in front.
        keyHint: sessionFileObjectKey({
            folder: cfg.folder,
            agentKey: conversation.agentKey,
            conversationId,
            uniqueName: generateFileRelativeKey(input.fileName),
        }),
        recordExtras: {
            purpose: 'conversation',
            conversationId,
            agentKey: conversation.agentKey,
            expiresAt: new Date(Date.now() + cfg.retentionDays * 86_400_000),
            uploadedBy: actor.userId,
        },
    });
    return toSessionFileView(result.record);
}

const formatMb = (bytes: number) => `${Number((bytes / (1024 * 1024)).toFixed(2))} MB`;

/** What one turn has stored of the agent's own files, against its cap. Shared by every write of the turn. */
export interface AgentOutputTurn {
    saved: number;
    maxFiles: number;
}

/**
 * Stores a file the agent wrote itself (to its sandbox's `/outputs/`, see agentSandboxOutputs.ts, or with
 * `session_files_create`) as a session file of origin `agent_output`. Unlike an upload it needs no
 * `attachments.enabled` and ignores the person's per-session file count and the MIME allow-list (those
 * guard what a person sends). It does need the agent's bucket, and it is held to the same limits an
 * upload is: the file's size (`maxFileBytes`, else the agent's `attachments.maxFileSizeMb`), the turn's
 * file cap (`turn`), and the project's file quotas.
 * Throws on any refusal: the caller keeps a turn alive.
 */
export async function saveAgentOutputFile(input: {
    scope: SessionFileScope;
    conversation: Pick<IAgentConversation, '_id' | 'agentKey'>;
    agentConfig: IAgentConfig | undefined;
    fileName: string;
    contentType: string;
    data: Buffer;
    actorId: string;
    tokenId?: string;
    maxFileBytes?: number;
    turn?: AgentOutputTurn;
}): Promise<IAgentMessageAttachment> {
    const cfg = resolveAttachmentsConfig(input.agentConfig?.attachments);
    const bucketKey = await resolveSessionFilesBucket(input.scope, cfg);
    if (input.data.length > (input.maxFileBytes ?? Math.floor(cfg.maxFileSizeMb * 1024 * 1024))) {
        throw new AgentAttachmentError(413, 'file_too_large', input.maxFileBytes !== undefined
            ? `The file exceeds the ${formatMb(input.maxFileBytes)} limit for files an agent writes.`
            : fileTooLargeMessage(cfg, input.contentType));
    }
    if (input.turn && input.turn.saved >= input.turn.maxFiles) {
        throw new AgentAttachmentError(409, 'too_many_files', `At most ${input.turn.maxFiles} files can be created in one turn.`);
    }
    const db = await tenantDb(input.scope.tenantDbName);
    await assertFileQuotas(db, {
        scope: input.scope,
        bucketKey,
        bytes: input.data.length,
        addedBytes: input.data.length,
        newFile: true,
        actor: { userId: input.actorId, ...(input.tokenId ? { tokenId: input.tokenId } : {}) },
    });
    const conversationId = String(input.conversation._id);
    const result = await uploadFile(input.scope.tenantDbName, input.scope.tenantId, input.scope.projectId, {
        bucketKey,
        fileName: input.fileName,
        contentType: input.contentType,
        data: input.data,
        createdBy: input.actorId,
        // What the agent wrote is stored byte for byte, with no text copy: its own text is already text.
        convertToMarkdown: false,
        keyHint: sessionFileObjectKey({
            folder: cfg.folder,
            agentKey: input.conversation.agentKey,
            conversationId,
            uniqueName: generateFileRelativeKey(input.fileName),
        }),
        recordExtras: {
            purpose: 'conversation',
            conversationId,
            agentKey: input.conversation.agentKey,
            expiresAt: new Date(Date.now() + cfg.retentionDays * 86_400_000),
            uploadedBy: input.actorId,
            origin: 'agent_output',
        },
    });
    if (input.turn) input.turn.saved += 1;
    return { ...toMessageAttachment(result.record), origin: 'agent_output' };
}

/**
 * Adds text to a file the agent wrote earlier in this session (`session_files_append`). Only a file of
 * origin `agent_output` of this agent and session, and only one of the text types the agent may write
 * (so a binary file the sandbox produced is never rewritten as text). The grown file must stay within
 * `maxFileBytes` and the project's storage quota. Throws `AgentAttachmentError` on a refusal.
 */
export async function appendAgentOutputFile(input: {
    scope: SessionFileScope;
    conversation: Pick<IAgentConversation, '_id' | 'agentKey'>;
    fileId: string;
    data: Buffer;
    actorId: string;
    tokenId?: string;
    maxFileBytes: number;
}): Promise<IAgentMessageAttachment> {
    const conversationId = String(input.conversation._id);
    const record = await findSessionFileRecord(input.scope, conversationId, input.fileId);
    if (!record || record.origin !== 'agent_output' || record.agentKey !== input.conversation.agentKey) {
        throw new AgentAttachmentError(404, 'file_not_found', 'Only a file this agent created in this session can be appended to.');
    }
    const extension = record.name.includes('.') ? record.name.split('.').pop()!.toLowerCase() : '';
    if (!FILE_OUTPUT_TYPES[extension]) {
        throw new AgentAttachmentError(415, 'unsupported_file_type', 'Only text files the agent created can be appended to.');
    }
    const grown = record.size + input.data.length;
    if (grown > input.maxFileBytes) {
        throw new AgentAttachmentError(413, 'file_too_large', `The file would exceed the ${formatMb(input.maxFileBytes)} limit for files an agent writes.`);
    }
    const db = await tenantDb(input.scope.tenantDbName);
    await assertFileQuotas(db, {
        scope: input.scope,
        bucketKey: record.bucketKey,
        bytes: grown,
        addedBytes: input.data.length,
        newFile: false,
        actor: { userId: input.actorId, ...(input.tokenId ? { tokenId: input.tokenId } : {}) },
    });
    const current = await downloadFile(input.scope.tenantDbName, input.scope.tenantId, input.scope.projectId, record.bucketKey, record.key);
    const updated = await replaceFileContent(input.scope.tenantDbName, input.scope.tenantId, input.scope.projectId, record.bucketKey, record.key, {
        data: Buffer.concat([current.data, input.data]),
        updatedBy: input.actorId,
        convertToMarkdown: false,
    });
    return { ...toMessageAttachment(updated), origin: 'agent_output' };
}

/**
 * A conversation's files, oldest first. With `withNames` each also says who uploaded it by
 * name (`uploadedByName`) — a screen's wish, so the model's own file tool does not pay for it.
 */
export async function listSessionFiles(
    scope: SessionFileScope,
    conversationId: string,
    options: { withNames?: boolean } = {},
): Promise<SessionFileView[]> {
    const db = await tenantDb(scope.tenantDbName);
    const records = await db.listFileRecordsByConversation(conversationId);
    const views = records.filter((record) => record.projectId === scope.projectId).map(toSessionFileView);
    return options.withNames ? withUploaderNames(scope.tenantDbName, views, { db }) : views;
}

/** The record of a file that belongs to this conversation, else null. */
export async function findSessionFileRecord(
    scope: SessionFileScope,
    conversationId: string,
    fileId: string,
): Promise<IFileRecord | null> {
    const db = await tenantDb(scope.tenantDbName);
    let record: IFileRecord | null = null;
    try {
        record = await db.findFileRecordById(fileId);
    } catch {
        record = null; // a malformed id
    }
    if (!record || record.purpose !== 'conversation' || record.conversationId !== conversationId || record.projectId !== scope.projectId) {
        return null;
    }
    return record;
}

/**
 * Removes a file (object, markdown, row).
 *
 * A bucket or provider that is gone altogether leaves nothing to delete the
 * object from: the row is dropped and the orphaned object logged
 * (`session_file_orphaned`) so the operator can find it. One that is only
 * switched off or unreachable (disabled bucket, inactive or unassigned provider)
 * may come back, so:
 *  - `strict` (a person deleting the file, a session going away) refuses with
 *    `409 storage_unavailable` — the file stays until storage is fixed;
 *  - `sweep` (the retention cleanup) drops it too: retrying every hour would
 *    keep an expired file for ever.
 */
async function removeFileRecord(
    scope: SessionFileScope,
    record: IFileRecord,
    deletedBy: string,
    mode: 'strict' | 'sweep' = 'strict',
): Promise<boolean> {
    const db = await tenantDb(scope.tenantDbName);
    const inspection = await inspectFileBucket(db, scope.tenantId, scope.projectId, record.bucketKey);
    if (!inspection.usable) {
        const gone = inspection.issue === 'bucket_missing' || inspection.issue === 'provider_missing';
        if (!gone && mode === 'strict') throw storageUnavailableError(inspection);
        logger.warn('Dropped a session file whose storage is unavailable; its object is left behind', {
            code: 'session_file_orphaned',
            fileId: String(record._id),
            bucketKey: record.bucketKey,
            providerKey: record.providerKey,
            objectKey: record.key,
            reason: inspection.issue,
        });
        return db.deleteFileRecord(String(record._id));
    }
    try {
        return await deleteFile(scope.tenantDbName, scope.tenantId, scope.projectId, record.bucketKey, record.key, deletedBy);
    } catch (error) {
        // The record or its object is already gone: nothing left to delete.
        if (error instanceof Error && /not found/i.test(error.message)) {
            return db.deleteFileRecord(String(record._id));
        }
        throw error;
    }
}

/** Deletes one session file (object, markdown and row). False when it is not on this session. */
export async function deleteSessionFile(
    scope: SessionFileScope,
    conversationId: string,
    fileId: string,
    deletedBy: string,
): Promise<boolean> {
    const record = await findSessionFileRecord(scope, conversationId, fileId);
    if (!record) return false;
    return removeFileRecord(scope, record, deletedBy);
}

/**
 * Deletes every file of a conversation, for when the conversation goes. A file
 * that cannot be removed now is logged and left for the retention sweep, which
 * retries it once it expires.
 */
export async function deleteConversationFiles(
    tenantDbName: string,
    conversation: Pick<IAgentConversation, '_id' | 'tenantId' | 'projectId'>,
): Promise<number> {
    const db = await tenantDb(tenantDbName);
    let records: IFileRecord[];
    try {
        records = await db.listFileRecordsByConversation(String(conversation._id));
    } catch (error) {
        logger.warn('Could not list the files of a deleted session', { error: error instanceof Error ? error.message : String(error) });
        return 0;
    }
    const scope = { tenantDbName, tenantId: conversation.tenantId, projectId: conversation.projectId };
    let deleted = 0;
    for (const record of records) {
        try {
            if (await removeFileRecord(scope, record, 'system')) deleted += 1;
        } catch (error) {
            logger.warn('Could not delete a session file with its session', {
                fileId: String(record._id),
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return deleted;
}

/**
 * Deletes session files past their `expiresAt` (object + markdown + row), a
 * batch at a time. Returns how many it deleted. A file that cannot be deleted
 * is logged and tried again on the next sweep — but it does not hold the sweep
 * up: the batches of one sweep skip what already failed (each batch asks for
 * that many more rows), so a hundred stuck files at the head of the queue never
 * keep the ones behind them from being reached. A file whose storage is gone for
 * good is dropped (`removeFileRecord` in sweep mode).
 */
export async function cleanupExpiredSessionFiles(
    db: DatabaseProvider,
    tenantDbName: string,
    now: Date,
    options: { batchSize?: number; maxBatches?: number } = {},
): Promise<number> {
    const batchSize = options.batchSize ?? 200;
    const failed = new Set<string>();
    let deleted = 0;
    for (let batch = 0; batch < (options.maxBatches ?? 5); batch += 1) {
        const asked = batchSize + failed.size;
        const fetched = await db.listExpiredConversationFiles(now, asked);
        for (const record of fetched) {
            const id = String(record._id);
            if (failed.has(id)) continue;
            if (!record.projectId) {
                failed.add(id); // not scoped to a project: nothing to resolve its storage with
                continue;
            }
            try {
                const scope = { tenantDbName, tenantId: record.tenantId, projectId: record.projectId };
                if (await removeFileRecord(scope, record, 'system', 'sweep')) deleted += 1;
            } catch (error) {
                failed.add(id);
                logger.warn('Could not delete an expired session file', {
                    fileId: id,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        if (fetched.length < asked) break;
    }
    return deleted;
}

/**
 * The files of a session that no message has carried yet, oldest first: what
 * `attachNewUploads` puts on the next message. "Carried" = named in the
 * `attachments` of a message the session already holds.
 */
export async function findUnsentSessionFiles(
    scope: SessionFileScope,
    conversation: Pick<IAgentConversation, '_id' | 'messages'> & Partial<Pick<IAgentConversation, 'metadata'>>,
): Promise<IFileRecord[]> {
    const db = await tenantDb(scope.tenantDbName);
    const carried = new Set<string>();
    for (const message of conversation.messages ?? []) {
        for (const attachment of message.attachments ?? []) carried.add(attachment.fileId);
    }
    // Files of messages that were cut from the transcript (truncate / regenerate / edit) were sent already.
    const sent = conversation.metadata?.sentFileIds;
    if (Array.isArray(sent)) for (const fileId of sent) if (typeof fileId === 'string') carried.add(fileId);
    const files = await db.listFileRecordsByConversation(String(conversation._id));
    // A file the agent wrote reaches the person on the answer that carries it; it never rides on their next message.
    return files.filter((record) => record.purpose === 'conversation'
        && record.origin !== 'agent_output'
        && record.projectId === scope.projectId
        && !carried.has(String(record._id)));
}

/** What a conversation holds, for deciding which read tools are offered. */
export interface SessionFileFacts {
    /** Holds at least one file. */
    any: boolean;
    /** Holds at least one image a model request can carry (`isSendableImageMime`). */
    images: boolean;
}

export async function conversationFileFacts(db: DatabaseProvider, conversationId: string | undefined): Promise<SessionFileFacts> {
    if (!conversationId) return { any: false, images: false };
    try {
        const records = await db.listFileRecordsByConversation(conversationId);
        return { any: records.length > 0, images: records.some((record) => isSendableImageMime(record.contentType)) };
    } catch (error) {
        logger.debug('Could not look up session files', { error: error instanceof Error ? error.message : String(error) });
        return { any: false, images: false };
    }
}

/** Whether a conversation holds any file — decides whether the read tools are offered. */
export async function conversationHasFiles(db: DatabaseProvider, conversationId: string | undefined): Promise<boolean> {
    return (await conversationFileFacts(db, conversationId)).any;
}

// ── Serving a file's bytes ──────────────────────────────────────────────────

export type SessionFileVariant = 'original' | 'markdown';
export type SessionFileDisposition = 'inline' | 'attachment';

/** Types a browser may show in place when asked to. Everything else is offered as a download. */
const INLINE_SAFE_TYPES = [
    /^image\/(png|jpe?g|gif|webp|avif|bmp)$/,
    /^application\/pdf$/,
    /^text\/(plain|markdown|csv)$/,
    /^application\/json$/,
];

function baseType(contentType: string): string {
    return contentType.split(';')[0]!.trim().toLowerCase();
}

/**
 * How a file is offered: pictures open in place, everything else downloads
 * unless the caller asks for `inline` AND the type is one a browser shows
 * without running anything. SVG, HTML and the other active types always
 * download — an uploaded file is served from the console's own origin.
 */
export function sessionFileDisposition(contentType: string, requested?: SessionFileDisposition): SessionFileDisposition {
    const type = baseType(contentType);
    const safe = INLINE_SAFE_TYPES.some((pattern) => pattern.test(type));
    if (!safe) return 'attachment';
    if (requested) return requested;
    return type.startsWith('image/') ? 'inline' : 'attachment';
}

/**
 * `Content-Disposition` for a file name from the outside: control characters,
 * quotes, slashes and `;` out of the plain `filename`, non-ASCII kept in the
 * RFC 5987 `filename*` form.
 */
export function contentDispositionHeader(disposition: SessionFileDisposition, fileName: string): string {
    const cleaned = fileName.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '_').trim().slice(0, 180) || 'file';
    const ascii = cleaned.replace(/[^\x20-\x7e]/g, '_').replace(/["%;]/g, '_');
    const encoded = encodeURIComponent(cleaned).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export interface SessionFileContent {
    data: Buffer;
    contentType: string;
    disposition: SessionFileDisposition;
    /** The `Content-Disposition` header value. */
    contentDisposition: string;
    size: number;
}

/**
 * A file of the session read from its bucket, ready to send: the original, or
 * the markdown it was converted to. Null when the file is not on this session.
 * `409 markdown_unavailable` for a markdown variant that does not exist.
 */
export async function readSessionFileContent(
    scope: SessionFileScope,
    conversationId: string,
    fileId: string,
    options: { variant?: SessionFileVariant; disposition?: SessionFileDisposition } = {},
): Promise<SessionFileContent | null> {
    const record = await findSessionFileRecord(scope, conversationId, fileId);
    if (!record) return null;
    const variant = options.variant ?? 'original';
    if (variant === 'markdown' && !(record.markdownStatus === 'succeeded' && record.markdownKey)) {
        throw new AgentAttachmentError(409, 'markdown_unavailable', 'This file has no text version.');
    }
    const result = await downloadFile(scope.tenantDbName, scope.tenantId, scope.projectId, record.bucketKey, record.key, { variant });
    const data = Buffer.from(result.data as Uint8Array);
    const contentType = variant === 'markdown'
        ? 'text/markdown; charset=utf-8'
        : (record.contentType || result.contentType || 'application/octet-stream');
    const disposition = sessionFileDisposition(contentType, options.disposition);
    return {
        data,
        contentType,
        disposition,
        contentDisposition: contentDispositionHeader(disposition, variant === 'markdown' ? (result.fileName || record.name) : record.name),
        size: data.length,
    };
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** The file as text: its markdown when converted, else the bytes of a plain-text file, else null. */
async function readFileText(scope: SessionFileScope, record: IFileRecord): Promise<string | null> {
    if (isImageMime(record.contentType)) return null;
    if (record.markdownStatus === 'succeeded' && record.markdownKey) {
        const markdown = await downloadFile(scope.tenantDbName, scope.tenantId, scope.projectId, record.bucketKey, record.key, { variant: 'markdown' });
        return markdown.data.toString('utf8');
    }
    // A file the agent wrote is text of a type it may write (yaml included) and has no converted copy: read the bytes.
    if (isPlainTextMime(record.contentType) || record.origin === 'agent_output') {
        const original = await downloadFile(scope.tenantDbName, scope.tenantId, scope.projectId, record.bucketKey, record.key);
        return original.data.toString('utf8');
    }
    return null;
}

/** An image of the session read from its bucket, ready for the model call. */
export interface SessionImageBytes {
    base64: string;
    mediaType: string;
    /** Size of the original, before base64. */
    bytes: number;
}

/**
 * The image's bytes, read only at the model call (`sessionImages.ts`). The
 * native providers take them as a `{ type: 'image', source: { base64 } }` part
 * and render the provider's own wire form.
 */
export async function readSessionImage(scope: SessionFileScope, record: IFileRecord): Promise<SessionImageBytes> {
    // Only a format the providers accept goes out as a media type; anything else would fail the request.
    const mediaType = sendableImageType(record.contentType);
    if (!mediaType) throw new Error(`"${record.name}" is not an image format the model can be shown.`);
    const original = await downloadFile(scope.tenantDbName, scope.tenantId, scope.projectId, record.bucketKey, record.key);
    return {
        base64: original.data.toString('base64'),
        mediaType,
        bytes: original.data.length,
    };
}

/**
 * The model wrapper's view of a session's images (`sessionImages.ts`): a file
 * is an image of THIS session or it does not exist for the model, and the bytes
 * come from the bucket the moment the model is called.
 */
export function createSessionImageSource(scope: SessionFileScope, conversationId: string): SessionImageSource {
    const records = new Map<string, IFileRecord>();
    return {
        async find(fileId) {
            const record = await findSessionFileRecord(scope, conversationId, fileId);
            if (!record || !isSendableImageMime(record.contentType)) return null;
            records.set(fileId, record);
            return { name: record.name, size: record.size };
        },
        async read(fileId) {
            const record = records.get(fileId) ?? await findSessionFileRecord(scope, conversationId, fileId);
            if (!record) throw new Error(`Image "${fileId}" is not a file of this session.`);
            const image = await readSessionImage(scope, record);
            return { base64: image.base64, mediaType: image.mediaType };
        },
    };
}

/** An image in the user turn: a reference, never the bytes (see `sessionAttachmentText.ts`). */
export type ImagePart = ImageReferencePart;

export interface AssembledAttachments {
    /** Text appended to the person's message (starts with `ATTACHMENT_BLOCK_MARKER`); '' when there is nothing to add. */
    block: string;
    /** The images the model is shown, as references. */
    images: ImagePart[];
    /** What the user message persists. */
    attachments: IAgentMessageAttachment[];
    /** `inline` = the documents are in the turn; `paged` = the agent reads them with the tools. */
    mode: 'none' | 'inline' | 'paged';
    warnings: string[];
}

export const NO_ATTACHMENTS: AssembledAttachments = { block: '', images: [], attachments: [], mode: 'none', warnings: [] };

/**
 * The records a message attaches, checked to be files of THIS session. Throws
 * `AgentAttachmentError` (404) for an id that is not — before anything runs.
 */
export async function resolveTurnAttachments(
    scope: SessionFileScope,
    conversationId: string,
    fileIds: string[],
): Promise<IFileRecord[]> {
    const records: IFileRecord[] = [];
    for (const fileId of [...new Set(fileIds)]) {
        const record = await findSessionFileRecord(scope, conversationId, fileId);
        if (!record) {
            throw new AgentAttachmentError(404, 'attachment_not_found', `Attachment "${fileId}" is not a file of this session. Upload it to the session first.`);
        }
        records.push(record);
    }
    return records;
}

/**
 * The user turn's attachments, ready for the model — see the file header for the
 * inline / paged / image rules. A document that cannot be read is reported in
 * the turn and in `warnings`; it never fails the turn. Images are not read here
 * at all: they are references, read when the model is called.
 */
export async function assembleTurnAttachments(input: {
    scope: SessionFileScope;
    records: IFileRecord[];
    cfg: ResolvedAttachmentsConfig;
    /** The agent's model accepts image input. */
    supportsVision: boolean;
}): Promise<AssembledAttachments> {
    const { scope, records, cfg } = input;
    if (records.length === 0) return NO_ATTACHMENTS;

    const warnings: string[] = [];
    const imageNotes: string[] = [];
    const unsupportedNotes: string[] = [];
    const images: ImagePart[] = [];
    const documents: Array<{ record: IFileRecord; id: string; text: string | null }> = [];

    for (const record of records) {
        const id = String(record._id);
        if (isSendableImageMime(record.contentType)) {
            if (!input.supportsVision) {
                imageNotes.push(`[Image "${escapeAttribute(record.name)}" (id ${id}) is attached, but this model cannot read images.]`);
                continue;
            }
            images.push(imageReferencePart(id, record.name));
            continue;
        }
        if (isImageMime(record.contentType)) {
            // A picture in a format no provider takes (tiff, svg, heic, ...): kept as a file with no text.
            unsupportedNotes.push(unsupportedImageNote({ name: record.name, fileId: id, mimeType: record.contentType ?? 'image' }));
            continue;
        }
        let text: string | null = null;
        try {
            text = await readFileText(scope, record);
        } catch (error) {
            warnings.push(`File "${record.name}" could not be read.`);
            logger.warn('Could not read a session file', { fileId: id, error: error instanceof Error ? error.message : String(error) });
        }
        documents.push({ record, id, text });
    }

    const readable = documents.filter((doc): doc is typeof doc & { text: string } => doc.text !== null);
    const unreadable = documents.filter((doc) => doc.text === null);
    const totalTokens = estimateTokens(readable.reduce((sum, doc) => sum + doc.text.length, 0));
    const inline = readable.length > 0 && totalTokens <= cfg.inlineMaxTokens;

    // The first line names every attachment by kind, whatever the mix — also a message of images only.
    const lines: string[] = [attachmentSummaryLine({
        documentsInline: inline ? readable.length : 0,
        documentsPaged: inline ? 0 : readable.length,
        documentsUnreadable: unreadable.length,
        imagesShown: images.length,
        imagesHidden: imageNotes.length,
        imagesUnsupported: unsupportedNotes.length,
    })];
    if (inline) {
        for (const doc of readable) {
            lines.push(`<document name="${escapeAttribute(doc.record.name)}" id="${doc.id}">\n${doc.text}\n</document>`);
        }
    } else if (readable.length > 0) {
        lines.push(
            `The person attached ${readable.length} file${readable.length === 1 ? '' : 's'} that ${readable.length === 1 ? 'is' : 'are'} too long to include here`
            + ` (about ${totalTokens} tokens; the limit for inlining is ${cfg.inlineMaxTokens}). Read ${readable.length === 1 ? 'it' : 'them'} with`
            + ` ${SESSION_FILES_LIST_TOOL} and ${SESSION_FILES_READ_TOOL}({ fileId, page }):`,
            ...readable.map((doc) => `- "${escapeAttribute(doc.record.name)}" (id ${doc.id}, ${pageCount(doc.text.length, cfg.readPageChars)} page${pageCount(doc.text.length, cfg.readPageChars) === 1 ? '' : 's'})`),
        );
    }
    for (const doc of unreadable) {
        lines.push(`[File "${escapeAttribute(doc.record.name)}" (id ${doc.id}) is attached, but its text could not be extracted (${doc.record.markdownStatus}).]`);
    }
    lines.push(...imageNotes, ...unsupportedNotes);

    return {
        block: wrapAttachmentBlock(lines),
        images,
        attachments: records.map(toMessageAttachment),
        mode: readable.length === 0 ? 'none' : inline ? 'inline' : 'paged',
        warnings,
    };
}

/**
 * The content of the user turn: the text alone (unchanged) or the text followed
 * by each image's handle and reference — the handle is what the model, and the
 * summary of a long conversation, can name the picture by.
 */
export function buildUserTurnContent(userMessage: string, assembled: AssembledAttachments): string | ContentPart[] {
    const text = `${userMessage}${assembled.block}`;
    if (assembled.images.length === 0) return text;
    return [
        { type: 'text', text },
        ...assembled.images.flatMap((image): ContentPart[] => [
            { type: 'text', text: imageAnchorText(image.name, image.fileId) },
            image,
        ]),
    ];
}

// ── Tools ───────────────────────────────────────────────────────────────────

export interface SessionFileToolDeps {
    createToolFn: typeof CreateSdkTool;
    zod: typeof import('zod').z;
    guard: {
        protect<A extends Record<string, unknown>, R>(
            spec: { name: string; requestedName: string },
            execute: (safeArgs: A) => Promise<R>,
        ): (args: A) => Promise<R | string>;
    };
    scope: SessionFileScope;
    conversationId: string;
    readPageChars: number;
    /** Offer `session_files_view_image`: the session holds an image and the model takes images. */
    viewImage?: boolean;
}

/**
 * `session_files_list` and `session_files_read` — the only way the agent reads
 * a file too long to be in the turn, and a way back to an earlier upload — and,
 * when images can be looked at, `session_files_view_image`. Read-only, and
 * scoped to this conversation's files.
 */
export function buildSessionFileTools(deps: SessionFileToolDeps): AgentSdkToolInterface[] {
    const { createToolFn, zod, guard, scope, conversationId, readPageChars } = deps;

    const list = createToolFn({
        name: SESSION_FILES_LIST_TOOL,
        description: 'List the files attached to this conversation, with their ids. Use it to find a file before reading it.',
        schema: zod.object({}),
        func: guard.protect(
            { name: 'agent.session_files.list', requestedName: SESSION_FILES_LIST_TOOL },
            async () => {
                const files = await listSessionFiles(scope, conversationId);
                if (files.length === 0) return 'No files are attached to this conversation.';
                return JSON.stringify(files.map((file) => ({
                    fileId: file.id,
                    name: file.name,
                    mimeType: file.mimeType,
                    size: file.size,
                    readable: file.conversionStatus === 'succeeded' && !isImageMime(file.mimeType),
                    ...(isSendableImageMime(file.mimeType) ? { image: true } : {}),
                })));
            },
        ),
    }) as AgentSdkToolInterface;

    const read = createToolFn({
        name: SESSION_FILES_READ_TOOL,
        description: [
            'Read one page of a file attached to this conversation, as text.',
            `A page is up to ${readPageChars} characters. The result is { text, page, pages }; ask for the next page until you have what you need.`,
        ].join(' '),
        schema: zod.object({
            fileId: zod.string().describe('The file id, from session_files_list or the attachment note.'),
            page: zod.number().int().min(1).optional().describe('Page number, starting at 1 (default 1).'),
        }),
        func: guard.protect(
            { name: 'agent.session_files.read', requestedName: SESSION_FILES_READ_TOOL },
            async (args: { fileId?: string; page?: number }) => {
                const fileId = typeof args.fileId === 'string' ? args.fileId : '';
                const record = fileId ? await findSessionFileRecord(scope, conversationId, fileId) : null;
                if (!record) return `File "${fileId}" is not attached to this conversation. Use ${SESSION_FILES_LIST_TOOL} to see the files.`;
                let text: string | null;
                try {
                    text = await readFileText(scope, record);
                } catch (error) {
                    logger.warn('session_files_read failed', { fileId, error: error instanceof Error ? error.message : String(error) });
                    return 'The file could not be read right now.';
                }
                if (text === null) {
                    if (isSendableImageMime(record.contentType)) {
                        return deps.viewImage
                            ? `This file is an image; it has no text to read. Use ${SESSION_FILES_VIEW_IMAGE_TOOL} to look at it.`
                            : 'This file is an image; it has no text to read.';
                    }
                    if (isImageMime(record.contentType)) {
                        return 'This file is an image in a format the model cannot be shown; it has no text to read.';
                    }
                    return 'This file has no readable text (it could not be converted).';
                }
                const page = pageText(text, args.page ?? 1, readPageChars);
                if (!page) return JSON.stringify({ error: `Page ${args.page} is out of range.`, pages: pageCount(text.length, readPageChars) });
                return JSON.stringify(page);
            },
        ),
    }) as AgentSdkToolInterface;

    const tools = [list, read];
    if (deps.viewImage) {
        // The result only names the image; the model wrapper (`sessionImages.ts`) puts the
        // picture itself in front of the model in a message that follows it — a tool result
        // can only be text on the providers' wire.
        tools.push(createToolFn({
            name: SESSION_FILES_VIEW_IMAGE_TOOL,
            description: [
                'Look at an image attached to this conversation again. The image is shown to you in the message that follows the result.',
                'Use it when an earlier image is no longer visible to you, or to check a detail you are unsure of.',
            ].join(' '),
            schema: zod.object({
                fileId: zod.string().describe('The image file id, from session_files_list or the [Attached image: …] handle.'),
            }),
            func: guard.protect(
                { name: 'agent.session_files.view_image', requestedName: SESSION_FILES_VIEW_IMAGE_TOOL },
                async (args: { fileId?: string }) => {
                    const fileId = typeof args.fileId === 'string' ? args.fileId : '';
                    const record = fileId ? await findSessionFileRecord(scope, conversationId, fileId) : null;
                    if (!record) return `File "${fileId}" is not attached to this conversation. Use ${SESSION_FILES_LIST_TOOL} to see the files.`;
                    if (!isSendableImageMime(record.contentType)) {
                        return isImageMime(record.contentType)
                            ? `"${record.name}" is an image in a format the model cannot be shown.`
                            : `"${record.name}" is not an image. Use ${SESSION_FILES_READ_TOOL} to read it.`;
                    }
                    return viewImageToolResult(String(record._id), record.name);
                },
            ),
        }) as AgentSdkToolInterface);
    }
    return tools;
}

export function sessionFileToolDefinitions(readPageChars: number, options: { viewImage?: boolean } = {}): TraceToolDefinition[] {
    return [
        {
            name: SESSION_FILES_LIST_TOOL,
            description: 'List the files attached to this conversation, with their ids.',
            parameters: { type: 'object', properties: {} },
        },
        {
            name: SESSION_FILES_READ_TOOL,
            description: `Read one page (up to ${readPageChars} characters) of an attached file as text.`,
            parameters: {
                type: 'object',
                properties: {
                    fileId: { type: 'string', description: 'The file id.' },
                    page: { type: 'number', description: 'Page number, starting at 1 (default 1).' },
                },
                required: ['fileId'],
            },
        },
        ...(options.viewImage
            ? [{
                name: SESSION_FILES_VIEW_IMAGE_TOOL,
                description: 'Look at an attached image again; the image is shown in the message that follows.',
                parameters: {
                    type: 'object',
                    properties: { fileId: { type: 'string', description: 'The image file id.' } },
                    required: ['fileId'],
                },
            }]
            : []),
    ];
}
