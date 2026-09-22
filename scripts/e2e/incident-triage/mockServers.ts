/**
 * The external systems, as local HTTP servers with realistic contracts.
 *
 *  - Confluence Cloud REST v1 (`/wiki/rest/api/content`), paginated with
 *    `_links.next` and requiring an Authorization header, so the importer has
 *    to do what a real one does.
 *  - App logs: an Elasticsearch-flavoured search (`GET /logs/_search`).
 *  - Infra logs: a Loki-flavoured LogQL range query
 *    (`POST /loki/api/v1/query_range`), a different shape on purpose.
 *  - Incident comments: `POST /incidents/{id}/comments`, the "post the
 *    finding" target for the tool-posting variant.
 *
 * Every request is recorded with a timestamp, which is how the scorer checks
 * what the agent actually called and in what order — independent of what the
 * agent CLAIMS it did in its answer.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
    APP_LOGS,
    CONFLUENCE_PAGES,
    INFRA_LOGS,
    type AppLogEntry,
    type InfraLogLine,
} from './fixtures';

export interface RecordedRequest {
    at: number;
    server: 'confluence' | 'app-logs' | 'infra-logs' | 'incidents';
    method: string;
    path: string;
    query: Record<string, string>;
    body?: unknown;
    status: number;
}

export interface PostedComment {
    at: number;
    incidentId: string;
    body: Record<string, unknown>;
}

export interface MockWorld {
    baseUrls: { confluence: string; appLogs: string; infraLogs: string; incidents: string };
    requests: RecordedRequest[];
    comments: PostedComment[];
    /**
     * Fail the next N comment POSTs with a 503, to see what each delivery
     * mechanism does when the incident tracker blips mid-delivery.
     */
    failNextPosts: number;
    /** Forget what the last scenario did; the fixtures themselves are static. */
    reset(): void;
    close(): Promise<void>;
}

export const CONFLUENCE_TOKEN = 'e2e-confluence-token';

async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return undefined;
    const text = Buffer.concat(chunks).toString('utf-8');
    try { return JSON.parse(text); } catch { return text; }
}

function send(res: ServerResponse, status: number, payload: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
    return new Promise((resolve) => {
        const server = createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            resolve({ server, url: `http://127.0.0.1:${port}` });
        });
    });
}

const inWindow = (ts: string, from?: string, to?: string) =>
    (!from || ts >= from) && (!to || ts <= to);

/** A deliberately small LogQL: `{k="v", k2=~"a|b"} |= "text"`. */
export function parseLogQl(query: string): { matchers: Array<{ key: string; value: string; regex: boolean }>; contains: string[] } | null {
    const selector = /^\s*\{([^}]*)\}/.exec(query);
    if (!selector) return null;
    const matchers: Array<{ key: string; value: string; regex: boolean }> = [];
    for (const part of selector[1].split(',').map((p) => p.trim()).filter(Boolean)) {
        const m = /^([a-zA-Z_]+)\s*(=~|=)\s*"([^"]*)"$/.exec(part);
        if (!m) return null;
        matchers.push({ key: m[1], value: m[3], regex: m[2] === '=~' });
    }
    const contains = [...query.slice(selector[0].length).matchAll(/\|=\s*"([^"]*)"/g)].map((m) => m[1]);
    return { matchers, contains };
}

function matchesInfra(line: InfraLogLine, q: NonNullable<ReturnType<typeof parseLogQl>>): boolean {
    const labels = line.labels as Record<string, string | undefined>;
    for (const m of q.matchers) {
        const actual = labels[m.key];
        if (actual === undefined) return false;
        if (m.regex ? !new RegExp(`^(?:${m.value})$`).test(actual) : actual !== m.value) return false;
    }
    return q.contains.every((text) => line.line.toLowerCase().includes(text.toLowerCase()));
}

/**
 * Storage-format XHTML → the plain text a knowledge base should index.
 *
 * Tags are stripped until none remain (a single pass leaves `<scr<b>ipt>`
 * as `<script>`), and `&amp;` is decoded LAST — decoding it first would turn
 * the literal text `&amp;lt;` into `<`, unescaping twice.
 */
export function confluenceStorageToText(storage: string): string {
    let text = storage
        .replace(/<\/(h[1-6]|p|li|ol|ul)>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ');
    let previous: string;
    do {
        previous = text;
        text = text.replace(/<[^<>]*>/g, '');
    } while (text !== previous);
    return text
        .replace(/[<>]/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export async function startMockWorld(): Promise<MockWorld> {
    const requests: RecordedRequest[] = [];
    const comments: PostedComment[] = [];
    const state = { failNextPosts: 0 };

    const record = (server: RecordedRequest['server'], req: IncomingMessage, url: URL, status: number, body?: unknown) => {
        requests.push({
            at: Date.now(),
            server,
            method: req.method ?? 'GET',
            path: url.pathname,
            query: Object.fromEntries(url.searchParams.entries()),
            ...(body !== undefined ? { body } : {}),
            status,
        });
    };

    const confluence = await listen(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (req.headers.authorization !== `Bearer ${CONFLUENCE_TOKEN}`) {
            record('confluence', req, url, 401);
            return send(res, 401, { message: 'Unauthorized' });
        }
        if (url.pathname !== '/wiki/rest/api/content') {
            record('confluence', req, url, 404);
            return send(res, 404, { message: 'Not found' });
        }
        const space = url.searchParams.get('spaceKey');
        const start = Number(url.searchParams.get('start') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 25);
        const pages = CONFLUENCE_PAGES.filter((p) => !space || p.space === space);
        const slice = pages.slice(start, start + limit);
        record('confluence', req, url, 200);
        return send(res, 200, {
            results: slice.map((p) => ({
                id: p.id,
                type: 'page',
                title: p.title,
                version: { number: p.version },
                body: { storage: { value: p.storage, representation: 'storage' } },
                _links: { webui: `/spaces/${p.space}/pages/${p.id}` },
            })),
            start,
            limit,
            size: slice.length,
            _links: start + limit < pages.length
                ? { next: `/wiki/rest/api/content?spaceKey=${space ?? ''}&type=page&expand=body.storage,version&start=${start + limit}&limit=${limit}` }
                : {},
        });
    });

    const appLogs = await listen(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname !== '/logs/_search') {
            record('app-logs', req, url, 404);
            return send(res, 404, { error: 'Not found' });
        }
        const service = url.searchParams.get('service') ?? undefined;
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const level = url.searchParams.get('level')?.toUpperCase();
        const from = url.searchParams.get('from') ?? undefined;
        const to = url.searchParams.get('to') ?? undefined;
        const size = Math.min(Number(url.searchParams.get('size') ?? 50) || 50, 200);
        const hits = APP_LOGS.filter((e: AppLogEntry) =>
            (!service || e.service === service)
            && (!level || e.level === level)
            && (!q || e.message.toLowerCase().includes(q) || e.service.includes(q))
            && inWindow(e['@timestamp'], from, to)).slice(0, size);
        record('app-logs', req, url, 200);
        return send(res, 200, { took: 3, hits: { total: { value: hits.length }, hits: hits.map((h) => ({ _source: h })) } });
    });

    const infraLogs = await listen(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        const body = (await readBody(req)) as Record<string, unknown> | undefined;
        if (url.pathname !== '/loki/api/v1/query_range' || req.method !== 'POST') {
            record('infra-logs', req, url, 404, body);
            return send(res, 404, { status: 'error', error: 'Not found' });
        }
        const parsed = typeof body?.query === 'string' ? parseLogQl(body.query) : null;
        if (!parsed) {
            record('infra-logs', req, url, 400, body);
            // A useful 400: a model that wrote bad LogQL should be able to fix it.
            return send(res, 400, {
                status: 'error',
                error: 'query must be LogQL like {namespace="prod", app="postgres"} |= "error"',
            });
        }
        const limit = Math.min(Number(body?.limit ?? 100) || 100, 500);
        const lines = INFRA_LOGS.filter((l) => matchesInfra(l, parsed)
            && inWindow(l.ts, body?.start as string | undefined, body?.end as string | undefined)).slice(0, limit);
        const streams = new Map<string, { stream: Record<string, string>; values: Array<[string, string]> }>();
        for (const l of lines) {
            const key = JSON.stringify(l.labels);
            const entry = streams.get(key) ?? { stream: l.labels as Record<string, string>, values: [] };
            entry.values.push([l.ts, l.line]);
            streams.set(key, entry);
        }
        record('infra-logs', req, url, 200, body);
        return send(res, 200, { status: 'success', data: { resultType: 'streams', result: [...streams.values()] } });
    });

    const incidents = await listen(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        const body = await readBody(req);
        const m = /^\/incidents\/([^/]+)\/comments$/.exec(url.pathname);
        if (!m || req.method !== 'POST') {
            record('incidents', req, url, 404, body);
            return send(res, 404, { error: 'Not found' });
        }
        if (state.failNextPosts > 0) {
            state.failNextPosts -= 1;
            record('incidents', req, url, 503, body);
            return send(res, 503, { error: 'incident service temporarily unavailable, retry later' });
        }
        const payload = (body && typeof body === 'object' ? body : { body }) as Record<string, unknown>;
        if (typeof payload.body !== 'string' || !payload.body.trim()) {
            record('incidents', req, url, 400, body);
            return send(res, 400, { error: 'body (markdown text) is required' });
        }
        comments.push({ at: Date.now(), incidentId: decodeURIComponent(m[1]), body: payload });
        record('incidents', req, url, 201, body);
        return send(res, 201, { id: `c-${comments.length}`, incidentId: decodeURIComponent(m[1]) });
    });

    const servers = [confluence.server, appLogs.server, infraLogs.server, incidents.server];
    return {
        baseUrls: { confluence: confluence.url, appLogs: appLogs.url, infraLogs: infraLogs.url, incidents: incidents.url },
        requests,
        comments,
        get failNextPosts() { return state.failNextPosts; },
        set failNextPosts(n: number) { state.failNextPosts = n; },
        reset() { requests.length = 0; comments.length = 0; state.failNextPosts = 0; },
        close: () => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))).then(() => undefined),
    };
}
