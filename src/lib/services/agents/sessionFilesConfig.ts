/**
 * The settings side of session files — pure, no database, so the Studio's
 * composer and Configure panel can use it too. See sessionFiles.ts for what the
 * settings do.
 */

import type { IAgentAttachmentsConfig, IAgentConfig } from '@/lib/database/provider/types.domain';

/** `attachments.ocr` as resolved: the same shape as stored, sanitised. */
export type ResolvedAttachmentsOcr = NonNullable<IAgentAttachmentsConfig['ocr']>;

/** What an unset field of `IAgentConfig.attachments` falls back to. */
export const SESSION_FILES_DEFAULTS = {
    enabled: false,
    maxFiles: 10,
    maxFileSizeMb: 20,
    inlineMaxTokens: 30_000,
    readPageChars: 20_000,
    retentionDays: 30,
    folder: 'agent-sessions',
    attachNewUploads: true,
    maxImages: 6,
    maxBytes: 12_000_000,
    carryRecentImages: 2,
} as const;

/** Longest `attachments.folder` (after normalising). */
export const SESSION_FILES_FOLDER_MAX_LENGTH = 200;

/** Names of the read-only file tools, in one place for the tool list and the approval exemption. */
export const SESSION_FILES_LIST_TOOL = 'session_files_list';
/** Reads any file: a sandbox path or a session file id (`readTool.ts`). Replaces `sandbox_read_file` / `session_files_read` / `session_files_view_image`. */
export const READ_TOOL = 'read';
/** The old "look at an image again" tool: no longer offered, but old conversations hold its results (`sessionImages.ts`). */
export const SESSION_FILES_VIEW_IMAGE_TOOL = 'session_files_view_image';
/** The agent writes a text file for the person / adds to one it wrote (`attachments.outputs`, no sandbox needed). */
export const SESSION_FILES_CREATE_TOOL = 'session_files_create';
export const SESSION_FILES_APPEND_TOOL = 'session_files_append';

/** What an unset field of `attachments.outputs` falls back to, and the most a stored value may ask for. */
export const SESSION_FILE_OUTPUTS_DEFAULTS = { maxFilesPerTurn: 10, maxFileSizeMb: 2 } as const;
export const SESSION_FILE_OUTPUTS_LIMITS = { maxFilesPerTurn: 20, maxFileSizeMb: 10 } as const;

/**
 * The file types the agent may write: extension -> the MIME type it is stored as. Text only, so a
 * file is readable by the next turn (`read`) and cannot carry anything but text.
 */
export const FILE_OUTPUT_TYPES: Readonly<Record<string, string>> = {
    md: 'text/markdown',
    csv: 'text/csv',
    txt: 'text/plain',
    json: 'application/json',
    html: 'text/html',
    xml: 'application/xml',
    yaml: 'application/yaml',
    yml: 'application/yaml',
};

/** The extensions the agent may write, in the order the prompt and the capability list name them. */
export const FILE_OUTPUT_EXTENSIONS: readonly string[] = Object.keys(FILE_OUTPUT_TYPES);

/** Other spellings of a type the agent may declare for an extension; anything else is a mismatch. */
export const FILE_OUTPUT_MIME_ALIASES: Readonly<Record<string, readonly string[]>> = {
    md: ['text/x-markdown'],
    xml: ['text/xml'],
    yaml: ['text/yaml', 'application/x-yaml', 'text/x-yaml'],
    yml: ['text/yaml', 'application/x-yaml', 'text/x-yaml'],
};

export interface ResolvedAttachmentsConfig {
    /** The switch as the agent's owner set it; whether files are really usable also needs a bucket (`attachmentsAvailability`). */
    enabled: boolean;
    maxFiles: number;
    maxFileSizeMb: number;
    allowedMimeTypes: string[];
    inlineMaxTokens: number;
    readPageChars: number;
    retentionDays: number;
    /** Root folder inside the bucket, normalised (never empty, no leading or trailing slash). */
    folder: string;
    /** Files nobody has sent yet ride along with the next message. */
    attachNewUploads: boolean;
    /** Images one model request carries at most (oldest become a text placeholder). */
    maxImages: number;
    /** Image bytes one model request carries at most. */
    maxBytes: number;
    /** Recent image-bearing messages shown again when they fell out of the agent's context. 0 = off. */
    carryRecentImages: number;
    bucketKey?: string;
    /** OCR for uploads, sanitised; absent when the agent has none stored. `mode: 'off'` = stored but off. */
    ocr?: ResolvedAttachmentsOcr;
}

const OCR_MODES: ReadonlySet<string> = new Set(['off', 'auto', 'always']);

/**
 * `attachments.ocr` as the runtime reads it. A stored value that bypassed the save check (by hand, an old import)
 * must not break an upload: what is wrong is dropped, and a missing or unknown `mode` is `off`.
 */
export function resolveAttachmentsOcr(raw: unknown): ResolvedAttachmentsOcr | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const input = raw as Record<string, unknown>;
    const mode = typeof input.mode === 'string' && OCR_MODES.has(input.mode) ? (input.mode as ResolvedAttachmentsOcr['mode']) : 'off';
    const modelKey = typeof input.modelKey === 'string' ? input.modelKey.trim() : '';
    const languages = Array.isArray(input.languages)
        ? [...new Set(input.languages.filter((entry): entry is string => typeof entry === 'string' && /^[a-z]{2,3}(_[a-z]+)?$/i.test(entry.trim())).map((entry) => entry.trim().toLowerCase()))].slice(0, 8)
        : [];
    return {
        mode,
        ...(modelKey && modelKey.length <= 120 ? { modelKey } : {}),
        ...(languages.length > 0 ? { languages } : {}),
        ...(typeof input.maxPages === 'number' && Number.isInteger(input.maxPages) && input.maxPages >= 1 ? { maxPages: input.maxPages } : {}),
        ...(typeof input.images === 'boolean' ? { images: input.images } : {}),
    };
}

/** OCR is switched on for uploads (a stored `mode` other than `off`). */
export function attachmentsOcrActive(cfg: Pick<ResolvedAttachmentsConfig, 'ocr'>): boolean {
    return cfg.ocr !== undefined && cfg.ocr.mode !== 'off';
}

/** Pictures are read by OCR too: OCR is on and the agent asked for images. */
export function attachmentsOcrReadsImages(cfg: Pick<ResolvedAttachmentsConfig, 'ocr'>): boolean {
    return attachmentsOcrActive(cfg) && cfg.ocr?.images === true;
}

function positive(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A whole number >= 0 (0 is a real choice here: "never"). */
function nonNegativeInt(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

const FOLDER_CHARS = /^[A-Za-z0-9._\-/]*$/;

/**
 * `attachments.folder` as stored: slashes trimmed and collapsed, backslashes
 * read as slashes. `error` says why a value cannot be a folder (a character
 * outside `A-Z a-z 0-9 . _ - /`, a `..` or a lone `.` segment, too long);
 * `folder` is then empty. An empty input is fine (the default applies).
 */
export function normalizeAttachmentsFolder(raw: unknown): { folder: string; error?: string } {
    if (raw === undefined || raw === null) return { folder: '' };
    if (typeof raw !== 'string') return { folder: '', error: 'must be text' };
    const folder = raw.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
    if (!FOLDER_CHARS.test(folder)) return { folder: '', error: 'may only contain letters, digits and . _ - /' };
    if (folder.includes('..') || folder.split('/').includes('.')) return { folder: '', error: 'cannot contain "." or ".." segments' };
    if (folder.length > SESSION_FILES_FOLDER_MAX_LENGTH) {
        return { folder: '', error: `must be at most ${SESSION_FILES_FOLDER_MAX_LENGTH} characters` };
    }
    return { folder };
}

/** The agent's attachment settings with the defaults filled in. */
export function resolveAttachmentsConfig(raw?: IAgentAttachmentsConfig | null): ResolvedAttachmentsConfig {
    // A folder that cannot be one (stored by hand, bypassing the save check) falls back to the default
    // rather than letting a path escape the layout.
    const folder = normalizeAttachmentsFolder(raw?.folder).folder || SESSION_FILES_DEFAULTS.folder;
    const ocr = resolveAttachmentsOcr(raw?.ocr);
    return {
        enabled: raw?.enabled === true,
        maxFiles: Math.floor(positive(raw?.maxFiles, SESSION_FILES_DEFAULTS.maxFiles)),
        maxFileSizeMb: positive(raw?.maxFileSizeMb, SESSION_FILES_DEFAULTS.maxFileSizeMb),
        allowedMimeTypes: Array.isArray(raw?.allowedMimeTypes)
            ? raw.allowedMimeTypes.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
            : [],
        inlineMaxTokens: Math.floor(positive(raw?.inlineMaxTokens, SESSION_FILES_DEFAULTS.inlineMaxTokens)),
        readPageChars: Math.floor(positive(raw?.readPageChars, SESSION_FILES_DEFAULTS.readPageChars)),
        retentionDays: positive(raw?.retentionDays, SESSION_FILES_DEFAULTS.retentionDays),
        folder,
        attachNewUploads: raw?.attachNewUploads !== false,
        maxImages: Math.floor(positive(raw?.maxImages, SESSION_FILES_DEFAULTS.maxImages)),
        maxBytes: Math.floor(positive(raw?.maxBytes, SESSION_FILES_DEFAULTS.maxBytes)),
        carryRecentImages: nonNegativeInt(raw?.carryRecentImages, SESSION_FILES_DEFAULTS.carryRecentImages),
        ...(typeof raw?.bucketKey === 'string' && raw.bucketKey.trim() ? { bucketKey: raw.bucketKey.trim() } : {}),
        ...(ocr ? { ocr } : {}),
    };
}

export interface ResolvedOutputsConfig {
    enabled: boolean;
    maxFilesPerTurn: number;
    maxFileSizeMb: number;
}

function boundedNumber(value: unknown, fallback: number, max: number, whole: boolean): number {
    const n = positive(value, fallback);
    return Math.min(whole ? Math.floor(n) : n, max);
}

/**
 * `attachments.outputs` with the defaults filled in and the limits clamped to what the server allows.
 * `enabled` left unset follows uploads: on when the agent takes uploads and has a bucket, off otherwise.
 */
export function resolveOutputsConfig(raw?: IAgentAttachmentsConfig | null): ResolvedOutputsConfig {
    const outputs = raw?.outputs;
    return {
        enabled: typeof outputs?.enabled === 'boolean' ? outputs.enabled : raw?.enabled === true && Boolean(raw.bucketKey?.trim()),
        maxFilesPerTurn: boundedNumber(outputs?.maxFilesPerTurn, SESSION_FILE_OUTPUTS_DEFAULTS.maxFilesPerTurn, SESSION_FILE_OUTPUTS_LIMITS.maxFilesPerTurn, true),
        maxFileSizeMb: boundedNumber(outputs?.maxFileSizeMb, SESSION_FILE_OUTPUTS_DEFAULTS.maxFileSizeMb, SESSION_FILE_OUTPUTS_LIMITS.maxFileSizeMb, false),
    };
}

/**
 * Whether an agent can write files: not a connected agent, a bucket named, and the outputs switched on
 * (by default they follow `attachments.enabled`, see `resolveOutputsConfig`). Not tied to uploads:
 * an agent that takes none can still hand a file back. Whether the bucket works is checked when the run is built.
 */
export function outputsAvailability(config: IAgentConfig | undefined):
    | { available: true; cfg: ResolvedAttachmentsConfig & { bucketKey: string }; outputs: ResolvedOutputsConfig }
    | { available: false } {
    if (!config || (config.kind === 'external' && config.connection)) return { available: false };
    const cfg = resolveAttachmentsConfig(config.attachments);
    const outputs = resolveOutputsConfig(config.attachments);
    if (!outputs.enabled || !cfg.bucketKey) return { available: false };
    return { available: true, cfg: { ...cfg, bucketKey: cfg.bucketKey }, outputs };
}

/**
 * Whether an agent takes attachments, and if not, why:
 *  - `external`: a connected agent runs remotely, nothing we attach would reach its model;
 *  - `disabled`: the switch is off (the default);
 *  - `not_configured`: switched on but no bucket names where the files go
 *    (older data — saving such a config is refused now), so there is nowhere to put them.
 * Whether the named bucket still works is checked when a file arrives (sessionFilesBucket.ts).
 */
export type AttachmentsAvailability =
    | { available: true; cfg: ResolvedAttachmentsConfig & { bucketKey: string } }
    | { available: false; reason: 'external' | 'disabled' | 'not_configured' };

export function attachmentsAvailability(config: IAgentConfig | undefined): AttachmentsAvailability {
    if (!config) return { available: false, reason: 'disabled' };
    if (config.kind === 'external' && config.connection) return { available: false, reason: 'external' };
    const cfg = resolveAttachmentsConfig(config.attachments);
    if (!cfg.enabled) return { available: false, reason: 'disabled' };
    if (!cfg.bucketKey) return { available: false, reason: 'not_configured' };
    return { available: true, cfg: { ...cfg, bucketKey: cfg.bucketKey } };
}

/** What a refused upload or turn tells the caller. */
export function attachmentsUnavailableMessage(reason: 'external' | 'disabled' | 'not_configured'): string {
    return reason === 'not_configured' ? 'Files are not set up for this agent.' : 'This agent does not take attachments.';
}

/** Takes attachments AND has a bucket to keep them in: the paperclip, uploads and `attachments` ids all hang on this. */
export function agentTakesAttachments(config: IAgentConfig | undefined): boolean {
    return attachmentsAvailability(config).available;
}

export function isMimeAllowed(mimeType: string, allowed: string[]): boolean {
    if (allowed.length === 0) return true;
    const mime = mimeType.split(';')[0]!.trim().toLowerCase();
    return allowed.some((entry) => {
        const pattern = entry.split(';')[0]!.trim().toLowerCase();
        return pattern.endsWith('/*') ? mime.startsWith(pattern.slice(0, -1)) : pattern === mime;
    });
}

/** Looks like a picture (`image/*`). Whether a model can be SHOWN it is `isSendableImageMime`. */
export function isImageMime(mimeType: string | undefined): boolean {
    return Boolean(mimeType && mimeType.toLowerCase().startsWith('image/'));
}

/**
 * The picture formats a model request carries: what every provider the console
 * talks to accepts as image input. Any other `image/*` file (tiff, svg, heic,
 * bmp, ...) is stored like a document without text — the model is told it
 * exists and why it cannot see it, instead of the provider rejecting the
 * request (and, since a picture is re-attached on later turns, every later one).
 */
export const SENDABLE_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Spellings clients use for a sendable type that providers do not accept as a media type. */
const IMAGE_TYPE_ALIASES: Readonly<Record<string, string>> = { 'image/jpg': 'image/jpeg' };

/** The media type to send a picture as (parameters dropped, aliases folded), or null when it is not a sendable format. */
export function sendableImageType(mimeType: string | undefined): string | null {
    if (!mimeType) return null;
    const base = mimeType.split(';')[0]!.trim().toLowerCase();
    const type = IMAGE_TYPE_ALIASES[base] ?? base;
    return SENDABLE_IMAGE_TYPES.has(type) ? type : null;
}

/** A picture in a format a model request can carry. */
export function isSendableImageMime(mimeType: string | undefined): boolean {
    return sendableImageType(mimeType) !== null;
}

/** A picture the model cannot be shown (`image/*` but not a sendable format). */
export function isUnsupportedImageMime(mimeType: string | undefined): boolean {
    return isImageMime(mimeType) && !isSendableImageMime(mimeType);
}

/**
 * The most bytes one file of this type may have. A picture that is also bigger
 * than a model request carries (`maxBytes`) could never be shown, so it is held
 * to that smaller number: refused when it arrives rather than dropped, unseen,
 * from every request.
 */
export function maxUploadBytes(cfg: Pick<ResolvedAttachmentsConfig, 'maxFileSizeMb' | 'maxBytes' | 'ocr'>, mimeType: string | undefined): number {
    const perFile = Math.floor(cfg.maxFileSizeMb * 1024 * 1024);
    // With OCR on pictures, a picture too big to show is still read as text, so it is held to the document limit.
    return isSendableImageMime(mimeType) && !attachmentsOcrReadsImages(cfg) ? Math.min(perFile, cfg.maxBytes) : perFile;
}

/** The size refusal for a file of this type, in the words of whichever limit it hit. */
export function fileTooLargeMessage(cfg: Pick<ResolvedAttachmentsConfig, 'maxFileSizeMb' | 'maxBytes' | 'ocr'>, mimeType: string | undefined): string {
    const perFile = Math.floor(cfg.maxFileSizeMb * 1024 * 1024);
    if (isSendableImageMime(mimeType) && !attachmentsOcrReadsImages(cfg) && cfg.maxBytes < perFile) {
        return `Images larger than ${Math.round((cfg.maxBytes / 1_000_000) * 10) / 10} MB cannot be shown to the model (the image size limit of this agent).`;
    }
    return `File exceeds the ${cfg.maxFileSizeMb} MB limit of this agent.`;
}
