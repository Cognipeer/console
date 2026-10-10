/**
 * Puts a session's images in front of the model at the model call — and only
 * there.
 *
 * In the agent's input an image is a reference (`session-file://<fileId>`,
 * `sessionAttachmentText.ts`), so the saved state, the traces and the SDK's
 * token estimate carry a few dozen characters per image instead of megabytes of
 * base64 (a 55 KB photo made the SDK count ~18,000 tokens and compact a
 * conversation that was nowhere near full). This wrapper sits OUTSIDE the SDK
 * model, like `withAssembledStream`: whatever the SDK sends, `invoke`, `stream`
 * and the model `bindTools` returns, passes through `prepare` first, which
 *
 *  - turns each reference into the SDK's `{ base64, media_type }` image (read
 *    from the bucket once per run — the cache is shared by every bound copy),
 *  - keeps the request inside the agent's `attachments.maxImages` /
 *    `attachments.maxBytes`: the NEWEST images win, an older one becomes a text
 *    placeholder naming the file so the model can say what it cannot see,
 *  - replaces a reference whose file is gone with `[Image "…" is no longer
 *    available]`, and
 *  - turns the result of `session_files_view_image` into a user message that
 *    carries the image (a tool result is text on every provider's wire).
 *
 * Nothing here is written back: the messages the SDK holds are never touched.
 */

import { createLogger } from '@/lib/core/logger';
import {
    escapeAttribute,
    imageFileIdOf,
    imageParts,
    type ContentPart,
} from './sessionAttachmentText';
import { SESSION_FILES_VIEW_IMAGE_TOOL } from './sessionFilesConfig';

const logger = createLogger('agent-session-images');

/** Where an image's record and bytes come from — the session's bucket in production. */
export interface SessionImageSource {
    /** The image file if it is a file of this session, else null. */
    find(fileId: string): Promise<{ name: string; size: number } | null>;
    read(fileId: string): Promise<{ base64: string; mediaType: string }>;
}

export interface SessionImagesOptions {
    source: SessionImageSource;
    /** Most images one request carries (`attachments.maxImages`). */
    maxImages: number;
    /** Most image bytes, before base64, one request carries (`attachments.maxBytes`). */
    maxBytes: number;
    /** The placeholder may point at `session_files_view_image`. */
    viewImageTool?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
interface WrappableModel {
    invoke?: AnyFn;
    stream?: AnyFn;
    bindTools?: AnyFn;
}

type LooseMessage = Record<string, unknown> & { role?: unknown; content?: unknown; name?: unknown };

/** What one run has learned about its session's images (shared by every bound copy of the model). */
interface RunCache {
    records: Map<string, Promise<{ name: string; size: number } | null>>;
    bytes: Map<string, Promise<{ base64: string; mediaType: string } | null>>;
}

function roleOf(message: LooseMessage): string | undefined {
    if (typeof message.role === 'string') return message.role;
    const typed = message as { _getType?: () => string; getType?: () => string };
    return typed.getType?.() ?? typed._getType?.();
}

/** `{ fileId, name }` when a tool message is the result of `session_files_view_image`. */
function viewedImage(message: LooseMessage): { fileId: string; name: string } | null {
    if (roleOf(message) !== 'tool' || message.name !== SESSION_FILES_VIEW_IMAGE_TOOL) return null;
    if (typeof message.content !== 'string') return null;
    try {
        const parsed = JSON.parse(message.content) as { ok?: unknown; fileId?: unknown; name?: unknown };
        if (parsed.ok === true && typeof parsed.fileId === 'string' && parsed.fileId) {
            return { fileId: parsed.fileId, name: typeof parsed.name === 'string' && parsed.name ? parsed.name : parsed.fileId };
        }
    } catch {
        // A refusal ("not attached to this conversation") is plain text: nothing to show.
    }
    return null;
}

/**
 * The request with every `session_files_view_image` result followed by a user
 * message carrying the image. The message goes after the whole run of tool
 * results of that assistant turn — providers want the results adjacent to the
 * calls they answer.
 */
export function expandViewedImages(messages: unknown[]): unknown[] {
    const out: unknown[] = [];
    let pending: Array<{ fileId: string; name: string }> = [];
    let changed = false;
    const flush = () => {
        if (pending.length === 0) return;
        const unique = [...new Map(pending.map((entry) => [entry.fileId, entry])).values()];
        out.push({
            role: 'user',
            content: [
                { type: 'text', text: unique.length === 1 ? 'Here is the image you asked to look at.' : 'Here are the images you asked to look at.' },
                ...unique.flatMap((entry) => imageParts(entry.fileId, entry.name, 'requested')),
            ],
        });
        pending = [];
        changed = true;
    };
    for (const entry of messages) {
        const message = entry as LooseMessage | null;
        if (message && typeof message === 'object' && roleOf(message) === 'tool') {
            out.push(entry);
            const viewed = viewedImage(message);
            if (viewed) pending.push(viewed);
            continue;
        }
        flush();
        out.push(entry);
    }
    flush();
    return changed ? out : messages;
}

interface Slot {
    message: number;
    part: number;
    fileId: string;
    name: string | undefined;
}

function megabytes(bytes: number): string {
    return `${Math.round((bytes / 1_000_000) * 10) / 10} MB`;
}

export function withSessionImages<T extends object>(input: T, options: SessionImagesOptions, shared?: RunCache): T {
    const model = input as T & WrappableModel;
    if (!model || typeof model !== 'object') return input;
    const cache: RunCache = shared ?? { records: new Map(), bytes: new Map() };
    const wrapped = { ...model } as WrappableModel & Record<string, unknown>;

    const record = (fileId: string) => {
        let found = cache.records.get(fileId);
        if (!found) {
            found = options.source.find(fileId).catch((error: unknown) => {
                logger.warn('Could not look up a session image', { fileId, error: error instanceof Error ? error.message : String(error) });
                return null;
            });
            cache.records.set(fileId, found);
        }
        return found;
    };
    const bytes = (fileId: string) => {
        let found = cache.bytes.get(fileId);
        if (!found) {
            found = options.source.read(fileId).catch((error: unknown) => {
                logger.warn('Could not read a session image', { fileId, error: error instanceof Error ? error.message : String(error) });
                return null;
            });
            cache.bytes.set(fileId, found);
        }
        return found;
    };

    const prepare = async (messages: unknown): Promise<unknown> => {
        if (!Array.isArray(messages)) return messages;
        const expanded = expandViewedImages(messages);

        const slots: Slot[] = [];
        expanded.forEach((entry, messageIndex) => {
            const content = (entry as LooseMessage | null)?.content;
            if (!Array.isArray(content)) return;
            content.forEach((part, partIndex) => {
                const fileId = imageFileIdOf(part);
                // Already inline (a caller's own bytes) is not ours to touch.
                if (!fileId || (part as { image_url?: { base64?: unknown } }).image_url?.base64) return;
                slots.push({ message: messageIndex, part: partIndex, fileId, name: (part as { name?: unknown }).name as string | undefined });
            });
        });
        if (slots.length === 0) return expanded;

        // The newest images win the budget; walking back from the end keeps them.
        const shown = new Set<number>();
        const replacement = new Map<number, ContentPart>();
        const known = new Map<string, { name: string; size: number } | null>();
        for (const fileId of new Set(slots.map((slot) => slot.fileId))) known.set(fileId, await record(fileId));

        let count = 0;
        let total = 0;
        let droppedForBudget = 0;
        for (let i = slots.length - 1; i >= 0; i -= 1) {
            const slot = slots[i]!;
            const info = known.get(slot.fileId);
            const name = info?.name ?? slot.name ?? slot.fileId;
            if (!info) {
                replacement.set(i, { type: 'text', text: `[Image "${escapeAttribute(name)}" is no longer available]` });
                continue;
            }
            if (count + 1 > options.maxImages || total + info.size > options.maxBytes) {
                droppedForBudget += 1;
                const limit = `${options.maxImages} image${options.maxImages === 1 ? '' : 's'} / ${megabytes(options.maxBytes)}`;
                replacement.set(i, {
                    type: 'text',
                    text: `[Image "${escapeAttribute(name)}" (id ${slot.fileId}) is not shown: a request carries at most ${limit}, and newer images took the room.`
                        + `${options.viewImageTool ? ` Use ${SESSION_FILES_VIEW_IMAGE_TOOL} to look at it again.` : ''}]`,
                });
                continue;
            }
            count += 1;
            total += info.size;
            shown.add(i);
        }

        // Read what is kept (each file once per run).
        for (const i of [...shown]) {
            const slot = slots[i]!;
            const data = await bytes(slot.fileId);
            if (!data) {
                const name = known.get(slot.fileId)?.name ?? slot.name ?? slot.fileId;
                replacement.set(i, { type: 'text', text: `[Image "${escapeAttribute(name)}" is no longer available]` });
                shown.delete(i);
                continue;
            }
            replacement.set(i, { type: 'image_url', image_url: { base64: data.base64, media_type: data.mediaType } });
        }
        if (droppedForBudget > 0) {
            logger.info('Session images left out of a model request (over the agent\'s image budget)', {
                dropped: droppedForBudget, maxImages: options.maxImages, maxBytes: options.maxBytes,
            });
        }

        const result = expanded.slice();
        const byMessage = new Map<number, Map<number, ContentPart>>();
        slots.forEach((slot, i) => {
            const part = replacement.get(i);
            if (!part) return;
            const forMessage = byMessage.get(slot.message) ?? new Map<number, ContentPart>();
            forMessage.set(slot.part, part);
            byMessage.set(slot.message, forMessage);
        });
        for (const [messageIndex, parts] of byMessage) {
            const message = result[messageIndex] as LooseMessage;
            result[messageIndex] = {
                ...message,
                content: (message.content as unknown[]).map((part, partIndex) => parts.get(partIndex) ?? part),
            };
        }
        return result;
    };

    if (typeof model.bindTools === 'function') {
        const bindTools = model.bindTools.bind(model);
        // Tools are bound per call, and the bound model is the one that runs.
        wrapped.bindTools = (tools: unknown, bindOptions?: unknown) =>
            withSessionImages(bindTools(tools, bindOptions) as object, options, cache);
    }
    if (typeof model.invoke === 'function') {
        const invoke = model.invoke.bind(model);
        wrapped.invoke = async (messages: unknown, ...rest: unknown[]) => invoke(await prepare(messages), ...rest);
    }
    if (typeof model.stream === 'function') {
        const stream = model.stream.bind(model);
        wrapped.stream = async function* withImages(messages: unknown, ...rest: unknown[]) {
            const started = stream(await prepare(messages), ...rest);
            // LangChain's `stream` returns a promise of the iterator; the SDK adapter's is the iterator.
            yield* ((typeof started?.then === 'function' ? await started : started) as AsyncIterable<unknown>);
        };
    }
    return wrapped as unknown as T;
}
