/**
 * What the session composer knows about attachments, as pure functions — the
 * pre-upload checks, the size label and the request pieces — so the composer
 * and its tests agree. The server enforces the same limits when the file
 * arrives; checking here only saves a round trip.
 */

import type { IAgentMessageAttachment } from '@/lib/database/provider/types.domain';
import {
    isImageMime,
    isMimeAllowed,
    type ResolvedAttachmentsConfig,
} from '@/lib/services/agents/sessionFilesConfig';
import type { ChatMessage } from './sessionTypes';

/** A file uploaded to the session and waiting to be sent with the next message. */
export interface PendingAttachment extends IAgentMessageAttachment {
    /** `failed` / `skipped` = no text could be extracted from it. */
    conversionStatus?: 'pending' | 'succeeded' | 'failed' | 'skipped';
}

export type AttachmentRefusal =
    | { code: 'file_too_large'; max: number }
    | { code: 'too_many_files'; max: number }
    | { code: 'unsupported_file_type' };

export function formatFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Files the session already holds: those on earlier messages plus the ones waiting to be sent. */
export function heldFileCount(messages: ChatMessage[], pending: PendingAttachment[]): number {
    const sent = new Set<string>();
    for (const message of messages) for (const file of message.attachments ?? []) sent.add(file.fileId);
    for (const file of pending) sent.add(file.fileId);
    return sent.size;
}

/** Why a file cannot be attached, or null when it can. */
export function checkAttachmentCandidate(
    file: { name: string; size: number; type: string },
    cfg: ResolvedAttachmentsConfig,
    held: number,
): AttachmentRefusal | null {
    if (held >= cfg.maxFiles) return { code: 'too_many_files', max: cfg.maxFiles };
    if (file.size > cfg.maxFileSizeMb * 1024 * 1024) return { code: 'file_too_large', max: cfg.maxFileSizeMb };
    // An unknown type is left to the server, which also looks at the file name.
    if (file.type && !isMimeAllowed(file.type, cfg.allowedMimeTypes)) return { code: 'unsupported_file_type' };
    return null;
}

/** The upload URL; the file name travels as `?name=` and the bytes as the raw body. */
export function sessionFileUploadUrl(agentId: string, sessionId: string, fileName: string): string {
    return `/api/agents/${agentId}/sessions/${sessionId}/files?name=${encodeURIComponent(fileName)}`;
}

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;

/**
 * The Content-Type of a raw upload. A JSON body is the server's base64
 * envelope, so a `.json` file goes up as opaque bytes (its name still says what it is).
 */
export function uploadContentType(file: { type: string }): string {
    return !file.type || JSON_TYPE.test(file.type) ? 'application/octet-stream' : file.type;
}

/** The `attachments` of a chat request. */
export function attachmentIds(pending: PendingAttachment[]): string[] {
    return pending.map((file) => file.fileId);
}

export function isImageAttachment(file: Pick<IAgentMessageAttachment, 'mimeType'>): boolean {
    return isImageMime(file.mimeType);
}

/** True when a converted file has no text the agent can read. */
export function lacksReadableText(file: PendingAttachment): boolean {
    return !isImageAttachment(file) && (file.conversionStatus === 'failed' || file.conversionStatus === 'skipped');
}

/** The "Allowed file types" text → the MIME types it lists (comma-separated; blanks dropped). */
export function parseMimeTypes(text: string): string[] {
    return text.split(',').map((entry) => entry.trim()).filter(Boolean);
}
