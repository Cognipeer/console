/**
 * Agent flow — plan versions, sub-agent groups and positioned summaries — end to end through the real console
 * API, against a scripted mock model (no network, no real LLM).
 *
 * What the playground draws is built from three things this harness pins down on the wire: the live SSE frames
 * (`plan`, `subagent`, `summary`, `tool` with its sub-agent stamp), the message the turn stores (`plans`,
 * `subagentRuns`, positioned `compactions`) and the session event log the dashboard follows. The client API
 * reads the same log and must stay as it was.
 *
 *   Scenario P: planning ON. Turn 1 writes a plan, calls a tool, updates the plan and answers; turn 2 (same
 *               session) updates it again; turn 3 only reads it (a plan call that writes no version). Also an
 *               agent with planning OFF.
 *   Scenario S: delegate_to a registry child (one big tool result), then spawn_subagents_parallel with two ad-hoc
 *               children, in one turn.
 *   Scenario B: a plan, then a delegation whose child needs approval: the turn pauses inside the child, is
 *               approved through the real API (?stream=1) and finishes in a second leg.
 *   Scenario C: summarization twice in one turn after tool calls (the mock answers the summarizer), and a
 *               sub-agent that summarizes inside its own run.
 *
 *   npx tsx scripts/e2e/agent-flow/run.ts [--only P,S,B,C] [--dump] [--debug] [--keep]
 *
 *   --dump   print every SSE frame (compact) and every dashboard log row of each scenario
 *   --debug  print every request the mock model receives
 *   --keep   keep the throwaway data dir (kept anyway when a check fails), and print how to open it
 *
 * Expectations branch on the installed @cognipeer/agent-sdk: 0.18/0.19 (legacy: no toolCallId on plan events,
 * no `start` summary frames, compactedTools attributed by Console afterwards) and >= 0.20 (the SDK says it).
 *
 * Isolated: throwaway SQLite dir, memory cache, own secrets, mock servers on port 0. Nothing here reads a real
 * credential or talks to a real host.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLAN_UPDATE_1, PLAN_UPDATE_2, PLAN_WRITE, startMockFlowLlm, type IssuedCall, type Json } from './mockFlowLlm';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const ONLY = arg('only')?.toUpperCase().split(',').map((s) => s.trim());
const DUMP = flag('dump');
const DEBUG = flag('debug');
const KEEP = flag('keep');

let SDK_VERSION = 'unknown';
try {
    SDK_VERSION = JSON.parse(readFileSync(join(process.cwd(), 'node_modules/@cognipeer/agent-sdk/package.json'), 'utf8')).version ?? SDK_VERSION;
} catch { /* reported below */ }
const [SDK_MAJOR, SDK_MINOR] = SDK_VERSION.split('.').map((part) => Number.parseInt(part, 10));
/** The SDK says where things happened itself (plan toolCallId, summary start/trigger/compactedTools). */
const SDK_NEW = SDK_MAJOR > 0 || SDK_MINOR >= 20;
if (!(SDK_MAJOR > 0 || SDK_MINOR >= 18)) {
    console.error(`This harness needs @cognipeer/agent-sdk >= 0.18.0 (installed: ${SDK_VERSION}).`);
    process.exit(2);
}

const STAMP = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const dataDir = mkdtempSync(join(tmpdir(), 'cognipeer-e2e-agentflow-'));
const SECRETS = {
    JWT_SECRET: 'e2e-agentflow-jwt-secret-please-ignore-0123456789',
    PROVIDER_ENCRYPTION_SECRET: 'e2e-agentflow-provider-secret-please-ignore-0123456789',
};
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = dataDir;
process.env.MAIN_DB_NAME = 'e2e_main';
process.env.CACHE_PROVIDER = 'memory';
process.env.RATE_LIMIT_PROVIDER = 'memory';
process.env.JWT_SECRET = SECRETS.JWT_SECRET;
process.env.JWT_EXPIRES_IN = '7d';
process.env.PROVIDER_ENCRYPTION_SECRET = SECRETS.PROVIDER_ENCRYPTION_SECRET;
(process.env as Record<string, string>).NODE_ENV = process.env.NODE_ENV ?? 'development';
process.env.OUTBOUND_HTTP_ALLOWED_HOSTS = '127.0.0.1,localhost';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

const LOGIN = { companyName: `E2E AgentFlow ${STAMP}`, email: `owner-${STAMP}@e2e.test`, name: 'E2E Owner', password: 'E2eAgentFlow!2024#Secure' };

interface Result { id: string; scenario: string; name: string; ok: boolean; detail: string; evidence: string[] }
interface Frame { i: number; event: string; data: any }

// ── the OpenAPI tool's backend ────────────────────────────────────────────

/** Topics `big-*` answer with a note of ~1.5k tokens, so a run that reads a few of them crosses a tiny summarization trigger. */
async function startNotesApi() {
    const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname === '/notes') {
            const topic = url.searchParams.get('topic') ?? 'none';
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ topic, note: `NOTE-${topic}: the cache is warm`, ...(topic.startsWith('big') ? { pad: 'lorem ipsum dolor '.repeat(300) } : {}) }));
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

function notesSpec(baseUrl: string) {
    return {
        openapi: '3.0.3',
        info: { title: 'Notes', version: '1.0.0' },
        servers: [{ url: baseUrl }],
        paths: {
            '/notes': {
                get: {
                    operationId: 'lookup_note',
                    summary: 'Look up the stored note for a topic.',
                    parameters: [{ name: 'topic', in: 'query', required: true, schema: { type: 'string' } }],
                    responses: { 200: { description: 'The note' } },
                },
            },
        },
    };
}

// ── helpers ───────────────────────────────────────────────────────────────

/** Frames of an SSE body, in arrival order. */
function sseFrames(raw: unknown): Frame[] {
    if (typeof raw !== 'string') return [];
    return raw.split('\n\n').map((block) => {
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
        const data = /^data: (.*)$/m.exec(block)?.[1];
        let parsed: any = data;
        try { parsed = data ? JSON.parse(data) : undefined; } catch { /* keep the raw text */ }
        return { event, data: parsed };
    }).filter((f) => f.data !== undefined).map((f, i) => ({ ...f, i }));
}

const jsonLen = (v: unknown) => { try { return JSON.stringify(v)?.length ?? 0; } catch { return Infinity; } };
const short = (v: unknown, n = 160) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > n ? `${s.slice(0, n)}…` : String(s); };
const isIso = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const seqs = (es: Json[]) => es.map((e) => e.seq).join();
const sameList = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => JSON.stringify(x) === JSON.stringify(b[i]));

/** A frame's compact label, for order comparisons and dumps. */
function label(f: Frame): string {
    const d = f.data ?? {};
    switch (f.event) {
        case 'tool': return `tool.${d.phase}:${d.name}${d.subagent ? `@${d.subagent.name}` : ''}`;
        case 'plan': return `plan.v${d.version}:${d.operation}`;
        case 'subagent': return `subagent.${d.phase}:${d.name}`;
        case 'summary': return `summary.${d.phase ?? 'done'}${d.index !== undefined ? `#${d.index}` : ''}${d.subagent ? `@${d.subagent.name}` : ''}`;
        default: return f.event;
    }
}

/** What a log row stands for, compactly. */
function rowLabel(e: Json): string {
    const d = e.data ?? {};
    switch (e.type) {
        case 'agent.tool_use': case 'agent.tool_result': return `${e.type.slice(6)}:${d.name}${d.subagentId ? `@${d.subagent ?? d.subagentId}` : ''}`;
        case 'agent.plan': return `plan.v${d.version}`;
        case 'agent.subagent': return `subagent.${d.phase}:${d.name}`;
        case 'agent.compaction': return `compaction${d.index !== undefined ? `#${d.index}` : ''}${d.subagent ? `@${d.subagent.name ?? d.subagent}` : ''}`;
        default: return e.type;
    }
}

const FLOW_EVENTS = new Set(['tool', 'plan', 'subagent', 'summary']);

/** What the live reducers and `orderTurnFlow` both stand for, in a form the two can be compared in. */
function liveSignature(segments: any[]): string[] {
    return segments.flatMap((seg) => {
        switch (seg.kind) {
            case 'tools': return [`steps(${seg.calls.map((c: Json) => c.name).join(',')})`];
            case 'plan': return [`plan(v${seg.plan.version})`];
            case 'compaction': return [`compaction(${seg.pending ? 'pending' : seg.compaction.id})`];
            case 'subagents': return [`subagents(${seg.parallel ? 'par' : 'seq'}:${seg.runs.map((r: Json) => `${r.name}[${r.steps.length}]`).join(',')})`];
            default: return [];
        }
    });
}
function storedSignature(blocks: any[]): string[] {
    return blocks.flatMap((b) => {
        switch (b.kind) {
            case 'steps': return [`steps(${b.steps.map((st: Json) => st.name).join(',')})`];
            case 'plan': return [`plan(v${b.plan.version})`];
            case 'compaction': return [`compaction(${b.compaction.id})`];
            case 'subagents': return [`subagents(${b.parallel ? 'par' : 'seq'}:${b.runs.map((r: Json) => `${r.name}[${r.steps.length}]`).join(',')})`];
            default: return [];
        }
    });
}

async function main(): Promise<number> {
    const { SmokeClient } = await import('../../smoke/client');
    const { startSmokeServer } = await import('../../smoke/server');
    const { orderTurnFlow } = await import('../../../src/lib/shared/agentTurnFlow');
    const live = await import('../../../src/components/agents/session/liveFlow');
    const log = (msg = '') => console.log(msg);
    /** The frames of a turn, fed through the live reducers the playground uses. */
    const liveSegmentsOf = (frames: Frame[], basePlan?: Json | null) => frames.reduce((segs: any[], f) => {
        switch (f.event) {
            case 'tool': return live.applyLiveToolEvent(segs, f.data);
            case 'plan': return live.applyLivePlan(segs, f.data, basePlan as never);
            case 'subagent': return live.applyLiveSubagent(segs, f.data);
            case 'summary': return live.applyLiveCompaction(segs, f.data);
            default: return segs;
        }
    }, [] as any[]);

    const mock = await startMockFlowLlm({ debug: DEBUG });
    const notes = await startNotesApi();
    const server = await startSmokeServer();
    const c = new SmokeClient(server.baseUrl);
    const all: Result[] = [];
    const ids: Record<string, string> = {};
    const want = (id: string) => !ONLY || ONLY.includes(id);
    let scenario = '-';
    const check = (id: string, name: string, ok: boolean, detail: string, evidence: string[] = []) => {
        const r: Result = { id, scenario, name, ok, detail, evidence };
        all.push(r);
        log(`  ${ok ? '✓' : '✗'} ${id} ${name} — ${detail}`);
        if (!ok) evidence.slice(0, 24).forEach((l) => log(`        ${l}`));
    };

    const must = async (name: string, method: string, path: string, expect: number[], body?: unknown, headers?: Record<string, string>): Promise<Json> => {
        const res = await c.request<Json>(method, path, { ...(body !== undefined ? { body } : {}), ...(headers ? { headers } : {}) });
        if (!expect.includes(res.status)) throw new Error(`setup "${name}" → HTTP ${res.status}: ${res.raw?.slice(0, 400)}`);
        return res.body;
    };

    try {
        log(`▶ Agent flow e2e — agent-sdk ${SDK_VERSION} (${SDK_NEW ? 'new path: toolCallId on plan events, start frames, per-pass compactedTools' : 'legacy path: plan anchored by the open call, no start frames, compactedTools attributed by Console'})`);
        log(`  mock model ${mock.url}, notes API ${notes.url}, data dir ${dataDir}`);
        await must('register', 'POST', '/api/auth/register', [201], LOGIN);
        await must('provider', 'POST', '/api/models/providers', [201], {
            key: 'mock-provider', driver: 'openai-compatible', label: 'Mock LLM',
            credentials: { apiKey: 'mock-key-not-a-secret' }, settings: { baseUrl: `${mock.url}/v1` },
        });
        await must('model', 'POST', '/api/models', [201], {
            name: 'mock-model', key: 'mock-llm', providerKey: 'mock-provider', category: 'llm', modelId: 'mock-gpt',
            pricing: { currency: 'USD', inputTokenPer1M: 1, outputTokenPer1M: 2, cachedTokenPer1M: 0 },
            settings: {}, supportsToolCalls: true,
        });
        const tool = await must('notes tool', 'POST', '/api/tools', [201], { name: 'Notes', type: 'openapi', openApiSpec: JSON.stringify(notesSpec(notes.url)) });
        const toolKey = String(tool.tool.key);
        const tokenBody = await must('api token', 'POST', '/api/tokens', [201], { label: 'e2e agent flow token' });
        const apiToken = String(tokenBody.token);
        const bearer = { authorization: `Bearer ${apiToken}` };

        const notesBinding = { source: 'tool', sourceKey: toolKey, toolNames: ['lookup_note'] };
        const noApproval = { toolApproval: { enabled: false }, askUser: { enabled: false } };
        const subagentPolicy = { mode: 'registry_and_adhoc', maxParallel: 2, maxChildCalls: 8, maxDepth: 2 };
        const researcher = (role = 'RESEARCHER', name = 'researcher', extra: Json = {}) => ({
            kind: 'inline', name, header: 'Looks up stored notes by topic.',
            systemPrompt: `ROLE=${role} You look up notes with lookup_note and report them.`,
            toolBindings: [notesBinding],
            ...extra,
        });
        const createAgent = async (name: string, config: Json) => {
            const created = await must(`agent ${name}`, 'POST', '/api/agents', [201], { name: `${name} ${STAMP}`, config: { modelKey: 'mock-llm', ...config } });
            if (created.warnings?.length) log(`    (agent ${name} warnings: ${JSON.stringify(created.warnings).slice(0, 300)})`);
            return String(created.agent._id ?? created.agent.id);
        };
        const newSession = async (agentId: string, title: string) =>
            String((await must('session', 'POST', `/api/agents/${agentId}/sessions`, [201], { title })).session._id);
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

        /** One /chat/stream turn: every frame in arrival order, the result frame, and what the mock model issued meanwhile. */
        const streamTurn = async (agentId: string, sessionId: string, message: string) => {
            const mark = mock.issued.length;
            const res = await c.request<Json>('POST', `/api/agents/${agentId}/chat/stream`, { body: { message, conversationId: sessionId } });
            const frames = sseFrames(res.body);
            return { status: res.status, frames, result: frames.find((f) => f.event === 'result')?.data as Json | undefined, error: frames.find((f) => f.event === 'error')?.data, calls: mock.since(mark), raw: res.raw };
        };
        const resolveStream = async (agentId: string, sessionId: string, actionId: string) => {
            const mark = mock.issued.length;
            const res = await c.request<Json>('POST', `/api/agents/${agentId}/sessions/${sessionId}/actions/${actionId}/resolve?stream=1`, { body: { decision: 'allow' } });
            const frames = sseFrames(res.body);
            return { status: res.status, frames, result: frames.find((f) => f.event === 'result')?.data as Json | undefined, error: frames.find((f) => f.event === 'error')?.data, calls: mock.since(mark) };
        };
        const getSession = async (agentId: string, sessionId: string) => must('session', 'GET', `/api/agents/${agentId}/sessions/${sessionId}`, [200]);
        const assistantMessages = (s: Json): Json[] => ((s.session?.messages ?? []) as Json[]).filter((m) => m.role === 'assistant');

        /** The whole dashboard log of a session (paged). */
        const dashEvents = async (agentId: string, sessionId: string): Promise<Json[]> => {
            const out: Json[] = [];
            let after = 0;
            for (let guard = 0; guard < 50; guard += 1) {
                const page = await must('events', 'GET', `/api/agents/${agentId}/sessions/${sessionId}/events?limit=1000&after=${after}`, [200]);
                out.push(...page.events);
                if (!page.has_more) break;
                after = page.last_seq;
            }
            return out;
        };
        /** The client API's log of the same session, walked page by page with `limit` rows per page. */
        const clientEvents = async (sessionId: string, limit: number) => {
            const out: Json[] = [];
            let after = 0;
            let pages = 0;
            let overfull = 0;
            let emptyWithMore = 0;
            let lastSeqs: number[] = [];
            for (let guard = 0; guard < 400; guard += 1) {
                const page = await must('client events', 'GET', `/api/client/v1/agents/sessions/${sessionId}/events?limit=${limit}&after=${after}`, [200], undefined, bearer);
                pages += 1;
                if (page.events.length > limit) overfull += 1;
                if (page.events.length === 0 && page.has_more) emptyWithMore += 1;
                out.push(...page.events);
                lastSeqs.push(page.last_seq);
                if (!page.has_more) break;
                if (!(page.last_seq > after)) { lastSeqs = [...lastSeqs, -1]; break; }
                after = page.last_seq;
            }
            const monotonic = lastSeqs.every((s, i) => s >= 0 && (i === 0 || s > lastSeqs[i - 1]));
            return { events: out, pages, overfull, emptyWithMore, monotonic };
        };
        const dump = (title: string, frames: Frame[], rows?: Json[]) => {
            if (!DUMP) return;
            log(`    ── ${title}: SSE frames`);
            frames.filter((f) => !['text', 'status', 'reasoning'].includes(f.event)).forEach((f) => log(`    ${String(f.i).padStart(3)} ${f.event === 'result' ? 'result' : label(f)} ${f.event === 'result' ? '' : short(f.data, 220)}`));
            if (rows) { log(`    ── ${title}: dashboard log`); rows.forEach((e) => log(`    ${String(e.seq).padStart(3)} ${e.type} ${short(e.data, 200)}`)); }
        };

        /** The tool frames of the parent (no sub-agent stamp). */
        const parentTools = (frames: Frame[]) => frames.filter((f) => f.event === 'tool' && !f.data.subagent);
        const hasKeys = (obj: Json, keys: string[]) => keys.filter((k) => obj && Object.prototype.hasOwnProperty.call(obj, k));
        const CAMEL_SNAKE = (k: string) => [k, k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)];
        const noLeak = (messages: unknown) => {
            const text = JSON.stringify(messages ?? null);
            return ['"plans"', '"subagentRuns"', '"subagent_runs"', '"stepsDropped"', '"afterToolCallId"', '"after_tool_call_id"', '"compactedTools"', '"compacted_tools"'].filter((k) => text.includes(k));
        };

        // ═════════════ Scenario P: plan versions ═════════════
        if (want('P')) {
            scenario = 'P';
            log('\n── Scenario P: planning ON, three turns in one session (write + update, update, read); planning OFF agent ──');
            const agentId = await createAgent('flow-plan', {
                systemPrompt: 'ROLE=PLAN You plan, look up a note and report.',
                humanInTheLoop: noApproval,
                toolBindings: [notesBinding],
                runtime: { planning: { mode: 'todo' } },
            });
            const sessionId = await newSession(agentId, 'flow plan');
            ids.planAgent = agentId; ids.planSession = sessionId;

            // ── turn 1
            const t1 = await streamTurn(agentId, sessionId, 'TURN-1 write a plan, look up the note, update the plan and answer.');
            log(`  turn 1 → HTTP ${t1.status}; frames: ${t1.frames.filter((f) => FLOW_EVENTS.has(f.event)).map(label).join(' ')}`);
            log(`    mock issued ${t1.calls.length} calls: ${t1.calls.map((x) => `#${x.k}:${x.role}${x.toolCalls.length ? `→${x.toolCalls[0]}` : ''}`).join(' ')}; answer="${short(t1.result?.content ?? t1.error, 80)}"`);
            await sleep(150);
            const sess1 = await getSession(agentId, sessionId);
            const rows1 = await dashEvents(agentId, sessionId);
            dump('P turn 1', t1.frames, rows1);
            const frames = t1.frames;
            const planFrames = frames.filter((f) => f.event === 'plan');
            const planTools = frames.filter((f) => f.event === 'tool' && f.data.name === 'manage_plan' && f.data.phase === 'start');
            const lookupStart = frames.find((f) => f.event === 'tool' && f.data.name === 'lookup_note' && f.data.phase === 'start');
            const issuedPlanCalls = t1.calls.filter((x) => x.toolCalls.includes('manage_plan')).flatMap((x) => x.toolCallIds);

            check('P1', 'turn 1 ran: HTTP 200, answer, three plan/tool/plan model calls', t1.status === 200 && String(t1.result?.content ?? '').startsWith('FINAL-P1') && !t1.error && t1.calls.length === 4,
                `HTTP ${t1.status}; answer="${short(t1.result?.content ?? t1.error, 70)}"; ${t1.calls.length} model calls`);

            const stepsOf = (p: Json) => (p.steps ?? []).map((s: Json) => `${s.id}:${s.status}`).join(',');
            check('P2', 'SSE plan frames: v1 write then v2 update, with the steps and their statuses',
                planFrames.length === 2
                && planFrames[0].data.version === 1 && planFrames[0].data.operation === 'write'
                && planFrames[1].data.version === 2 && planFrames[1].data.operation === 'update'
                && stepsOf(planFrames[0].data) === '1:in-progress,2:not-started,3:not-started'
                && stepsOf(planFrames[1].data) === '1:completed,2:in-progress,3:not-started'
                && planFrames[0].data.steps.map((s: Json) => s.title).join('|') === PLAN_WRITE.map((s) => s.title).join('|')
                && planFrames.every((f) => isIso(f.data.at)),
                `${planFrames.length} plan frame(s): ${planFrames.map((f) => `v${f.data.version} ${f.data.operation} [${stepsOf(f.data)}] completion=${f.data.completion}`).join(' → ')}`,
                planFrames.map((f) => short(f.data, 300)));

            check('P3', "each plan frame's toolCallId is the id of its manage_plan 'tool' start frame",
                planFrames.length === 2 && planTools.length === 2
                && planFrames[0].data.toolCallId === planTools[0].data.id && planFrames[1].data.toolCallId === planTools[1].data.id
                && planFrames[0].data.toolCallId === issuedPlanCalls[0] && planFrames[1].data.toolCallId === issuedPlanCalls[1],
                `plan ids ${planFrames.map((f) => f.data.toolCallId)}; manage_plan start frame ids ${planTools.map((f) => f.data.id)}; ids the model issued ${issuedPlanCalls}${SDK_NEW ? ' (SDK sends the id)' : ' (legacy: Console anchors to the open manage_plan call)'}`,
                planFrames.map((f) => short(f.data, 200)));

            const idxOf = (pred: (f: Frame) => boolean) => frames.findIndex(pred);
            const startIdx = planTools.map((f) => f.i);
            const successIdx = frames.filter((f) => f.event === 'tool' && f.data.name === 'manage_plan' && f.data.phase === 'success').map((f) => f.i);
            check('P4', 'frame order: plan v1 after its tool start and before the next tool; plan v2 likewise; v1 before v2',
                planFrames.length === 2 && startIdx.length === 2 && Boolean(lookupStart)
                && startIdx[0] < planFrames[0].i && planFrames[0].i < lookupStart!.i
                && lookupStart!.i < startIdx[1] && startIdx[1] < planFrames[1].i && planFrames[1].i < idxOf((f) => f.event === 'result')
                && planFrames[0].i < planFrames[1].i
                && successIdx.length === 2 && planFrames[0].i < successIdx[0] && planFrames[1].i < successIdx[1],
                `flow: ${frames.filter((f) => FLOW_EVENTS.has(f.event)).map(label).join(' ')}`);

            const resultPlans = (t1.result?.plans ?? []) as Json[];
            const storedMsg1 = assistantMessages(sess1).at(-1) ?? {};
            const storedPlans = (storedMsg1.plans ?? []) as Json[];
            const brief = (ps: Json[]) => ps.map((p) => `v${p.version}/${p.operation}/${p.toolCallId}`).join(' ');
            check('P5', "'result' frame and the stored assistant message carry plans [v1, v2] (toolCallId, steps, at)",
                resultPlans.length === 2 && resultPlans.map((p) => p.version).join() === '1,2' && resultPlans.map((p) => p.operation).join() === 'write,update'
                && resultPlans.every((p, i) => p.toolCallId === planFrames[i]?.data.toolCallId && isIso(p.at) && (p.steps ?? []).length === 3)
                && sameList(resultPlans, storedPlans) && stepsOf(storedPlans[1] ?? {}) === '1:completed,2:in-progress,3:not-started',
                `result.plans: ${brief(resultPlans) || 'none'}; stored message.plans: ${brief(storedPlans) || 'none'}; identical: ${sameList(resultPlans, storedPlans)}`);

            const sp = sess1.plan as Json | null;
            check('P6', 'GET session returns the top-level plan v2 with step statuses, completion and time',
                Boolean(sp) && sp!.version === 2 && stepsOf(sp!) === '1:completed,2:in-progress,3:not-started' && sp!.completion === 0.33 && isIso(sp!.at)
                && (sp!.steps ?? []).every((s: Json) => typeof s.title === 'string' && s.title),
                `plan=${sp ? `v${sp.version} [${stepsOf(sp)}] completion=${sp.completion} at=${sp.at}` : 'null'}`, [short(sess1.plan, 400)]);

            const agentRows1 = rows1.filter((e) => e.type.startsWith('agent.') && e.type !== 'agent.message');
            const wantRows = ['tool_use:manage_plan', 'plan.v1', 'tool_result:manage_plan', 'tool_use:lookup_note', 'tool_result:lookup_note', 'tool_use:manage_plan', 'plan.v2', 'tool_result:manage_plan'];
            const gotRows = agentRows1.map(rowLabel);
            const planRows = rows1.filter((e) => e.type === 'agent.plan');
            const anchored = planRows.every((e) => {
                const i = rows1.indexOf(e);
                const use = [...rows1.slice(0, i)].reverse().find((r) => r.type === 'agent.tool_use');
                return use?.data?.toolCallId === e.data.toolCallId;
            });
            check('P7', 'dashboard log: agent.plan rows v1, v2 in seq order between the tool rows, none duplicated',
                gotRows.join(' ') === wantRows.join(' ') && planRows.length === 2 && planRows.every((e, i) => e.data.version === i + 1) && anchored
                && agentRows1.every((e, i) => i === 0 || e.seq > agentRows1[i - 1].seq),
                `rows: ${gotRows.join(' ')}${anchored ? '' : ' (a plan row is not anchored to the tool_use before it)'}`,
                agentRows1.map((e) => `${e.seq} ${rowLabel(e)} ${short(e.data, 160)}`));

            const cl1 = await clientEvents(sessionId, 1000);
            const cl1Types = cl1.events.map((e) => e.type);
            const clTools = cl1.events.filter((e) => e.type === 'agent.tool_use').map((e) => e.data?.name);
            const clPaged = await clientEvents(sessionId, 1);
            const clPaged2 = await clientEvents(sessionId, 3);
            check('P8', 'client wire: no agent.plan rows, tool rows intact; paging (limit 1 and 3) returns the same rows, last_seq/has_more from the unfiltered page',
                !cl1Types.includes('agent.plan') && !cl1Types.includes('agent.subagent') && clTools.join() === 'manage_plan,lookup_note,manage_plan'
                && seqs(clPaged.events) === seqs(cl1.events) && seqs(clPaged2.events) === seqs(cl1.events)
                && clPaged.monotonic && clPaged2.monotonic && clPaged.overfull === 0 && clPaged2.overfull === 0 && cl1.events.length === rows1.length - planRows.length,
                `client rows ${cl1.events.length} of ${rows1.length} dashboard rows (${planRows.length} agent.plan hidden); tool_use rows [${clTools}]; limit=1 walk: ${clPaged.pages} pages, ${clPaged.emptyWithMore} empty page(s) with has_more, same rows: ${seqs(clPaged.events) === seqs(cl1.events)}; limit=3 walk: ${clPaged2.pages} pages, same rows: ${seqs(clPaged2.events) === seqs(cl1.events)}`,
                [`client seqs: ${seqs(cl1.events)}`, `dashboard seqs: ${seqs(rows1)}`, `limit=1 seqs: ${seqs(clPaged.events)}`, `limit=3 seqs: ${seqs(clPaged2.events)}`]);

            // ── turn 2, same session
            const t2 = await streamTurn(agentId, sessionId, 'TURN-2 move the plan on and answer.');
            log(`  turn 2 → HTTP ${t2.status}; frames: ${t2.frames.filter((f) => FLOW_EVENTS.has(f.event)).map(label).join(' ')}`);
            await sleep(150);
            const sess2 = await getSession(agentId, sessionId);
            const rows2 = await dashEvents(agentId, sessionId);
            dump('P turn 2', t2.frames);
            const plan2Frames = t2.frames.filter((f) => f.event === 'plan');
            const plan2Tool = t2.frames.find((f) => f.event === 'tool' && f.data.name === 'manage_plan' && f.data.phase === 'start');
            const plans2 = (t2.result?.plans ?? []) as Json[];
            const msgs2 = assistantMessages(sess2);
            const sp2 = sess2.plan as Json | null;
            check('P9', 'turn 2: one plan frame v3 (own toolCallId); its message.plans = [v3]; GET session plan v3; message 1 keeps [v1, v2]',
                t2.status === 200 && String(t2.result?.content ?? '').startsWith('FINAL-P2')
                && plan2Frames.length === 1 && plan2Frames[0].data.version === 3 && plan2Frames[0].data.operation === 'update' && plan2Frames[0].data.toolCallId === plan2Tool?.data.id
                && plan2Tool?.data.id !== planFrames[1].data.toolCallId
                && plans2.length === 1 && plans2[0].version === 3 && sameList(plans2, (msgs2.at(-1)?.plans ?? []) as Json[])
                && msgs2.length === 2 && (msgs2[0].plans ?? []).map((p: Json) => p.version).join() === '1,2'
                && sp2?.version === 3 && stepsOf(sp2 ?? {}) === '1:completed,2:completed,3:in-progress',
                `turn 2 frames: ${plan2Frames.map((f) => `v${f.data.version}@${f.data.toolCallId}`)} (tool start ${plan2Tool?.data.id}); result.plans [${plans2.map((p) => `v${p.version}`)}]; messages' plans ${msgs2.map((m) => `[${(m.plans ?? []).map((p: Json) => p.version)}]`).join(' ')}; GET plan ${sp2 ? `v${sp2.version} [${stepsOf(sp2)}]` : 'null'}`,
                [short(t2.result, 300), short(sess2.plan, 300)]);
            const planRows2 = rows2.filter((e) => e.type === 'agent.plan');
            const afterUser2 = rows2.findIndex((e) => e.type === 'user.message' && String(e.data?.content).startsWith('TURN-2'));
            check('P10', 'dashboard log across turns: agent.plan rows v1, v2, v3 (v3 after turn 2 starts), no duplicates; client wire still has none',
                planRows2.map((e) => e.data.version).join() === '1,2,3' && afterUser2 >= 0 && rows2.indexOf(planRows2[2]) > afterUser2 && planRows2.every((e, i) => i === 0 || e.seq > planRows2[i - 1].seq)
                && !(await clientEvents(sessionId, 1000)).events.some((e) => e.type === 'agent.plan'),
                `agent.plan rows ${planRows2.map((e) => `seq ${e.seq} v${e.data.version}`).join(', ')}`);
            const clientMsgs = await must('client messages', 'GET', `/api/client/v1/agents/sessions/${sessionId}/messages`, [200], undefined, bearer);
            const leaked = noLeak(clientMsgs);
            check('P11', 'client messages route does not carry plans', leaked.length === 0, `keys leaked: ${leaked.join(',') || 'none'}; ${JSON.stringify(clientMsgs).length} chars`);

            // ── planning OFF
            const offId = await createAgent('flow-noplan', { systemPrompt: 'ROLE=NOPLAN', humanInTheLoop: noApproval, toolBindings: [notesBinding] });
            const offSession = await newSession(offId, 'flow noplan');
            ids.noPlanAgent = offId; ids.noPlanSession = offSession;
            const off = await streamTurn(offId, offSession, 'Do it without a plan.');
            await sleep(150);
            const offSess = await getSession(offId, offSession);
            const offRows = await dashEvents(offId, offSession);
            dump('P planning off', off.frames, offRows);
            // A turn without a plan call leaves `plans` out altogether (an empty list would say "plans are recorded, and this turn wrote none").
            const offHasPlans = hasKeys(off.result ?? {}, ['plans']).length > 0 || assistantMessages(offSess).some((m) => hasKeys(m, ['plans']).length > 0);
            check('P12', 'planning OFF: no plan frames, the `plans` field is absent (not empty) from the result and the stored message, GET plan null, no agent.plan rows, no manage_plan offered',
                off.status === 200 && String(off.result?.content ?? '').startsWith('FINAL-NP')
                && !off.frames.some((f) => f.event === 'plan') && !offHasPlans
                && offSess.plan === null && !offRows.some((e) => e.type === 'agent.plan') && off.calls.every((x) => !x.offered.includes('manage_plan')),
                `plan frames ${off.frames.filter((f) => f.event === 'plan').length}; plans key present: ${offHasPlans}; GET plan ${JSON.stringify(offSess.plan)}; agent.plan rows ${offRows.filter((e) => e.type === 'agent.plan').length}; manage_plan offered: ${off.calls.some((x) => x.offered.includes('manage_plan'))}`);

            const p13Stored = storedSignature(orderTurnFlow(storedMsg1 as never));
            const p13Live = liveSignature(liveSegmentsOf(t1.frames));
            check('P13', 'UI parity: the stored message (orderTurnFlow) and the live frames (reducers) draw the same blocks: plan v1, the lookup, plan v2 (plan tool rows hidden)',
                p13Stored.join(' ') === p13Live.join(' ') && p13Stored.join(' ') === 'plan(v1) steps(lookup_note) plan(v2)',
                `stored: ${p13Stored.join(' ')}; live: ${p13Live.join(' ')}`);
            const stepIds = ((storedMsg1.steps ?? []) as Json[]).map((st) => `${st.name}:${st.id}`);
            const frameIds = new Set(frames.filter((f) => f.event === 'tool' && f.data.phase === 'start').map((f) => f.data.id));
            const issuedIds = t1.calls.flatMap((x) => x.toolCallIds);
            check('P14', "the stored steps are identified by the tool-call ids the frames and plans use, one each, in call order (orderTurnFlow anchors a plan/run/pass by `step.id === toolCallId`)",
                ((storedMsg1.steps ?? []) as Json[]).length === 3 && ((storedMsg1.steps ?? []) as Json[]).every((st) => frameIds.has(st.id))
                && ((storedMsg1.steps ?? []) as Json[]).map((st) => st.id).join() === issuedIds.join(),
                `stored step ids: ${stepIds.join(', ')}; tool-call ids on the wire: ${[...frameIds].join(', ')}; ids the model issued: ${issuedIds.join(', ')}`);
            // Plans are anchored to their manage_plan call; their wall clock must not matter. Swap the two clocks: a placement by time reverses them.
            const scrambledPlans = { ...storedMsg1, plans: (storedMsg1.plans ?? []).map((p: Json, i: number) => ({ ...p, at: i === 0 ? '2100-01-01T00:00:00.000Z' : '1970-01-01T00:00:00.000Z' })) };
            const p15 = storedSignature(orderTurnFlow(scrambledPlans as never));
            check('P15', "stored plan placement follows the plan's toolCallId, not its clock (plan times swapped: order unchanged)",
                p15.join(' ') === 'plan(v1) steps(lookup_note) plan(v2)', `with swapped plan times: ${p15.join(' ')}`);

            // ── turn 3, same session: the model only READS the plan, a plan call that writes no version
            const t3 = await streamTurn(agentId, sessionId, 'TURN-3 read the plan and answer.');
            log(`  turn 3 → HTTP ${t3.status}; frames: ${t3.frames.filter((f) => FLOW_EVENTS.has(f.event)).map(label).join(' ')}`);
            await sleep(150);
            const sess3 = await getSession(agentId, sessionId);
            const rows3 = await dashEvents(agentId, sessionId);
            dump('P turn 3', t3.frames);
            const msgs3 = assistantMessages(sess3);
            const storedMsg3 = msgs3.at(-1) ?? {};
            const afterUser3 = rows3.findIndex((e) => e.type === 'user.message' && String(e.data?.content).startsWith('TURN-3'));
            const turn3Rows = afterUser3 >= 0 ? rows3.slice(afterUser3) : [];
            const sp3 = sess3.plan as Json | null;
            const versionsOf = (m: Json | undefined) => ((m?.plans ?? []) as Json[]).map((p) => p.version).join();
            check('P16', "a read-only plan turn: no plan frame and no agent.plan row; the 'result' frame and the stored message carry `plans: []` (an empty list, not an absent field); earlier messages and GET plan unchanged",
                t3.status === 200 && String(t3.result?.content ?? '').startsWith('FINAL-P3') && t3.calls.length === 2
                && !t3.frames.some((f) => f.event === 'plan')
                && t3.frames.filter((f) => f.event === 'tool' && f.data.name === 'manage_plan').map((f) => f.data.phase).join() === 'start,success'
                && Array.isArray(t3.result?.plans) && t3.result?.plans.length === 0
                && msgs3.length === 3 && Array.isArray(storedMsg3.plans) && storedMsg3.plans.length === 0
                && versionsOf(msgs3[0]) === '1,2' && versionsOf(msgs3[1]) === '3'
                && turn3Rows.length > 0 && !turn3Rows.some((e) => e.type === 'agent.plan')
                && turn3Rows.filter((e) => e.type.startsWith('agent.tool_')).map(rowLabel).join(' ') === 'tool_use:manage_plan tool_result:manage_plan'
                && rows3.filter((e) => e.type === 'agent.plan').map((e) => e.data.version).join() === '1,2,3'
                && sp3?.version === 3 && stepsOf(sp3 ?? {}) === '1:completed,2:completed,3:in-progress',
                `HTTP ${t3.status}; answer="${short(t3.result?.content ?? t3.error, 60)}"; plan frames ${t3.frames.filter((f) => f.event === 'plan').length}; result.plans ${JSON.stringify(t3.result?.plans)}; stored plans per message ${msgs3.map((m) => (Array.isArray(m.plans) ? `[${versionsOf(m)}]` : 'absent')).join(' ')}; turn 3 log rows ${turn3Rows.filter((e) => e.type.startsWith('agent.')).map(rowLabel).join(' ')}; agent.plan rows v${rows3.filter((e) => e.type === 'agent.plan').map((e) => e.data.version).join(',v')}; GET plan ${sp3 ? `v${sp3.version} [${stepsOf(sp3)}]` : 'null'}`,
                [short(t3.result, 300), short(storedMsg3, 300)]);

            // What the playground draws for it: the live view hides plan-tool calls, and so must the stored view, but only when the message says plans are recorded.
            const p17Stored = storedSignature(orderTurnFlow(storedMsg3 as never));
            const p17Live = liveSignature(liveSegmentsOf(t3.frames));
            const beforePlans: Json = { ...storedMsg3 };
            delete beforePlans.plans;
            const p17Before = storedSignature(orderTurnFlow(beforePlans as never));
            check('P17', "UI parity for a read-only plan turn: stored (orderTurnFlow) and live (reducers) both draw nothing for the read call; the same message without the `plans` field (stored before plans were recorded) keeps it as a step",
                p17Stored.length === 0 && p17Live.length === 0 && p17Before.join(' ') === 'steps(manage_plan)',
                `stored: [${p17Stored.join(' ')}]; live: [${p17Live.join(' ')}]; without the field: [${p17Before.join(' ')}]`);

            const clientMsgs3 = await must('client messages', 'GET', `/api/client/v1/agents/sessions/${sessionId}/messages`, [200], undefined, bearer);
            const leaked3 = noLeak(clientMsgs3);
            const cl3 = await clientEvents(sessionId, 1000);
            const clPlanToolRows = cl3.events.filter((e) => e.type === 'agent.tool_use' && e.data?.name === 'manage_plan').length;
            check('P18', 'client wire after the read-only turn: the messages route carries no `plans` key (not even the empty one); the events log has all four manage_plan tool rows and no agent.plan row',
                leaked3.length === 0 && !cl3.events.some((e) => e.type === 'agent.plan') && clPlanToolRows === 4,
                `keys leaked: ${leaked3.join(',') || 'none'}; client manage_plan tool_use rows ${clPlanToolRows}; client agent.plan rows ${cl3.events.filter((e) => e.type === 'agent.plan').length}`);
        }

        // ═════════════ Scenario S: sub-agents ═════════════
        if (want('S')) {
            scenario = 'S';
            log('\n── Scenario S: delegate_to + spawn_subagents_parallel in one turn ──');
            const agentId = await createAgent('flow-subagents', {
                systemPrompt: 'ROLE=PARENT-S You coordinate sub-agents.',
                humanInTheLoop: noApproval,
                subagents: [researcher('RESEARCHER-BIG')],
                subagentPolicy,
            });
            const sessionId = await newSession(agentId, 'flow subagents');
            ids.subagentAgent = agentId; ids.subagentSession = sessionId;
            const t = await streamTurn(agentId, sessionId, 'Run the scenario.');
            log(`  chat/stream → HTTP ${t.status}; flow: ${t.frames.filter((f) => FLOW_EVENTS.has(f.event)).map(label).join(' ')}`);
            log(`    mock issued ${t.calls.length} calls: ${t.calls.map((x) => `#${x.k}:${x.role}${x.toolCalls.length ? `→${x.toolCalls[0]}` : ''}`).join(' ')}; answer="${short(t.result?.content ?? t.error, 80)}"`);
            await sleep(200);
            const sess = await getSession(agentId, sessionId);
            const rows = await dashEvents(agentId, sessionId);
            dump('S', t.frames, rows);
            const frames = t.frames;
            const delegateStart = frames.find((f) => f.event === 'tool' && !f.data.subagent && f.data.name === 'delegate_to' && f.data.phase === 'start');
            const spawnStart = frames.find((f) => f.event === 'tool' && !f.data.subagent && f.data.name === 'spawn_subagents_parallel' && f.data.phase === 'start');
            const subFrames = frames.filter((f) => f.event === 'subagent');
            const runOf = (name: string) => subFrames.filter((f) => f.data.name === name);
            const wantParent: Record<string, string | undefined> = { researcher: delegateStart?.data.id, 'child-A': spawnStart?.data.id, 'child-B': spawnStart?.data.id };

            check('S0', 'turn ran: HTTP 200, final answer, 7 model calls (parent 3, researcher 2, children 2)', t.status === 200 && String(t.result?.content ?? '').startsWith('FINAL-S') && !t.error,
                `HTTP ${t.status}; answer="${short(t.result?.content ?? t.error, 80)}"; ${t.calls.length} model calls [${t.calls.map((x) => x.role).join(',')}]`);

            const phasesOf = (name: string) => runOf(name).map((f) => f.data.phase).join();
            const idsOf = (name: string) => [...new Set(runOf(name).map((f) => f.data.id))];
            const startsAreEarly = ['researcher', 'child-A', 'child-B'].every((n) => {
                const start = runOf(n).find((f) => f.data.phase === 'start');
                const result = runOf(n).find((f) => f.data.phase === 'result');
                return start && result && start.i < result.i;
            });
            const subOk = ['researcher', 'child-A', 'child-B'].every((n) => phasesOf(n) === 'start,result' && idsOf(n).length === 1
                && runOf(n).every((f) => f.data.parentToolCallId === wantParent[n] && isIso(f.data.at)));
            const parallelOk = ['child-A', 'child-B'].every((n) => runOf(n).every((f) => f.data.parallel === true))
                && runOf('researcher').every((f) => !f.data.parallel);
            check('S1', "SSE subagent frames: start then result for each child, parentToolCallId = its delegation tool frame id, parallel:true for the two",
                subOk && startsAreEarly && parallelOk && Boolean(delegateStart) && Boolean(spawnStart) && delegateStart!.data.id !== spawnStart!.data.id,
                `delegate_to id ${delegateStart?.data.id}, spawn id ${spawnStart?.data.id}; ${['researcher', 'child-A', 'child-B'].map((n) => `${n}: [${phasesOf(n)}] parent=${runOf(n)[0]?.data.parentToolCallId} parallel=${runOf(n)[0]?.data.parallel} mode=${runOf(n)[0]?.data.mode}`).join('; ')}`,
                subFrames.map((f) => short(f.data, 300)));

            const childTools = frames.filter((f) => f.event === 'tool' && f.data.subagent);
            const researcherRunId = idsOf('researcher')[0];
            const stampOk = childTools.length === 2
                && childTools.every((f) => f.data.name === 'lookup_note' && f.data.subagent.id === researcherRunId && f.data.subagent.name === 'researcher'
                    && f.data.subagent.parentToolCallId === delegateStart?.data.id && !f.data.subagent.parallel);
            const parentUnstamped = parentTools(frames).every((f) => !hasKeys(f.data.subagent ?? {}, ['id']).length);
            check('S2', "child 'tool' frames carry subagent {id, name, parentToolCallId, parallel}; the parent's own calls carry none",
                stampOk && parentUnstamped && parentTools(frames).map((f) => `${f.data.phase}:${f.data.name}`).join() === 'start:delegate_to,success:delegate_to,start:spawn_subagents_parallel,success:spawn_subagents_parallel',
                `child tool frames ${childTools.map((f) => `${f.data.phase}:${f.data.name} stamp=${JSON.stringify(f.data.subagent)}`).join(' | ') || 'none'}; parent tool frames: ${parentTools(frames).map((f) => `${f.data.phase}:${f.data.name}`).join(',')}`);

            const resultRuns = (t.result?.subagentRuns ?? []) as Json[];
            const storedMsg = assistantMessages(sess).at(-1) ?? {};
            const storedRuns = (storedMsg.subagentRuns ?? []) as Json[];
            const byName = (rs: Json[], n: string) => rs.find((r) => r.name === n) ?? {};
            const resR = byName(resultRuns, 'researcher');
            const stepOf = resR.steps?.[0] ?? {};
            const stepValuesOk = (steps: Json[]) => steps.every((s) => (jsonLen(s.args) <= 1024 || s._truncated === true) && (jsonLen(s.output) <= 1024 || s._truncated === true)
                && (s._truncated !== true || (typeof s.output !== 'string' || s.output.length <= 1100)));
            const runsOk = resultRuns.length === 3
                && ['researcher', 'child-A', 'child-B'].every((n) => {
                    const r = byName(resultRuns, n);
                    // The parent id is exactly the delegation call's id: the SDK keys a parallel child `<call>#<i>`, Console cuts the suffix.
                    return r.id === idsOf(n)[0] && r.phase === 'result' && r.parentToolCallId === wantParent[n] && typeof r.input === 'string' && r.input.length > 0
                        && typeof r.result === 'string' && r.result.length > 0 && typeof r.durationMs === 'number' && isIso(r.startedAt) && isIso(r.endedAt) && Array.isArray(r.steps);
                })
                && byName(resultRuns, 'child-A').parallel === true && byName(resultRuns, 'child-B').parallel === true && !byName(resultRuns, 'researcher').parallel
                && /TASK-A/.test(byName(resultRuns, 'child-A').input) && /child-A done/.test(byName(resultRuns, 'child-A').result) && /child-B done/.test(byName(resultRuns, 'child-B').result)
                && /^researcher-big done|read the big note/.test(resR.result ?? '');
            const stepsOk = (resR.steps ?? []).length === 1 && stepOf.name === 'lookup_note' && stepOf.status === 'success' && stepOf.args?.topic === 'big-9'
                && stepOf.output !== undefined && stepOf._truncated === true && typeof stepOf.output === 'string' && stepValuesOk(resR.steps)
                && byName(resultRuns, 'child-A').steps.length === 0 && byName(resultRuns, 'child-B').steps.length === 0;
            check('S3', "message.subagentRuns: 3 runs (ids, phase result, parent ids, input/result, timing); the researcher's step has name/status/args/output (big output cut to a preview + _truncated); stored message identical",
                runsOk && stepsOk && sameList(resultRuns, storedRuns),
                `${resultRuns.length} run(s) in result, ${storedRuns.length} stored (identical: ${sameList(resultRuns, storedRuns)}); ${resultRuns.map((r) => `${r.name}[${r.phase}${r.parallel ? ',parallel' : ''},${(r.steps ?? []).length} step(s),${r.durationMs}ms]`).join(' ')}; researcher step: ${short({ name: stepOf.name, status: stepOf.status, args: stepOf.args, outputLen: jsonLen(stepOf.output), _truncated: stepOf._truncated, durationMs: stepOf.durationMs }, 240)}`,
                resultRuns.map((r) => short(r, 400)));

            const subRows = rows.filter((e) => e.type === 'agent.subagent');
            const childRows = rows.filter((e) => (e.type === 'agent.tool_use' || e.type === 'agent.tool_result') && e.data?.subagentId);
            const parentRows = rows.filter((e) => (e.type === 'agent.tool_use' || e.type === 'agent.tool_result') && !e.data?.subagentId);
            const rowOrderOk = (() => {
                const at = (pred: (e: Json) => boolean) => rows.findIndex(pred);
                const dUse = at((e) => e.type === 'agent.tool_use' && e.data.name === 'delegate_to');
                const rStart = at((e) => e.type === 'agent.subagent' && e.data.name === 'researcher' && e.data.phase === 'start');
                const cUse = at((e) => e.type === 'agent.tool_use' && e.data.subagentId);
                const rResult = at((e) => e.type === 'agent.subagent' && e.data.name === 'researcher' && e.data.phase === 'result');
                const dRes = at((e) => e.type === 'agent.tool_result' && e.data.name === 'delegate_to');
                return dUse < rStart && rStart < cUse && cUse < rResult && rResult <= dRes;
            })();
            check('S4', 'dashboard log: agent.subagent start+result rows for all 3 runs, each with its delegation call as parent (no `#<i>` suffix on the parallel children); child tool rows carry subagentId/parentToolCallId/parallel (+ name); parent rows carry none; rows in order',
                subRows.length === 6 && ['researcher', 'child-A', 'child-B'].every((n) => subRows.filter((e) => e.data.name === n).map((e) => e.data.phase).join() === 'start,result')
                && subRows.every((e) => e.data.parentToolCallId === wantParent[e.data.name])
                && childRows.length === 2 && childRows.every((e) => e.data.subagentId === researcherRunId && e.data.parentToolCallId === delegateStart?.data.id && e.data.subagent === 'researcher' && e.data.parallel !== true)
                && parentRows.length === 4 && parentRows.every((e) => !hasKeys(e.data, ['subagentId', 'parentToolCallId', 'parallel']).length) && rowOrderOk,
                `agent.subagent rows: ${subRows.map((e) => `${e.data.phase}:${e.data.name}<-${e.data.parentToolCallId}`).join(' ')}; child tool rows: ${childRows.map((e) => `${e.type}:${short({ subagentId: e.data.subagentId, parentToolCallId: e.data.parentToolCallId, parallel: e.data.parallel, subagent: e.data.subagent }, 160)}`).join(' | ')}; order ok: ${rowOrderOk}`,
                rows.filter((e) => e.type.startsWith('agent.') && e.type !== 'agent.message').map((e) => `${e.seq} ${rowLabel(e)} ${short(e.data, 200)}`));

            const cl = await clientEvents(sessionId, 1000);
            const clChild = cl.events.filter((e) => (e.type === 'agent.tool_use' || e.type === 'agent.tool_result') && e.data?.name === 'lookup_note');
            const forbidden = ['subagentId', 'parentToolCallId', 'parallel'].flatMap(CAMEL_SNAKE);
            const clPaged = await clientEvents(sessionId, 2);
            check('S5', 'client wire: no agent.subagent rows; child tool rows present without subagent id / parent id / parallel; paging (limit 2) equal',
                !cl.events.some((e) => e.type === 'agent.subagent') && clChild.length === 2 && clChild.every((e) => hasKeys(e.data, forbidden).length === 0)
                && cl.events.length === rows.length - subRows.length && seqs(clPaged.events) === seqs(cl.events) && clPaged.monotonic,
                `client rows ${cl.events.length} of ${rows.length} (${subRows.length} agent.subagent hidden); child tool rows keys: ${clChild.map((e) => Object.keys(e.data).join('/')).join(' | ')}; limit=2 walk ${clPaged.pages} pages, same rows ${seqs(clPaged.events) === seqs(cl.events)}`,
                clChild.map((e) => short(e, 300)));
            const clientMsgs = await must('client messages', 'GET', `/api/client/v1/agents/sessions/${sessionId}/messages`, [200], undefined, bearer);
            const leaked = noLeak(clientMsgs);
            check('S6', 'client messages route does not carry subagentRuns', leaked.length === 0, `keys leaked: ${leaked.join(',') || 'none'}`);

            const storedFlow = orderTurnFlow(storedMsg as never);
            const storedSig = storedSignature(storedFlow);
            const liveSig = liveSignature(liveSegmentsOf(t.frames));
            const wantSig = 'subagents(seq:researcher[1]) subagents(par:child-A[0],child-B[0])';
            const spawnBlock = storedFlow.find((b: any) => b.kind === 'subagents' && b.step?.name === 'spawn_subagents_parallel') as any;
            check('S7', "stored flow (orderTurnFlow): each delegation call's block holds its runs — delegate_to → researcher, spawn_subagents_parallel → child-A + child-B (no orphan run blocks)",
                storedSig.join(' ') === wantSig && spawnBlock?.runs?.length === 2,
                `stored blocks: ${storedSig.join(' ')}; spawn block runs: ${spawnBlock?.runs?.map((r: Json) => `${r.name}(parent ${r.parentToolCallId})`).join(', ') ?? 'none'} (spawn step id ${spawnStart?.data.id})`,
                [`expected: ${wantSig}`, ...storedFlow.map((b: any) => `${b.kind} parent=${b.parentToolCallId ?? '-'} step=${b.step?.id ?? '-'} runs=${(b.runs ?? []).map((r: Json) => `${r.name}<-${r.parentToolCallId}`).join(',')}`)]);
            check('S8', 'live flow (reducers over the SSE frames) draws the same groups as the stored flow',
                liveSig.join(' ') === wantSig && liveSig.join(' ') === storedSig.join(' '),
                `live: ${liveSig.join(' ')}; stored: ${storedSig.join(' ')}`);
            // The stored steps are named by the wire's tool-call ids (see P14), so a delegation step is the very id its runs hang on.
            const storedSteps = (storedMsg.steps ?? []) as Json[];
            const stepIdOf = (name: string) => storedSteps.find((st) => st.name === name)?.id;
            const stepIdFor = (r: Json) => stepIdOf(r.parallel ? 'spawn_subagents_parallel' : 'delegate_to');
            const suffixed = [
                ...storedRuns.map((r) => r.parentToolCallId), ...subFrames.map((f) => f.data.parentToolCallId),
                ...subRows.map((e) => e.data.parentToolCallId), ...childTools.map((f) => f.data.subagent?.parentToolCallId),
            ].filter((id) => typeof id === 'string' && id.includes('#'));
            check('S9', "delegation steps are stored under their calls' wire ids; every stored run's parentToolCallId is exactly its delegation step's id (a parallel child's `<call>#<i>` is cut to the call); no `#<i>` id on the wire or in the log",
                stepIdOf('delegate_to') === delegateStart?.data.id && stepIdOf('spawn_subagents_parallel') === spawnStart?.data.id
                && storedRuns.length === 3 && storedRuns.every((r) => r.parentToolCallId === stepIdFor(r)) && suffixed.length === 0,
                `delegation step ids: delegate_to ${stepIdOf('delegate_to')}, spawn_subagents_parallel ${stepIdOf('spawn_subagents_parallel')} (wire ids ${delegateStart?.data.id}, ${spawnStart?.data.id}); run parents ${storedRuns.map((r) => `${r.name}<-${r.parentToolCallId}`).join(', ')}; ids still carrying a suffix: ${suffixed.join(', ') || 'none'}`,
                storedSteps.map((st) => `step ${st.name} id=${st.id}`));
        }

        // ═════════════ Scenario B: approval inside a child ═════════════
        if (want('B')) {
            scenario = 'B';
            log('\n── Scenario B: plan, then the child pauses for tool approval, is approved, resumes ──');
            const agentId = await createAgent('flow-approval', {
                systemPrompt: 'ROLE=PARENT-B You coordinate sub-agents.',
                humanInTheLoop: { toolApproval: { enabled: true, defaultPolicy: 'never', tools: { lookup_note: 'always' } }, askUser: { enabled: false } },
                subagents: [researcher()],
                subagentPolicy,
                runtime: { planning: { mode: 'todo' } },
            });
            const sessionId = await newSession(agentId, 'flow approval');
            ids.approvalAgent = agentId; ids.approvalSession = sessionId;
            const leg1 = await streamTurn(agentId, sessionId, 'Run the scenario.');
            await sleep(200);
            const pending = ((await must('actions', 'GET', `/api/agents/${agentId}/sessions/${sessionId}/actions?status=pending`, [200])).actions ?? []) as Json[];
            const approval = pending.find((a) => a.kind === 'tool_approval');
            log(`  leg 1 → HTTP ${leg1.status}; flow: ${leg1.frames.filter((f) => FLOW_EVENTS.has(f.event)).map(label).join(' ')}; pending: ${JSON.stringify(pending.map((a) => `${a.kind}:${a.toolName}${a.subagent ? `@${a.subagent}` : ''}`))}`);
            const sess1 = await getSession(agentId, sessionId);
            const rows1 = await dashEvents(agentId, sessionId);
            dump('B leg 1', leg1.frames, rows1);
            const leg1Runs = (leg1.result?.subagentRuns ?? []) as Json[];
            const stored1 = (assistantMessages(sess1).at(-1)?.subagentRuns ?? []) as Json[];
            const delegateStart1 = leg1.frames.find((f) => f.event === 'tool' && !f.data.subagent && f.data.name === 'delegate_to' && f.data.phase === 'start');
            check('B1', "first leg: the message has the researcher run with phase 'paused' (parent id, no result yet) and the plan v1",
                Boolean(approval) && leg1Runs.length === 1 && leg1Runs[0].name === 'researcher' && leg1Runs[0].phase === 'paused' && leg1Runs[0].parentToolCallId === delegateStart1?.data.id && !leg1Runs[0].resumed
                && (leg1.result?.plans ?? []).map((p: Json) => p.version).join() === '1' && sameList(leg1Runs, stored1),
                `result.subagentRuns ${leg1Runs.map((r) => `${r.name}[${r.phase}${r.resumed ? ',resumed' : ''},steps ${(r.steps ?? []).length}]`).join(' ') || 'none'}; stored identical ${sameList(leg1Runs, stored1)}; plans [${(leg1.result?.plans ?? []).map((p: Json) => `v${p.version}`)}]; stopReason ${leg1.result?.stopReason}`,
                leg1Runs.map((r) => short(r, 400)));
            const leg1Subs = leg1.frames.filter((f) => f.event === 'subagent').map((f) => f.data.phase).join();
            check('B2', 'first leg SSE: plan v1 frame, subagent start then paused frames',
                leg1.frames.filter((f) => f.event === 'plan').map((f) => f.data.version).join() === '1' && /^start,paused$/.test(leg1Subs),
                `subagent phases [${leg1Subs}]; plan frames [${leg1.frames.filter((f) => f.event === 'plan').map((f) => `v${f.data.version}`)}]`);

            if (approval) {
                const leg2 = await resolveStream(agentId, sessionId, String(approval.id));
                await sleep(250);
                log(`  leg 2 (POST …/actions/:id/resolve?stream=1) → HTTP ${leg2.status}; flow: ${leg2.frames.filter((f) => FLOW_EVENTS.has(f.event)).map(label).join(' ')}; answer="${short(leg2.result?.content ?? leg2.error, 80)}"`);
                const sess2 = await getSession(agentId, sessionId);
                const rows2 = await dashEvents(agentId, sessionId);
                dump('B leg 2', leg2.frames, rows2);
                const leg2Runs = (leg2.result?.subagentRuns ?? []) as Json[];
                const msgs = assistantMessages(sess2);
                const storedLast = (msgs.at(-1)?.subagentRuns ?? []) as Json[];
                const r2 = leg2Runs.find((r) => r.name === 'researcher') ?? {};
                const subs2 = leg2.frames.filter((f) => f.event === 'subagent');
                const tools2 = leg2.frames.filter((f) => f.event === 'tool' && f.data.subagent);
                check('B3', 'resolve ?stream=1: SSE subagent + stamped child tool frames for the resumed leg, plan v2 frame, final answer',
                    leg2.status === 200 && String(leg2.result?.content ?? '').startsWith('FINAL-B') && subs2.some((f) => f.data.name === 'researcher' && f.data.phase === 'result')
                    && tools2.some((f) => f.data.name === 'lookup_note' && f.data.phase === 'success' && f.data.subagent.name === 'researcher' && f.data.subagent.parentToolCallId === delegateStart1?.data.id)
                    && leg2.frames.filter((f) => f.event === 'plan').map((f) => f.data.version).join() === '2',
                    `HTTP ${leg2.status}; subagent frames [${subs2.map((f) => `${f.data.phase}${f.data.resumed ? '(resumed)' : ''}:${f.data.name}`)}]; child tool frames [${tools2.map((f) => `${f.data.phase}:${f.data.name}`)}]; plan frames [${leg2.frames.filter((f) => f.event === 'plan').map((f) => `v${f.data.version}`)}]`,
                    leg2.frames.filter((f) => FLOW_EVENTS.has(f.event)).map((f) => `${f.i} ${label(f)} ${short(f.data, 200)}`));
                check('B4', "resumed message: the researcher run has resumed:true and phase 'result' (parent id kept, steps incl. the approved lookup); stored message identical",
                    leg2Runs.length >= 1 && r2.resumed === true && r2.phase === 'result' && r2.parentToolCallId === delegateStart1?.data.id && typeof r2.result === 'string'
                    && (r2.steps ?? []).some((s: Json) => s.name === 'lookup_note' && s.status === 'success') && sameList(leg2Runs, storedLast),
                    `result.subagentRuns ${leg2Runs.map((r) => `${r.name}[${r.phase}${r.resumed ? ',resumed' : ''},steps ${(r.steps ?? []).map((s: Json) => `${s.name}:${s.status}`)}]`).join(' ') || 'none'}; stored identical ${sameList(leg2Runs, storedLast)}; assistant messages in session ${msgs.length}; plans on messages ${msgs.map((m) => `[${(m.plans ?? []).map((p: Json) => `v${p.version}`)}]`).join(' ')}`,
                    leg2Runs.map((r) => short(r, 500)));
                const planRows = rows2.filter((e) => e.type === 'agent.plan');
                const dupKey = (e: Json) => `${e.type}:${e.data?.toolCallId}${e.data?.subagentId ? `@${e.data.subagentId}` : ''}`;
                const toolRows = rows2.filter((e) => e.type === 'agent.tool_use' || e.type === 'agent.tool_result');
                const seen = new Map<string, number>();
                for (const e of toolRows) seen.set(dupKey(e), (seen.get(dupKey(e)) ?? 0) + 1);
                const dups = [...seen.entries()].filter(([, n]) => n > 1);
                const wantTools = ['tool_use:manage_plan', 'tool_result:manage_plan', 'tool_use:delegate_to', 'tool_use:lookup_note', 'tool_result:lookup_note', 'tool_result:delegate_to', 'tool_use:manage_plan', 'tool_result:manage_plan'];
                const gotTools = rows2.filter((e) => e.type.startsWith('agent.tool_')).map(rowLabel).map((l) => l.replace(/@.*/, ''));
                check('B5', 'dashboard log across both legs: agent.plan rows exactly v1, v2; no duplicated tool rows (same type + toolCallId)',
                    planRows.map((e) => e.data.version).join() === '1,2' && dups.length === 0,
                    `agent.plan rows ${planRows.map((e) => `seq ${e.seq} v${e.data.version}`).join(', ')}; tool rows: ${gotTools.join(' ')}; duplicated: ${dups.map(([k, n]) => `${k}×${n}`).join(', ') || 'none'}; expected tool rows ${wantTools.join(' ')}`,
                    rows2.filter((e) => e.type.startsWith('agent.') && e.type !== 'agent.message').map((e) => `${e.seq} ${rowLabel(e)} ${short(e.data, 200)}`));
                const subRows = rows2.filter((e) => e.type === 'agent.subagent');
                check('B6', 'dashboard log: agent.subagent rows for the researcher show start, paused, then the resumed leg to result (no row repeated)',
                    subRows.map((e) => e.data.phase).join().startsWith('start,paused') && subRows.at(-1)?.data.phase === 'result' && subRows.filter((e) => e.data.phase === 'result').length === 1
                    && subRows.filter((e) => e.data.phase === 'paused').length === 1,
                    `agent.subagent rows: ${subRows.map((e) => `${e.seq} ${e.data.phase}${e.data.resumed ? '(resumed)' : ''}`).join(', ')}`);
                const cl = await clientEvents(sessionId, 1000);
                check('B7', 'client wire across legs: no agent.plan / agent.subagent rows',
                    !cl.events.some((e) => e.type === 'agent.plan' || e.type === 'agent.subagent'), `client rows ${cl.events.length} of ${rows2.length}`);
            }
        }

        // ═════════════ Scenario C: summarization in the flow ═════════════
        if (want('C')) {
            scenario = 'C';
            log('\n── Scenario C: summarization at least twice in one turn ──');
            const summarization = { enable: true, summaryTriggerTokens: 1000, maxTokens: 1000 };
            const agentId = await createAgent('flow-summary', {
                systemPrompt: 'ROLE=PARENT-C You read notes.',
                humanInTheLoop: noApproval,
                toolBindings: [notesBinding],
                runtime: { summarization },
            });
            const sessionId = await newSession(agentId, 'flow summary');
            ids.summaryAgent = agentId; ids.summarySession = sessionId;
            const t = await streamTurn(agentId, sessionId, 'Read the three big notes.');
            log(`  chat/stream → HTTP ${t.status}; flow: ${t.frames.filter((f) => FLOW_EVENTS.has(f.event)).map(label).join(' ')}`);
            log(`    mock issued ${t.calls.length} calls: ${t.calls.map((x) => `#${x.k}:${x.role}${x.toolCalls.length ? `→${x.toolCalls[0]}` : ''}`).join(' ')}`);
            await sleep(200);
            const sess = await getSession(agentId, sessionId);
            const rows = await dashEvents(agentId, sessionId);
            dump('C', t.frames, rows);
            const frames = t.frames;
            const done = frames.filter((f) => f.event === 'summary' && !f.data.subagent && (f.data.phase === undefined || f.data.phase === 'done'));
            const starts = frames.filter((f) => f.event === 'summary' && f.data.phase === 'start');
            const lastFinishedBefore = (f: Frame) => [...frames.slice(0, f.i)].reverse().find((x) => x.event === 'tool' && !x.data.subagent && (x.data.phase === 'success' || x.data.phase === 'error'))?.data.id ?? null;
            const lookupCalls = t.calls.filter((x) => x.toolCalls.includes('lookup_note'));
            check('C0', 'turn ran: three lookups, two summarizer calls answered by the mock, final answer',
                t.status === 200 && String(t.result?.content ?? '').startsWith('FINAL-C') && lookupCalls.length === 3 && t.calls.filter((x) => x.role === 'SUMMARIZER').length === 2,
                `HTTP ${t.status}; lookups ${lookupCalls.length}; summarizer calls ${t.calls.filter((x) => x.role === 'SUMMARIZER').length}; answer="${short(t.result?.content ?? t.error, 60)}"`);
            check('C1', "SSE summary frames of completed passes: index 1, 2; afterToolCallId = the last finished parent tool call before each (and the pass's id)",
                done.length === 2 && done.map((f) => f.data.index).join() === '1,2' && done.every((f) => f.data.afterToolCallId === lastFinishedBefore(f) && typeof f.data.id === 'string' && f.data.id)
                && done[0].data.afterToolCallId === lookupCalls[1]?.toolCallIds[0] && done[1].data.afterToolCallId === lookupCalls[2]?.toolCallIds[0]
                && new Set(done.map((f) => f.data.id)).size === 2,
                `${done.length} completed pass frame(s): ${done.map((f) => `#${f.data.index} id=${f.data.id} after=${f.data.afterToolCallId} (last finished tool frame: ${lastFinishedBefore(f)}) trigger=${f.data.trigger}`).join(' | ')}; lookup ids ${lookupCalls.map((x) => x.toolCallIds[0])}`,
                done.map((f) => short(f.data, 300)));

            const toolFlow = frames.filter((f) => f.event === 'tool' || f.event === 'summary').map(label);
            const T = (n: number, ph: string) => `tool.${ph}:lookup_note`;
            const wantFlow = SDK_NEW
                ? [T(1, 'start'), T(1, 'success'), T(2, 'start'), T(2, 'success'), 'summary.start', 'summary.done#1', T(3, 'start'), T(3, 'success'), 'summary.start', 'summary.done#2']
                : [T(1, 'start'), T(1, 'success'), T(2, 'start'), T(2, 'success'), 'summary.done#1', T(3, 'start'), T(3, 'success'), 'summary.done#2'];
            const normalized = toolFlow.map((l) => l.replace(/^summary\.start#?\d*$/, 'summary.start'));
            check('C2', 'arrival order: each pass arrives between the right tool frames (after lookup 2, after lookup 3)', normalized.join(' ') === wantFlow.join(' '),
                `flow: ${toolFlow.join(' ')}`, [`expected: ${wantFlow.join(' ')}`]);

            const resultComp = (t.result?.compactions ?? []) as Json[];
            const storedComp = (assistantMessages(sess).at(-1)?.compactions ?? []) as Json[];
            const posOf = (cs: Json[]) => cs.map((c) => `${c.id}#${c.index}@${c.afterToolCallId}`).join(' ');
            check('C3', 'message.compactions (result + stored) carry the same ids / index / afterToolCallId as the frames, in order',
                resultComp.length === 2 && posOf(resultComp) === done.map((f) => `${f.data.id}#${f.data.index}@${f.data.afterToolCallId}`).join(' ') && sameList(resultComp, storedComp)
                && resultComp.every((c) => typeof c.tokensBefore === 'number' && c.tokensBefore > c.tokensAfter),
                `result.compactions ${posOf(resultComp) || 'none'}; stored identical ${sameList(resultComp, storedComp)}; frames ${done.map((f) => `${f.data.id}#${f.data.index}@${f.data.afterToolCallId}`).join(' ')}`,
                resultComp.map((c) => short(c, 300)));

            // A pass leaves the newest round of calls alone, so the truth is: pass 1 replaced lookup 1, pass 2 replaced lookup 2 (lookup 3 is never replaced).
            // Both paths must say exactly that, pass by pass: the SDK >= 0.20 reports it itself, Console works it out for the older SDK.
            const compactedIds = (cs: Json[]) => cs.map((c) => (c.compactedTools ?? []).map((x: Json) => x.toolCallId).join('+') || '-').join(' / ');
            const wantPerPass = `${lookupCalls[0]?.toolCallIds[0]} / ${lookupCalls[1]?.toolCallIds[0]}`;
            const compactedNames = resultComp.flatMap((c) => (c.compactedTools ?? []).map((x: Json) => x.toolName));
            const perPassOk = compactedIds(resultComp) === wantPerPass && compactedNames.length === 2 && compactedNames.every((n) => n === 'lookup_note');
            if (SDK_NEW) {
                check('C4', 'SDK >= 0.20: summary start frames (same id as the pass, before it), per-pass compactedTools (pass 1 → lookup 1, pass 2 → lookup 2), trigger set',
                    starts.length === 2 && starts.every((s, i) => s.data.id === done[i]?.data.id && s.i < done[i].i && !('afterToolCallId' in s.data && s.data.afterToolCallId === undefined))
                    && perPassOk
                    && resultComp.every((c) => ['pre_leg', 'mid_leg', 'post_tools'].includes(c.trigger)) && done.every((f) => ['pre_leg', 'mid_leg', 'post_tools'].includes(f.data.trigger)),
                    `start frames ${starts.map((s) => `${s.data.id}@${s.i}`)}; done ${done.map((f) => `${f.data.id}@${f.i}`)}; compactedTools ${compactedIds(resultComp)} (wanted ${wantPerPass}); triggers ${resultComp.map((c) => c.trigger)}`,
                    [...starts, ...done].map((f) => short(f.data, 300)));
            } else {
                check('C4', 'legacy SDK: no start frames; Console attributes each replaced tool result to the pass that made it (pass 1 → lookup 1, pass 2 → lookup 2, none twice); trigger absent',
                    starts.length === 0 && perPassOk && resultComp.every((c) => c.trigger === undefined),
                    `start frames ${starts.length}; compactedTools per pass [${compactedIds(resultComp)}] (wanted [${wantPerPass}]); triggers ${resultComp.map((c) => c.trigger)}`,
                    resultComp.map((c) => short(c.compactedTools, 300)));
            }

            const compRows = rows.filter((e) => e.type === 'agent.compaction');
            const at = (pred: (e: Json) => boolean) => rows.findIndex(pred);
            const orderOk = compRows.length === 2
                && at((e) => e.type === 'agent.tool_result' && e.data.toolCallId === lookupCalls[1]?.toolCallIds[0]) < rows.indexOf(compRows[0])
                && rows.indexOf(compRows[0]) < at((e) => e.type === 'agent.tool_use' && e.data.toolCallId === lookupCalls[2]?.toolCallIds[0])
                && at((e) => e.type === 'agent.tool_result' && e.data.toolCallId === lookupCalls[2]?.toolCallIds[0]) < rows.indexOf(compRows[1]);
            check('C5', 'dashboard log: two agent.compaction rows carrying id / index / afterToolCallId, between the right tool rows; start frames never logged',
                orderOk && compRows.map((e) => `${e.data.id}#${e.data.index}@${e.data.afterToolCallId}`).join(' ') === posOf(resultComp) && compRows.every((e) => !e.data.subagent && e.data.phase === undefined),
                `rows ${rows.filter((e) => e.type.startsWith('agent.') && e.type !== 'agent.message').map(rowLabel).join(' ')}; positions ${compRows.map((e) => `${e.data.id}#${e.data.index}@${e.data.afterToolCallId}`).join(' ')}`,
                compRows.map((e) => short(e.data, 300)));

            const cl = await clientEvents(sessionId, 1000);
            const clComp = cl.events.filter((e) => e.type === 'agent.compaction');
            const forbidden = ['id', 'index', 'afterToolCallId', 'trigger', 'compactedTools', 'phase', 'subagent'].flatMap(CAMEL_SNAKE);
            check('C6', 'client wire: compaction rows still there, without id / index / afterToolCallId / trigger / compactedTools',
                clComp.length === 2 && clComp.every((e) => hasKeys(e.data, forbidden).length === 0) && cl.events.length === rows.length,
                `client compaction rows ${clComp.length}; keys ${clComp.map((e) => Object.keys(e.data).join('/')).join(' | ')}; forbidden present: ${clComp.flatMap((e) => hasKeys(e.data, forbidden)).join(',') || 'none'}`,
                clComp.map((e) => short(e.data, 300)));
            const clientMsgs = await must('client messages', 'GET', `/api/client/v1/agents/sessions/${sessionId}/messages`, [200], undefined, bearer);
            const leaked = noLeak(clientMsgs);
            check('C7', 'client messages route does not carry positioned compactions', leaked.length === 0, `keys leaked: ${leaked.join(',') || 'none'}`);
            // The pass ids are the SDK's (`call_summary_<ts>`) or Console's own (`pass-<n>`): whatever the frames carried.
            const wantC = `steps(lookup_note,lookup_note) compaction(${done[0]?.data.id}) steps(lookup_note) compaction(${done[1]?.data.id})`;
            const cStored = storedSignature(orderTurnFlow((assistantMessages(sess).at(-1) ?? {}) as never));
            const cLive = liveSignature(liveSegmentsOf(t.frames)).map((x) => x.replace(/compaction\(.*\)/, (m) => m));
            check('C10', 'UI parity: stored (orderTurnFlow) and live (reducers) draw the passes at the same places — after lookup 2 and after lookup 3',
                cStored.join(' ') === wantC && cLive.join(' ') === wantC,
                `stored: ${cStored.join(' ')}; live: ${cLive.join(' ')}`);
            const scrambledMsg = { ...(assistantMessages(sess).at(-1) ?? {}), compactions: resultComp.map((cp, i) => ({ ...cp, at: i === 0 ? '2100-01-01T00:00:00.000Z' : '1970-01-01T00:00:00.000Z' })) };
            const cScrambled = storedSignature(orderTurnFlow(scrambledMsg as never));
            check('C11', "stored pass placement follows afterToolCallId, not the pass's clock (pass times swapped: order unchanged)",
                cScrambled.join(' ') === wantC, `with swapped pass times: ${cScrambled.join(' ')}`,
                [`stored step ids: ${((assistantMessages(sess).at(-1)?.steps ?? []) as Json[]).map((st) => st.id).join(', ')}; afterToolCallId ${resultComp.map((cp) => cp.afterToolCallId).join(', ')}`]);

            // ── a child that summarizes inside its own run
            log('\n── Scenario C2: a sub-agent that summarizes inside its own run ──');
            const agentCs = await createAgent('flow-child-summary', {
                systemPrompt: 'ROLE=PARENT-CS You delegate reading.',
                humanInTheLoop: noApproval,
                // A sub-agent's context budget is its own `limits`: the SDK derives its summarization trigger from it.
                subagents: [researcher('READER', 'reader', { limits: { maxContextTokens: 1000 } })],
                subagentPolicy,
                runtime: { summarization },
            });
            const sessionCs = await newSession(agentCs, 'flow child summary');
            ids.childSummaryAgent = agentCs; ids.childSummarySession = sessionCs;
            const cs = await streamTurn(agentCs, sessionCs, 'Delegate the reading.');
            log(`  chat/stream → HTTP ${cs.status}; flow: ${cs.frames.filter((f) => FLOW_EVENTS.has(f.event)).map(label).join(' ')}`);
            log(`    mock issued ${cs.calls.length} calls: ${cs.calls.map((x) => `#${x.k}:${x.role}${x.toolCalls.length ? `→${x.toolCalls[0]}` : ''}`).join(' ')}`);
            await sleep(200);
            const sessCs = await getSession(agentCs, sessionCs);
            const rowsCs = await dashEvents(agentCs, sessionCs);
            dump('C2', cs.frames, rowsCs);
            const childPasses = cs.frames.filter((f) => f.event === 'summary' && f.data.subagent && (f.data.phase === undefined || f.data.phase === 'done'));
            const parentPasses = cs.frames.filter((f) => f.event === 'summary' && !f.data.subagent);
            if (childPasses.length === 0) {
                check('C8', 'a sub-agent summarizes inside its own run', false,
                    `NOT COVERED: the child produced no summarization pass in this setup (summarizer calls: ${cs.calls.filter((x) => x.role === 'SUMMARIZER').length}); model calls ${cs.calls.map((x) => x.role).join(',')}`);
            } else {
                const runs = (cs.result?.subagentRuns ?? []) as Json[];
                const run = runs.find((r) => r.name === 'reader') ?? {};
                const msgComp = (cs.result?.compactions ?? []) as Json[];
                const storedMsg = assistantMessages(sessCs).at(-1) ?? {};
                const childRows = rowsCs.filter((e) => e.type === 'agent.compaction' && e.data.subagent);
                check('C8', "child pass: 'summary' frame with subagent {id, name}; stored in subagentRuns[].compactions and NOT in message.compactions",
                    childPasses.every((f) => f.data.subagent.id === run.id && f.data.subagent.name === 'reader') && (run.compactions ?? []).length === childPasses.length
                    && msgComp.length === 0 && !(storedMsg.compactions ?? []).length && parentPasses.length === 0,
                    `${childPasses.length} child pass frame(s) ${childPasses.map((f) => `${short(f.data.subagent, 80)} id=${f.data.id} index=${f.data.index}`).join(' | ')}; run ${run.id} compactions ${(run.compactions ?? []).length}; message.compactions ${msgComp.length}; stored ${(storedMsg.compactions ?? []).length}; parent-level pass frames ${parentPasses.length}; start frames ${cs.frames.filter((f) => f.event === 'summary' && f.data.phase === 'start').length}`,
                    childPasses.map((f) => short(f.data, 300)));
                if (SDK_NEW) {
                    const childStarts = cs.frames.filter((f) => f.event === 'summary' && f.data.phase === 'start');
                    check('C8b', "SDK >= 0.20: each child pass is announced by a 'start' frame with subagent {id, name}, before the pass with the same id",
                        childStarts.length === childPasses.length && childStarts.every((st, i) => st.data.subagent?.id === run.id && st.data.subagent?.name === 'reader' && st.data.id === childPasses[i].data.id && st.i < childPasses[i].i)
                        && (run.compactions ?? []).every((cp: Json) => ['pre_leg', 'mid_leg', 'post_tools'].includes(cp.trigger)),
                        `${childStarts.length} start frame(s) ${childStarts.map((f) => `${f.data.id}@${f.i}${short(f.data.subagent, 60)}`).join(' | ')}; passes ${childPasses.map((f) => `${f.data.id}@${f.i}`).join(' | ')}; triggers ${(run.compactions ?? []).map((cp: Json) => cp.trigger)}`);
                }
                const clCs = await clientEvents(sessionCs, 1000);
                check('C9', 'child pass in the log (agent.compaction with subagent) and hidden from the client wire',
                    childRows.length === childPasses.length && !clCs.events.some((e) => e.type === 'agent.compaction' && JSON.stringify(e.data).includes('reader')) && !clCs.events.some((e) => e.type === 'agent.compaction' && hasKeys(e.data, ['subagent']).length),
                    `dashboard rows ${childRows.length}; client compaction rows ${clCs.events.filter((e) => e.type === 'agent.compaction').length}`,
                    childRows.map((e) => short(e.data, 300)));
            }
        }

        // ── table
        const failed = all.filter((r) => !r.ok);
        log(`\n┌ agent-sdk ${SDK_VERSION} (${SDK_NEW ? 'new' : 'legacy'} path)`);
        for (const r of all) log(`│ ${r.ok ? 'PASS' : 'FAIL'}  ${r.scenario} ${r.id.padEnd(4)} ${r.name}`);
        log(`└ ${all.length - failed.length}/${all.length} checks passed${failed.length ? `; FAILED: ${failed.map((r) => r.id).join(', ')}` : ''}`);
        log(`\nids: ${JSON.stringify(ids)}`);
        log(`login: tenant "${LOGIN.companyName}", email ${LOGIN.email}, password ${LOGIN.password}`);
        return failed.length > 0 ? 1 : 0;
    } catch (error) {
        log(`  ✗ failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        return 1;
    } finally {
        await server.close();
        await mock.close();
        await notes.close();
    }
}

const watchdog = setTimeout(() => { console.error('watchdog: run exceeded 5 minutes, exiting'); process.exit(2); }, 5 * 60_000);
watchdog.unref();
main().then((code) => {
    if (code === 0 && !KEEP) rmSync(dataDir, { recursive: true, force: true });
    else console.log(`\ndata dir kept: ${dataDir}\n  to open it: SQLITE_DATA_DIR=${dataDir} DB_PROVIDER=sqlite MAIN_DB_NAME=e2e_main CACHE_PROVIDER=memory RATE_LIMIT_PROVIDER=memory JWT_SECRET=${SECRETS.JWT_SECRET} PROVIDER_ENCRYPTION_SECRET=${SECRETS.PROVIDER_ENCRYPTION_SECRET} (the mock model / notes API ports are gone; replies cannot be re-run)`);
    process.exit(code);
}, (error) => {
    console.error(error);
    process.exit(1);
});
