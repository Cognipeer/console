/**
 * Confluence → knowledge base.
 *
 * The console has no Confluence connector, so this is what one looks like
 * built on the public APIs of both sides: page through Confluence's REST v1
 * content endpoint (body.storage + version), turn the storage XHTML into text,
 * and ingest each page into a knowledge engine module as its own document.
 *
 * Idempotent by construction: each page becomes `confluence-<pageId>.md`, and
 * the knowledge engine skips a re-ingest whose content hash is unchanged — so
 * re-running an import re-embeds only the pages that actually changed.
 */

import { confluenceStorageToText } from './mockServers';

interface ConfluencePageResult {
    id: string;
    title: string;
    version?: { number?: number };
    body?: { storage?: { value?: string } };
    _links?: { webui?: string };
}

interface ConfluencePageList {
    results: ConfluencePageResult[];
    _links?: { next?: string };
}

export interface ConfluenceImportOptions {
    confluenceBaseUrl: string;
    token: string;
    spaceKey: string;
    ragModuleKey: string;
    /** POSTs a document to the console; returns the HTTP status. */
    ingest: (path: string, body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
    pageSize?: number;
}

export interface ConfluenceImportResult {
    pages: number;
    ingested: number;
    failed: Array<{ pageId: string; status: number }>;
}

export async function importConfluenceSpace(options: ConfluenceImportOptions): Promise<ConfluenceImportResult> {
    const result: ConfluenceImportResult = { pages: 0, ingested: 0, failed: [] };
    const limit = options.pageSize ?? 2;
    let next: string | undefined =
        `/wiki/rest/api/content?spaceKey=${encodeURIComponent(options.spaceKey)}&type=page&expand=body.storage,version&start=0&limit=${limit}`;

    while (next) {
        const res = await fetch(`${options.confluenceBaseUrl}${next}`, {
            headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`Confluence returned ${res.status} for ${next}`);
        const page = (await res.json()) as ConfluencePageList;

        for (const item of page.results) {
            result.pages += 1;
            const text = confluenceStorageToText(item.body?.storage?.value ?? '');
            // The title goes into the text too: a query like "slow logins"
            // should match a page whose body never repeats its own title.
            const content = `# ${item.title}\n\n${text}`;
            const { status } = await options.ingest(
                `/api/rag/modules/${encodeURIComponent(options.ragModuleKey)}/documents`,
                {
                    fileName: `confluence-${item.id}.md`,
                    content,
                    contentType: 'text/markdown',
                    metadata: {
                        source: 'confluence',
                        pageId: item.id,
                        title: item.title,
                        version: item.version?.number,
                        url: item._links?.webui,
                        space: options.spaceKey,
                    },
                },
            );
            if (status >= 200 && status < 300) result.ingested += 1;
            else result.failed.push({ pageId: item.id, status });
        }
        next = page._links?.next;
    }
    return result;
}
