/**
 * Canonical tool result that may carry media (images, audio, resources).
 *
 * MCP-shaped and JSON-safe: results cross nodes as JSON (routeInstanceCall),
 * so the marker is a plain string field rather than a class instance.
 * Everything here is pure — no I/O.
 */

export type ToolContentBlock =
    | { type: 'text'; text: string }
    /** `data` (base64, no data: prefix) OR `fileId` (agent-internal reference to an image the agent run
     *  can already resolve: a conversation file id or a tool-media id `tm_…`). Exactly one of them. */
    | { type: 'image'; mimeType: string; data?: string; fileId?: string; name?: string; width?: number; height?: number }
    | { type: 'audio'; mimeType: string; data: string; name?: string }
    | { type: 'resource_link'; uri: string; name?: string; title?: string; description?: string; mimeType?: string; size?: number }
    | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

export interface ToolOutput {
    kind: 'tool_output';
    content: ToolContentBlock[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
}

export const TOOL_OUTPUT_KIND = 'tool_output' as const;

/** Image types every provider accepts as a model input. */
export const MODEL_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** ≈4.5 MB raw; keeps one block under the 8 MiB MCP SSE backlog and provider per-image limits. */
/** At most this many media blocks, and this much base64 in all, survive in one tool result. */
export const MAX_MEDIA_BLOCKS = 16;
export const MAX_MEDIA_TOTAL_BASE64_CHARS = 24 * 1024 * 1024;
export const MAX_MEDIA_BASE64_CHARS = 6 * 1024 * 1024;

const DEFAULT_MAX_RESOURCE_CHARS = 20000;
const MAX_REDACT_DEPTH = 32;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

export function toolOutput(
    content: ToolContentBlock[],
    extras?: { structuredContent?: Record<string, unknown>; isError?: boolean },
): ToolOutput {
    const out: ToolOutput = { kind: TOOL_OUTPUT_KIND, content };
    if (extras?.structuredContent !== undefined) out.structuredContent = extras.structuredContent;
    if (extras?.isError !== undefined) out.isError = extras.isError;
    return out;
}

export function isToolOutput(value: unknown): value is ToolOutput {
    return isPlainObject(value)
        && value.kind === TOOL_OUTPUT_KIND
        && Array.isArray(value.content);
}

export function hasMedia(output: ToolOutput): boolean {
    return output.content.some((block) => block?.type !== 'text');
}

export function isModelImageMime(mimeType: string): boolean {
    if (typeof mimeType !== 'string') return false;
    const base = mimeType.split(';')[0].trim().toLowerCase();
    return (MODEL_IMAGE_MIME_TYPES as readonly string[]).includes(base);
}

/** Exact decoded length of a base64 string (padding aware, whitespace ignored). */
export function base64ByteLength(b64: string): number {
    if (!b64) return 0;
    let len = b64.length;
    // Whitespace is not part of the payload; only pay for the scan when present.
    if (/\s/.test(b64)) {
        len = b64.replace(/\s+/g, '').length;
        b64 = b64.replace(/\s+/g, '');
    }
    let padding = 0;
    if (b64.endsWith('==')) padding = 2;
    else if (b64.endsWith('=')) padding = 1;
    return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

function formatMb(bytes: number): string {
    return (bytes / (1024 * 1024)).toFixed(1);
}

const LIMIT_MB = formatMb((MAX_MEDIA_BASE64_CHARS * 3) / 4);

/** True when `content` is an array with at least one well-formed non-text block. */
export function contentHasMedia(content: unknown): boolean {
    if (!Array.isArray(content)) return false;
    return content.some((block) => {
        if (!isPlainObject(block)) return false;
        switch (block.type) {
            case 'image':
            case 'audio':
                return typeof block.data === 'string' && typeof block.mimeType === 'string';
            case 'resource_link':
                return typeof block.uri === 'string';
            case 'resource':
                return isPlainObject(block.resource) && typeof block.resource.uri === 'string';
            default:
                return false;
        }
    });
}

function cleanBase64(data: string): string {
    return data.replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '');
}

function copyDefined<T extends Record<string, unknown>>(source: Record<string, unknown>, keys: string[]): T {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
        if (source[key] !== undefined) out[key] = source[key];
    }
    return out as T;
}

/** Validate an MCP `content` array into canonical blocks. Never throws. */
export function normalizeMcpContent(content: unknown): ToolContentBlock[] {
    if (!Array.isArray(content)) return [];
    const out: ToolContentBlock[] = [];
    // The per-block cap alone lets a server send hundreds of blocks; bound the whole result too.
    let mediaBlocks = 0;
    let mediaChars = 0;
    const admit = (chars: number): boolean => {
        if (mediaBlocks + 1 > MAX_MEDIA_BLOCKS || mediaChars + chars > MAX_MEDIA_TOTAL_BASE64_CHARS) return false;
        mediaBlocks += 1;
        mediaChars += chars;
        return true;
    };
    for (const raw of content) {
        if (!isPlainObject(raw)) continue;
        const type = raw.type;
        if (type === 'text') {
            if (typeof raw.text === 'string') out.push({ type: 'text', text: raw.text });
            continue;
        }
        if (type === 'image' || type === 'audio') {
            if (typeof raw.data !== 'string' || typeof raw.mimeType !== 'string') {
                out.push({ type: 'text', text: `[unsupported content type: ${String(type)}]` });
                continue;
            }
            const data = cleanBase64(raw.data);
            if (data.length > MAX_MEDIA_BASE64_CHARS) {
                out.push({
                    type: 'text',
                    text: `[${type} omitted: ${formatMb(base64ByteLength(data))} MB is over the ${LIMIT_MB} MB limit]`,
                });
                continue;
            }
            if (!admit(data.length)) {
                out.push({ type: 'text', text: `[${type} omitted: too much media in one result]` });
                continue;
            }
            out.push(type === 'image'
                ? { type: 'image', mimeType: raw.mimeType, data }
                : { type: 'audio', mimeType: raw.mimeType, data });
            continue;
        }
        if (type === 'resource_link') {
            if (typeof raw.uri !== 'string') {
                out.push({ type: 'text', text: '[unsupported content type: resource_link]' });
                continue;
            }
            const block = copyDefined<Record<string, unknown>>(raw, ['uri', 'name', 'title', 'description', 'mimeType', 'size']);
            for (const key of ['name', 'title', 'description', 'mimeType'] as const) {
                if (block[key] !== undefined && typeof block[key] !== 'string') delete block[key];
            }
            if (block.size !== undefined && typeof block.size !== 'number') delete block.size;
            out.push({ type: 'resource_link', ...block } as ToolContentBlock);
            continue;
        }
        if (type === 'resource') {
            const res = raw.resource;
            if (!isPlainObject(res) || typeof res.uri !== 'string') {
                out.push({ type: 'text', text: '[unsupported content type: resource]' });
                continue;
            }
            const resource: { uri: string; mimeType?: string; text?: string; blob?: string } = { uri: res.uri };
            if (typeof res.mimeType === 'string') resource.mimeType = res.mimeType;
            if (typeof res.text === 'string') resource.text = res.text;
            if (typeof res.blob === 'string') {
                const blob = cleanBase64(res.blob);
                if (blob.length > MAX_MEDIA_BASE64_CHARS) {
                    const note = `[binary content omitted: ${formatMb(base64ByteLength(blob))} MB is over the ${LIMIT_MB} MB limit]`;
                    resource.text = resource.text ? `${resource.text}\n${note}` : note;
                } else if (!admit(blob.length)) {
                    const note = '[binary content omitted: too much media in one result]';
                    resource.text = resource.text ? `${resource.text}\n${note}` : note;
                } else {
                    resource.blob = blob;
                }
            }
            out.push({ type: 'resource', resource });
            continue;
        }
        out.push({ type: 'text', text: `[unsupported content type: ${String(type)}]` });
    }
    return out;
}

export function mcpResultToToolOutput(result: unknown): ToolOutput {
    const record = isPlainObject(result) ? result : {};
    const out: ToolOutput = {
        kind: TOOL_OUTPUT_KIND,
        content: normalizeMcpContent(record.content),
    };
    if (isPlainObject(record.structuredContent)) out.structuredContent = record.structuredContent;
    if (record.isError === true) out.isError = true;
    return out;
}

/**
 * Render for an MCP `tools/call` response, downgrading block types the
 * negotiated protocol version cannot carry.
 */
export function toMcpCallResult(
    output: ToolOutput,
    protocolVersion: string = '2025-03-26',
): { content: unknown[]; structuredContent?: Record<string, unknown>; isError?: boolean } {
    const content: unknown[] = [];
    for (const block of output.content) {
        switch (block.type) {
            case 'text':
                content.push({ type: 'text', text: block.text });
                break;
            case 'image':
                if (typeof block.data === 'string') {
                    content.push({ type: 'image', data: block.data, mimeType: block.mimeType });
                } else {
                    content.push({ type: 'text', text: `[image: ${block.name ?? block.mimeType}]` });
                }
                break;
            case 'audio':
                content.push(protocolVersion >= '2025-03-26'
                    ? { type: 'audio', data: block.data, mimeType: block.mimeType }
                    : { type: 'text', text: `[audio: ${block.mimeType}]` });
                break;
            case 'resource_link':
                if (protocolVersion >= '2025-06-18') {
                    content.push({ ...block });
                } else {
                    content.push({ type: 'text', text: `[${block.name ?? block.uri}](${block.uri})` });
                }
                break;
            case 'resource':
                content.push({ type: 'resource', resource: block.resource });
                break;
            default:
                break;
        }
    }

    const result: { content: unknown[]; structuredContent?: Record<string, unknown>; isError?: boolean } = { content };
    if (output.structuredContent) {
        if (protocolVersion >= '2025-06-18') {
            result.structuredContent = output.structuredContent;
        } else if (!output.content.some((b) => b.type === 'text')) {
            content.push({ type: 'text', text: JSON.stringify(output.structuredContent) });
        }
    }
    if (output.isError) result.isError = true;
    return result;
}

export function toolOutputToText(output: ToolOutput, opts?: { maxResourceChars?: number }): string {
    const maxResource = opts?.maxResourceChars ?? DEFAULT_MAX_RESOURCE_CHARS;
    const parts: string[] = [];
    let hasText = false;
    for (const block of output.content) {
        switch (block.type) {
            case 'text':
                hasText = true;
                parts.push(block.text);
                break;
            case 'image': {
                const dims = block.width && block.height ? ` ${block.width}x${block.height}` : '';
                parts.push(`[image: ${block.name ?? block.mimeType}${dims}]`);
                break;
            }
            case 'audio':
                parts.push(`[audio: ${block.mimeType}]`);
                break;
            case 'resource_link':
                parts.push(`[link: ${block.name ?? block.uri} <${block.uri}>]`);
                break;
            case 'resource':
                if (typeof block.resource.text === 'string') {
                    hasText = true;
                    parts.push(block.resource.text.length > maxResource
                        ? block.resource.text.slice(0, maxResource)
                        : block.resource.text);
                } else {
                    parts.push(`[binary resource: ${block.resource.uri}]`);
                }
                break;
            default:
                break;
        }
    }
    if (!hasText && output.structuredContent) parts.push(JSON.stringify(output.structuredContent));
    return parts.join('\n');
}

/** Upstream results are untrusted: a record only counts as a media payload when the string really is
 *  base64, otherwise prose hidden under {type:'image',data} would skip guardrails and secret masking. */
const BASE64_PAYLOAD_RE = /^[A-Za-z0-9+/\s]+={0,2}\s*$/;
const MIN_BASE64_PAYLOAD_CHARS = 32;

function looksLikeBase64Payload(value: unknown): boolean {
    return typeof value === 'string'
        && value.length >= MIN_BASE64_PAYLOAD_CHARS
        && BASE64_PAYLOAD_RE.test(value);
}

/** Walkers use this to skip base64 payloads. */
export function isMediaPayloadRecord(node: unknown): boolean {
    if (!isPlainObject(node)) return false;
    if ((node.type === 'image' || node.type === 'audio') && looksLikeBase64Payload(node.data)) return true;
    if (node.type === 'resource' && isPlainObject(node.resource) && looksLikeBase64Payload(node.resource.blob)) return true;
    return false;
}

function omitted(b64: string): string {
    return `[base64 omitted: ${base64ByteLength(b64)} bytes]`;
}

/** Deep copy with media payload strings replaced by a size marker. For logs/persistence only. */
export function redactMediaPayloads<T>(value: T): T {
    const ancestors = new WeakSet<object>();
    const visit = (node: unknown, depth: number): unknown => {
        if (node === null || typeof node !== 'object') return node;
        if (depth > MAX_REDACT_DEPTH || ancestors.has(node)) return node;
        ancestors.add(node);
        try {
            if (Array.isArray(node)) return node.map((item) => visit(item, depth + 1));
            if (!isPlainObject(node)) return node;
            const media = isMediaPayloadRecord(node);
            const out: Record<string, unknown> = {};
            for (const [key, child] of Object.entries(node)) {
                if (media && key === 'data' && typeof child === 'string') {
                    out[key] = omitted(child);
                } else if (media && key === 'resource' && isPlainObject(child)) {
                    const res: Record<string, unknown> = {};
                    for (const [rk, rv] of Object.entries(child)) {
                        res[rk] = rk === 'blob' && typeof rv === 'string' ? omitted(rv) : visit(rv, depth + 2);
                    }
                    out[key] = res;
                } else {
                    out[key] = visit(child, depth + 1);
                }
            }
            return out;
        } finally {
            ancestors.delete(node);
        }
    };
    return visit(value, 0) as T;
}
