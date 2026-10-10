/**
 * The settings side of session files — pure, no database, so the Studio's
 * composer and Configure panel can use it too. See sessionFiles.ts for what the
 * settings do.
 */

import type { IAgentAttachmentsConfig, IAgentConfig } from '@/lib/database/provider/types.domain';

/** What an unset field of `IAgentConfig.attachments` falls back to. */
export const SESSION_FILES_DEFAULTS = {
    enabled: true,
    maxFiles: 10,
    maxFileSizeMb: 20,
    inlineMaxTokens: 30_000,
    readPageChars: 20_000,
    retentionDays: 30,
} as const;

/** Names of the two read-only tools, in one place for the tool list and the approval exemption. */
export const SESSION_FILES_LIST_TOOL = 'session_files_list';
export const SESSION_FILES_READ_TOOL = 'session_files_read';

export interface ResolvedAttachmentsConfig {
    enabled: boolean;
    maxFiles: number;
    maxFileSizeMb: number;
    allowedMimeTypes: string[];
    inlineMaxTokens: number;
    readPageChars: number;
    retentionDays: number;
    bucketKey?: string;
}

function positive(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** The agent's attachment settings with the defaults filled in. */
export function resolveAttachmentsConfig(raw?: IAgentAttachmentsConfig | null): ResolvedAttachmentsConfig {
    return {
        enabled: raw?.enabled !== false,
        maxFiles: Math.floor(positive(raw?.maxFiles, SESSION_FILES_DEFAULTS.maxFiles)),
        maxFileSizeMb: positive(raw?.maxFileSizeMb, SESSION_FILES_DEFAULTS.maxFileSizeMb),
        allowedMimeTypes: Array.isArray(raw?.allowedMimeTypes)
            ? raw.allowedMimeTypes.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
            : [],
        inlineMaxTokens: Math.floor(positive(raw?.inlineMaxTokens, SESSION_FILES_DEFAULTS.inlineMaxTokens)),
        readPageChars: Math.floor(positive(raw?.readPageChars, SESSION_FILES_DEFAULTS.readPageChars)),
        retentionDays: positive(raw?.retentionDays, SESSION_FILES_DEFAULTS.retentionDays),
        ...(typeof raw?.bucketKey === 'string' && raw.bucketKey.trim() ? { bucketKey: raw.bucketKey.trim() } : {}),
    };
}

/** A connected (external) agent runs remotely: nothing we attach would reach its model. */
export function agentTakesAttachments(config: IAgentConfig | undefined): boolean {
    if (!config) return false;
    if (config.kind === 'external' && config.connection) return false;
    return resolveAttachmentsConfig(config.attachments).enabled;
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

