/**
 * Incident-triage end-to-end run.
 *
 *   Confluence runbooks ──import──▶ knowledge engine
 *   problem ──▶ agent: knowledge_search ─▶ app logs ─▶ infra logs ─▶ finding
 *   finding ──▶ incident comment   (A: agent posts via tool,
 *                                    B: structured output, we format + post,
 *                                    C: text answer, we post verbatim)
 *
 * Boots the REAL console API (same plugin as production) on a throwaway
 * SQLite tenant — nothing touches developer data — with a REAL model, and the
 * external systems (Confluence, two log backends, the incident tracker) as
 * local mock servers with realistic contracts.
 *
 * LLM credentials: E2E_LLM_BASE_URL + E2E_LLM_API_KEY, or — on a dev machine —
 * decrypted from the local dev tenant's provider by a subprocess (see
 * extractLocalLlm.ts). The key is never printed.
 *
 *   npx tsx scripts/e2e/incident-triage/run.ts [--reps 2] [--variants A,B,C]
 *        [--scenarios checkout-502,slow-login] [--model gpt-5.6-luna]
 *
 * Writes scripts/e2e/incident-triage/reports/latest.{json,md}. Exits non-zero
 * when setup fails or when any variant's pass rate is below --min-pass (0.0
 * by default: this is a measurement, not a gate, unless you make it one).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ── CLI ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
};
const REPS = Number(arg('reps', '2'));
const VARIANT_FILTER = arg('variants', 'A,B,C')!.split(',').map((v) => v.trim().toUpperCase());
const SCENARIO_FILTER = arg('scenarios')?.split(',').map((s) => s.trim());
const LLM_MODEL = arg('model', process.env.E2E_LLM_MODEL ?? 'gpt-5.6-luna')!;
const EMBED_MODEL = arg('embed-model', process.env.E2E_EMBED_MODEL ?? 'text-embedding-3-small')!;
const EMBED_DIM = Number(arg('embed-dim', '1536'));
const MIN_PASS = Number(arg('min-pass', '0'));
/** Fail the first N comment POSTs of every run with a 503 (delivery-resilience test). */
const FLAKY_POSTS = Number(arg('flaky-posts', '0'));

// ── 0. LLM credentials — BEFORE the environment is isolated ─────────────
function resolveLlm(): { baseUrl: string; apiKey: string } {
    if (process.env.E2E_LLM_BASE_URL && process.env.E2E_LLM_API_KEY) {
        return { baseUrl: process.env.E2E_LLM_BASE_URL, apiKey: process.env.E2E_LLM_API_KEY };
    }
    const envDir = resolve(process.env.E2E_LOCAL_ENV_DIR ?? '../console-ee/.overlay-build');
    const dbFile = resolve(process.env.E2E_LOCAL_TENANT_DB ?? '../console-main/data/tenant_local-dev.db');
    const providerKey = process.env.E2E_LOCAL_PROVIDER ?? 'openai-compatible';
    const out = execFileSync(
        'npx',
        ['tsx', join('scripts', 'e2e', 'incident-triage', 'extractLocalLlm.ts'), envDir, dbFile, providerKey],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const parsed = JSON.parse(out) as { baseUrl?: string; apiKey?: string };
    if (!parsed.baseUrl || !parsed.apiKey) throw new Error('local provider has no baseUrl/apiKey');
    return { baseUrl: parsed.baseUrl, apiKey: parsed.apiKey };
}
const LLM = resolveLlm();

// ── 1. Environment isolation (before any '@/' import) ───────────────────
const STAMP = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const dataDir = mkdtempSync(join(tmpdir(), 'cognipeer-e2e-triage-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = dataDir;
process.env.MAIN_DB_NAME = 'e2e_main';
process.env.CACHE_PROVIDER = 'memory';
process.env.RATE_LIMIT_PROVIDER = 'memory';
process.env.JWT_SECRET = 'e2e-triage-jwt-secret-please-ignore-0123456789';
process.env.JWT_EXPIRES_IN = '7d';
(process.env as Record<string, string>).NODE_ENV = process.env.NODE_ENV ?? 'development';
// The tools call mock servers on loopback; the outbound guard blocks private
// addresses by default, which is right in production and wrong here.
process.env.OUTBOUND_HTTP_ALLOWED_HOSTS = '127.0.0.1,localhost';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';

const REPORT_DIR = join(process.cwd(), 'scripts', 'e2e', 'incident-triage', 'reports');

type Json = Record<string, unknown>;

/**
 * How an INTEGRATION posts (variants B and C): bounded retries on 5xx, one
 * logical delivery. The agent is not involved, so a flaky tracker can never
 * make it re-run an investigation or post twice.
 */
async function deliver(baseUrl: string, incidentId: string, body: Json, attempts = 3): Promise<{ ok: boolean; status: number }> {
    let status = 0;
    for (let i = 0; i < attempts; i += 1) {
        const res = await fetch(`${baseUrl}/incidents/${encodeURIComponent(incidentId)}/comments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        status = res.status;
        if (res.ok) return { ok: true, status };
        if (res.status < 500) break;
        await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
    return { ok: false, status };
}

async function main(): Promise<number> {
    const { SmokeClient } = await import('../../smoke/client');
    const { startSmokeServer } = await import('../../smoke/server');
    const { startMockWorld, CONFLUENCE_TOKEN } = await import('./mockServers');
    const { importConfluenceSpace } = await import('./confluenceImporter');
    const { CONFLUENCE_SPACE, SCENARIOS } = await import('./fixtures');
    const { appLogsSpec, infraLogsSpec, incidentCommentsSpec } = await import('./toolSpecs');
    const { VARIANTS, formatStructuredComment } = await import('./variants');
    const { scoreRun } = await import('./scoring');

    const log = (msg: string) => console.log(msg);
    log('▶ Incident-triage e2e');
    log(`  model    : ${LLM_MODEL} via ${new URL(LLM.baseUrl).host}`);
    log(`  data dir : ${dataDir}`);

    const world = await startMockWorld();
    const server = await startSmokeServer();
    const c = new SmokeClient(server.baseUrl);
    const setupFailures: string[] = [];

    const must = async <T = Json>(name: string, method: string, path: string, expect: number[], body?: unknown): Promise<T> => {
        const res = await c.step<T>(name, method, path, expect, body !== undefined ? { body } : {});
        if (!res) {
            setupFailures.push(name);
            throw new Error(`setup step failed: ${name}`);
        }
        return res.body;
    };

    const runs: Array<Json> = [];
    const extraChecks: Array<{ name: string; ok: boolean; detail: string }> = [];

    try {
        // ── 2. Tenant ────────────────────────────────────────────────────
        c.currentModule = 'setup';
        await must('register tenant', 'POST', '/api/auth/register', [201], {
            companyName: `E2E Triage ${STAMP}`,
            email: `owner-${STAMP}@e2e.test`,
            name: 'E2E Owner',
            password: 'E2eTriage!2024#Secure',
        });

        // ── 3. Models ────────────────────────────────────────────────────
        const providerKey = `e2e-llm-${STAMP}`;
        await must('create model provider', 'POST', '/api/models/providers', [201], {
            key: providerKey,
            driver: 'openai-compatible',
            label: 'E2E LLM',
            credentials: { apiKey: LLM.apiKey },
            settings: { baseUrl: LLM.baseUrl },
        });
        const llm = await must<{ model: Json }>('create LLM', 'POST', '/api/models', [201], {
            name: LLM_MODEL,
            key: 'e2e-llm',
            providerKey,
            category: 'llm',
            modelId: LLM_MODEL,
            // Placeholder prices so cost is exercised end to end; set
            // E2E_PRICE_IN / E2E_PRICE_OUT to your contract's per-1M rates.
            pricing: {
                currency: 'USD',
                inputTokenPer1M: Number(process.env.E2E_PRICE_IN ?? 1.25),
                outputTokenPer1M: Number(process.env.E2E_PRICE_OUT ?? 10),
                cachedTokenPer1M: 0,
            },
            settings: {},
            supportsToolCalls: true,
        });
        const llmId = String(llm.model._id ?? llm.model.id);
        await must('create embedding model', 'POST', '/api/models', [201], {
            name: EMBED_MODEL,
            key: 'e2e-embed',
            providerKey,
            category: 'embedding',
            modelId: EMBED_MODEL,
            pricing: { currency: 'USD', inputTokenPer1M: 0.02, outputTokenPer1M: 0, cachedTokenPer1M: 0 },
            settings: {},
        });

        // ── 4. Knowledge base from Confluence ────────────────────────────
        const vectorKey = `e2e-vec-${STAMP}`;
        await must('create vector provider', 'POST', '/api/vector/providers', [201], {
            key: vectorKey,
            driver: 'sqlite-vector',
            label: 'E2E vectors',
            credentials: {},
            settings: { basePath: join(dataDir, 'vectors') },
        });
        const index = await must<Json>('create vector index', 'POST', '/api/vector/indexes', [201], {
            name: `e2e-runbooks-${STAMP}`,
            providerKey: vectorKey,
            dimension: EMBED_DIM,
            metric: 'cosine',
        });
        const indexKey = String((index.index as Json | undefined)?.key ?? index.key ?? '');
        await must('create knowledge engine', 'POST', '/api/rag/modules', [201], {
            name: 'Ops runbooks',
            key: 'ops-runbooks',
            embeddingModelKey: 'e2e-embed',
            vectorProviderKey: vectorKey,
            vectorIndexKey: indexKey,
            chunkConfig: { strategy: 'recursive_character', chunkSize: 900, chunkOverlap: 100 },
            defaultTopK: 4,
        });
        c.currentModule = 'confluence';
        const imported = await importConfluenceSpace({
            confluenceBaseUrl: world.baseUrls.confluence,
            token: CONFLUENCE_TOKEN,
            spaceKey: CONFLUENCE_SPACE,
            ragModuleKey: 'ops-runbooks',
            ingest: async (path, body) => {
                const res = await c.request('POST', path, { body });
                return { status: res.status, body: res.body };
            },
        });
        log(`  ✓ confluence: ${imported.ingested}/${imported.pages} pages ingested${imported.failed.length ? `, failed ${JSON.stringify(imported.failed)}` : ''}`);
        if (imported.ingested !== imported.pages) setupFailures.push('confluence import incomplete');
        extraChecks.push({
            name: 'confluence import',
            ok: imported.ingested === imported.pages && imported.pages > 0,
            detail: `${imported.ingested}/${imported.pages} pages, ${world.requests.filter((r) => r.server === 'confluence').length} REST calls (paginated)`,
        });
        const probe = await c.request<Json>('POST', '/api/rag/modules/ops-runbooks/query', { body: { query: 'checkout returns 502', topK: 2 } });
        const probeText = JSON.stringify(probe.body ?? {});
        extraChecks.push({
            name: 'knowledge base retrieval',
            ok: probe.status === 200 && probeText.includes('checkout'),
            detail: `query "checkout returns 502" → HTTP ${probe.status}${probeText.includes('Runbook: checkout') ? ', top hit is the checkout runbook' : ''}`,
        });

        // ── 5. Tools (OpenAPI imports pointing at the mocks) ─────────────
        c.currentModule = 'tools';
        const tools: Record<string, string> = {};
        for (const [name, spec] of [
            ['App logs', appLogsSpec(world.baseUrls.appLogs)],
            ['Infra logs', infraLogsSpec(world.baseUrls.infraLogs)],
            ['Incidents', incidentCommentsSpec(world.baseUrls.incidents)],
        ] as const) {
            const res = await must<{ tool: Json }>(`import tool: ${name}`, 'POST', '/api/tools', [201], {
                name,
                type: 'openapi',
                openApiSpec: JSON.stringify(spec),
            });
            tools[name] = String(res.tool.key);
        }

        // ── 6. Agents, one per variant, published ────────────────────────
        c.currentModule = 'agents';
        const chosen = VARIANTS.filter((v) => VARIANT_FILTER.includes(v.id[0]));
        const agents: Record<string, { id: string; version: number }> = {};
        for (const variant of chosen) {
            const toolBindings = [
                { source: 'tool', sourceKey: tools['App logs'], toolNames: ['search_app_logs'] },
                { source: 'tool', sourceKey: tools['Infra logs'], toolNames: ['query_infra_logs'] },
                ...(variant.postsViaTool
                    ? [{ source: 'tool', sourceKey: tools.Incidents, toolNames: ['post_incident_comment'] }]
                    : []),
            ];
            const created = await must<{ agent: Json }>(`create agent ${variant.id}`, 'POST', '/api/agents', [201], {
                name: variant.name,
                config: {
                    modelKey: 'e2e-llm',
                    systemPrompt: variant.systemPrompt,
                    knowledgeEngineKey: 'ops-runbooks',
                    toolBindings,
                    ...(variant.structuredOutput ? { structuredOutput: variant.structuredOutput } : {}),
                },
            });
            const id = String(created.agent._id ?? created.agent.id);
            const published = await must<{ version: Json }>(`publish ${variant.id}`, 'POST', `/api/agents/${id}/publish`, [201], {
                changelog: 'e2e',
            });
            agents[variant.id] = { id, version: Number(published.version.version) };
        }

        // ── 7. The matrix ────────────────────────────────────────────────
        c.currentModule = 'runs';
        const scenarios = SCENARIOS.filter((s) => !SCENARIO_FILTER || SCENARIO_FILTER.includes(s.id));
        const total = chosen.length * scenarios.length * REPS;
        let n = 0;
        // Sequential on purpose: the mock servers' request logs are how tool
        // usage is verified, and concurrent runs would interleave them.
        for (let rep = 1; rep <= REPS; rep += 1) {
            for (const scenario of scenarios) {
                for (const variant of chosen) {
                    n += 1;
                    world.reset();
                    world.failNextPosts = FLAKY_POSTS;
                    const agent = agents[variant.id];
                    const session = await c.request<{ session: Json }>('POST', `/api/agents/${agent.id}/sessions`, {
                        body: { title: `${scenario.incidentId} ${variant.id} #${rep}` },
                    });
                    const sessionId = String(session.body?.session?._id ?? '');
                    const started = Date.now();
                    const res = await c.request<Json>('POST', `/api/agents/${agent.id}/chat`, {
                        body: {
                            message: `Incident ${scenario.incidentId}: ${scenario.problem}`,
                            conversationId: sessionId,
                            version: agent.version,
                        },
                    });
                    const data = (res.body ?? {}) as Json;
                    const steps = (Array.isArray(data.steps) ? data.steps : []) as Array<Json>;

                    let deliveredText: string | undefined;
                    let rootCauseField: string | undefined;
                    let deliveries = 0;
                    let deliveredToIncident: string | undefined;
                    let schemaValid: boolean | undefined;

                    if (variant.id === 'A-tool-post') {
                        deliveries = world.comments.length;
                        const first = world.comments[0];
                        if (first) {
                            deliveredText = `${String(first.body.rootCause ?? '')}\n${String(first.body.body ?? '')}`;
                            rootCauseField = typeof first.body.rootCause === 'string' ? first.body.rootCause : undefined;
                            deliveredToIncident = first.incidentId;
                        }
                    } else if (variant.id === 'B-structured') {
                        const output = data.output as Json | undefined;
                        schemaValid = Boolean(output) && !data.outputError
                            && ['rootCause', 'evidence', 'severity'].every((k) => output?.[k] !== undefined);
                        if (schemaValid && output) {
                            // The integration knows which incident it asked
                            // about — the id comes from its own context, not
                            // from the model.
                            const text = formatStructuredComment(output);
                            const post = await deliver(world.baseUrls.incidents, scenario.incidentId, {
                                body: text, rootCause: output.rootCause, severity: output.severity,
                            });
                            if (post.ok) {
                                deliveries = 1;
                                deliveredText = text;
                                rootCauseField = String(output.rootCause ?? '');
                                deliveredToIncident = scenario.incidentId;
                            }
                        }
                    } else {
                        const text = typeof data.content === 'string' ? data.content.trim() : '';
                        if (text) {
                            const post = await deliver(world.baseUrls.incidents, scenario.incidentId, { body: text });
                            if (post.ok) {
                                deliveries = 1;
                                deliveredText = text;
                                deliveredToIncident = scenario.incidentId;
                                rootCauseField = /root cause\**\s*:?\**\s*([^\n]+)/i.exec(text)?.[1];
                            }
                        }
                    }

                    // A's deliveries are counted from what actually landed; the
                    // failed attempts it made are counted separately.
                    const failedPostAttempts = world.requests.filter((q) => q.server === 'incidents' && q.status >= 500).length;
                    const usage = (data.usage ?? {}) as Json;
                    const obs = {
                        scenario,
                        variant: variant.id,
                        httpStatus: res.status,
                        ...(res.status !== 200 ? { error: String((data.error as string) ?? res.raw?.slice(0, 200)) } : {}),
                        steps: steps.map((s) => ({
                            name: String(s.name),
                            args: s.args,
                            ...(s.error ? { error: String(s.error) } : {}),
                            ...(s.status ? { status: String(s.status) } : {}),
                        })),
                        requests: [...world.requests],
                        deliveredText,
                        rootCauseField,
                        deliveries,
                        deliveredToIncident,
                        schemaValid,
                        tokens: { input: Number(usage.inputTokens ?? 0), output: Number(usage.outputTokens ?? 0) },
                        latencyMs: typeof data.latencyMs === 'number' ? data.latencyMs : Date.now() - started,
                    };
                    const score = scoreRun(obs);
                    runs.push({
                        rep,
                        scenario: scenario.id,
                        variant: variant.id,
                        score,
                        tokens: obs.tokens,
                        latencyMs: obs.latencyMs,
                        toolSequence: obs.steps.map((s) => s.name),
                        failedPostAttempts,
                        infraQueries: obs.requests.filter((r) => r.server === 'infra-logs').map((r) => ({ status: r.status, query: (r.body as Json | undefined)?.query })),
                        delivered: deliveredText?.slice(0, 1200),
                    });
                    log(`  ${score.pass ? '✓' : '✗'} [${n}/${total}] ${variant.id.padEnd(13)} ${scenario.id.padEnd(16)} ${String(obs.latencyMs).padStart(6)}ms  tools: ${obs.steps.map((s) => s.name).join(' → ') || '(none)'}${score.pass ? '' : `\n      ↳ ${score.failureReasons.join('; ')}`}`);
                }
            }
        }

        // ── 8. Streaming path: same agent, over /chat/stream ─────────────
        c.currentModule = 'stream';
        for (const variant of chosen) {
            world.reset();
            const agent = agents[variant.id];
            const scenario = scenarios[0];
            const response = await fetch(`${server.baseUrl}/api/agents/${agent.id}/chat/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', cookie: c.cookieHeader() },
                body: JSON.stringify({ message: `Incident ${scenario.incidentId}: ${scenario.problem}`, version: agent.version }),
            });
            const raw = await response.text();
            const events = raw.split('\n\n').filter(Boolean).map((block) => ({
                event: /event: (.+)/.exec(block)?.[1],
                data: (() => { try { return JSON.parse(/data: (.+)/.exec(block)?.[1] ?? 'null'); } catch { return null; } })(),
            }));
            const toolEvents = events.filter((e) => e.event === 'tool').length;
            const result = events.find((e) => e.event === 'result')?.data as Json | undefined;
            const usage = (result?.usage ?? {}) as Json;
            const stepsCount = Array.isArray(result?.steps) ? (result?.steps as unknown[]).length : 0;
            const answered = Boolean((result?.content as string | undefined)?.trim()) || result?.output !== undefined || world.comments.length > 0;
            extraChecks.push({
                name: `stream ${variant.id}`,
                ok: response.status === 200 && stepsCount > 0 && Number(usage.inputTokens ?? 0) > 0 && answered,
                detail: `HTTP ${response.status}, ${toolEvents} live tool events, ${stepsCount} steps, tokens ${Number(usage.inputTokens ?? 0)}/${Number(usage.outputTokens ?? 0)}, answered=${answered}`,
            });
        }

        // ── 9. Model Hub: agent calls must show up as model usage ────────
        await new Promise((r) => setTimeout(r, 1500)); // usage writes are fire-and-forget
        const hub = await c.request<{ usage: Json }>('GET', `/api/models/${llmId}/usage`);
        const u = (hub.body?.usage ?? {}) as Json;
        extraChecks.push({
            name: 'model hub usage for the agent model',
            ok: Number(u.totalCalls ?? 0) > 0 && Number(u.totalInputTokens ?? 0) > 0,
            detail: `calls ${Number(u.totalCalls ?? 0)} (errors ${Number(u.errorCalls ?? 0)}), tokens ${Number(u.totalInputTokens ?? 0)}/${Number(u.totalOutputTokens ?? 0)}, tool calls ${Number(u.totalToolCalls ?? 0)}, cost ${JSON.stringify((u.costSummary as Json | undefined)?.totalCost ?? null)}`,
        });
    } catch (error) {
        console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        await server.close();
        await world.close();
        try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }

    const summary = summarize(runs);
    writeReports(runs, summary, extraChecks, setupFailures);
    printSummary(summary, extraChecks, setupFailures);
    if (setupFailures.length > 0) return 1;
    return Object.values(summary).every((s) => s.passRate >= MIN_PASS) ? 0 : 1;
}

interface VariantSummary {
    runs: number;
    passRate: number;
    rootCauseAccuracy: number;
    kbFirstRate: number;
    bothSourcesRate: number;
    deliveredOnceRate: number;
    duplicateDeliveries: number;
    schemaFailures: number;
    infraQueryErrors: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    avgInputTokens: number;
    avgOutputTokens: number;
    avgToolCalls: number;
    failureReasons: Record<string, number>;
}

function summarize(runs: Array<Json>): Record<string, VariantSummary> {
    const out: Record<string, VariantSummary> = {};
    const byVariant = new Map<string, Array<Json>>();
    for (const r of runs) byVariant.set(String(r.variant), [...(byVariant.get(String(r.variant)) ?? []), r]);
    for (const [variant, list] of byVariant) {
        const scores = list.map((r) => r.score as Record<string, unknown>);
        const rate = (pred: (s: Record<string, unknown>) => boolean) => scores.filter(pred).length / Math.max(1, scores.length);
        const lat = list.map((r) => Number(r.latencyMs)).sort((a, b) => a - b);
        const reasons: Record<string, number> = {};
        for (const s of scores) for (const reason of s.failureReasons as string[]) reasons[reason] = (reasons[reason] ?? 0) + 1;
        out[variant] = {
            runs: list.length,
            passRate: rate((s) => s.pass === true),
            rootCauseAccuracy: rate((s) => s.rootCauseCorrect === true),
            kbFirstRate: rate((s) => s.kbFirst === true),
            bothSourcesRate: rate((s) => s.usedAppLogs === true && s.usedInfraLogs === true),
            deliveredOnceRate: rate((s) => s.deliveredOnce === true),
            duplicateDeliveries: scores.filter((s) => s.duplicateDelivery === true).length,
            schemaFailures: scores.filter((s) => s.schemaValid === false).length,
            infraQueryErrors: scores.reduce((sum, s) => sum + Number(s.infraQueryErrors ?? 0), 0),
            avgLatencyMs: Math.round(lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length)),
            p95LatencyMs: lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] ?? 0,
            avgInputTokens: Math.round(list.reduce((a, r) => a + Number((r.tokens as Json).input), 0) / Math.max(1, list.length)),
            avgOutputTokens: Math.round(list.reduce((a, r) => a + Number((r.tokens as Json).output), 0) / Math.max(1, list.length)),
            avgToolCalls: Number((scores.reduce((a, s) => a + Number(s.toolCalls), 0) / Math.max(1, scores.length)).toFixed(1)),
            failureReasons: reasons,
        };
    }
    return out;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

function printSummary(summary: Record<string, VariantSummary>, checks: Array<{ name: string; ok: boolean; detail: string }>, setup: string[]) {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  INCIDENT-TRIAGE E2E');
    console.log('──────────────────────────────────────────────────────────────');
    for (const [v, s] of Object.entries(summary)) {
        console.log(`  ${v.padEnd(13)} pass ${pct(s.passRate).padStart(4)}  root cause ${pct(s.rootCauseAccuracy).padStart(4)}  kb-first ${pct(s.kbFirstRate).padStart(4)}  both sources ${pct(s.bothSourcesRate).padStart(4)}  delivered-once ${pct(s.deliveredOnceRate).padStart(4)}  avg ${s.avgLatencyMs}ms  tokens ${s.avgInputTokens}/${s.avgOutputTokens}`);
    }
    console.log('');
    for (const check of checks) console.log(`  ${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`);
    if (setup.length) console.log(`\n  ✗ setup failures: ${setup.join(', ')}`);
    console.log(`\n  Reports: ${REPORT_DIR}/latest.{json,md}\n`);
}

function writeReports(runs: Array<Json>, summary: Record<string, VariantSummary>, checks: Array<{ name: string; ok: boolean; detail: string }>, setup: string[]) {
    mkdirSync(REPORT_DIR, { recursive: true });
    const generatedAt = new Date().toISOString();
    writeFileSync(join(REPORT_DIR, 'latest.json'), JSON.stringify({ generatedAt, model: LLM_MODEL, reps: REPS, summary, checks, setupFailures: setup, runs }, null, 2));
    const lines = [
        '# Incident-triage E2E report',
        '',
        `Generated ${generatedAt} · model \`${LLM_MODEL}\` · ${REPS} repetition(s) per scenario`,
        '',
        '| Variant | Runs | Pass | Root cause | KB first | Both log sources | Delivered once | Duplicates | Schema fails | Avg latency | p95 | Avg tokens in/out | Avg tool calls |',
        '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
        ...Object.entries(summary).map(([v, s]) => `| ${v} | ${s.runs} | ${pct(s.passRate)} | ${pct(s.rootCauseAccuracy)} | ${pct(s.kbFirstRate)} | ${pct(s.bothSourcesRate)} | ${pct(s.deliveredOnceRate)} | ${s.duplicateDeliveries} | ${s.schemaFailures} | ${s.avgLatencyMs}ms | ${s.p95LatencyMs}ms | ${s.avgInputTokens}/${s.avgOutputTokens} | ${s.avgToolCalls} |`),
        '',
        '## Checks',
        '',
        ...checks.map((c) => `- ${c.ok ? '✅' : '❌'} **${c.name}** — ${c.detail}`),
        ...(setup.length ? ['', `**Setup failures:** ${setup.join(', ')}`] : []),
        '',
        '## Failure reasons',
        '',
        ...Object.entries(summary).flatMap(([v, s]) => Object.entries(s.failureReasons).map(([r, count]) => `- ${v}: ${r} × ${count}`)),
        '',
        '## Runs',
        '',
        '| Rep | Variant | Scenario | Pass | Tools | Latency | Tokens | Reasons |',
        '|---|---|---|---|---|---|---|---|',
        ...runs.map((r) => {
            const s = r.score as Record<string, unknown>;
            return `| ${r.rep} | ${r.variant} | ${r.scenario} | ${s.pass ? '✅' : '❌'} | ${(r.toolSequence as string[]).join(' → ')} | ${r.latencyMs}ms | ${(r.tokens as Json).input}/${(r.tokens as Json).output} | ${(s.failureReasons as string[]).join('; ')} |`;
        }),
    ];
    writeFileSync(join(REPORT_DIR, 'latest.md'), lines.join('\n'));
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error('Fatal e2e error:', error);
        process.exit(1);
    });
