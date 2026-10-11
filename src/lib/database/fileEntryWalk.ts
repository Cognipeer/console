/**
 * A bucket seen as folders, derived from the file keys.
 *
 * Files are rows keyed `a/b/c.txt`; there are no folder rows. Listing a folder
 * the way an object store does (`prefix` + `/` delimiter) must not read every
 * key under it — a bucket of session files holds one folder per agent and per
 * session, tens of thousands of keys deep. So the walk goes along the key
 * index in order: read the next key; if it sits in a sub-folder, record the
 * folder and JUMP past all of its keys; otherwise it is a file of this folder.
 * One index probe per entry returned, whatever the bucket holds. Both
 * database providers run this same walk over their own `probe`.
 */

import type { IFileEntriesPage, IFileRecord } from './provider/types';

/** Where to start/stop reading keys, in key order. `gte` and `gt` are alternatives. */
export interface KeyRange {
    gte?: string;
    gt?: string;
    lt?: string;
}

/** The next `limit` file records in key order inside `range`. */
export type FileKeyProbe = (range: KeyRange, limit: number) => Promise<IFileRecord[]>;

/**
 * The smallest string greater than every string that starts with `prefix`, or
 * undefined when there is none (an empty prefix, or one of nothing but U+FFFF).
 */
export function keyPrefixUpperBound(prefix: string): string | undefined {
    for (let end = prefix.length; end > 0; end -= 1) {
        const code = prefix.charCodeAt(end - 1);
        if (code < 0xffff) return prefix.slice(0, end - 1) + String.fromCharCode(code + 1);
    }
    return undefined;
}

/** A folder path as the listing takes it: no leading slash, one trailing slash, `''` = the root. */
export function normalizeFolderPrefix(raw: string | undefined | null): string {
    const trimmed = (raw ?? '').trim().replace(/^\/+/, '');
    if (!trimmed) return '';
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

type Entry = { kind: 'folder'; path: string } | { kind: 'file'; record: IFileRecord };

const MAX_BATCH = 500;

export async function walkFileEntries(
    probe: FileKeyProbe,
    options: { prefix: string; limit: number; cursor?: string },
): Promise<IFileEntriesPage> {
    const { prefix, limit } = options;
    const upper = keyPrefixUpperBound(prefix);
    const before = upper !== undefined ? { lt: upper } : {};

    // Where to read from: the start of the folder, or just past the entry the caller stopped at.
    let from: { gte?: string; gt?: string } = { gte: prefix };
    const { cursor } = options;
    if (cursor && cursor.startsWith(prefix) && cursor.length > prefix.length) {
        if (cursor.endsWith('/')) {
            // A folder: everything under it is behind us.
            const past = keyPrefixUpperBound(cursor);
            if (past === undefined) return { folders: [], items: [] };
            from = { gte: past };
        } else {
            from = { gt: cursor };
        }
    }

    // One more than a page, to know whether there is a next one.
    const want = limit + 1;
    const entries: Entry[] = [];
    let exhausted = false;
    while (!exhausted && entries.length < want) {
        const ask = Math.min(MAX_BATCH, want - entries.length);
        const batch = await probe({ ...from, ...before }, ask);
        let jumped = false;
        for (const record of batch) {
            const rest = record.key.slice(prefix.length);
            const slash = rest.indexOf('/');
            if (slash === -1) {
                entries.push({ kind: 'file', record });
                from = { gt: record.key };
                if (entries.length >= want) break;
                continue;
            }
            // The first key of a sub-folder: note the folder, skip the rest of it.
            const folder = prefix + rest.slice(0, slash + 1);
            entries.push({ kind: 'folder', path: folder });
            const past = keyPrefixUpperBound(folder);
            if (past === undefined) exhausted = true;
            else from = { gte: past };
            jumped = true;
            break;
        }
        if (!jumped && batch.length < ask) exhausted = true;
    }

    const more = entries.length > limit;
    const page = entries.slice(0, limit);
    const last = page[page.length - 1];
    return {
        folders: page.flatMap((entry) => (entry.kind === 'folder' ? [entry.path] : [])),
        items: page.flatMap((entry) => (entry.kind === 'file' ? [entry.record] : [])),
        ...(more && last ? { nextCursor: last.kind === 'folder' ? last.path : last.record.key } : {}),
    };
}
