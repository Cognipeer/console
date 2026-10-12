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
    isSendableImageMime,
    maxUploadBytes,
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

/**
 * Files the session already holds. The server's list is the truth (a file that
 * expired or was deleted elsewhere no longer counts, and one uploaded from the
 * API does); until it has loaded, the files on earlier messages stand in. Files
 * waiting to be sent are always counted, once, in case the list predates them.
 */
export function heldFileCount(
    messages: ChatMessage[],
    pending: PendingAttachment[],
    serverFiles?: ReadonlyArray<{ id: string }> | null,
): number {
    const held = new Set<string>();
    if (serverFiles) {
        for (const file of serverFiles) held.add(file.id);
    } else {
        for (const message of messages) for (const file of message.attachments ?? []) held.add(file.fileId);
    }
    for (const file of pending) held.add(file.fileId);
    return held.size;
}

/** Why a file cannot be attached, or null when it can. */
export function checkAttachmentCandidate(
    file: { name: string; size: number; type: string },
    cfg: ResolvedAttachmentsConfig,
    held: number,
): AttachmentRefusal | null {
    if (held >= cfg.maxFiles) return { code: 'too_many_files', max: cfg.maxFiles };
    // A picture is also held to what one model request carries (the server refuses it past that).
    if (file.size > maxUploadBytes(cfg, file.type)) {
        const requestBound = isSendableImageMime(file.type) && cfg.maxBytes < Math.floor(cfg.maxFileSizeMb * 1024 * 1024);
        return { code: 'file_too_large', max: requestBound ? Math.round((cfg.maxBytes / 1_000_000) * 10) / 10 : cfg.maxFileSizeMb };
    }
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

/** What deleting a file waiting to be sent came to: gone (or already gone), or why it is still there. */
export type AttachmentRemoval = { removed: true } | { removed: false; message: string };

/**
 * Deletes a session file on the server and says whether it is really gone. The
 * chip may only leave the composer when it is: a file that is still on the
 * session rides along with the next message (`attachNewUploads`), so a failed
 * delete that looked like a removal would send a file the person took out.
 * A 404 means it is already gone.
 */
export async function removeSessionFile(
    url: string,
    fetchFn: (input: string, init?: { method: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> = fetch,
): Promise<AttachmentRemoval> {
    try {
        const res = await fetchFn(url, { method: 'DELETE' });
        if (res.ok || res.status === 404) return { removed: true };
        const data = await res.json().catch(() => ({})) as { error?: unknown };
        const detail = typeof data.error === 'string' ? data.error : (data.error as { message?: unknown } | undefined)?.message;
        return { removed: false, message: typeof detail === 'string' && detail ? detail : `HTTP ${res.status}` };
    } catch (error) {
        return { removed: false, message: error instanceof Error ? error.message : String(error) };
    }
}
