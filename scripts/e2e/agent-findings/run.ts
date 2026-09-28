/**
 * Agent runtime findings — end to end, against a real model.
 *
 * One check per finding from the 2026-09 test round, each driven through the
 * real console API (same Fastify plugin as production) on a throwaway SQLite
 * tenant, with the log backends as local mocks:
 *
 *   #1 summary_only keeps the first-message instruction across summarization
 *   #2 no ask-user tool, even with a stored `askUser: true`
 *   #3 tool results from turn N are available in turn N+1
 *   #4 a limit-stopped run says why, with its partial text
 *   #5 maxCostUsd actually stops a run
 *   #6 an invalid config is refused at save time
 *   #7 a wrong provider API key is reported as such
 *   #9 summarization is recorded on the turn (and so shown in the session)
 *
 *   npx tsx scripts/e2e/agent-findings/run.ts [--model gpt-5.6-luna] [--only 1,3]
 *
 * Credentials: as the incident-triage harness (E2E_LLM_BASE_URL/API_KEY, or
 * the local dev tenant's provider, decrypted in a subprocess; never printed).
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
};
const LLM_MODEL = arg('model', process.env.E2E_LLM_MODEL ?? 'gpt-5.6-luna')!;
const ONLY = arg('only')?.split(',').map((s) => s.trim());

function resolveLlm(): { baseUrl: string; apiKey: string } {
    if (process.env.E2E_LLM_BASE_URL && process.env.E2E_LLM_API_KEY) {
        return { baseUrl: process.env.E2E_LLM_BASE_URL, apiKey: process.env.E2E_LLM_API_KEY };
    }
    const out = execFileSync(
        'npx',
        [
            'tsx', join('scripts', 'e2e', 'incident-triage', 'extractLocalLlm.ts'),
            resolve(process.env.E2E_LOCAL_ENV_DIR ?? '../console-ee/.overlay-build'),
            resolve(process.env.E2E_LOCAL_TENANT_DB ?? '../console-main/data/tenant_local-dev.db'),
            process.env.E2E_LOCAL_PROVIDER ?? 'openai-compatible',
        ],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const parsed = JSON.parse(out) as { baseUrl?: string; apiKey?: string };
    if (!parsed.baseUrl || !parsed.apiKey) throw new Error('local provider has no baseUrl/apiKey');
    return { baseUrl: parsed.baseUrl, apiKey: parsed.apiKey };
}
const LLM = resolveLlm();

const STAMP = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const dataDir = mkdtempSync(join(tmpdir(), 'cognipeer-e2e-findings-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = dataDir;
process.env.MAIN_DB_NAME = 'e2e_main';
process.env.CACHE_PROVIDER = 'memory';
process.env.RATE_LIMIT_PROVIDER = 'memory';
process.env.JWT_SECRET = 'e2e-findings-jwt-secret-please-ignore-0123456789';
process.env.JWT_EXPIRES_IN = '7d';
process.env.PROVIDER_ENCRYPTION_SECRET = 'e2e-findings-provider-secret-please-ignore-0123456789';
(process.env as Record<string, string>).NODE_ENV = process.env.NODE_ENV ?? 'development';
process.env.OUTBOUND_HTTP_ALLOWED_HOSTS = '127.0.0.1,localhost';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

type Json = Record<string, any>;
interface Check { id: string; name: string; ok: boolean; detail: string }

/** Archive pages; each is ~3.5k tokens, so a full read crosses the summarization trigger twice. */
const PAGES = 5;

/** A log archive whose pages are big enough to push a run over a small context budget. */
async function startArchive() {
    const requests: string[] = [];
    const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        requests.push(url.pathname + url.search);
        if (url.pathname === '/archive') {
            // Cursor-paged, so the pages can only be read one after another —
            // separate model turns, which is what lets the earlier pages be
            // summarized away while the run goes on.
            const cursor = url.searchParams.get('cursor') ?? 'start';
            const page = cursor === 'start' ? 1 : Number(/^p(\d+)$/.exec(cursor)?.[1] ?? 0);
            if (!page || page > PAGES) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'unknown cursor; start with cursor=start' }));
                return;
            }
            const lines = Array.from({ length: 120 }, (_, i) =>
                `2026-09-22T09:${String(i % 60).padStart(2, '0')}:00Z checkout-api WARN page=${page} line=${i} slow query on orders (${400 + i}ms)`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                page,
                lines,
                ...(page === PAGES ? { note: 'root cause marker: ORDERS_INDEX_DROPPED' } : {}),
                next_cursor: page < PAGES ? `p${page + 1}` : null,
            }));
            return;
        }
        if (url.pathname === '/errors') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                count: 3,
                errors: [
                    { at: '09:14:05', message: 'HikariPool-1 - Connection is not available, request timed out after 30000ms' },
                    { at: '09:14:09', message: 'POST /checkout 502 30011ms' },
                    { at: '09:15:02', message: 'HikariPool-1 - Connection is not available, request timed out after 30000ms' },
                ],
            }));
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function archiveSpec(baseUrl: string) {
    return {
        openapi: '3.0.3',
        info: { title: 'Log archive', version: '1.0.0' },
        servers: [{ url: baseUrl }],
        paths: {
            '/archive': {
                get: {
                    operationId: 'read_log_archive',
                    summary: 'Read the next page of the raw checkout-api log archive. Start with cursor=start; each page returns next_cursor for the following page (null on the last).',
                    parameters: [{ name: 'cursor', in: 'query', required: true, schema: { type: 'string' } }],
                    responses: { 200: { description: 'A page of log lines' } },
                },
            },
            '/errors': {
                get: {
                    operationId: 'list_checkout_errors',
                    summary: 'List the ERROR-level checkout-api log lines of the incident window.',
                    responses: { 200: { description: 'Error lines' } },
                },
            },
        },
    };
}

const TURKISH = /[çğışöüÇĞİŞÖÜ]|\b(ve|bir|için|olarak|sayfa|hata|kök|neden)\b/i;

async function main(): Promise<number> {
    const { SmokeClient } = await import('../../smoke/client');
    const { startSmokeServer } = await import('../../smoke/server');
    const log = (msg: string) => console.log(msg);
    log(`▶ Agent findings e2e — ${LLM_MODEL} via ${new URL(LLM.baseUrl).host}`);

    const archive = await startArchive();
    const server = await startSmokeServer();
    const c = new SmokeClient(server.baseUrl);
    const checks: Check[] = [];
    const record = (id: string, name: string, ok: boolean, detail: string) => {
        checks.push({ id, name, ok, detail });
        log(`  ${ok ? '✓' : '✗'} #${id} ${name} — ${detail}`);
    };
    const want = (id: string) => !ONLY || ONLY.includes(id);

    const must = async (name: string, method: string, path: string, expect: number[], body?: unknown): Promise<Json> => {
        const res = await c.request<Json>(method, path, body !== undefined ? { body } : {});
        if (!expect.includes(res.status)) throw new Error(`setup "${name}" → HTTP ${res.status}: ${res.raw?.slice(0, 300)}`);
        return res.body;
    };

    try {
        await must('register', 'POST', '/api/auth/register', [201], {
            companyName: `E2E Findings ${STAMP}`,
            email: `owner-${STAMP}@e2e.test`,
            name: 'E2E Owner',
            password: 'E2eFindings!2024#Secure',
        });
        await must('provider', 'POST', '/api/models/providers', [201], {
            key: 'e2e-llm-provider', driver: 'openai-compatible', label: 'E2E LLM',
            credentials: { apiKey: LLM.apiKey }, settings: { baseUrl: LLM.baseUrl },
        });
        await must('model', 'POST', '/api/models', [201], {
            name: LLM_MODEL, key: 'e2e-llm', providerKey: 'e2e-llm-provider', category: 'llm', modelId: LLM_MODEL,
            pricing: { currency: 'USD', inputTokenPer1M: 1.25, outputTokenPer1M: 10, cachedTokenPer1M: 0 },
            settings: {}, supportsToolCalls: true,
        });
        await must('unpriced model', 'POST', '/api/models', [201], {
            name: `${LLM_MODEL} (unpriced)`, key: 'e2e-llm-unpriced', providerKey: 'e2e-llm-provider', category: 'llm',
            modelId: LLM_MODEL, pricing: { currency: 'USD', inputTokenPer1M: 0, outputTokenPer1M: 0, cachedTokenPer1M: 0 },
            settings: {}, supportsToolCalls: true,
        });
        const tool = await must('archive tool', 'POST', '/api/tools', [201], {
            name: 'Log archive', type: 'openapi', openApiSpec: JSON.stringify(archiveSpec(archive.url)),
        });
        const toolKey = String(tool.tool.key);
        const bindings = [{ source: 'tool', sourceKey: toolKey, toolNames: ['read_log_archive', 'list_checkout_errors'] }];

        const createAgent = async (name: string, config: Json) => {
            const created = await must(`agent ${name}`, 'POST', '/api/agents', [201], {
                name: `${name} ${STAMP}`,
                config: { modelKey: 'e2e-llm', toolBindings: bindings, ...config },
            });
            return { id: String(created.agent._id ?? created.agent.id), warnings: created.warnings as Json[] | undefined };
        };
        const newSession = async (agentId: string) => {
            const res = await must('session', 'POST', `/api/agents/${agentId}/sessions`, [201], { title: 'findings' });
            return String(res.session._id);
        };
        const chat = async (agentId: string, sessionId: string, message: string) =>
            c.request<Json>('POST', `/api/agents/${agentId}/chat`, { body: { message, conversationId: sessionId } });
        const sessionMessages = async (agentId: string, sessionId: string) =>
            ((await must('session read', 'GET', `/api/agents/${agentId}/sessions/${sessionId}`, [200])).session.messages ?? []) as Json[];

        // ── #3 tool results carried to the next turn ─────────────────────
        if (want('3')) {
            const agent = await createAgent('carry', { systemPrompt: 'You investigate checkout incidents with the log tools.' });
            const session = await newSession(agent.id);
            archive.requests.length = 0;
            const first = await chat(agent.id, session, 'List the checkout ERROR lines of the incident window and tell me how many there are.');
            const callsAfterFirst = archive.requests.filter((r) => r.startsWith('/errors')).length;
            const second = await chat(agent.id, session,
                'Quote the exact text of the FIRST error line you saw, word for word. Answer from what you already fetched.');
            const refetched = archive.requests.filter((r) => r.startsWith('/errors')).length - callsAfterFirst;
            const answer = String(second.body?.content ?? '');
            record('3', 'tool results reach the next turn',
                first.status === 200 && second.status === 200 && answer.includes('Connection is not available') && refetched === 0,
                `turn 2 re-queried ${refetched}×, quoted the log line: ${answer.includes('Connection is not available')}`);
        }

        // ── #1 + #9 summary_only keeps the instruction across summarization ──
        if (want('1') || want('9')) {
            const agent = await createAgent('summary-only', {
                systemPrompt: 'You investigate checkout incidents with the log tools. When asked to read the archive, call read_log_archive with cursor "start" and keep calling it with the returned next_cursor until next_cursor is null. Never answer about the archive without reading it.',
                runtime: {
                    context: { policy: (process.env.E2E_POLICY ?? 'summary_only') as 'summary_only', lastTurnsToKeep: 1 },
                    summarization: { enable: true, summaryTriggerTokens: 8000, maxTokens: 8000 },
                },
            });
            const session = await newSession(agent.id);
            await chat(agent.id, session, 'Standing instruction for this whole conversation: always answer in Turkish. Reply OK.');
            const pull = await chat(agent.id, session,
                'Read the whole log archive, page by page following next_cursor, then tell me the root cause marker on the last page.');
            const status = await chat(agent.id, session, 'Give me a two-sentence status update.');
            const messages = await sessionMessages(agent.id, session);
            const compactions = messages.flatMap((m) => (m.compactions ?? []) as Json[]);
            const statusText = String(status.body?.content ?? '');
            if (process.env.E2E_VERBOSE) {
                log(`    pull answer: ${String(pull.body?.content ?? '').slice(0, 300)}`);
                log(`    pull steps: ${JSON.stringify(((pull.body?.steps ?? []) as Json[]).map((st) => st.args))}`);
                messages.forEach((m, i) => (m.compactions ?? []).forEach((cp: Json) => log(
                    `    turn ${i} compaction: ${cp.tokensBefore}→${cp.tokensAfter} facts=${JSON.stringify(cp.summary?.facts ?? []).slice(0, 400)}`)));
            }
            if (want('9')) {
                const first = compactions[0];
                record('9', 'summarization is recorded on the turn',
                    compactions.length > 0 && typeof first?.tokensBefore === 'number' && first.tokensBefore > (first.tokensAfter ?? Infinity),
                    compactions.length > 0
                        ? `${compactions.length} summarization(s); ${first.tokensBefore} → ${first.tokensAfter} tokens; directives=${JSON.stringify(first.summary?.userDirectives ?? [])}; pull turn HTTP ${pull.status}`
                        : `no summarization recorded (pull turn HTTP ${pull.status}: ${String(pull.body?.error ?? '').slice(0, 120)})`);
            }
            const pullSteps = ((pull.body?.steps ?? []) as Json[]).map((st) => String((st.args as Json | undefined)?.cursor ?? ''));
            const restarted = pullSteps.filter((cursor) => cursor === 'start').length > 1;
            log(`    (info) pull turn read ${pullSteps.length} page(s)${restarted ? ', RESTARTED from the first page' : ''}; `
                + `found the marker: ${String(pull.body?.content ?? '').includes('ORDERS_INDEX_DROPPED')}`);
            if (want('1')) {
                record('1', 'summary_only keeps the first-message instruction',
                    status.status === 200 && compactions.length > 0 && TURKISH.test(statusText),
                    `after ${compactions.length} summarization(s) the status answer is ${TURKISH.test(statusText) ? 'Turkish' : 'NOT Turkish'}: "${statusText.slice(0, 120)}"`);
            }
        }

        // ── #2 ask-user is never offered ─────────────────────────────────
        if (want('2')) {
            const agent = await createAgent('ask-user', {
                systemPrompt: 'If anything is ambiguous, ask the user before acting.',
                runtime: { askUser: true },
            });
            const session = await newSession(agent.id);
            const res = await chat(agent.id, session, 'Check the logs for the environment I mean.');
            const steps = (res.body?.steps ?? []) as Json[];
            const asked = steps.some((s) => String(s.name).includes('ask_user'));
            record('2', 'no ask-user tool, no locked conversation',
                res.status === 200 && !asked && res.body?.stopReason !== 'paused'
                    && Boolean(agent.warnings?.some((w) => w.field === 'runtime.askUser')),
                `HTTP ${res.status}, ask_user called: ${asked}, stopReason: ${res.body?.stopReason ?? 'none'}, save warning: ${Boolean(agent.warnings?.length)}`);
        }

        // ── #4 wall-clock limit → partial text + reason ──────────────────
        if (want('4')) {
            const agent = await createAgent('wall-clock', {
                systemPrompt: 'Before calling any tool, say in one sentence what you are about to check. Read the whole log archive page by page.',
                runtime: { limits: { maxWallClockMs: 1000 } },
            });
            const session = await newSession(agent.id);
            const res = await chat(agent.id, session, 'Read the whole log archive page by page and summarize it.');
            const messages = await sessionMessages(agent.id, session);
            const stored = messages[messages.length - 1] ?? {};
            record('4', 'a limit stop says why and keeps partial text',
                res.status === 200 && res.body?.stopReason === 'limit' && /^maxWallClockMs/.test(String(res.body?.stopDetail))
                    && stored.stopReason === 'limit',
                `stopReason=${res.body?.stopReason}, detail="${res.body?.stopDetail}", partial="${String(res.body?.content ?? '').slice(0, 80)}"`);
        }

        // ── #5 maxCostUsd stops the run ──────────────────────────────────
        if (want('5')) {
            const agent = await createAgent('cost-cap', {
                systemPrompt: 'Read the whole log archive page by page, then summarize.',
                runtime: { limits: { maxCostUsd: 0.00001 } },
            });
            const session = await newSession(agent.id);
            const res = await chat(agent.id, session, 'Read the whole log archive page by page and summarize it.');
            record('5', 'maxCostUsd stops a run',
                res.status === 200 && res.body?.stopReason === 'limit' && /^maxCostUsd/.test(String(res.body?.stopDetail)),
                `stopReason=${res.body?.stopReason}, detail="${res.body?.stopDetail}", cost=${res.body?.usage?.costUsd}`);
        }

        // ── #6 invalid config refused ────────────────────────────────────
        if (want('6')) {
            const missingTool = await c.request<Json>('POST', '/api/agents', {
                body: { name: `bad ${STAMP}`, config: { modelKey: 'e2e-llm', toolBindings: [{ source: 'tool', sourceKey: 'nope', toolNames: ['x'] }] } },
            });
            const unpricedCap = await c.request<Json>('POST', '/api/agents', {
                body: { name: `bad2 ${STAMP}`, config: { modelKey: 'e2e-llm-unpriced', runtime: { limits: { maxCostUsd: 1 } } } },
            });
            const agent = await createAgent('patch-target', { systemPrompt: 'x' });
            const badPatch = await c.request<Json>('PATCH', `/api/agents/${agent.id}`, {
                body: { config: { modelKey: 'deleted-model' } },
            });
            record('6', 'invalid config is refused',
                missingTool.status === 400 && unpricedCap.status === 400 && badPatch.status === 400,
                `missing tool → ${missingTool.status} (${missingTool.body?.validation?.errors?.[0]?.field}), `
                + `cost cap on unpriced model → ${unpricedCap.status}, bad PATCH → ${badPatch.status}`);
        }

        // ── #7 wrong provider key ────────────────────────────────────────
        if (want('7')) {
            await must('bad provider', 'POST', '/api/models/providers', [201], {
                key: 'e2e-bad-key', driver: 'openai-compatible', label: 'Bad key',
                credentials: { apiKey: 'sk-this-key-is-wrong-0000000000000000' }, settings: { baseUrl: LLM.baseUrl },
            });
            await must('bad model', 'POST', '/api/models', [201], {
                name: 'bad', key: 'e2e-bad-model', providerKey: 'e2e-bad-key', category: 'llm', modelId: LLM_MODEL,
                pricing: { currency: 'USD', inputTokenPer1M: 1, outputTokenPer1M: 1, cachedTokenPer1M: 0 }, settings: {},
            });
            const check = await c.request<Json>('POST', '/api/agents/model-check', { body: { modelKey: 'e2e-bad-model' } });
            const agent = await createAgent('bad-key', { modelKey: 'e2e-bad-model', systemPrompt: 'hi', toolBindings: undefined });
            const session = await newSession(agent.id);
            const res = await chat(agent.id, session, 'hello');
            record('7', 'a wrong provider key is reported as such',
                check.body?.ok === false && check.body?.error?.type === 'provider_authentication_error'
                    && res.status === 502 && res.body?.type === 'provider_authentication_error',
                `model-check → ${check.body?.error?.type}; chat → HTTP ${res.status} ${res.body?.type}: "${String(res.body?.error ?? '').slice(0, 90)}"`);
        }
    } catch (error) {
        log(`  ✗ setup failed: ${error instanceof Error ? error.message : String(error)}`);
        checks.push({ id: 'setup', name: 'setup', ok: false, detail: String(error) });
    } finally {
        await server.close();
        await archive.close();
        rmSync(dataDir, { recursive: true, force: true });
    }

    const reportDir = join(process.cwd(), 'scripts', 'e2e', 'agent-findings', 'reports');
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, 'latest.json'), JSON.stringify({ model: LLM_MODEL, at: new Date().toISOString(), checks }, null, 2));
    const failed = checks.filter((check) => !check.ok);
    log(`\n${checks.length - failed.length}/${checks.length} checks passed (${LLM_MODEL})`);
    return failed.length > 0 ? 1 : 0;
}

main().then((code) => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
});
