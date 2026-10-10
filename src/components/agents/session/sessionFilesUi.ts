/**
 * The session page's Files panel as pure functions: the rows the server's list
 * becomes, where a file is stored, and the URLs the panel calls.
 */

/** One file of `GET /api/agents/:agentId/sessions/:sessionId/files`. */
export interface SessionFileItem {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    /** `succeeded` = readable as text; `failed` / `skipped` = only the original exists; `pending` = converting. */
    conversionStatus?: 'pending' | 'succeeded' | 'failed' | 'skipped';
    conversionError?: string;
    /** The Document Store bucket the file is in, and its path inside it. */
    bucketKey?: string;
    path?: string;
    createdAt?: string;
    expiresAt?: string | null;
    uploadedBy?: string;
}

export function sessionFilesUrl(agentId: string, sessionId: string): string {
    return `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/files`;
}

export function sessionFileUrl(agentId: string, sessionId: string, fileId: string): string {
    return `${sessionFilesUrl(agentId, sessionId)}/${encodeURIComponent(fileId)}`;
}

/** `<bucket>/<path>` — where the original lives; just the bucket when the server gave no path. */
export function fileLocation(file: Pick<SessionFileItem, 'bucketKey' | 'path'>): string | null {
    if (!file.bucketKey) return null;
    return file.path ? `${file.bucketKey}/${file.path}` : file.bucketKey;
}

/** The Document Store page of the file's bucket. */
export function bucketHref(bucketKey: string | undefined): string | null {
    return bucketKey ? `/dashboard/files/${encodeURIComponent(bucketKey)}` : null;
}

export type ConversionBadgeKey = 'conversionPending' | 'conversionReady' | 'conversionFailed' | 'conversionSkipped';

/** How a file's text conversion reads, as a message key under `agents.attachments` and a badge colour; null when it is not known. */
export function conversionBadge(
    file: Pick<SessionFileItem, 'mimeType' | 'conversionStatus'>,
): { key: ConversionBadgeKey; color: string } | null {
    // An image is sent to the model as it is; "no text" would say something wrong about it.
    if (file.mimeType.toLowerCase().startsWith('image/')) return null;
    switch (file.conversionStatus) {
        case 'pending': return { key: 'conversionPending', color: 'yellow' };
        case 'succeeded': return { key: 'conversionReady', color: 'teal' };
        case 'failed': return { key: 'conversionFailed', color: 'orange' };
        case 'skipped': return { key: 'conversionSkipped', color: 'gray' };
        default: return null;
    }
}
