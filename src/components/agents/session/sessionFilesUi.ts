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
    /** `uploadedBy` as a person's name, when the server could resolve it. */
    uploadedByName?: string;
}

export function sessionFilesUrl(agentId: string, sessionId: string): string {
    return `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/files`;
}

export function sessionFileUrl(agentId: string, sessionId: string, fileId: string): string {
    return `${sessionFilesUrl(agentId, sessionId)}/${encodeURIComponent(fileId)}`;
}

/** Which copy of a file the content route sends: the upload as it came, or the text it was converted to. */
export type FileVariant = 'original' | 'markdown';

/** `inline` = shown by the browser (an image); `attachment` = saved. The server decides when none is asked for, and always saves SVG / HTML. */
export type FileDisposition = 'inline' | 'attachment';

/**
 * `GET /api/agents/:agentId/sessions/:sessionId/files/:fileId/content` — the
 * file's bytes, streamed from its bucket, under the session's access check.
 */
export function sessionFileContentUrl(
    agentId: string,
    sessionId: string,
    fileId: string,
    options: { variant?: FileVariant; disposition?: FileDisposition } = {},
): string {
    const params = new URLSearchParams();
    if (options.variant) params.set('variant', options.variant);
    if (options.disposition) params.set('disposition', options.disposition);
    const query = params.toString();
    return `${sessionFileUrl(agentId, sessionId, fileId)}/content${query ? `?${query}` : ''}`;
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

/* ── A file as the transcript shows it ────────────────────────────────────── */

/**
 * One file in a transcript, wherever the transcript is drawn: a session page,
 * the inspector of a session, a request in tracing. `url` shows or opens it
 * (an image is drawn from it), `downloadUrl` saves it; neither = nothing to
 * open. `expired` = the file is gone (retention, or deleted), shown muted.
 * `reference` = the request holds only a pointer to a file kept elsewhere.
 */
export interface AttachmentView {
    fileId: string;
    name: string;
    mimeType: string;
    size?: number;
    url?: string;
    downloadUrl?: string;
    expired?: boolean;
    reference?: boolean;
    /** `url` is an address on another site: shown as a link to click, never fetched by the page itself. */
    external?: boolean;
    /**
     * A picture drawn from a reference the viewer may not be allowed to open (a tracing request's
     * `session-file://`): when its address refuses or the file is gone, the named chip is shown
     * in its place instead of a broken-picture stand-in.
     */
    fallbackToChip?: boolean;
}

export type AttachmentKind = 'image' | 'pdf' | 'document' | 'spreadsheet' | 'presentation' | 'archive' | 'code' | 'text' | 'other';

const DOCUMENT_EXTENSIONS = new Set(['doc', 'docx', 'odt', 'rtf']);
const SPREADSHEET_EXTENSIONS = new Set(['xls', 'xlsx', 'ods', 'csv', 'tsv']);
const PRESENTATION_EXTENSIONS = new Set(['ppt', 'pptx', 'odp', 'key']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', '7z', 'rar']);
const CODE_EXTENSIONS = new Set(['json', 'xml', 'yaml', 'yml', 'js', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rs', 'rb', 'php', 'sh', 'sql', 'html', 'css']);

/** What kind of file this is, for its icon — from the MIME type, and the file name when the type says too little. */
export function attachmentKind(file: { mimeType?: string; name?: string }): AttachmentKind {
    const mime = (file.mimeType ?? '').toLowerCase();
    const name = (file.name ?? '').toLowerCase();
    const dot = name.lastIndexOf('.');
    const extension = dot >= 0 ? name.slice(dot + 1) : '';

    if (mime.startsWith('image/')) return 'image';
    if (mime === 'application/pdf' || extension === 'pdf') return 'pdf';
    if (mime.includes('wordprocessingml') || mime === 'application/msword' || DOCUMENT_EXTENSIONS.has(extension)) return 'document';
    if (mime.includes('spreadsheetml') || mime === 'application/vnd.ms-excel' || mime === 'text/csv' || SPREADSHEET_EXTENSIONS.has(extension)) return 'spreadsheet';
    if (mime.includes('presentationml') || mime.includes('powerpoint') || PRESENTATION_EXTENSIONS.has(extension)) return 'presentation';
    if (mime.includes('zip') || mime.includes('tar') || mime.includes('gzip') || ARCHIVE_EXTENSIONS.has(extension)) return 'archive';
    if (mime.includes('json') || mime.includes('xml') || mime.includes('javascript') || mime.includes('yaml') || CODE_EXTENSIONS.has(extension)) return 'code';
    if (mime.startsWith('text/')) return 'text';
    return 'other';
}

/** The file is past its expiry, or the server no longer lists it. */
export function isFileGone(
    fileId: string,
    files: ReadonlyArray<Pick<SessionFileItem, 'id' | 'expiresAt'>> | null | undefined,
    now: Date = new Date(),
): boolean {
    // Until the session's files have been listed there is no telling, so nothing is called expired.
    if (!files) return false;
    const held = files.find((file) => file.id === fileId);
    if (!held) return true;
    if (!held.expiresAt) return false;
    const at = Date.parse(held.expiresAt);
    return Number.isFinite(at) && at <= now.getTime();
}

/** How a session file is shown or opened (`url`) and how it is saved (`downloadUrl`). */
export function sessionFileLinks(agentId: string, sessionId: string, fileId: string): { url: string; downloadUrl: string } {
    return {
        url: sessionFileContentUrl(agentId, sessionId, fileId, { variant: 'original', disposition: 'inline' }),
        downloadUrl: sessionFileContentUrl(agentId, sessionId, fileId, { variant: 'original', disposition: 'attachment' }),
    };
}

/**
 * The files of a message as the transcript draws them, linked to the session's
 * content route. A file the server no longer holds is marked `expired` and gets
 * no link; `files` null (not listed yet) marks none.
 */
export function toAttachmentViews(
    attachments: ReadonlyArray<{ fileId: string; name: string; mimeType: string; size?: number }> | undefined,
    context: {
        agentId: string;
        sessionId: string;
        files?: ReadonlyArray<Pick<SessionFileItem, 'id' | 'expiresAt'>> | null;
        now?: Date;
    },
): AttachmentView[] {
    return (attachments ?? []).map((file) => {
        const view: AttachmentView = { fileId: file.fileId, name: file.name, mimeType: file.mimeType, size: file.size };
        if (isFileGone(file.fileId, context.files, context.now)) return { ...view, expired: true };
        return { ...view, ...sessionFileLinks(context.agentId, context.sessionId, file.fileId) };
    });
}
