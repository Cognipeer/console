/**
 * Session files: documents and images a user attaches to an agent session.
 *
 * A session file is an ordinary file record (`IFileRecord`) tagged
 * `purpose: 'conversation'` and the conversation it belongs to, stored in the
 * project's system `conversation-files` bucket on the built-in storage (or the
 * bucket the agent's `attachments.bucketKey` names). The original is kept and
 * converted to markdown by the same file service every other upload uses, so
 * the quota checks, the provider drivers and the Files screens all apply.
 *
 * Using the files in a turn (`assembleTurnAttachments`):
 *  - The markdown of the files attached to THIS message is put in the user turn
 *    as `<document name="…" id="…">…</document>` blocks when it fits
 *    `inlineMaxTokens` (estimated chars / 4). Otherwise the turn carries a short
 *    note listing the files and the agent reads them in pages with
 *    `session_files_list` / `session_files_read`.
 *  - Images become image parts when the model accepts images, else a text note.
 *  - Everything added to the user text sits after `ATTACHMENT_BLOCK_MARKER`, so
 *    the transcript can persist the text the person typed
 *    (`stripAttachmentBlock`) while the model works from the full turn.
 *
 * The two tools are present whenever the conversation has files — a later turn
 * can read an earlier upload — and both are read-only (`HITL_READ_ONLY_TOOLS`).
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
    createFileBucket,
    deleteFile,
    downloadFile,
    uploadFile,
} from '@/lib/services/files';
import { BUILTIN_FILE_PROVIDER_KEY, ensureBuiltinProviders } from '@/lib/services/providers/builtinProviders';
import { checkPerRequestLimits, checkRateLimit, checkResourceQuota } from '@/lib/quota/quotaGuard';
import type { LicenseType } from '@/lib/license/license-manager';
import type { TraceToolDefinition } from '@/lib/services/tracingToolDefinitions';
import { AgentAttachmentError } from './agentErrors';
import {
    SESSION_FILES_DEFAULTS,
    SESSION_FILES_LIST_TOOL,
    SESSION_FILES_READ_TOOL,
    agentTakesAttachments,
    isImageMime,
    isMimeAllowed,
    resolveAttachmentsConfig,
    type ResolvedAttachmentsConfig,
} from './sessionFilesConfig';

/**
 * Everything the turn adds to the person's text starts here. The transcript
 * keeps only what came before it (`stripAttachmentBlock`).
 */
export const ATTACHMENT_BLOCK_MARKER = '\n\n<attachments source="session-files">\n';
const ATTACHMENT_BLOCK_END = '\n</attachments>';

export {
    SESSION_FILES_DEFAULTS,
    SESSION_FILES_LIST_TOOL,
    SESSION_FILES_READ_TOOL,
    agentTakesAttachments,
    isImageMime,
    isMimeAllowed,
    resolveAttachmentsConfig,
    type ResolvedAttachmentsConfig,
};

const logger = createLogger('agent-session-files');

/** Key of the per-project system bucket session files are stored in. */
export const CONVERSATION_FILES_BUCKET_KEY = 'conversation-files';

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
    createdAt?: Date;
    expiresAt?: Date | null;
    uploadedBy?: string;
}

export function toSessionFileView(record: Pick<
    IFileRecord,
    '_id' | 'name' | 'contentType' | 'size' | 'markdownStatus' | 'markdownError' | 'createdAt' | 'expiresAt' | 'uploadedBy'
> & { id?: string }): SessionFileView {
    return {
        id: record.id ?? String(record._id),
        name: record.name,
        mimeType: record.contentType ?? 'application/octet-stream',
        size: record.size,
        conversionStatus: record.markdownStatus,
        ...(record.markdownError ? { conversionError: record.markdownError } : {}),
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

function isAlreadyExistsError(error: unknown): boolean {
    return error instanceof Error && /already exists/i.test(error.message);
}

/**
 * The bucket new session files go to: the agent's own `attachments.bucketKey`,
 * else the project's system `conversation-files` bucket — created on the
 * built-in storage the first time it is needed.
 */
export async function resolveSessionFilesBucket(
    scope: SessionFileScope,
    cfg: ResolvedAttachmentsConfig,
    userId: string,
): Promise<string> {
    if (cfg.bucketKey) return cfg.bucketKey;
    const db = await tenantDb(scope.tenantDbName);
    const existing = await db.findFileBucketByKey(scope.tenantId, CONVERSATION_FILES_BUCKET_KEY, scope.projectId);
    if (existing) return CONVERSATION_FILES_BUCKET_KEY;

    await ensureBuiltinProviders(scope.tenantDbName, scope.tenantId, scope.projectId, userId);
    try {
        await createFileBucket(scope.tenantDbName, scope.tenantId, scope.projectId, {
            key: CONVERSATION_FILES_BUCKET_KEY,
            name: 'Conversation files',
            providerKey: BUILTIN_FILE_PROVIDER_KEY,
            description: 'Files attached to agent sessions. Managed by the platform; expired files are removed automatically.',
            metadata: { system: true },
            createdBy: userId,
        });
    } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
    }
    return CONVERSATION_FILES_BUCKET_KEY;
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
    const cfg = resolveAttachmentsConfig(agentConfig?.attachments);
    if (!agentTakesAttachments(agentConfig)) {
        throw new AgentAttachmentError(403, 'attachments_disabled', 'This agent does not take attachments.');
    }

    const maxBytes = Math.floor(cfg.maxFileSizeMb * 1024 * 1024);
    const declaredBytes = typeof input.data === 'string' ? estimateBase64Size(input.data) : input.data.length;
    if (declaredBytes > maxBytes) {
        throw new AgentAttachmentError(413, 'file_too_large', `File exceeds the ${cfg.maxFileSizeMb} MB limit of this agent.`);
    }
    if (declaredBytes === 0) {
        throw new AgentAttachmentError(400, 'empty_file', 'The file is empty.');
    }

    const mimeType = resolveUploadMimeType(input.contentType, input.fileName);
    if (!isMimeAllowed(mimeType, cfg.allowedMimeTypes)) {
        throw new AgentAttachmentError(415, 'unsupported_file_type', `Files of type "${mimeType}" are not accepted by this agent.`);
    }

    const conversationId = String(conversation._id);
    const db = await tenantDb(scope.tenantDbName);
    const held = await db.listFileRecordsByConversation(conversationId);
    if (held.length >= cfg.maxFiles) {
        throw new AgentAttachmentError(409, 'too_many_files', `A session holds at most ${cfg.maxFiles} files. Delete one to attach another.`);
    }

    const bucketKey = await resolveSessionFilesBucket(scope, cfg, actor.userId);

    const quotaContext = {
        domain: 'file' as const,
        licenseType: actor.licenseType as LicenseType,
        projectId: scope.projectId,
        resourceKey: bucketKey,
        tenantDbName: scope.tenantDbName,
        tenantId: scope.tenantId,
        ...(actor.tokenId ? { tokenId: actor.tokenId } : {}),
        userId: actor.userId,
    };
    const perRequest = await checkPerRequestLimits(quotaContext, { fileSize: declaredBytes, filesPerRequest: 1 });
    if (!perRequest.allowed) {
        throw new AgentAttachmentError(429, 'quota_exceeded', perRequest.reason || 'Quota exceeded');
    }
    const rate = await checkRateLimit(quotaContext, { files: 1, requests: 1, storageBytes: declaredBytes });
    if (!rate.allowed) {
        throw new AgentAttachmentError(429, 'quota_exceeded', rate.reason || 'Rate limit exceeded');
    }
    const resource = await checkResourceQuota(quotaContext, 'filesTotal', await db.countFileRecords({ projectId: scope.projectId }));
    if (!resource.allowed) {
        throw new AgentAttachmentError(429, 'quota_exceeded', resource.reason || 'File quota exceeded');
    }
    const storageLimit = perRequest.effectiveLimits.quotas?.maxStorageBytes;
    if (storageLimit !== undefined && storageLimit !== -1) {
        const projected = (await db.sumFileRecordBytes({ projectId: scope.projectId })) + declaredBytes;
        if (projected > storageLimit) {
            throw new AgentAttachmentError(429, 'quota_exceeded', `storageBytes limit exceeded (${projected}/${storageLimit})`);
        }
    }

    const buffer = typeof input.data === 'string' ? decodeBase64(input.data) : input.data;
    // The estimate above is for a string; the decoded size is what is stored.
    if (buffer.length > maxBytes) {
        throw new AgentAttachmentError(413, 'file_too_large', `File exceeds the ${cfg.maxFileSizeMb} MB limit of this agent.`);
    }

    const result = await uploadFile(scope.tenantDbName, scope.tenantId, scope.projectId, {
        bucketKey,
        fileName: input.fileName,
        contentType: mimeType,
        data: buffer,
        createdBy: actor.userId,
        // An image has no text to convert; the model reads the original.
        convertToMarkdown: !isImageMime(mimeType),
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

/** A conversation's files, oldest first. */
export async function listSessionFiles(scope: SessionFileScope, conversationId: string): Promise<SessionFileView[]> {
    const db = await tenantDb(scope.tenantDbName);
    const records = await db.listFileRecordsByConversation(conversationId);
    return records.filter((record) => record.projectId === scope.projectId).map(toSessionFileView);
}

/** The record of a file that belongs to this conversation, else null. */
async function findSessionFile(
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

async function removeFileRecord(scope: SessionFileScope, record: IFileRecord, deletedBy: string): Promise<boolean> {
    try {
        return await deleteFile(scope.tenantDbName, scope.tenantId, scope.projectId, record.bucketKey, record.key, deletedBy);
    } catch (error) {
        // The bucket or provider is gone: nothing left to delete the object from.
        if (error instanceof Error && /not found/i.test(error.message)) {
            const db = await tenantDb(scope.tenantDbName);
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
    const record = await findSessionFile(scope, conversationId, fileId);
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
 * batch at a time. Returns how many it deleted. A file that cannot be deleted is
 * logged and tried again on the next sweep.
 */
export async function cleanupExpiredSessionFiles(
    db: DatabaseProvider,
    tenantDbName: string,
    now: Date,
    options: { batchSize?: number; maxBatches?: number } = {},
): Promise<number> {
    const batchSize = options.batchSize ?? 200;
    let deleted = 0;
    for (let batch = 0; batch < (options.maxBatches ?? 5); batch += 1) {
        const expired = await db.listExpiredConversationFiles(now, batchSize);
        for (const record of expired) {
            if (!record.projectId) continue;
            try {
                const scope = { tenantDbName, tenantId: record.tenantId, projectId: record.projectId };
                if (await removeFileRecord(scope, record, 'system')) deleted += 1;
            } catch (error) {
                logger.warn('Could not delete an expired session file', {
                    fileId: String(record._id),
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        if (expired.length < batchSize) break;
    }
    return deleted;
}

/** Whether a conversation holds any file — decides whether the read tools are offered. */
export async function conversationHasFiles(db: DatabaseProvider, conversationId: string | undefined): Promise<boolean> {
    if (!conversationId) return false;
    try {
        return (await db.listFileRecordsByConversation(conversationId)).length > 0;
    } catch (error) {
        logger.debug('Could not look up session files', { error: error instanceof Error ? error.message : String(error) });
        return false;
    }
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** The file as text: its markdown when converted, else the bytes of a plain-text file, else null. */
async function readFileText(scope: SessionFileScope, record: IFileRecord): Promise<string | null> {
    if (isImageMime(record.contentType)) return null;
    if (record.markdownStatus === 'succeeded' && record.markdownKey) {
        const markdown = await downloadFile(scope.tenantDbName, scope.tenantId, scope.projectId, record.bucketKey, record.key, { variant: 'markdown' });
        return markdown.data.toString('utf8');
    }
    if (isPlainTextMime(record.contentType)) {
        const original = await downloadFile(scope.tenantDbName, scope.tenantId, scope.projectId, record.bucketKey, record.key);
        return original.data.toString('utf8');
    }
    return null;
}

/**
 * The image as the SDK's `{ base64, media_type }` part. Not a `data:` URL: the
 * SDK renders a URL image as text wherever it measures or logs content
 * (`[image:<url>]`), which for a data URL would be the whole file; this form
 * stays `[image:unknown]` and is turned into the provider's data URL only at the
 * model call.
 */
async function readImagePart(scope: SessionFileScope, record: IFileRecord): Promise<ImagePart> {
    const original = await downloadFile(scope.tenantDbName, scope.tenantId, scope.projectId, record.bucketKey, record.key);
    return { type: 'image_url', image_url: { base64: original.data.toString('base64'), media_type: record.contentType ?? 'image/png' } };
}

export type ImagePart = { type: 'image_url'; image_url: { base64: string; media_type: string } };

export interface AssembledAttachments {
    /** Text appended to the person's message (starts with `ATTACHMENT_BLOCK_MARKER`); '' when there is nothing to add. */
    block: string;
    images: ImagePart[];
    /** What the user message persists. */
    attachments: IAgentMessageAttachment[];
    /** `inline` = the documents are in the turn; `paged` = the agent reads them with the tools. */
    mode: 'none' | 'inline' | 'paged';
    warnings: string[];
}

export const NO_ATTACHMENTS: AssembledAttachments = { block: '', images: [], attachments: [], mode: 'none', warnings: [] };

function escapeAttribute(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
        const record = await findSessionFile(scope, conversationId, fileId);
        if (!record) {
            throw new AgentAttachmentError(404, 'attachment_not_found', `Attachment "${fileId}" is not a file of this session. Upload it to the session first.`);
        }
        records.push(record);
    }
    return records;
}

/**
 * The user turn's attachments, ready for the model — see the file header for the
 * inline / paged / image rules. A file that cannot be read is reported in the
 * turn and in `warnings`; it never fails the turn.
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
    const notes: string[] = [];
    const images: ImagePart[] = [];
    const documents: Array<{ record: IFileRecord; id: string; text: string | null }> = [];

    for (const record of records) {
        const id = String(record._id);
        if (isImageMime(record.contentType)) {
            if (!input.supportsVision) {
                notes.push(`[Image "${escapeAttribute(record.name)}" (id ${id}) is attached, but this model cannot read images.]`);
                continue;
            }
            try {
                images.push(await readImagePart(scope, record));
            } catch (error) {
                warnings.push(`Image "${record.name}" could not be read.`);
                notes.push(`[Image "${escapeAttribute(record.name)}" (id ${id}) is attached but could not be read.]`);
                logger.warn('Could not read a session image', { fileId: id, error: error instanceof Error ? error.message : String(error) });
            }
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
    const totalTokens = estimateTokens(readable.reduce((sum, doc) => sum + doc.text.length, 0));
    const inline = readable.length > 0 && totalTokens <= cfg.inlineMaxTokens;

    const blocks: string[] = [];
    if (inline) {
        for (const doc of readable) {
            blocks.push(`<document name="${escapeAttribute(doc.record.name)}" id="${doc.id}">\n${doc.text}\n</document>`);
        }
    } else if (readable.length > 0) {
        blocks.push(
            `The person attached ${readable.length} file${readable.length === 1 ? '' : 's'} that ${readable.length === 1 ? 'is' : 'are'} too long to include here`
            + ` (about ${totalTokens} tokens; the limit for inlining is ${cfg.inlineMaxTokens}). Read ${readable.length === 1 ? 'it' : 'them'} with`
            + ` ${SESSION_FILES_LIST_TOOL} and ${SESSION_FILES_READ_TOOL}({ fileId, page }):`,
            ...readable.map((doc) => `- "${escapeAttribute(doc.record.name)}" (id ${doc.id}, ${pageCount(doc.text.length, cfg.readPageChars)} page${pageCount(doc.text.length, cfg.readPageChars) === 1 ? '' : 's'})`),
        );
    }
    for (const doc of documents.filter((entry) => entry.text === null)) {
        blocks.push(`[File "${escapeAttribute(doc.record.name)}" (id ${doc.id}) is attached, but its text could not be extracted (${doc.record.markdownStatus}).]`);
    }
    blocks.push(...notes);

    return {
        block: blocks.length > 0 ? `${ATTACHMENT_BLOCK_MARKER}${blocks.join('\n')}${ATTACHMENT_BLOCK_END}` : '',
        images,
        attachments: records.map(toMessageAttachment),
        mode: readable.length === 0 ? 'none' : inline ? 'inline' : 'paged',
        warnings,
    };
}

/** What the person typed: the user turn without the block `assembleTurnAttachments` added. */
export function stripAttachmentBlock(text: string): string {
    const at = text.indexOf(ATTACHMENT_BLOCK_MARKER);
    return at >= 0 ? text.slice(0, at) : text;
}

/** The content of the user turn: the text alone (unchanged) or text with image parts. */
export function buildUserTurnContent(userMessage: string, assembled: AssembledAttachments): string | Array<{ type: string; [key: string]: unknown }> {
    const text = `${userMessage}${assembled.block}`;
    return assembled.images.length > 0 ? [{ type: 'text', text }, ...assembled.images] : text;
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
}

/**
 * `session_files_list` and `session_files_read` — the only way the agent reads
 * a file too long to be in the turn, and a way back to an earlier upload.
 * Read-only, and scoped to this conversation's files.
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
                const record = fileId ? await findSessionFile(scope, conversationId, fileId) : null;
                if (!record) return `File "${fileId}" is not attached to this conversation. Use ${SESSION_FILES_LIST_TOOL} to see the files.`;
                let text: string | null;
                try {
                    text = await readFileText(scope, record);
                } catch (error) {
                    logger.warn('session_files_read failed', { fileId, error: error instanceof Error ? error.message : String(error) });
                    return 'The file could not be read right now.';
                }
                if (text === null) {
                    return isImageMime(record.contentType)
                        ? 'This file is an image; it has no text to read.'
                        : 'This file has no readable text (it could not be converted).';
                }
                const page = pageText(text, args.page ?? 1, readPageChars);
                if (!page) return JSON.stringify({ error: `Page ${args.page} is out of range.`, pages: pageCount(text.length, readPageChars) });
                return JSON.stringify(page);
            },
        ),
    }) as AgentSdkToolInterface;

    return [list, read];
}

export function sessionFileToolDefinitions(readPageChars: number): TraceToolDefinition[] {
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
    ];
}
