/**
 * The settings side of session files — pure, no database, so the Studio's
 * composer and Configure panel can use it too. See sessionFiles.ts for what the
 * settings do.
 */

import type { IAgentAttachmentsConfig, IAgentConfig } from '@/lib/database/provider/types.domain';

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

/** Names of the two read-only tools, in one place for the tool list and the approval exemption. */
export const SESSION_FILES_LIST_TOOL = 'session_files_list';
export const SESSION_FILES_READ_TOOL = 'session_files_read';
/** Looks at an image of the session again; offered while the session holds an image and the model takes images. */
export const SESSION_FILES_VIEW_IMAGE_TOOL = 'session_files_view_image';

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
    };
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

export function isImageMime(mimeType: string | undefined): boolean {
    return Boolean(mimeType && mimeType.toLowerCase().startsWith('image/'));
}
