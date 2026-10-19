/**
 * Sub-agent tracing — end to end through the real console API, against a
 * scripted mock model (no network, no real LLM).
 *
 * Verifies that @cognipeer/agent-sdk >= 0.17.1 records sub-agent runs as a nested
 * tree inside the parent's single trace session (a run that pauses for a person
 * and resumes is ONE span, written pending and again when it ends), and that
 * Console stores, totals and renders that tree correctly:
 *
 *   Scenario A: delegate_to (a registry child with an OpenAPI tool) and then
 *               spawn_subagents_parallel (two ad-hoc children) in one turn;
 *               run once over /chat and once over /chat/stream.
 *   Scenario B: the registry child's tool needs approval; the turn pauses
 *               inside the child, is approved through the real API (the
 *               endpoint the playground uses), resumes and finishes.
 *
 *   Scenario D: the child needs two approvals: the turn pauses twice inside it, is
 *               approved twice and finishes; it is still one span and one group.
 *
 *   npx tsx scripts/e2e/subagent-trace/run.ts [--only A|B|D] [--dump] [--debug] [--selftest]
 *
 *   --dump      print every stored event of each scenario (compact)
 *   --debug     print every request the mock model receives
 *   --selftest  also corrupt the stored scenario A trace in memory in a dozen ways, and the stored
 *               scenario B and D traces (a pending span with a different span id; the fold
 *               disabled), and prove the checks notice (a check that cannot fail proves nothing)
 *
 * Isolated: throwaway SQLite dir, memory cache, own secrets, mock servers on
 * port 0. Nothing here reads a real credential or talks to a real host.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockLlm, usageOf, type IssuedCall, type Json } from './mockLlm';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const ONLY = arg('only')?.toUpperCase();
const DUMP = flag('dump');
const DEBUG = flag('debug');
const SELFTEST = flag('selftest');

const STAMP = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const dataDir = mkdtempSync(join(tmpdir(), 'cognipeer-e2e-subtrace-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = dataDir;
process.env.MAIN_DB_NAME = 'e2e_main';
process.env.CACHE_PROVIDER = 'memory';
process.env.RATE_LIMIT_PROVIDER = 'memory';
process.env.JWT_SECRET = 'e2e-subtrace-jwt-secret-please-ignore-0123456789';
process.env.JWT_EXPIRES_IN = '7d';
process.env.PROVIDER_ENCRYPTION_SECRET = 'e2e-subtrace-provider-secret-please-ignore-0123456789';
(process.env as Record<string, string>).NODE_ENV = process.env.NODE_ENV ?? 'development';
process.env.OUTBOUND_HTTP_ALLOWED_HOSTS = '127.0.0.1,localhost';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

interface Result { id: string; name: string; ok: boolean; detail: string; evidence: string[] }
type Ev = Json & { id: string; sequence?: number; type?: string; label?: string; status?: string; spanId?: string; parentSpanId?: string };

// ── the OpenAPI tool's backend ────────────────────────────────────────────

async function startNotesApi() {
    const hits: string[] = [];
    const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        hits.push(url.pathname + url.search);
        if (url.pathname === '/notes') {
            const topic = url.searchParams.get('topic') ?? 'none';
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ topic, note: `NOTE-${topic}: the cache is warm` }));
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url, hits, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
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

// ── event helpers ─────────────────────────────────────────────────────────

const isAgentSpan = (e: Ev) => e.type === 'span' && e.actor?.scope === 'agent' && e.actor?.role === 'subagent';
const brief = (e: Ev) => `#${e.sequence ?? '?'} ${e.type}${e.label ? ` "${e.label}"` : ''} span=${e.spanId ?? '-'} parent=${e.parentSpanId ?? '-'} status=${e.status ?? '-'}`
    + `${e.inputTokens ? ` tok=${e.inputTokens}/${e.outputTokens}` : ''} actor=${e.actor?.scope ?? ''}/${e.actor?.name ?? ''}/${e.actor?.role ?? ''}`;
const bySeq = (a: Ev, b: Ev) => (a.sequence ?? 0) - (b.sequence ?? 0);
const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);
const sameCounts = (a: Json, b: Json) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** Frames of an SSE body. */
function sseFrames(raw: unknown): Array<{ event: string; data: any }> {
    if (typeof raw !== 'string') return [];
    return raw.split('\n\n').map((block) => {
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
        const data = /^data: (.*)$/m.exec(block)?.[1];
        let parsed: any = data;
        try { parsed = data ? JSON.parse(data) : undefined; } catch { /* keep the raw text */ }
        return { event, data: parsed };
    }).filter((f) => f.data !== undefined);
}

interface Helpers {
    cleanLabel: (e: any) => string | undefined;
    buildSessionModel: (events: any[], session?: any) => any;
    flattenTree: (nodes: any[], depth?: number) => Array<{ node: any; depth: number }>;
    foldSupersededSpans: <T extends Json>(events: T[]) => T[];
}

interface Turn {
    session: Json;
    events: Ev[];            // with content (default GET)
    uiEvents: Ev[];          // ?includeEventContent=false, what the page feeds buildSessionModel
    calls: IssuedCall[];     // what the mock model issued for the turn
    wallMs: number;
    freshSessions: Json[];
    usage?: Json;
}

/** Everything the two scenarios share about the shape of a session. */
function sessionIndex(t: Turn, h: Helpers) {
    const { events, calls } = t;
    const label = (e: Ev) => h.cleanLabel(e) ?? e.label ?? '';
    const bySpan = new Map<string, Ev>();
    for (const e of events) if (e.spanId) bySpan.set(e.spanId, e);
    const parent = (e: Ev) => (e.parentSpanId ? bySpan.get(e.parentSpanId) : undefined);
    const chain = (e: Ev): Ev[] => {
        const out: Ev[] = [];
        const seen = new Set<string>();
        for (let p = parent(e); p && !seen.has(p.id); p = parent(p)) { out.push(p); seen.add(p.id); }
        return out;
    };
    const owner = (e: Ev) => chain(e).find(isAgentSpan);
    const info = (e: Ev) => (e.sections ?? []).find((s: Json) => s.kind === 'metadata' && s.label === 'Sub-agent')?.data as Json | undefined;
    const callOf = (e: Ev) => calls.find((x) => x.promptTokens === e.inputTokens);
    const responseOf = (e: Ev) => {
        const secs = (e.sections ?? []).filter((s: Json) => (s.kind === 'message' && s.role === 'assistant') || s.kind === 'tool_call');
        const last = secs[secs.length - 1];
        return last ? String(last.content ?? JSON.stringify(last.arguments ?? '')) : '';
    };
    const iterNo = (e: Ev) => Number(/Iteration (\d+)/.exec(label(e))?.[1]);
    return { label, bySpan, parent, chain, owner, info, callOf, responseOf, iterNo };
}

const NAME_BY_ROLE: Record<string, string> = { RESEARCHER: 'researcher', 'CHILD-A': 'child-A', 'CHILD-B': 'child-B' };

/** The token comparison shared by C6 and B4. */
function tokenCheck(t: Turn) {
    const { events, session, calls } = t;
    const ai = events.filter((e) => e.type === 'ai_call');
    const evIn = sum(ai.map((e) => Number(e.inputTokens) || 0));
    const evOut = sum(ai.map((e) => Number(e.outputTokens) || 0));
    const evCached = sum(ai.map((e) => Number(e.cachedInputTokens) || 0));
    const mock = usageOf(calls);
    const sm = session.summary ?? {};
    const stray = events.filter((e) => e.type !== 'ai_call' && ((Number(e.inputTokens) || 0) > 0 || (Number(e.outputTokens) || 0) > 0));
    const ok = session.totalInputTokens === evIn && sm.totalInputTokens === evIn && evIn === mock.input
        && session.totalOutputTokens === evOut && sm.totalOutputTokens === evOut && evOut === mock.output
        && (session.totalCachedInputTokens ?? 0) === evCached && (sm.totalCachedInputTokens ?? 0) === evCached
        && ai.length === mock.calls && stray.length === 0;
    const detail = `in/out — session ${session.totalInputTokens}/${session.totalOutputTokens}, summary ${sm.totalInputTokens}/${sm.totalOutputTokens}, `
        + `ai_call events ${evIn}/${evOut} (${ai.length}), mock issued ${mock.input}/${mock.output} (${mock.calls} calls), cached ${evCached}, `
        + `non-ai events carrying tokens: ${stray.length}${t.usage ? `; turn usage ${JSON.stringify(t.usage).slice(0, 90)}` : ''}`;
    const evidence = [
        ...stray.map((e) => `stray tokens: ${brief(e)}`),
        ...calls.map((x) => `mock #${x.k} ${x.role} in=${x.promptTokens} out=${x.completionTokens} ${ai.some((e) => e.inputTokens === x.promptTokens) ? 'has event' : 'NO EVENT'}`),
    ];
    return { ok, detail, evidence };
}

/** C1..C10 for a one-turn delegate_to + parallel run. */
function evaluateTurnA(t: Turn, h: Helpers): Result[] {
    const out: Result[] = [];
    const add = (id: string, name: string, ok: boolean, detail: string, evidence: string[] = []) => out.push({ id, name, ok, detail, evidence });
    const { events, session, calls } = t;
    const ix = sessionIndex(t, h);
    const rootSpanId = session.rootSpanId as string;

    // C1
    const traceIds = new Set(events.map((e) => e.traceId));
    add('C1', 'one trace session for the turn',
        t.freshSessions.length === 1 && traceIds.size === 1 && traceIds.has(session.traceId),
        `${t.freshSessions.length} new session(s) [${t.freshSessions.map((s) => `${s.agentName}:${s.status}`).join(', ')}], ${events.length} events, ${traceIds.size} traceId(s)`);

    // C2
    const delegate = events.filter((e) => e.type === 'tool_call' && e.toolName === 'delegate_to');
    const rSpans = events.filter((e) => isAgentSpan(e) && e.actor?.name === 'researcher');
    const r = rSpans[0];
    const rInfo = r ? ix.info(r) : undefined;
    add('C2', 'researcher agent span under the delegate_to tool_call',
        delegate.length === 1 && rSpans.length === 1 && ix.label(r) === 'Sub-agent researcher' && r.parentSpanId === delegate[0].spanId
            && r.status === 'success' && !r.error && rInfo?.name === 'researcher' && rInfo?.status === 'ok',
        `${rSpans.length} span(s); label="${r ? ix.label(r) : '-'}"; parent=${r?.parentSpanId ?? '-'} vs delegate_to span=${delegate[0]?.spanId ?? '-'}; status=${r?.status}; error=${JSON.stringify(r?.error ?? null)}; info.id=${rInfo?.id} mode=${rInfo?.mode} depth=${rInfo?.depth}`,
        [...delegate, ...rSpans].map(brief));

    // C3
    const rEvents = r
        ? events.filter((e) => (e.type === 'ai_call' && ix.callOf(e)?.role === 'RESEARCHER') || (e.type === 'tool_call' && e.toolName === 'lookup_note'))
        : [];
    const rBad = rEvents.filter((e) => {
        const p = ix.parent(e);
        return !(p?.type === 'agent_iteration' && p.parentSpanId === r.spanId && ix.owner(e)?.spanId === r.spanId);
    });
    const rootLevel = events.filter((e) => !isAgentSpan(e) && !ix.owner(e) && e.type !== 'agent_iteration');
    const leaked = rootLevel.filter((e) => (e.type === 'ai_call' && !ix.callOf(e)?.role.startsWith('PARENT'))
        || (e.type === 'tool_call' && !['delegate_to', 'spawn_subagents_parallel'].includes(String(e.toolName))));
    add('C3', "researcher's calls hang under its own iteration → agent span",
        rEvents.length === 3 && rBad.length === 0 && leaked.length === 0,
        `${rEvents.filter((e) => e.type === 'ai_call').length} ai_call + ${rEvents.filter((e) => e.type === 'tool_call').length} tool_call events: ${rEvents.length - rBad.length}/${rEvents.length} reach the span through a child agent_iteration; child events on the parent's iterations: ${leaked.length}`,
        [...rBad, ...leaked].map((e) => `${brief(e)} ← parent ${ix.parent(e) ? brief(ix.parent(e)!) : 'unresolved'}`));

    // C4
    const spawn = events.filter((e) => e.type === 'tool_call' && e.toolName === 'spawn_subagents_parallel');
    const kids = ['child-A', 'child-B'].map((n) => events.filter((e) => isAgentSpan(e) && e.actor?.name === n));
    const kidSpans = kids.map((k) => k[0]);
    // A child's reply is exactly "child-A done" / "child-B done": the payload says whose call it was.
    const sayOf = (e: Ev) => /^child-([AB]) done$/.exec(ix.responseOf(e).trim());
    const wired = events.filter((e) => e.type === 'ai_call' && sayOf(e));
    const miswired = events.filter((e) => e.type === 'ai_call').map((e) => {
        const byCall = NAME_BY_ROLE[ix.callOf(e)?.role ?? ''];
        const said = sayOf(e);
        const byText = said ? `child-${said[1]}` : undefined;
        const actual = ix.owner(e)?.actor?.name;
        return { e, byCall, byText, actual, bad: byCall !== actual || (byText !== undefined && byText !== actual) };
    }).filter((x) => x.bad);
    add('C4', 'two parallel children, each parented to spawn_subagents_parallel, no cross-wiring',
        spawn.length === 1 && kids.every((k) => k.length === 1) && kidSpans.every((s) => s?.parentSpanId === spawn[0].spanId && s?.status === 'success' && !s?.error)
            && wired.length === 2 && miswired.length === 0,
        `spawn span=${spawn[0]?.spanId ?? '-'}; child-A parent=${kidSpans[0]?.parentSpanId ?? '-'} (${kidSpans[0]?.status}), child-B parent=${kidSpans[1]?.parentSpanId ?? '-'} (${kidSpans[1]?.status}); `
            + `child answers found in ai_call payloads: ${wired.length} (each under its own span: ${wired.filter((e) => ix.owner(e)?.actor?.name === `child-${sayOf(e)![1]}`).length}); ai_call events under the wrong span: ${miswired.length}; info.parallel=${kidSpans.map((s) => s && ix.info(s)?.parallel)}`,
        [...spawn, ...kidSpans.filter(Boolean)].map((e) => brief(e!)).concat(miswired.map((x) => `${brief(x.e)} expected owner=${x.byCall ?? x.byText ?? 'root'} (by mock call=${x.byCall}, by payload=${x.byText}) actual=${x.actual ?? 'root'}`)));

    // C5
    const spanIds = events.map((e) => e.spanId).filter(Boolean) as string[];
    const unresolved = events.filter((e) => e.parentSpanId && e.parentSpanId !== rootSpanId && !ix.bySpan.has(e.parentSpanId));
    const dupSpans = spanIds.length - new Set(spanIds).size;
    const orphans = events.filter((e) => !e.parentSpanId);
    add('C5', 'every parentSpanId resolves (or is the root span)',
        unresolved.length === 0 && dupSpans === 0 && orphans.length === 0,
        `${events.length} events; unresolved parents: ${unresolved.length}; duplicate spanIds: ${dupSpans}; events without a parent: ${orphans.length}; root span ${rootSpanId} has ${events.filter((e) => e.parentSpanId === rootSpanId).length} direct children`,
        [...unresolved, ...orphans].map(brief));

    // C6
    const tok = tokenCheck(t);
    add('C6', 'token totals: session == ai_call events == mock usage', tok.ok, tok.detail, tok.evidence);

    // C7
    const iterations = events.filter((e) => e.type === 'agent_iteration');
    const numbersOf = (es: Ev[]) => es.map(ix.iterNo).sort((a, b) => a - b);
    const rootNums = numbersOf(iterations.filter((e) => !ix.owner(e)));
    const byChild = new Map<string, number[]>();
    for (const e of iterations.filter((x) => ix.owner(x))) {
        const n = ix.owner(e)!.actor?.name ?? '?';
        byChild.set(n, [...(byChild.get(n) ?? []), ix.iterNo(e)].sort((a, b) => a - b));
    }
    const childCount = sum([...byChild.values()].map((v) => v.length));
    const consecutive = (v: number[]) => v.every((n, i) => n === i + 1);
    add('C7', 'parent iterations 1..3, child iterations numbered separately',
        rootNums.length === 3 && consecutive(rootNums) && [...byChild.values()].every(consecutive)
            && byChild.get('researcher')?.length === 2 && byChild.get('child-A')?.length === 1 && byChild.get('child-B')?.length === 1,
        `parent [${rootNums}]; ${[...byChild].map(([n, v]) => `${n} [${v}]`).join(', ')}; summary.subagentIterations=${session.summary?.subagentIterations} (child iteration events: ${childCount})`);

    // C8
    const sd = session.summary?.totalDurationMs;
    const rootDur = (types: string[]) => sum(events.filter((e) => !ix.owner(e) && types.includes(String(e.type))).map((e) => Number(e.durationMs) || 0));
    add('C8', 'session duration is not double-counted',
        typeof session.durationMs === 'number' && session.durationMs <= t.wallMs + 1000 && (sd === undefined || sd <= t.wallMs + 1000)
            // The SDK's total is the parent-level calls only: a child's own events and its agent span add nothing.
            && (sd === undefined || Math.abs(sd - rootDur(['ai_call', 'tool_call'])) <= 2),
        `session.durationMs=${session.durationMs}, summary.totalDurationMs=${sd}, chat wall-clock=${t.wallMs}ms; sum of all event durations=${sum(events.map((e) => Number(e.durationMs) || 0))}ms; `
        + `parent-level ai_call+tool_call durations=${rootDur(['ai_call', 'tool_call'])}ms, parent iterations=${rootDur(['agent_iteration'])}ms, agent spans=${sum(events.filter(isAgentSpan).map((e) => Number(e.durationMs) || 0))}ms`);

    // C9
    const counts: Record<string, number> = {};
    for (const e of events) counts[e.type ?? '?'] = (counts[e.type ?? '?'] ?? 0) + 1;
    add('C9', 'event counts match the stored summary',
        sameCounts(counts, session.eventCounts ?? {}) && sameCounts(counts, session.summary?.eventCounts ?? {}) && session.totalEvents === events.length,
        `by type ${JSON.stringify(counts)}; session.eventCounts=${JSON.stringify(session.eventCounts)}; totalEvents=${session.totalEvents}; toolsUsed=${JSON.stringify(session.toolsUsed)}; modelsUsed=${JSON.stringify(session.modelsUsed)}`);

    // C10 — the page's own model (sessionModel.ts) nests every call under its sub-agent
    const model = h.buildSessionModel(t.uiEvents, { startedAt: session.startedAt, durationMs: session.durationMs });
    const leaves: Array<{ ev: Ev; trail: string[] }> = [];
    const walk = (nodes: any[], trail: string[]) => {
        for (const n of nodes) {
            const here = [...trail, ...n.foldedLabels, n.label];
            if (n.event?.type === 'ai_call') leaves.push({ ev: n.event, trail: here });
            walk(n.children, here);
        }
    };
    walk(model.tree, []);
    const uiCall = (e: Ev) => calls.find((x) => x.promptTokens === e.inputTokens);
    const uiBad = leaves.filter(({ ev, trail }) => {
        const want = NAME_BY_ROLE[uiCall(ev)?.role ?? ''];
        const subs = trail.filter((l) => l.startsWith('Sub-agent '));
        return want ? !(subs.length === 1 && subs[0] === `Sub-agent ${want}`) : subs.length > 0;
    });
    add('C10', "Console's sessionModel nests each call under its own sub-agent row",
        leaves.length === calls.length && uiBad.length === 0,
        `${leaves.length} model-call rows in the UI tree (mock issued ${calls.length}); rows under the wrong/no sub-agent: ${uiBad.length}; tree roots: ${model.tree.length}`,
        uiBad.map(({ ev, trail }) => `${brief(ev)} trail=${trail.join(' › ')}`));
    return out;
}

/** Corrupts a copy of the scenario A trace and reports whether the intended check notices. */
function selfTest(turn: Turn, h: Helpers): Result[] {
    const out: Result[] = [];
    const both = (t: Turn, id: string, patch: (e: Ev) => void) => { for (const list of [t.events, t.uiEvents]) { const e = list.find((x) => x.id === id); if (e) patch(e); } };
    const drop = (t: Turn, id: string) => { t.events = t.events.filter((e) => e.id !== id); t.uiEvents = t.uiEvents.filter((e) => e.id !== id); };
    const named = (t: Turn, f: (e: Ev, ix: ReturnType<typeof sessionIndex>) => boolean) => { const ix = sessionIndex(t, h); return t.events.find((e) => f(e, ix))!; };
    const muts: Array<{ name: string; expect: string; apply: (t: Turn) => void }> = [
        { name: "child-A's model call re-parented under child-B's iteration", expect: 'C4', apply: (t) => {
            const a = named(t, (e, ix) => e.type === 'ai_call' && ix.callOf(e)?.role === 'CHILD-A');
            const b = named(t, (e, ix) => e.type === 'agent_iteration' && ix.owner(e)?.actor?.name === 'child-B');
            both(t, a.id, (e) => { e.parentSpanId = b.spanId; });
        } },
        { name: "researcher's model call re-parented onto the parent's Iteration 1", expect: 'C3', apply: (t) => {
            const r = named(t, (e, ix) => e.type === 'ai_call' && ix.callOf(e)?.role === 'RESEARCHER');
            const it = named(t, (e, ix) => e.type === 'agent_iteration' && !ix.owner(e) && ix.iterNo(e) === 1);
            both(t, r.id, (e) => { e.parentSpanId = it.spanId; });
        } },
        { name: 'agent span repeats its tokens (double count)', expect: 'C6', apply: (t) => {
            const sp = named(t, (e) => isAgentSpan(e) && e.actor?.name === 'child-A');
            both(t, sp.id, (e) => { e.inputTokens = 1005; e.outputTokens = 15; });
        } },
        { name: "a child's model call missing from the stored events", expect: 'C6', apply: (t) => {
            const a = named(t, (e, ix) => e.type === 'ai_call' && ix.callOf(e)?.role === 'CHILD-B');
            drop(t, a.id);
        } },
        { name: 'session token total off by one', expect: 'C6', apply: (t) => { t.session.totalInputTokens += 1; } },
        { name: 'child iteration numbered 4 (parent counts it)', expect: 'C7', apply: (t) => {
            const it = named(t, (e, ix) => e.type === 'agent_iteration' && ix.owner(e)?.actor?.name === 'child-A');
            both(t, it.id, (e) => { e.label = 'Iteration 4'; });
        } },
        { name: 'a parentSpanId pointing at nothing', expect: 'C5', apply: (t) => {
            const a = named(t, (e, ix) => e.type === 'ai_call' && ix.callOf(e)?.role === 'CHILD-A');
            both(t, a.id, (e) => { e.parentSpanId = 'deadbeefdeadbeef'; });
        } },
        { name: 'researcher span ends in error', expect: 'C2', apply: (t) => {
            const sp = named(t, (e) => isAgentSpan(e) && e.actor?.name === 'researcher');
            both(t, sp.id, (e) => { e.status = 'error'; e.error = { message: 'boom' }; });
        } },
        { name: "researcher span hangs off the parent's iteration, not the delegate_to call", expect: 'C2', apply: (t) => {
            const sp = named(t, (e) => isAgentSpan(e) && e.actor?.name === 'researcher');
            const it = named(t, (e, ix) => e.type === 'agent_iteration' && !ix.owner(e) && ix.iterNo(e) === 1);
            both(t, sp.id, (e) => { e.parentSpanId = it.spanId; });
        } },
        { name: 'a second trace session for the same turn', expect: 'C1', apply: (t) => { t.freshSessions = [...t.freshSessions, { sessionId: 'sess_other', agentName: 'researcher', status: 'success' }]; } },
        { name: 'session duration inflated 5x (children counted twice)', expect: 'C8', apply: (t) => { t.session.durationMs = t.wallMs * 5; } },
        { name: "summary.totalDurationMs also counts the children's own time", expect: 'C8', apply: (t) => { t.session.summary.totalDurationMs += 400; } },
        { name: 'UI-only: a child iteration loses its parent link', expect: 'C10', apply: (t) => {
            const it = named(t, (e, ix) => e.type === 'agent_iteration' && ix.owner(e)?.actor?.name === 'researcher');
            for (const e of t.uiEvents) if (e.id === it.id) delete e.parentSpanId;
        } },
    ];
    for (const m of muts) {
        const t = structuredClone(turn);
        m.apply(t);
        const failed = evaluateTurnA(t, h).filter((r) => !r.ok).map((r) => r.id);
        out.push({ id: 'ST', name: m.name, ok: failed.includes(m.expect), detail: `${failed.includes(m.expect) ? 'caught' : 'NOT caught'} by ${m.expect} (failing: ${failed.join(',') || 'none'})`, evidence: [] });
    }
    return out;
}

/**
 * The one-group invariant of a sub-agent that paused and resumed, from the stored trace:
 *   G1  every record of the run shares ONE span id (pending, ..., finished), nothing else repeats an id
 *   G2  the page draws ONE group for it: finished, no pending span row, no waiting row, `approvals` approvals inside
 *   G3  the fold drops exactly the superseded pending records
 * Used for the live B/D scenarios and, on corrupted copies, by the self-test.
 */
function evaluateOneGroup(t: Turn, h: Helpers, agent: string, approvals: number): Result[] {
    const mine = t.events.filter((e) => isAgentSpan(e) && e.actor?.name === agent).sort(bySeq);
    const ids = new Set(mine.map((e) => e.spanId));
    const byId = new Map<string, Ev[]>();
    for (const e of t.events) if (e.spanId) byId.set(e.spanId, [...(byId.get(e.spanId) ?? []), e]);
    const repeated = [...byId.values()].filter((list) => list.length > 1);
    const statuses = mine.map((e) => e.status).join();
    const g1 = mine.length === approvals + 1 && ids.size === 1 && statuses === [...Array(approvals).fill('pending'), 'success'].join()
        && repeated.length === 1 && repeated[0].every(isAgentSpan);

    const model = h.buildSessionModel(t.uiEvents, { startedAt: t.session.startedAt, durationMs: t.session.durationMs });
    const rows = h.flattenTree(model.tree).map((r: any) => r.node);
    const groups = rows.filter((n: any) => n.event && isAgentSpan(n.event as Ev) && n.event.actor?.name === agent);
    const inside: any[] = groups[0] ? h.flattenTree(groups[0].children).map((r: any) => r.node) : [];
    const humans = inside.filter((n) => n.human);
    const g2 = groups.length === 1 && groups[0].event.status === 'success'
        && humans.length === approvals && humans.every((n) => n.human.state === 'approved')
        && !rows.some((n: any) => n.waiting) && !rows.some((n: any) => n.event?.type === 'span' && n.event.status === 'pending');

    const drawn = h.foldSupersededSpans(t.events);
    const g3 = drawn.length === t.events.length - approvals && drawn.filter((e) => isAgentSpan(e) && e.actor?.name === agent).length === 1;
    return [
        { id: 'G1', name: `${agent}: one span id across every pause`, ok: g1, detail: `${mine.length} record(s) [${statuses}], ${ids.size} distinct span id(s), repeated ids ${repeated.length}`, evidence: mine.map(brief) },
        { id: 'G2', name: `${agent}: the page draws one finished group with ${approvals} approval(s) inside, nothing waiting`, ok: g2, detail: `${groups.length} group(s) [${groups.map((n: any) => n.event.status)}]; human rows inside ${humans.length}; waiting rows ${rows.filter((n: any) => n.waiting).length}`, evidence: [] },
        { id: 'G3', name: `${agent}: the fold drops the ${approvals} superseded pending record(s)`, ok: g3, detail: `${drawn.length} of ${t.events.length} records drawn`, evidence: [] },
    ];
}

/** Corrupt a stored paused-and-resumed trace and prove G1..G3 notice. */
function selfTestOneGroup(turn: Turn, h: Helpers, agent: string, approvals: number): Result[] {
    const out: Result[] = [];
    const spansOf = (t: Turn) => t.events.filter((e) => isAgentSpan(e) && e.actor?.name === agent).sort(bySeq);
    const both = (t: Turn, id: string, patch: (e: Ev) => void) => { for (const list of [t.events, t.uiEvents]) { const e = list.find((x) => x.id === id); if (e) patch(e); } };
    const muts: Array<{ name: string; expect: string[]; hh?: Helpers; apply: (t: Turn) => void }> = [
        { name: 'the first pending span gets a span id of its own', expect: ['G1', 'G2', 'G3'], apply: (t) => {
            const first = spansOf(t).find((e) => e.status === 'pending')!;
            both(t, first.id, (e) => { e.spanId = `${e.spanId}-other`; });
        } },
        { name: 'the fold disabled (superseded records no longer pending, helper is a no-op)', expect: ['G2', 'G3'],
            hh: { ...h, foldSupersededSpans: (events) => [...events] }, apply: (t) => {
                for (const e of spansOf(t)) if (e.status === 'pending') both(t, e.id, (x) => { x.status = 'success'; });
            } },
    ];
    for (const m of muts) {
        const t = structuredClone(turn);
        m.apply(t);
        const failed = evaluateOneGroup(t, m.hh ?? h, agent, approvals).filter((r) => !r.ok).map((r) => r.id);
        const caught = m.expect.every((id) => failed.includes(id));
        out.push({ id: 'ST', name: `${agent}: ${m.name}`, ok: caught, detail: `${caught ? 'caught' : 'NOT caught'} by ${m.expect.join('+')} (failing: ${failed.join(',') || 'none'})`, evidence: [] });
    }
    return out;
}

function treeLines(t: Turn, h: Helpers): string[] {
    const model = h.buildSessionModel(t.uiEvents, { startedAt: t.session.startedAt, durationMs: t.session.durationMs });
    return h.flattenTree(model.tree).map(({ node, depth }) => {
        const e = node.event as Ev | undefined;
        const actor = e?.actor ? `${e.actor.scope ?? ''}/${e.actor.name ?? ''}/${e.actor.role ?? ''}` : '-';
        const tok = e && (e.inputTokens || e.outputTokens) ? ` tok=${e.inputTokens}/${e.outputTokens}` : '';
        const fold = node.foldedLabels.length ? ` folded=[${node.foldedLabels.join(' > ')}]` : '';
        return `${'  '.repeat(depth)}${e?.type ?? 'inferred'} "${node.label}" actor=${actor} status=${e?.status ?? '-'}${tok}${fold}${node.parallel > 1 ? ` parallel=${node.parallel}` : ''}${node.waiting ? ' WAITING' : ''}`;
    });
}

async function main(): Promise<number> {
    const { SmokeClient } = await import('../../smoke/client');
    const { startSmokeServer } = await import('../../smoke/server');
    const sm = await import('../../../src/components/tracing/sessionModel');
    const { foldSupersededSpans } = await import('../../../src/lib/shared/foldSupersededSpans');
    const h: Helpers = { cleanLabel: sm.cleanLabel, buildSessionModel: sm.buildSessionModel as Helpers['buildSessionModel'], flattenTree: sm.flattenTree as Helpers['flattenTree'], foldSupersededSpans: foldSupersededSpans as Helpers['foldSupersededSpans'] };
    const log = (msg = '') => console.log(msg);

    const mock = await startMockLlm({ debug: DEBUG });
    const notes = await startNotesApi();
    const server = await startSmokeServer();
    const c = new SmokeClient(server.baseUrl);
    const all: Result[] = [];
    const show = (r: Result) => {
        all.push(r);
        log(`  ${r.ok ? '✓' : '✗'} ${r.id} ${r.name} — ${r.detail}`);
        if (!r.ok) r.evidence.slice(0, 16).forEach((l) => log(`        ${l}`));
    };
    const want = (id: string) => !ONLY || ONLY === id;

    const must = async (name: string, method: string, path: string, expect: number[], body?: unknown): Promise<Json> => {
        const res = await c.request<Json>(method, path, body !== undefined ? { body } : {});
        if (!expect.includes(res.status)) throw new Error(`setup "${name}" → HTTP ${res.status}: ${res.raw?.slice(0, 400)}`);
        return res.body;
    };

    try {
        log(`▶ Sub-agent tracing e2e — mock model ${mock.url}, notes API ${notes.url}`);
        await must('register', 'POST', '/api/auth/register', [201], {
            companyName: `E2E SubTrace ${STAMP}`, email: `owner-${STAMP}@e2e.test`, name: 'E2E Owner', password: 'E2eSubTrace!2024#Secure',
        });
        await must('provider', 'POST', '/api/models/providers', [201], {
            key: 'mock-provider', driver: 'openai-compatible', label: 'Mock LLM',
            credentials: { apiKey: 'mock-key-not-a-secret' }, settings: { baseUrl: `${mock.url}/v1` },
        });
        await must('model', 'POST', '/api/models', [201], {
            name: 'mock-model', key: 'mock-llm', providerKey: 'mock-provider', category: 'llm', modelId: 'mock-gpt',
            pricing: { currency: 'USD', inputTokenPer1M: 1, outputTokenPer1M: 2, cachedTokenPer1M: 0 },
            settings: {}, supportsToolCalls: true,
        });
        const tool = await must('notes tool', 'POST', '/api/tools', [201], {
            name: 'Notes', type: 'openapi', openApiSpec: JSON.stringify(notesSpec(notes.url)),
        });
        const toolKey = String(tool.tool.key);

        const researcher = () => ({
            kind: 'inline', name: 'researcher', header: 'Looks up stored notes by topic.',
            systemPrompt: 'ROLE=RESEARCHER You look up notes with lookup_note and report them.',
            toolBindings: [{ source: 'tool', sourceKey: toolKey, toolNames: ['lookup_note'] }],
        });
        const auditor = () => ({
            kind: 'inline', name: 'auditor', header: 'Looks up two stored notes, one after the other.',
            systemPrompt: 'ROLE=AUDITOR You look up notes with lookup_note, one topic at a time, and report them.',
            toolBindings: [{ source: 'tool', sourceKey: toolKey, toolNames: ['lookup_note'] }],
        });
        const policy = { mode: 'registry_and_adhoc', maxParallel: 2, maxChildCalls: 8, maxDepth: 2 };
        const createAgent = async (name: string, config: Json) => {
            const created = await must(`agent ${name}`, 'POST', '/api/agents', [201], { name: `${name} ${STAMP}`, config: { modelKey: 'mock-llm', ...config } });
            return { id: String(created.agent._id ?? created.agent.id), name: `${name} ${STAMP}`, warnings: created.warnings as Json[] | undefined };
        };
        const newSession = async (agentId: string) =>
            String((await must('session', 'POST', `/api/agents/${agentId}/sessions`, [201], { title: 'subtrace' })).session._id);
        const listTraceSessions = async (): Promise<Json[]> => ((await must('trace sessions', 'GET', '/api/tracing/sessions?limit=100', [200])).sessions ?? []) as Json[];
        const traceDetail = async (id: string, content = true): Promise<Json> =>
            must('trace detail', 'GET', `/api/tracing/sessions/${id}${content ? '' : '?includeEventContent=false'}`, [200]);
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

        /** The trace sessions that appeared since `before`, once they have settled. */
        const newTraceSessions = async (before: Set<string>, settled: (s: Json) => boolean): Promise<Json[]> => {
            let fresh: Json[] = [];
            for (let i = 0; i < 40; i += 1) {
                fresh = (await listTraceSessions()).filter((s) => !before.has(String(s.sessionId)));
                if (fresh.length > 0 && fresh.every(settled)) break;
                await sleep(150);
            }
            return fresh;
        };
        const waitDetail = async (id: string, done: (d: Json) => boolean): Promise<Json> => {
            let d = await traceDetail(id);
            for (let i = 0; i < 40 && !done(d); i += 1) { await sleep(150); d = await traceDetail(id); }
            return d;
        };
        const traceIdsNow = async () => new Set((await listTraceSessions()).map((s) => String(s.sessionId)));
        const dump = (title: string, events: Ev[]) => { if (DUMP) { log(`    ── ${title}`); [...events].sort(bySeq).forEach((e) => log(`    ${brief(e)}`)); } };

        // ═════════════ Scenario A ═════════════
        if (want('A')) {
            log('\n── Scenario A: delegate_to + spawn_subagents_parallel in one turn ──');
            const agent = await createAgent('subtrace-a', {
                systemPrompt: 'ROLE=PARENT-A You coordinate sub-agents.',
                // The dashboard defaults a new agent to asking before every tool; this scenario must not pause.
                humanInTheLoop: { toolApproval: { enabled: false }, askUser: { enabled: false } },
                subagents: [researcher()],
                subagentPolicy: policy,
            });
            if (agent.warnings?.length) log(`    (agent warnings: ${JSON.stringify(agent.warnings).slice(0, 300)})`);

            for (const via of ['chat', 'chat/stream'] as const) {
                const streaming = via === 'chat/stream';
                const sessionId = await newSession(agent.id);
                const before = await traceIdsNow();
                const mark = mock.issued.length;
                const t0 = Date.now();
                const res = await c.request<Json>('POST', `/api/agents/${agent.id}/${via}`, { body: { message: 'Run the scenario.', conversationId: sessionId } });
                const wallMs = Date.now() - t0;
                const frames = streaming ? sseFrames(res.body) : [];
                const result: Json | undefined = streaming ? frames.find((f) => f.event === 'result')?.data : res.body;
                const calls = mock.since(mark);
                log(`  ${via} → HTTP ${res.status} in ${wallMs}ms; ${streaming ? `SSE events: ${[...new Set(frames.map((f) => f.event))].join(',')}; ` : ''}stopReason=${result?.stopReason ?? '-'}; answer="${String(result?.content ?? result?.error ?? '').slice(0, 90)}"`);
                log(`    mock issued ${calls.length} calls: ${calls.map((x) => `#${x.k}:${x.role}${x.toolCalls.length ? `→${x.toolCalls[0]}` : ''}${x.stream ? '(sse)' : ''}`).join(' ')}`);
                const fresh = await newTraceSessions(before, (s) => s.status !== 'in_progress');
                if (!fresh[0]) { show({ id: 'C0', name: `trace session exists (${via})`, ok: false, detail: 'no trace session was stored', evidence: [] }); continue; }
                const sid = String(fresh[0].sessionId);
                const detail = await traceDetail(sid);
                const ui = await traceDetail(sid, false);
                const turn: Turn = { session: detail.session, events: detail.events, uiEvents: ui.events, calls, wallMs, freshSessions: fresh, usage: result?.usage };
                dump(`${via} events`, turn.events);
                const results = evaluateTurnA(turn, h);
                if (!streaming) {
                    results.forEach(show);
                    log('  UI model (sessionModel.buildSessionModel over ?includeEventContent=false):');
                    treeLines(turn, h).forEach((l) => log(`    ${l}`));
                    if (SELFTEST) {
                        const st = selfTest(turn, h);
                        st.forEach((r) => log(`    ${r.ok ? '✓' : '✗'} mutation: ${r.name} → ${r.detail}`));
                        show({ id: 'ST', name: 'checks are discriminating', ok: st.every((r) => r.ok), detail: `${st.filter((r) => r.ok).length}/${st.length} corruptions of the stored trace were caught by the intended check`, evidence: [] });
                    }
                } else {
                    const bad = results.filter((r) => !r.ok);
                    show({ id: 'S1', name: 'same C1..C10 over /chat/stream (SSE model calls)', ok: bad.length === 0 && res.status === 200,
                        detail: bad.length === 0 ? `all ${results.length} checks pass; mock served ${calls.filter((x) => x.stream).length}/${calls.length} calls as SSE (usage chunk requested: ${calls.every((x) => x.includeUsage || !x.stream)})` : `failed: ${bad.map((r) => r.id).join(',')}`,
                        evidence: bad.flatMap((r) => [`${r.id}: ${r.detail}`, ...r.evidence]) });
                }
            }
        }

        // ═════════════ Scenario B ═════════════
        if (want('B')) {
            log('\n── Scenario B: the child pauses for tool approval, is approved, resumes ──');
            const agent = await createAgent('subtrace-b', {
                systemPrompt: 'ROLE=PARENT-B You coordinate sub-agents.',
                humanInTheLoop: { toolApproval: { enabled: true, defaultPolicy: 'never', tools: { lookup_note: 'always' } }, askUser: { enabled: false } },
                subagents: [researcher()],
                subagentPolicy: policy,
            });
            const sessionId = await newSession(agent.id);
            const before = await traceIdsNow();
            const mark = mock.issued.length;
            const t0 = Date.now();
            const first = await c.request<Json>('POST', `/api/agents/${agent.id}/chat`, { body: { message: 'Run the scenario.', conversationId: sessionId } });
            log(`  chat → HTTP ${first.status} in ${Date.now() - t0}ms; stopReason=${first.body?.stopReason ?? '-'}; pending=${JSON.stringify((first.body?.pendingActions ?? []).map((a: Json) => `${a.kind}:${a.toolName}${a.subagent ? `@${a.subagent}` : ''}`))}`);
            const pending = ((await must('actions', 'GET', `/api/agents/${agent.id}/sessions/${sessionId}/actions?status=pending`, [200])).actions ?? []) as Json[];
            const approval = pending.find((a) => a.kind === 'tool_approval');
            log(`  pending actions via API: ${JSON.stringify(pending.map((a) => ({ id: a.id, kind: a.kind, tool: a.toolName, subagent: a.subagent, status: a.status })))}`);
            const pausedFresh = await newTraceSessions(before, (s) => s.status !== 'in_progress');
            if (!approval || !pausedFresh[0]) {
                show({ id: 'B0', name: 'turn 1 paused on the child approval', ok: false, detail: `approval=${Boolean(approval)}, trace sessions=${pausedFresh.length}, HTTP ${first.status}`, evidence: [JSON.stringify(first.body).slice(0, 400)] });
            } else {
                const sid = String(pausedFresh[0].sessionId);
                const pausedDetail = await traceDetail(sid);
                dump('paused part', pausedDetail.events);
                log(`  paused trace: status=${pausedDetail.session.status}, ${pausedDetail.events.length} events`);
                const pausedUi = await traceDetail(sid, false);
                const pausedModel = h.buildSessionModel(pausedUi.events, { startedAt: pausedDetail.session.startedAt, durationMs: pausedDetail.session.durationMs });
                const trails: Array<{ node: any; trail: string[] }> = [];
                const walkAll = (nodes: any[], trail: string[]) => { for (const n of nodes) { const here = [...trail, ...n.foldedLabels, n.label]; trails.push({ node: n, trail: here }); walkAll(n.children, here); } };
                walkAll(pausedModel.tree, []);
                const waiting = trails.filter((x) => x.node.waiting);
                // The page folds a span with a single grouped child into that child (`foldedLabels`), so the group is counted by label.
                const pausedGroups = trails.filter((x) => x.node.label === 'Sub-agent researcher' || x.node.foldedLabels.includes('Sub-agent researcher'));
                show({ id: 'B6', name: 'while paused the page shows ONE researcher group with the approval waiting inside it',
                    ok: pausedDetail.session.status === 'paused' && waiting.length === 1 && waiting[0].trail.includes('Sub-agent researcher')
                        && pausedGroups.length === 1,
                    detail: `session ${pausedDetail.session.status}; researcher groups: ${pausedGroups.length}; waiting rows: ${waiting.length} [${waiting.map((x) => x.trail.join(' › '))}]`,
                    evidence: treeLines({ ...({} as Turn), session: pausedDetail.session, uiEvents: pausedUi.events }, h) });
                const t1 = Date.now();
                const resolved = await c.request<Json>('POST', `/api/agents/${agent.id}/sessions/${sessionId}/actions/${approval.id}/resolve?stream=1`, { body: { decision: 'allow' } });
                const frames = sseFrames(resolved.body);
                const result: Json | undefined = frames.find((f) => f.event === 'result')?.data;
                const wallMs = Date.now() - t0;
                log(`  approve (POST …/actions/:id/resolve?stream=1, as the playground) → HTTP ${resolved.status} in ${Date.now() - t1}ms; SSE: ${[...new Set(frames.map((f) => f.event))].join(',') || String(resolved.raw).slice(0, 160)}; answer="${String(result?.content ?? frames.find((f) => f.event === 'error')?.data?.error ?? '').slice(0, 80)}"`);
                const calls = mock.since(mark);
                log(`    mock issued ${calls.length} calls: ${calls.map((x) => `#${x.k}:${x.role}${x.toolCalls.length ? `→${x.toolCalls[0]}` : ''}`).join(' ')}; notes API hits: ${notes.hits.filter((x) => x.includes('latency')).length} total`);
                const finalDetail = await waitDetail(sid, (d) => !['paused', 'in_progress'].includes(String(d.session.status)));
                const ui = await traceDetail(sid, false);
                const fresh = (await listTraceSessions()).filter((s) => !before.has(String(s.sessionId)));
                const turn: Turn = { session: finalDetail.session, events: finalDetail.events, uiEvents: ui.events, calls, wallMs, freshSessions: fresh, usage: result?.usage };
                dump('final (paused part + resumed part)', turn.events);
                const ix = sessionIndex(turn, h);
                const events = turn.events;

                show({ id: 'B0', name: 'one session across pause and resume',
                    ok: fresh.length === 1 && String(fresh[0]?.sessionId) === sid && turn.session.status === 'success' && resolved.status === 200 && Boolean(result),
                    detail: `${fresh.length} trace session(s); status paused → ${turn.session.status}; ${pausedDetail.events.length} events at the pause, ${events.length} after; paused part kept intact: ${pausedDetail.events.every((p: Ev) => events.some((e) => e.id === p.id && e.spanId === p.spanId))}`,
                    evidence: fresh.map((s) => `${s.sessionId} ${s.agentName} ${s.status}`) });

                // B1 — ONE span id for the whole run: written pending at the pause, again when it ended
                const spans = events.filter((e) => isAgentSpan(e) && e.actor?.name === 'researcher').sort(bySeq);
                const [s1, s2] = spans;
                const i1 = s1 ? ix.info(s1) : undefined;
                const i2 = s2 ? ix.info(s2) : undefined;
                const delegate = events.filter((e) => e.type === 'tool_call' && e.toolName === 'delegate_to');
                const p1 = s1 ? ix.parent(s1) : undefined;
                show({ id: 'B1', name: 'one sub-agent span id across the pause: pending, then the finished record under delegate_to',
                    ok: spans.length === 2 && s1.status === 'pending' && s2.status === 'success' && s1.spanId === s2.spanId
                        && Boolean(i1?.id) && i1?.id === i2?.id && i1?.segments === 1 && i2?.segments === 2
                        && p1?.type === 'agent_iteration' && !ix.owner(p1!)
                        && delegate.length === 1 && s2.parentSpanId === delegate[0].spanId && !s2.error,
                    detail: `${spans.length} researcher record(s): [${spans.map((s) => `${s.spanId} ${s.status}`).join(' → ')}]; sub-agent ids ${i1?.id} / ${i2?.id}; segments ${i1?.segments} / ${i2?.segments}; pending record hangs off ${p1 ? `${p1.type} "${ix.label(p1)}"` : 'nothing'}, finished one off ${ix.parent(s2 ?? ({} as Ev))?.toolName ?? '?'} (delegate_to span ${delegate[0]?.spanId})`,
                    evidence: [...spans, ...delegate].map(brief) });

                // B2 — every iteration of the child, from both segments, is a direct child of the one span, numbered on
                const kidIters = events.filter((e) => e.type === 'agent_iteration' && ix.owner(e)?.actor?.name === 'researcher').sort(bySeq);
                const nums = kidIters.map(ix.iterNo);
                const pausedIds = new Set(pausedDetail.events.map((e: Ev) => e.id));
                const preIters = kidIters.filter((e) => pausedIds.has(e.id)).map(ix.iterNo);
                const postIters = kidIters.filter((e) => !pausedIds.has(e.id)).map(ix.iterNo);
                const rootNums = events.filter((e) => e.type === 'agent_iteration' && !ix.owner(e)).map(ix.iterNo).sort((a, b) => a - b);
                show({ id: 'B2', name: "child's iterations 1..n all sit under the one span, numbered on across the resume",
                    ok: nums.length >= 2 && nums.every((n, i) => n === i + 1) && kidIters.every((e) => e.parentSpanId === s2?.spanId)
                        && preIters.length >= 1 && postIters.length >= 1 && Math.min(...postIters) > Math.max(...preIters),
                    detail: `researcher iterations: before the pause [${preIters}], after [${postIters}]; all direct children of ${s2?.spanId}: ${kidIters.every((e) => e.parentSpanId === s2?.spanId)}; parent iterations [${rootNums}]; summary.subagentIterations=${turn.session.summary?.subagentIterations}`,
                    evidence: kidIters.map(brief) });

                // B3
                const approvals = events.filter((e) => e.type === 'tool_approval').sort(bySeq);
                const requests = approvals.filter((e) => e.status === 'pending');
                const decisions = approvals.filter((e) => e.status !== 'pending');
                const tagged = events.filter((e) => JSON.stringify(e).includes('__subagent'));
                show({ id: 'B3', name: 'one approval request + one decision, recorded once (inside the child)',
                    ok: approvals.length === 2 && requests.length === 1 && decisions.length === 1 && approvals.every((e) => Boolean(ix.owner(e))) && tagged.length === 0
                        && new Set(approvals.map((e) => ix.owner(e)?.spanId)).size === 1 && ix.owner(approvals[0])?.spanId === s2?.spanId
                        && (requests[0]?.sequence ?? 0) < (decisions[0]?.sequence ?? 0),
                    detail: `${requests.length} request(s) [${requests.map((e) => `"${ix.label(e)}"`)}], ${decisions.length} decision(s) [${decisions.map((e) => `"${ix.label(e)}" ${e.status}`)}]; all inside a sub-agent span: ${approvals.every((e) => Boolean(ix.owner(e)))}; events with parent-tagged __subagent copies: ${tagged.length}; lookup_note ran ${events.filter((e) => e.type === 'tool_call' && e.toolName === 'lookup_note').length}×`,
                    evidence: approvals.map(brief) });

                // B4
                const tok = tokenCheck(turn);
                show({ id: 'B4', name: 'token totals still equal the mock usage', ok: tok.ok, detail: tok.detail, evidence: tok.evidence });

                // B5 — the rest of the session stays consistent after a continuation
                const counts: Record<string, number> = {};
                for (const e of events) counts[e.type ?? '?'] = (counts[e.type ?? '?'] ?? 0) + 1;
                const byId = new Map<string, Ev[]>();
                for (const e of events) if (e.spanId) byId.set(e.spanId, [...(byId.get(e.spanId) ?? []), e]);
                const repeated = [...byId.values()].filter((list) => list.length > 1);
                const drawn = h.foldSupersededSpans(events);
                show({ id: 'B5', name: 'event counts, ids and duration consistent after the continuation',
                    ok: sameCounts(counts, turn.session.eventCounts ?? {}) && turn.session.totalEvents === events.length
                        && repeated.length === 1 && repeated[0].every(isAgentSpan) && repeated[0].map((e) => e.status).join() === 'pending,success'
                        && new Set(drawn.map((e) => e.spanId)).size === drawn.length
                        && drawn.every((e) => !e.parentSpanId || e.parentSpanId === turn.session.rootSpanId || ix.bySpan.has(e.parentSpanId))
                        && typeof turn.session.durationMs === 'number' && turn.session.durationMs <= wallMs + 1000,
                    detail: `by type ${JSON.stringify(counts)}; session.eventCounts=${JSON.stringify(turn.session.eventCounts)}; totalEvents=${turn.session.totalEvents}; repeated span ids: ${repeated.map((l) => `${l[0].spanId} [${l.map((e) => e.status)}]`)}; ${drawn.length} of ${events.length} records drawn; durationMs=${turn.session.durationMs} (both requests ${wallMs}ms)`,
                    evidence: repeated.flat().map(brief) });

                // B7 — what the page draws: ONE researcher group, finished, holding both segments and the approval once
                const model = h.buildSessionModel(ui.events, { startedAt: turn.session.startedAt, durationMs: turn.session.durationMs });
                const rows = h.flattenTree(model.tree).map((r: any) => r.node);
                const groups = rows.filter((n: any) => n.event && isAgentSpan(n.event as Ev) && n.event.actor?.name === 'researcher');
                const inside: any[] = groups[0] ? h.flattenTree(groups[0].children).map((r: any) => r.node) : [];
                const drawnIters = inside.filter((n) => n.event?.type === 'agent_iteration').map((n) => ix.iterNo(n.event as Ev));
                const humans = inside.filter((n) => n.human);
                show({ id: 'B7', name: 'the page draws ONE researcher group with iterations 1..n and the approval inside it',
                    ok: groups.length === 1 && groups[0].event.status === 'success'
                        && drawnIters.length >= 2 && drawnIters.every((n: number, i: number) => n === i + 1)
                        && humans.length === 1 && humans[0].human.state === 'approved' && humans[0].human.kind === 'approval'
                        && !rows.some((n: any) => n.waiting) && !rows.some((n: any) => n.event?.type === 'span' && n.event.status === 'pending')
                        && inside.some((n) => n.event?.toolName === 'lookup_note'),
                    detail: `${groups.length} researcher group(s) [${groups.map((n: any) => n.event.status)}]; iterations inside [${drawnIters}]; human rows inside: ${humans.length} [${humans.map((n: any) => `${n.human.kind}:${n.human.state}`)}]; waiting rows anywhere: ${rows.filter((n: any) => n.waiting).length}`,
                    evidence: treeLines(turn, h) });
                log('  UI model after resume:');
                treeLines(turn, h).forEach((l) => log(`    ${l}`));
                evaluateOneGroup(turn, h, 'researcher', 1).forEach(show);
                if (SELFTEST) {
                    const st = selfTestOneGroup(turn, h, 'researcher', 1);
                    st.forEach((r) => log(`    ${r.ok ? '✓' : '✗'} mutation: ${r.name} → ${r.detail}`));
                    show({ id: 'ST', name: 'one-group checks are discriminating (B)', ok: st.every((r) => r.ok), detail: `${st.filter((r) => r.ok).length}/${st.length} corruptions caught`, evidence: st.filter((r) => !r.ok).map((r) => r.name) });
                }
            }
        }

        // ═════════════ Scenario D ═════════════
        if (want('D')) {
            log('\n── Scenario D: the child is paused twice for tool approval and finishes ──');
            const agent = await createAgent('subtrace-d', {
                systemPrompt: 'ROLE=PARENT-D You coordinate sub-agents.',
                humanInTheLoop: { toolApproval: { enabled: true, defaultPolicy: 'never', tools: { lookup_note: 'always' } }, askUser: { enabled: false } },
                subagents: [auditor()],
                subagentPolicy: policy,
            });
            const sessionId = await newSession(agent.id);
            const before = await traceIdsNow();
            const mark = mock.issued.length;
            const t0 = Date.now();
            const first = await c.request<Json>('POST', `/api/agents/${agent.id}/chat`, { body: { message: 'Run the scenario.', conversationId: sessionId } });
            log(`  chat → HTTP ${first.status} in ${Date.now() - t0}ms; stopReason=${first.body?.stopReason ?? '-'}`);
            const pendingNow = async () => (((await must('actions', 'GET', `/api/agents/${agent.id}/sessions/${sessionId}/actions?status=pending`, [200])).actions ?? []) as Json[]).filter((a) => a.kind === 'tool_approval');
            const pausedFresh = await newTraceSessions(before, (s) => s.status !== 'in_progress');
            const pausedIds: Array<Set<string>> = [];
            let sid = '';
            let last: Json | undefined;
            let approvals = 0;
            for (let round = 0; round < 4; round += 1) {
                const pending = await pendingNow();
                if (pending.length === 0) break;
                sid = String(pausedFresh[0]?.sessionId ?? sid);
                const paused = await traceDetail(sid);
                pausedIds.push(new Set(paused.events.map((e: Ev) => e.id)));
                const resolved = await c.request<Json>('POST', `/api/agents/${agent.id}/sessions/${sessionId}/actions/${pending[0].id}/resolve?stream=1`, { body: { decision: 'allow' } });
                approvals += 1;
                last = sseFrames(resolved.body).find((f) => f.event === 'result')?.data;
                log(`  approval ${approvals} (${paused.events.length} events at that pause, trace ${paused.session.status}) → HTTP ${resolved.status}; answer="${String(last?.content ?? '').slice(0, 70)}"`);
                await sleep(200);
            }
            const calls = mock.since(mark);
            const finalDetail = await waitDetail(sid, (d) => !['paused', 'in_progress'].includes(String(d.session.status)));
            const ui = await traceDetail(sid, false);
            const fresh = (await listTraceSessions()).filter((s) => !before.has(String(s.sessionId)));
            const turn: Turn = { session: finalDetail.session, events: finalDetail.events, uiEvents: ui.events, calls, wallMs: Date.now() - t0, freshSessions: fresh, usage: last?.usage };
            dump('final (three parts)', turn.events);
            const ix = sessionIndex(turn, h);
            const events = turn.events;

            show({ id: 'D0', name: 'one session across two pauses and the resume',
                ok: fresh.length === 1 && approvals === 2 && turn.session.status === 'success' && String(last?.content ?? '').startsWith('FINAL-D'),
                detail: `${fresh.length} trace session(s); ${approvals} approval(s); status → ${turn.session.status}; ${events.length} events; answer="${String(last?.content ?? '').slice(0, 60)}"`,
                evidence: fresh.map((s) => `${s.sessionId} ${s.agentName} ${s.status}`) });

            const spans = events.filter((e) => isAgentSpan(e) && e.actor?.name === 'auditor').sort(bySeq);
            const infos = spans.map((s) => ix.info(s));
            const delegate = events.filter((e) => e.type === 'tool_call' && e.toolName === 'delegate_to');
            const parentIters = new Set(events.filter((e) => e.type === 'agent_iteration' && !ix.owner(e)).map((e) => e.spanId));
            show({ id: 'D1', name: 'three records, ONE span id: pending at each pause, finished under delegate_to',
                ok: spans.length === 3 && spans.map((s) => s.status).join() === 'pending,pending,success' && new Set(spans.map((s) => s.spanId)).size === 1
                    && new Set(infos.map((i) => i?.id)).size === 1 && infos.map((i) => i?.segments).join() === '1,2,3'
                    && parentIters.has(spans[0].parentSpanId as string) && parentIters.has(spans[1].parentSpanId as string) && spans[0].parentSpanId !== spans[1].parentSpanId
                    && delegate.length === 1 && spans[2].parentSpanId === delegate[0].spanId,
                detail: `${spans.length} auditor record(s): [${spans.map((s) => `${s.spanId} ${s.status}`).join(' → ')}]; segments ${infos.map((i) => i?.segments)}; pending records hang off parent iterations ${spans.slice(0, 2).map((s) => ix.parent(s)?.spanId)}`,
                evidence: [...spans, ...delegate].map(brief) });

            const kidIters = events.filter((e) => e.type === 'agent_iteration' && ix.owner(e)?.actor?.name === 'auditor').sort(bySeq);
            const nums = kidIters.map(ix.iterNo);
            show({ id: 'D2', name: "child's iterations 1..n, from all three segments, are direct children of the one span",
                ok: nums.length >= 3 && nums.every((n, i) => n === i + 1) && kidIters.every((e) => e.parentSpanId === spans[2]?.spanId)
                    && pausedIds.length === 2 && kidIters.some((e) => pausedIds[0].has(e.id)) && kidIters.some((e) => !pausedIds[0].has(e.id) && pausedIds[1].has(e.id)) && kidIters.some((e) => !pausedIds[1].has(e.id)),
                detail: `auditor iterations [${nums}] (first part ${kidIters.filter((e) => pausedIds[0]?.has(e.id)).length}, second ${kidIters.filter((e) => !pausedIds[0]?.has(e.id) && pausedIds[1]?.has(e.id)).length}, third ${kidIters.filter((e) => !pausedIds[1]?.has(e.id)).length}); summary.subagentIterations=${turn.session.summary?.subagentIterations}`,
                evidence: kidIters.map(brief) });

            const humanEvents = events.filter((e) => e.type === 'tool_approval').sort(bySeq);
            show({ id: 'D3', name: 'two approval requests and two decisions, in order, all inside the one span',
                ok: humanEvents.map((e) => e.status === 'pending' ? 'request' : 'decision').join() === 'request,decision,request,decision'
                    && humanEvents.every((e) => ix.owner(e)?.spanId === spans[2]?.spanId)
                    && events.filter((e) => e.type === 'tool_call' && e.toolName === 'lookup_note').length === 2
                    && events.filter((e) => JSON.stringify(e).includes('__subagent')).length === 0,
                detail: `${humanEvents.length} approval event(s) [${humanEvents.map((e) => e.status)}]; owners ${[...new Set(humanEvents.map((e) => ix.owner(e)?.spanId))]}`,
                evidence: humanEvents.map(brief) });

            const model = h.buildSessionModel(ui.events, { startedAt: turn.session.startedAt, durationMs: turn.session.durationMs });
            const rows = h.flattenTree(model.tree).map((r: any) => r.node);
            const groups = rows.filter((n: any) => n.event && isAgentSpan(n.event as Ev) && n.event.actor?.name === 'auditor');
            const inside: any[] = groups[0] ? h.flattenTree(groups[0].children).map((r: any) => r.node) : [];
            const drawnIters = inside.filter((n) => n.event?.type === 'agent_iteration').map((n) => ix.iterNo(n.event as Ev));
            const humans = inside.filter((n) => n.human);
            show({ id: 'D4', name: 'the page draws ONE auditor group with iterations 1..n and both approvals inside it',
                ok: groups.length === 1 && groups[0].event.status === 'success' && drawnIters.length >= 3 && drawnIters.every((n: number, i: number) => n === i + 1)
                    && humans.length === 2 && humans.every((n) => n.human.state === 'approved') && !rows.some((n: any) => n.waiting)
                    && !rows.some((n: any) => n.event?.type === 'span' && n.event.status === 'pending'),
                detail: `${groups.length} auditor group(s) [${groups.map((n: any) => n.event.status)}]; iterations inside [${drawnIters}]; human rows inside ${humans.length} [${humans.map((n: any) => n.human.state)}]; waiting rows ${rows.filter((n: any) => n.waiting).length}`,
                evidence: treeLines(turn, h) });

            const tok = tokenCheck(turn);
            const byId = new Map<string, Ev[]>();
            for (const e of events) if (e.spanId) byId.set(e.spanId, [...(byId.get(e.spanId) ?? []), e]);
            const repeated = [...byId.values()].filter((list) => list.length > 1);
            const counts: Record<string, number> = {};
            for (const e of events) counts[e.type ?? '?'] = (counts[e.type ?? '?'] ?? 0) + 1;
            show({ id: 'D5', name: 'token totals, counts and ids consistent after two continuations',
                ok: tok.ok && sameCounts(counts, turn.session.eventCounts ?? {}) && turn.session.totalEvents === events.length
                    && repeated.length === 1 && repeated[0].length === 3 && repeated[0].every(isAgentSpan)
                    && h.foldSupersededSpans(events).length === events.length - 2,
                detail: `${tok.detail}; by type ${JSON.stringify(counts)}; repeated ids ${repeated.map((l) => `${l[0].spanId}×${l.length}`)}; ${h.foldSupersededSpans(events).length} of ${events.length} records drawn`,
                evidence: tok.evidence });

            evaluateOneGroup(turn, h, 'auditor', 2).forEach(show);
            if (SELFTEST) {
                const st = selfTestOneGroup(turn, h, 'auditor', 2);
                st.forEach((r) => log(`    ${r.ok ? '✓' : '✗'} mutation: ${r.name} → ${r.detail}`));
                show({ id: 'ST', name: 'one-group checks are discriminating (D)', ok: st.every((r) => r.ok), detail: `${st.filter((r) => r.ok).length}/${st.length} corruptions caught`, evidence: st.filter((r) => !r.ok).map((r) => r.name) });
            }
        }

        const failed = all.filter((r) => !r.ok);
        log(`\n${all.length - failed.length}/${all.length} checks passed`);
        return failed.length > 0 ? 1 : 0;
    } catch (error) {
        log(`  ✗ failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        return 1;
    } finally {
        await server.close();
        await mock.close();
        await notes.close();
        rmSync(dataDir, { recursive: true, force: true });
    }
}

const watchdog = setTimeout(() => { console.error('watchdog: run exceeded 5 minutes, exiting'); process.exit(2); }, 5 * 60_000);
watchdog.unref();
main().then((code) => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
});
