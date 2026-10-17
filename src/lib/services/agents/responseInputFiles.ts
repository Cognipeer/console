/**
 * The input of an agent request: the text and the files of its last user message.
 *
 * Shared by every dialect that starts an agent turn (Responses, the runs API,
 * chat completions, A2A). A message's parts, in either spelling:
 *  - text: `input_text` / `text` — every text part, joined with a blank line;
 *  - `input_file { file_id | file_data | file_url, filename }` (chat: `file { file: { file_id | file_data, filename } }`);
 *  - `input_image { file_id | image_url }` (chat: `image_url { url }`).
 * Any other part type (e.g. `input_audio`) is refused (400
 * `unsupported_content_part`) rather than silently dropped. Each file becomes
 * a file of the session the request runs on:
 *  - `file_id` names a file already uploaded to the session;
 *  - `file_data` (base64 or a data URL) and a `data:` `image_url` are decoded
 *    and uploaded;
 *  - an `http(s)` `image_url` / `file_url` is fetched through the SSRF guard,
 *    capped at the agent's file size limit, and uploaded. An `image_url` must
 *    answer with an image (`image/*`), so it is not a way to pull arbitrary web
 *    content into the model's context; a `file_url`'s type is then checked
 *    against the agent's allowed types like any upload.
 * The turn then reads them like any attachment (sessionFiles.ts).
 */

import { Buffer } from 'node:buffer';
import { getConfig } from '@/lib/core/config';
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
    /** Every text part, joined with a blank line (or the whole string input); null when there is none. */
    text: string | null;
    files: ResponseInputFile[];
}

/** A part of the input the API does not take: 400, in the caller's dialect. */
export class InputContentPartError extends Error {
    readonly status = 400;

    constructor(message: string, readonly code: 'unsupported_content_part' | 'invalid_file_url', readonly param = 'input') {
        super(message);
        this.name = 'InputContentPartError';
    }
}

const MAX_INPUT_FILES = 100;
const TEXT_PART_TYPES = new Set(['input_text', 'text']);

function stringField(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function httpUrl(value: string, where: string): string {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new InputContentPartError(`${where} must be an http(s) URL`, 'invalid_file_url');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new InputContentPartError(`${where} must be an http(s) URL`, 'invalid_file_url');
    }
    return value;
}

/** A file part as a file; null for one that names nothing (skipped, as before). Throws for a part type the API does not take. */
function toInputFile(part: Record<string, unknown>): ResponseInputFile | null {
    if (part.type === 'input_file' || part.type === 'file') {
        // Chat completions nests the fields under `file`.
        const spec = part.type === 'file' && part.file && typeof part.file === 'object' ? part.file as Record<string, unknown> : part;
        const fileId = stringField(spec.file_id);
        const data = stringField(spec.file_data);
        const url = stringField(spec.file_url);
        const filename = stringField(spec.filename) ? { filename: stringField(spec.filename) } : {};
        if (fileId) return { kind: 'file', fileId, ...filename };
        if (data) return { kind: 'file', data, ...filename };
        if (url) return { kind: 'file', url: httpUrl(url, 'input_file.file_url'), ...filename };
        return null;
    }
    if (part.type === 'input_image' || part.type === 'image_url') {
        const fileId = stringField(part.file_id);
        const imageUrl = typeof part.image_url === 'object' && part.image_url !== null
            ? stringField((part.image_url as { url?: unknown }).url)
            : stringField(part.image_url);
        if (fileId) return { kind: 'image', fileId };
        if (!imageUrl) return null;
        return imageUrl.startsWith('data:') ? { kind: 'image', data: imageUrl } : { kind: 'image', url: httpUrl(imageUrl, 'image_url') };
    }
    throw new InputContentPartError(
        `Content part type "${typeof part.type === 'string' ? part.type : 'unknown'}" is not supported: send text, input_file or input_image parts.`,
        'unsupported_content_part',
    );
}

/**
 * The text and the files of the LAST user message of a Responses `input` (or
 * of chat `messages`). A message with files and no text is a message (the text
 * is then null). Throws `InputContentPartError` for a part it does not take.
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

        const texts: string[] = [];
        const files: ResponseInputFile[] = [];
        for (const part of candidate.content) {
            if (!part || typeof part !== 'object') continue;
            if (TEXT_PART_TYPES.has(part.type as string)) {
                if (typeof part.text === 'string') texts.push(part.text);
                continue;
            }
            const file = toInputFile(part);
            if (file && files.length < MAX_INPUT_FILES) files.push(file);
        }
        const text = texts.length > 0 ? texts.join('\n\n') : null;
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

/** The last path segment as a file name (decoded; kept as sent when its escapes are malformed), else `fallback`. */
function fileNameOf(url: string, fallback: string): string {
    const segment = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (!segment || !segment.includes('.')) return fallback;
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/**
 * Downloads the file at `url` through the SSRF guard, refusing anything past
 * `maxBytes`. An image (`input_image`) must be declared `image/*` by the
 * server; a file (`input_file.file_url`) keeps the declared type (none = left
 * to the upload's guess from the name), checked against the agent's allowed
 * types when it is uploaded. One deadline (the outbound HTTP timeout) covers the
 * whole download, the body included: a server that answers and then sends its
 * body slowly is cut off (400 `attachment_unreachable`).
 */
async function fetchRemoteFile(
    url: string,
    kind: ResponseInputFile['kind'],
    maxBytes: number,
    maxMb: number,
): Promise<{ data: Buffer; mimeType?: string; name: string }> {
    const host = new URL(url).host;
    const tooLarge = () => new AgentAttachmentError(413, 'file_too_large', `The file at ${host} exceeds the ${maxMb} MB limit of this agent.`);
    const deadlineMs = getConfig().outboundHttp.defaultTimeoutMs;
    const timedOutError = () => new AgentAttachmentError(
        400,
        'attachment_unreachable',
        `The file at ${host} could not be fetched: it did not arrive within ${Math.max(1, Math.round(deadlineMs / 1000))} s.`,
    );
    const controller = new AbortController();
    let timedOut = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        void reader?.cancel().catch(() => undefined);
    }, deadlineMs);
    try {
        let response: Response;
        try {
            response = await safeFetch(url, { method: 'GET', signal: controller.signal }, { timeoutMs: deadlineMs, keepAbortLinked: true });
        } catch (error) {
            if (timedOut) throw timedOutError();
            throw new AgentAttachmentError(400, 'attachment_unreachable', `The file could not be fetched: ${error instanceof Error ? error.message : 'request failed'}`);
        }
        if (!response.ok) {
            throw new AgentAttachmentError(400, 'attachment_unreachable', `The file could not be fetched (HTTP ${response.status}).`);
        }
        // Decided on the header, before a byte of the body is read.
        const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || undefined;
        if (kind === 'image' && (!mimeType || !mimeType.startsWith('image/'))) {
            await response.body?.cancel().catch(() => undefined);
            throw new AgentAttachmentError(
                415,
                'unsupported_file_type',
                `The URL at ${host} did not return an image (Content-Type: ${mimeType?.slice(0, 80) || 'missing'}).`,
            );
        }
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) {
            await response.body?.cancel().catch(() => undefined);
            throw tooLarge();
        }
        const chunks: Uint8Array[] = [];
        let received = 0;
        reader = response.body?.getReader();
        while (reader) {
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
                chunk = await reader.read();
            } catch (error) {
                if (timedOut) throw timedOutError();
                throw new AgentAttachmentError(400, 'attachment_unreachable', `The file could not be fetched: ${error instanceof Error ? error.message : 'the download failed'}`);
            }
            // A deadline that cancelled the read ends it as if the body were complete: it was not.
            if (timedOut) throw timedOutError();
            if (chunk.done) break;
            received += chunk.value.length;
            if (received > maxBytes) {
                await reader.cancel().catch(() => undefined);
                throw tooLarge();
            }
            chunks.push(chunk.value);
        }
        return {
            data: Buffer.concat(chunks),
            mimeType,
            name: fileNameOf(url, kind),
        };
    } finally {
        clearTimeout(timer);
    }
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
            const fetched = await fetchRemoteFile(file.url, file.kind, maxBytes, cfg.maxFileSizeMb);
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
