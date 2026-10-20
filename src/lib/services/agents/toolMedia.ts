/**
 * Images (and other media) that tools return, made visible to the model.
 *
 * A tool message is text on every provider's wire (the adapters JSON.stringify
 * array content), so an image cannot ride in the tool result itself. Instead
 * the result the SDK keeps is a small JSON that NAMES the image
 * (`attachedImages: [{ fileId }]`), and the model wrapper (`sessionImages.ts`)
 * puts the picture in a user message after the run of tool results. Which
 * images the model sees is the model's choice — it decides per call by asking
 * a tool for one.
 *
 * Tool images are working material of ONE run (a screenshot, a rendered page):
 * they live in an in-memory store shared by the run and its sub-agents. No
 * schema, nothing in the conversation's file list. In a later turn the id is
 * gone and the model reads or captures it again (`sessionImages.ts` skips an id
 * the store no longer holds).
 *
 * A tool that does not return a `ToolOutput` is untouched, byte for byte.
 */

import { randomBytes } from 'node:crypto';
import type { ToolInterface as AgentSdkToolInterface } from '@cognipeer/agent-sdk';
import {
    base64ByteLength,
    isModelImageMime,
    isToolOutput,
    type ToolContentBlock,
} from '@/lib/services/tools/toolOutput';
import { imageDimensions, sniffMedia } from '@/lib/services/tools/mediaSniff';
import type { SessionImageSource } from './sessionImages';

export const TOOL_MEDIA_ID_PREFIX = 'tm_';

/** Providers refuse an image whose long edge is past ~8000 px; the read tool downscales to stay under this. */
const IMAGE_EDGE_MAX = 7900;
/** Enough of the file to sniff the type and find the dimensions (JPEG puts them after the metadata). */
const SNIFF_BASE64_CHARS = 262144;

const DEFAULT_MAX_ITEMS = 64;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface ToolMediaStore {
    put(input: { base64: string; mediaType: string; name: string }): { id: string; size: number };
    get(id: string): { base64: string; mediaType: string; name: string; size: number } | null;
}

export function createToolMediaStore(limits: { maxItems?: number; maxTotalBytes?: number } = {}): ToolMediaStore {
    const maxItems = limits.maxItems ?? DEFAULT_MAX_ITEMS;
    const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    // A Map iterates in insertion order: the first key is the oldest item.
    const items = new Map<string, { base64: string; mediaType: string; name: string; size: number }>();
    let total = 0;
    let counter = 0;

    return {
        put(input) {
            counter += 1;
            const id = `${TOOL_MEDIA_ID_PREFIX}${counter}_${randomBytes(3).toString('hex')}`;
            const size = base64ByteLength(input.base64);
            items.set(id, { base64: input.base64, mediaType: input.mediaType, name: input.name, size });
            total += size;
            // The newest item always stays: evicting it would hand back an id that is already gone.
            while (items.size > 1 && (items.size > maxItems || total > maxTotalBytes)) {
                const oldest = items.keys().next().value as string;
                total -= items.get(oldest)!.size;
                items.delete(oldest);
            }
            return { id, size };
        },
        get(id) {
            return items.get(id) ?? null;
        },
    };
}

export interface ToolMediaContext {
    store: ToolMediaStore;
    /** The model that will read the result takes image input. */
    modelTakesImages: boolean;
    /** Largest image (raw bytes) shown to the model. */
    maxImageBytes: number;
    /** Image blocks may name a file id the run resolves (only the built-in `read` tool is trusted to). */
    trustFileIds?: boolean;
}

interface AttachedImage {
    fileId: string;
    name: string;
    mimeType: string;
    width?: number;
    height?: number;
}

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

function megabytes(bytes: number): string {
    return (Math.round((bytes / (1024 * 1024)) * 10) / 10).toString();
}

function textOf(blocks: ToolContentBlock[]): string {
    const lines: string[] = [];
    for (const block of blocks) {
        if (block.type === 'text') lines.push(block.text);
        else if (block.type === 'resource_link') lines.push(`[link: ${block.name ?? block.uri} <${block.uri}>]`);
        else if (block.type === 'resource' && typeof block.resource.text === 'string') lines.push(block.resource.text);
    }
    return lines.join('\n');
}

/**
 * What the model reads for one tool result. A plain value (not a ToolOutput) comes back unchanged.
 * A ToolOutput becomes text, or, when it carries images the model can be shown, a JSON that names them.
 */
export function adaptToolResult(result: unknown, ctx: ToolMediaContext): unknown {
    if (!isToolOutput(result)) return result;

    const text = textOf(result.content);
    const attached: AttachedImage[] = [];
    const omitted: string[] = [];
    let imageNumber = 0;

    for (const block of result.content) {
        if (block.type === 'image') {
            imageNumber += 1;
            const declaredMime = typeof block.mimeType === 'string' ? block.mimeType : '';
            let mimeType = declaredMime;
            const name = (typeof block.name === 'string' && block.name) || `image-${imageNumber}.${EXTENSIONS[declaredMime.split(';')[0]!.trim().toLowerCase()] ?? 'img'}`;
            // A file id names something the run can already resolve. Upstream tools (OpenAPI, MCP) can
            // return a ToolOutput-shaped object too, so only our own `read` tool and this run's own
            // tool images may use one.
            if (block.fileId) {
                if (typeof block.fileId !== 'string' || !(ctx.trustFileIds || (block.fileId.startsWith(TOOL_MEDIA_ID_PREFIX) && ctx.store.get(block.fileId)))) {
                    omitted.push(`${name}: image reference not allowed from this tool`);
                    continue;
                }
                attached.push({ fileId: block.fileId, name, mimeType, ...(block.width ? { width: block.width } : {}), ...(block.height ? { height: block.height } : {}) });
                continue;
            }
            if (typeof block.data !== 'string' || !block.data) continue;
            if (!ctx.modelTakesImages) {
                omitted.push(`${name}: this model cannot view images`);
                continue;
            }
            // The declared type and size come from the tool; the provider checks the real bytes.
            const bytes = Buffer.from(block.data.slice(0, SNIFF_BASE64_CHARS), 'base64');
            const sniffed = sniffMedia(bytes);
            if (sniffed.kind === 'image' && sniffed.mimeType) mimeType = sniffed.mimeType;
            if (!isModelImageMime(mimeType) || (sniffed.kind !== 'image' && sniffed.kind !== 'unknown')) {
                omitted.push(`${name}: ${declaredMime || 'unknown type'} cannot be shown to the model`);
                continue;
            }
            const size = base64ByteLength(block.data);
            if (size > ctx.maxImageBytes) {
                omitted.push(`${name}: ${megabytes(size)} MB is over the ${megabytes(ctx.maxImageBytes)} MB image limit — make it smaller first`);
                continue;
            }
            // Dimensions are read only from bytes whose signature matched: a header read off other data is noise.
            const dims = sniffed.kind === 'image' ? imageDimensions(bytes, mimeType) : null;
            if (dims && Math.max(dims.width, dims.height) > IMAGE_EDGE_MAX) {
                omitted.push(`${name}: ${dims.width}x${dims.height} is over the ${IMAGE_EDGE_MAX}px image limit — make it smaller first`);
                continue;
            }
            const stored = ctx.store.put({ base64: block.data, mediaType: mimeType.split(';')[0]!.trim().toLowerCase(), name });
            attached.push({ fileId: stored.id, name, mimeType, ...(dims ?? (block.width && block.height ? { width: block.width, height: block.height } : {})) });
        } else if (block.type === 'audio') {
            omitted.push(`${block.name || 'audio'}: audio cannot be played to the model`);
        } else if (block.type === 'resource' && typeof block.resource.blob === 'string') {
            omitted.push(`${block.resource.uri}: binary resource not shown`);
        }
    }

    const isError = result.isError === true;
    const structured = result.structuredContent;
    if (attached.length === 0 && omitted.length === 0) {
        const plain = text || (structured ? JSON.stringify(structured) : '');
        return isError ? `Error: ${plain || 'the tool reported an error'}` : plain;
    }
    return JSON.stringify({
        ok: !isError,
        ...(text ? { text } : {}),
        ...(structured && !text ? { structured } : {}),
        ...(attached.length > 0 ? { attachedImages: attached } : {}),
        ...(omitted.length > 0 ? { omitted } : {}),
        ...(attached.length > 0
            ? { note: attached.length === 1 ? 'The image is shown to you in the next message.' : 'The images are shown to you in the next message.' }
            : {}),
    });
}

/**
 * The tool with its result passed through `adaptToolResult`. Mirrors `protectBuiltTool`
 * (agentService.ts): the SDK builds `invoke`, `call`, `run` and `func` as one closure and
 * resolves the executor by walking them, so all four are replaced — a single alias left
 * behind would return the raw ToolOutput the day the walk order changes.
 */
export function withToolMedia<T extends AgentSdkToolInterface>(tool: T, ctx: ToolMediaContext): T {
    const aliases: unknown[] = [tool.invoke, tool.call, tool.func, tool.run];
    const original = aliases.find(
        (alias): alias is (input: Record<string, unknown>, ...rest: unknown[]) => Promise<unknown> => typeof alias === 'function',
    );
    if (!original) return tool;
    const toolCtx = tool.name === 'read' ? { ...ctx, trustFileIds: true } : ctx;
    const adapted = async (args: Record<string, unknown>, ...rest: unknown[]) => adaptToolResult(await original(args, ...rest), toolCtx);
    return { ...tool, invoke: adapted, call: adapted, run: adapted, func: adapted };
}

/** The model wrapper's image source: tool images of this run first, then the session's own files. */
export function createCompositeImageSource(store: ToolMediaStore, session: SessionImageSource | null): SessionImageSource {
    return {
        async find(fileId) {
            if (fileId.startsWith(TOOL_MEDIA_ID_PREFIX)) {
                const item = store.get(fileId);
                return item ? { name: item.name, size: item.size } : null;
            }
            return session ? session.find(fileId) : null;
        },
        async read(fileId) {
            if (fileId.startsWith(TOOL_MEDIA_ID_PREFIX)) {
                const item = store.get(fileId);
                if (!item) throw new Error(`Image "${fileId}" is no longer available.`);
                return { base64: item.base64, mediaType: item.mediaType };
            }
            if (!session) throw new Error(`Image "${fileId}" is not available.`);
            return session.read(fileId);
        },
    };
}
