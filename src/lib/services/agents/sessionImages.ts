/**
 * Puts a session's images in front of the model at the model call — and only
 * there.
 *
 * In the agent's input an image is a reference (`session-file://<fileId>`,
 * `sessionAttachmentText.ts`), so the saved state, the traces and the SDK's
 * token estimate carry a few dozen characters per image instead of megabytes of
 * base64 (a 55 KB photo made the SDK count ~18,000 tokens and compact a
 * conversation that was nowhere near full). This wrapper sits OUTSIDE the SDK
 * model, as the usage tap does: whatever the SDK sends, `invoke`, `stream`
 * and the model `bindTools` returns, passes through `prepare` first, which
 *
 *  - turns each reference into the native providers' `{ type: 'image', source: base64 }` part (read
 *    from the bucket once per run — the cache is shared by every bound copy),
 *  - keeps the request inside the agent's `attachments.maxImages` /
 *    `attachments.maxBytes`: the NEWEST images win, an older one becomes a text
 *    placeholder naming the file so the model can say what it cannot see; an
 *    image bigger than `maxBytes` on its own gets its own placeholder ("too
 *    large for one request"), since no amount of room would fit it,
 *  - replaces a reference whose file is gone with `[Image "…" is no longer
 *    available]`, and
 *  - turns the images a tool result names (`attachedImages`, see `toolMedia.ts`;
 *    the legacy `session_files_view_image` result too) into a user message that
 *    carries them (a tool result is text on every provider's wire).
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
import { TOOL_MEDIA_ID_PREFIX, type ToolMediaStore } from './toolMedia';

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
    /** The placeholder may point at the `read` tool. */
    viewImageTool?: boolean;
    /** The run's tool images (`tm_…` ids): one an earlier turn left behind is gone and is not shown again. */
    toolMedia?: ToolMediaStore;
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

/** At most this many images one tool result can name. */
const MAX_IMAGES_PER_RESULT = 16;

/** The images a tool message names: the legacy `session_files_view_image` result, or any result with `attachedImages`. */
function toolMessageImages(message: LooseMessage): Array<{ fileId: string; name: string }> {
    if (roleOf(message) !== 'tool' || typeof message.content !== 'string' || !message.content.startsWith('{')) return [];
    let parsed: { ok?: unknown; fileId?: unknown; name?: unknown; attachedImages?: unknown };
    try {
        parsed = JSON.parse(message.content) as typeof parsed;
    } catch {
        return []; // a refusal ("not attached to this conversation") is plain text: nothing to show
    }
    if (!parsed || typeof parsed !== 'object') return [];
    if (message.name === SESSION_FILES_VIEW_IMAGE_TOOL) {
        if (parsed.ok === true && typeof parsed.fileId === 'string' && parsed.fileId) {
            return [{ fileId: parsed.fileId, name: typeof parsed.name === 'string' && parsed.name ? parsed.name : parsed.fileId }];
        }
        return [];
    }
    if (!Array.isArray(parsed.attachedImages)) return [];
    const found: Array<{ fileId: string; name: string }> = [];
    for (const entry of parsed.attachedImages.slice(0, MAX_IMAGES_PER_RESULT)) {
        const item = entry as { fileId?: unknown; name?: unknown } | null;
        if (!item || typeof item.fileId !== 'string' || !item.fileId) continue;
        found.push({ fileId: item.fileId, name: typeof item.name === 'string' && item.name ? item.name : item.fileId });
    }
    return found;
}

/**
 * The request with every tool result that names images followed by a user
 * message carrying them. The message goes after the whole run of tool
 * results of that assistant turn — providers want the results adjacent to the
 * calls they answer. `keep` leaves out an image that cannot be shown any more.
 */
export function expandViewedImages(messages: unknown[], options: { keep?: (fileId: string) => boolean } = {}): unknown[] {
    const out: unknown[] = [];
    let pending: Array<{ fileId: string; name: string }> = [];
    let changed = false;
    const flush = () => {
        if (pending.length === 0) return;
        const unique = [...new Map(pending.map((entry) => [entry.fileId, entry])).values()]
            .filter((entry) => !options.keep || options.keep(entry.fileId));
        pending = [];
        if (unique.length === 0) return;
        out.push({
            role: 'user',
            content: [
                { type: 'text', text: unique.length === 1 ? 'Here is the image you asked to look at.' : 'Here are the images you asked to look at.' },
                ...unique.flatMap((entry) => imageParts(entry.fileId, entry.name, 'requested')),
            ],
        });
        changed = true;
    };
    for (const entry of messages) {
        const message = entry as LooseMessage | null;
        if (message && typeof message === 'object' && roleOf(message) === 'tool') {
            out.push(entry);
            pending.push(...toolMessageImages(message));
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
        const expanded = expandViewedImages(messages, {
            // Tool media from an earlier turn is gone; the tool message already says what it was.
            keep: (fileId) => !fileId.startsWith(TOOL_MEDIA_ID_PREFIX) || Boolean(options.toolMedia?.get(fileId)),
        });

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
        let droppedTooLarge = 0;
        for (let i = slots.length - 1; i >= 0; i -= 1) {
            const slot = slots[i]!;
            const info = known.get(slot.fileId);
            const name = info?.name ?? slot.name ?? slot.fileId;
            if (!info) {
                replacement.set(i, { type: 'text', text: `[Image "${escapeAttribute(name)}" is no longer available]` });
                continue;
            }
            if (info.size > options.maxBytes) {
                // Bigger than a whole request: no amount of room would fit it, so do not blame newer images.
                droppedTooLarge += 1;
                replacement.set(i, {
                    type: 'text',
                    text: `[Image "${escapeAttribute(name)}" (id ${slot.fileId}) is not shown: it is ${megabytes(info.size)}, `
                        + `too large for one request (the limit is ${megabytes(options.maxBytes)}).]`,
                });
                continue;
            }
            if (count + 1 > options.maxImages || total + info.size > options.maxBytes) {
                droppedForBudget += 1;
                const limit = `${options.maxImages} image${options.maxImages === 1 ? '' : 's'} / ${megabytes(options.maxBytes)}`;
                replacement.set(i, {
                    type: 'text',
                    text: `[Image "${escapeAttribute(name)}" (id ${slot.fileId}) is not shown: a request carries at most ${limit}, and newer images took the room.`
                        + `${options.viewImageTool ? ` Use read with fileId "${slot.fileId}" to look at it again.` : ''}]`,
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
            replacement.set(i, { type: 'image', source: { type: 'base64', mediaType: data.mediaType, data: data.base64 } });
        }
        if (droppedTooLarge > 0) {
            logger.info('Session images left out of a model request (each larger than the agent\'s image size limit)', {
                dropped: droppedTooLarge, maxBytes: options.maxBytes,
            });
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
            yield* started as AsyncIterable<unknown>;
        };
    }
    return wrapped as unknown as T;
}
