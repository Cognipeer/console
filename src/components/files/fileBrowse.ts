/**
 * The Document Store's bucket view as pure functions: folders derived from file
 * keys, the breadcrumb, the "session files / other" filter, and the session
 * columns (expiry, link).
 *
 * A bucket has no folder rows: a file is `a/b/c.txt` and `a/` and `a/b/` exist
 * only because keys say so. The server lists one folder at a time (`prefix`)
 * and names its sub-folders; keys that arrive nested anyway are folded into
 * folders here, so the view is right whichever way a page came back.
 */

import type { FileRecordView } from '@/lib/services/files';

/** A sub-folder of the folder being viewed. `path` is the full prefix and ends with `/`. */
export interface FolderEntry {
    name: string;
    path: string;
}

/** Which files the list keeps. */
export type SessionFileFilter = 'all' | 'session' | 'other';

/** A folder path the way the listing takes it: no leading slash, one trailing slash, `''` = the bucket root. */
export function normalizePrefix(raw: string | undefined | null): string {
    const trimmed = (raw ?? '').trim().replace(/^\/+/, '').replace(/\/{2,}/g, '/');
    if (!trimmed) return '';
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

export interface Crumb {
    /** The folder's own name; `''` for the bucket root. */
    label: string;
    /** The prefix that opens it. */
    prefix: string;
}

/** The path to a folder, root first: `a/b/` → root, `a/`, `a/b/`. */
export function breadcrumbs(prefix: string): Crumb[] {
    const crumbs: Crumb[] = [{ label: '', prefix: '' }];
    let path = '';
    for (const segment of normalizePrefix(prefix).split('/').filter(Boolean)) {
        path += `${segment}/`;
        crumbs.push({ label: segment, prefix: path });
    }
    return crumbs;
}

/** The folder one level up, or null at the root. */
export function parentPrefix(prefix: string): string | null {
    const crumbs = breadcrumbs(prefix);
    return crumbs.length > 1 ? crumbs[crumbs.length - 2]!.prefix : null;
}

function relativeKey(prefix: string, key: string): string | null {
    return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

/** The files directly in the folder (a key with no further `/` after the prefix). */
export function filesInFolder<T extends { key: string }>(prefix: string, items: T[]): T[] {
    return items.filter((item) => {
        const rest = relativeKey(prefix, item.key);
        return rest !== null && rest.length > 0 && !rest.includes('/');
    });
}

/**
 * The sub-folders to show: the ones the server named, plus any a nested key
 * implies, each once, in name order.
 */
export function subFolders(prefix: string, named: string[] | undefined, items: Array<{ key: string }>): FolderEntry[] {
    const paths = new Set<string>();
    for (const raw of named ?? []) {
        const path = normalizePrefix(raw);
        if (path.startsWith(prefix) && path.length > prefix.length) paths.add(path);
    }
    for (const item of items) {
        const rest = relativeKey(prefix, item.key);
        const slash = rest?.indexOf('/') ?? -1;
        if (rest && slash > 0) paths.add(`${prefix}${rest.slice(0, slash + 1)}`);
    }
    // Only the first level below the prefix: a named path may be deeper than one segment.
    const direct = new Map<string, FolderEntry>();
    for (const path of paths) {
        const segment = path.slice(prefix.length).split('/')[0]!;
        direct.set(segment, { name: segment, path: `${prefix}${segment}/` });
    }
    return [...direct.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function isSessionFile(record: Pick<FileRecordView, 'purpose'>): boolean {
    return record.purpose === 'conversation';
}

/** Keeps the files the filter asks for. */
export function applySessionFilter<T extends Pick<FileRecordView, 'purpose'>>(items: T[], filter: SessionFileFilter): T[] {
    if (filter === 'session') return items.filter(isSessionFile);
    if (filter === 'other') return items.filter((item) => !isSessionFile(item));
    return items;
}

/** The `purpose` the listing takes for a filter; `all` sends none. */
export function purposeParam(filter: SessionFileFilter): 'conversation' | 'other' | undefined {
    return filter === 'session' ? 'conversation' : filter === 'other' ? 'other' : undefined;
}

/** The listing URL for a folder. `prefix` is always sent, so the server lists the folder and not the whole bucket. */
export function objectsUrl(
    bucketKey: string,
    options: { prefix: string; filter: SessionFileFilter; cursor?: string; limit?: number },
): string {
    const params = new URLSearchParams();
    params.set('limit', String(options.limit ?? 50));
    params.set('prefix', options.prefix);
    const purpose = purposeParam(options.filter);
    if (purpose) params.set('purpose', purpose);
    if (options.cursor) params.set('cursor', options.cursor);
    return `/api/files/buckets/${encodeURIComponent(bucketKey)}/objects?${params.toString()}`;
}

export interface ExpiryLabel {
    kind: 'none' | 'expired' | 'future';
    /** The localized phrase ("in 12 days", "12 gün sonra"); empty for `none`. */
    text: string;
}

/** When a session file goes away, as a phrase in the viewer's language. */
export function expiryLabel(expiresAt: Date | string | null | undefined, now: Date, locale: string): ExpiryLabel {
    if (!expiresAt) return { kind: 'none', text: '' };
    const at = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    if (Number.isNaN(at.getTime())) return { kind: 'none', text: '' };
    const diffMs = at.getTime() - now.getTime();
    const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const minutes = Math.round(diffMs / 60_000);
    const abs = Math.abs(minutes);
    const unit: [number, Intl.RelativeTimeFormatUnit] =
        abs >= 24 * 60 ? [Math.round(diffMs / 86_400_000), 'day']
            : abs >= 60 ? [Math.round(diffMs / 3_600_000), 'hour']
                : [minutes, 'minute'];
    return { kind: diffMs <= 0 ? 'expired' : 'future', text: formatter.format(unit[0], unit[1]) };
}

/** The agent session page a session file belongs to; null when the agent is not known. */
export function sessionHref(agentId: string | undefined, conversationId: string | undefined): string | null {
    if (!agentId || !conversationId) return null;
    return `/dashboard/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(conversationId)}`;
}

/** The sentence a refused bucket delete or disable carries: the server's reason, with the agents it names if the text lacks them. */
export function bucketRefusalMessage(error: unknown): string {
    const fallback = error instanceof Error ? error.message : 'Unexpected error';
    const payload = (error as { payload?: unknown } | null)?.payload;
    const agents = payload && typeof payload === 'object' ? (payload as { agents?: unknown }).agents : undefined;
    if (!Array.isArray(agents) || agents.length === 0) return fallback;
    const names = agents
        .map((agent) => {
            if (typeof agent === 'string') return agent;
            const record = agent as { name?: unknown; key?: unknown };
            return typeof record.name === 'string' ? record.name : typeof record.key === 'string' ? record.key : '';
        })
        .filter(Boolean);
    const missing = names.filter((name) => !fallback.includes(name));
    return missing.length > 0 ? `${fallback} (${missing.join(', ')})` : fallback;
}
