/**
 * The files in a Responses API request.
 *
 * `input` may carry, next to `input_text`, `input_file { file_id | file_data,
 * filename }` and `input_image { file_id | image_url }` parts. They used to be
 * dropped; now each becomes a file of the session the request runs on:
 *  - `file_id` names a file already uploaded to the session;
 *  - `file_data` (base64 or a data URL) and a `data:` `image_url` are decoded
 *    and uploaded;
 *  - an `http(s)` `image_url` is fetched through the SSRF guard, capped at the
 *    agent's file size limit, and uploaded.
 * The turn then reads them like any attachment (sessionFiles.ts).
 */

import { Buffer } from 'node:buffer';
import { safeFetch } from '@/lib/security/outboundFetch';
import type { IAgentConfig, IAgentConversation } from '@/lib/database';
import { AgentAttachmentError } from './agentErrors';
import {
    resolveAttachmentsConfig,
    resolveUploadMimeType,
    uploadSessionFile,
    type SessionFileActor,
    type SessionFileScope,
} from './sessionFiles';

export interface ResponseInputFile {
    kind: 'file' | 'image';
    /** A file already on the session. */
    fileId?: string;
    /** base64 or a `data:` URL. */
    data?: string;
    /** An `http(s)` URL to fetch. */
    url?: string;
    filename?: string;
}

export interface ResponseUserInput {
    /** The first `input_text` (or the whole string input); null when there is none. */
    text: string | null;
    files: ResponseInputFile[];
}

const MAX_INPUT_FILES = 100;

function stringField(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toInputFile(part: Record<string, unknown>): ResponseInputFile | null {
    if (part.type === 'input_file') {
        const fileId = stringField(part.file_id);
        const data = stringField(part.file_data);
        if (!fileId && !data) return null;
        return { kind: 'file', ...(fileId ? { fileId } : { data }), ...(stringField(part.filename) ? { filename: stringField(part.filename) } : {}) };
    }
    if (part.type === 'input_image') {
        const fileId = stringField(part.file_id);
        const imageUrl = typeof part.image_url === 'object' && part.image_url !== null
            ? stringField((part.image_url as { url?: unknown }).url)
            : stringField(part.image_url);
        if (fileId) return { kind: 'image', fileId };
        if (!imageUrl) return null;
        return imageUrl.startsWith('data:') ? { kind: 'image', data: imageUrl } : { kind: 'image', url: imageUrl };
    }
    return null;
}

/**
 * The text and the files of the LAST user message of a Responses `input`.
 * A message with files and no text is a message (the text is then null).
 */
export function extractResponseUserInput(input: unknown): ResponseUserInput {
    if (typeof input === 'string') return { text: input, files: [] };
    if (!Array.isArray(input)) return { text: null, files: [] };

    for (let index = input.length - 1; index >= 0; index -= 1) {
        const item = input[index];
        if (!item || typeof item !== 'object') continue;
        const candidate = item as { content?: string | Array<Record<string, unknown>>; role?: string };
        if (candidate.role !== 'user') continue;
        if (typeof candidate.content === 'string') return { text: candidate.content, files: [] };
        if (!Array.isArray(candidate.content)) continue;

        const textPart = candidate.content.find((part) => part.type === 'input_text' && typeof part.text === 'string');
        const files = candidate.content
            .map((part) => (part && typeof part === 'object' ? toInputFile(part) : null))
            .filter((file): file is ResponseInputFile => file !== null)
            .slice(0, MAX_INPUT_FILES);
        const text = textPart && typeof textPart.text === 'string' ? textPart.text : null;
        if (text !== null || files.length > 0) return { text, files };
    }
    return { text: null, files: [] };
}

/** The file ids the request names itself — all that makes a retry "the same request". */
export function namedFileIds(files: ResponseInputFile[]): string[] {
    return files.flatMap((file) => (file.fileId ? [file.fileId] : []));
}

const EXTENSION_BY_IMAGE_MIME: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
};

function parseDataUrl(value: string): { mimeType?: string; data: string } {
    const match = value.match(/^data:([^;,]*)(?:;[^,]*)?;base64,([\s\S]*)$/);
    return match ? { ...(match[1] ? { mimeType: match[1] } : {}), data: match[2]! } : { data: value };
}

/** Downloads `url` through the SSRF guard, refusing anything past `maxBytes`. */
async function fetchRemoteFile(url: string, maxBytes: number, maxMb: number): Promise<{ data: Buffer; mimeType?: string; name: string }> {
    const tooLarge = () => new AgentAttachmentError(413, 'file_too_large', `The file at ${new URL(url).host} exceeds the ${maxMb} MB limit of this agent.`);
    let response: Response;
    try {
        response = await safeFetch(url, { method: 'GET' });
    } catch (error) {
        throw new AgentAttachmentError(400, 'attachment_unreachable', `The file could not be fetched: ${error instanceof Error ? error.message : 'request failed'}`);
    }
    if (!response.ok) {
        throw new AgentAttachmentError(400, 'attachment_unreachable', `The file could not be fetched (HTTP ${response.status}).`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw tooLarge();
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = response.body?.getReader();
    while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw tooLarge();
        }
        chunks.push(value);
    }
    const pathName = new URL(url).pathname.split('/').filter(Boolean).pop();
    return {
        data: Buffer.concat(chunks),
        mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() || undefined,
        name: pathName && pathName.includes('.') ? decodeURIComponent(pathName) : 'image',
    };
}

/**
 * Makes every file of a request a file of the session. Returns every file id
 * the turn attaches, and the ones the caller named by id (for idempotency).
 */
export async function storeResponseInputFiles(input: {
    files: ResponseInputFile[];
    scope: SessionFileScope;
    conversation: Pick<IAgentConversation, '_id' | 'agentKey'>;
    agentConfig: IAgentConfig | undefined;
    actor: SessionFileActor;
}): Promise<{ attachments: string[]; named: string[] }> {
    const attachments: string[] = [];
    const cfg = resolveAttachmentsConfig(input.agentConfig?.attachments);
    const maxBytes = Math.floor(cfg.maxFileSizeMb * 1024 * 1024);

    for (const file of input.files) {
        if (file.fileId) {
            attachments.push(file.fileId);
            continue;
        }
        let name = file.filename ?? (file.kind === 'image' ? 'image' : 'file');
        let mimeType: string | undefined;
        let data: Buffer | string;
        if (file.url) {
            const fetched = await fetchRemoteFile(file.url, maxBytes, cfg.maxFileSizeMb);
            ({ data, mimeType } = fetched);
            if (!file.filename) name = fetched.name;
        } else {
            const parsed = parseDataUrl(file.data ?? '');
            mimeType = parsed.mimeType;
            data = parsed.data;
        }
        // An image sent as a data URL has no name: give it an extension its type implies.
        const resolvedMime = resolveUploadMimeType(mimeType, name);
        if (!name.includes('.') && EXTENSION_BY_IMAGE_MIME[resolvedMime]) name = `${name}.${EXTENSION_BY_IMAGE_MIME[resolvedMime]}`;

        const stored = await uploadSessionFile({
            scope: input.scope,
            conversation: input.conversation,
            agentConfig: input.agentConfig,
            fileName: name,
            contentType: mimeType,
            data,
            actor: input.actor,
        });
        attachments.push(stored.id);
    }
    return { attachments, named: namedFileIds(input.files) };
}
