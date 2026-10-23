/**
 * In-process mock of an OpenAI-compatible chat-completions endpoint for the
 * agent-flow e2e (plan versions, sub-agent groups, positioned summaries).
 *
 * Like the sub-agent tracing mock it decides every reply from the request itself
 * (the `ROLE=` marker of the system prompt, the tools offered, the tool calls
 * already in the thread since the last user message), never from a global
 * counter: parallel sub-agents call it concurrently. The one request it answers
 * without a role is the summarizer's: the SDK sends it a system message of its
 * own ("...summarizes conversation history...") and expects ONE JSON object back.
 *
 * Every call gets a distinct usage (prompt_tokens 1000+k, completion_tokens
 * 10+k for call number k) and is logged once its reply has been delivered.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Json = Record<string, any>;

export interface IssuedCall {
    k: number;
    role: string;
    stream: boolean;
    promptTokens: number;
    completionTokens: number;
    kind: 'tool_calls' | 'text';
    toolCalls: string[];
    /** The ids this reply gave its tool calls (`call_<k>_<i>`). */
    toolCallIds: string[];
    text?: string;
    offered: string[];
}

type Reply = { kind: 'text'; text: string } | { kind: 'tool_calls'; calls: Array<{ name: string; args: Json }> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : (p as Json)?.text ?? '')).join(' ');
    return '';
}

const roleOf = (system: string): string => /ROLE=([A-Za-z0-9-]+)/.exec(system)?.[1] ?? 'UNKNOWN';

/** The three steps the planning agent writes, and the two updates it makes. */
export const PLAN_WRITE = [
    { id: 1, title: 'Look up the stored note', status: 'in-progress' },
    { id: 2, title: 'Check the note against the question', status: 'not-started' },
    { id: 3, title: 'Report the result', status: 'not-started' },
];
export const PLAN_UPDATE_1 = [{ id: 1, status: 'completed' }, { id: 2, status: 'in-progress' }];
export const PLAN_UPDATE_2 = [{ id: 2, status: 'completed' }, { id: 3, status: 'in-progress' }];

/** What the summarizer's reply says: a valid structured summary the SDK accepts as is. */
const SUMMARY_JSON = JSON.stringify({
    user_directives: [],
    stable_facts: [{ key: 'notes_read', value: 'the stored notes were read', confidence: 0.9 }],
    active_goals: ['finish the lookups'],
    open_questions: [],
    discarded_obsolete: [],
    rawSummary: 'MOCK-SUMMARY: earlier lookups were read and condensed.',
});

/** How many model calls the reader sub-agent has made (reset by `startMockFlowLlm`). */
let readerCalls = 0;

export function planReply(body: Json): { role: string; reply: Reply } {
    const msgs: Json[] = body.messages ?? [];
    const offered: string[] = (body.tools ?? []).map((t: Json) => t.function?.name).filter(Boolean);
    const system = msgs.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => textOf(m.content)).join('\n');
    if (/summarizes conversation history/i.test(system)) return { role: 'SUMMARIZER', reply: { kind: 'text', text: SUMMARY_JSON } };
    const role = roleOf(system);
    const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
    const userText = lastUser >= 0 ? textOf(msgs[lastUser].content) : '';
    const after = msgs.slice(lastUser + 1);
    // A summarization pass leaves a synthetic `summarize_context` call (and its result) in the thread: not one of the agent's own turns.
    const isSummaryCall = (m: Json) => (m.tool_calls ?? []).every((t: Json) => t.function?.name === 'summarize_context');
    const assistantToolTurns = after.filter((m) => m.role === 'assistant' && m.tool_calls?.length && !isSummaryCall(m)).length;
    const toolResults = after.filter((m) => m.role === 'tool' && m.name !== 'summarize_context');
    const call = (name: string, args: Json): Reply => (offered.includes(name)
        ? { kind: 'tool_calls', calls: [{ name, args }] }
        : { kind: 'text', text: `MOCK-ERROR: ${role} wanted to call ${name} but it was not offered (offered: ${offered.join(',') || 'none'})` });
    const text = (t: string): Reply => ({ kind: 'text', text: t });
    const lookup = (topic: string) => call('lookup_note', { topic });
    const delegate = (subagent: string, input: string) => call('delegate_to', { subagent, input });

    switch (role) {
        // Planning ON: three turns in one session. The plan is v1 after the write, v2 after the first update, v3 after the second;
        // the third turn only READS it (a plan call that writes no version).
        case 'PLAN':
            if (/TURN-3/.test(userText)) {
                if (assistantToolTurns === 0) return { role, reply: call('manage_plan', { operation: 'read' }) };
                return { role, reply: text('FINAL-P3: the plan was read and left as it was.') };
            }
            if (/TURN-2/.test(userText)) {
                if (assistantToolTurns === 0) return { role, reply: call('manage_plan', { operation: 'update', expectedVersion: 2, todoList: PLAN_UPDATE_2 }) };
                return { role, reply: text('FINAL-P2: the plan moved on to the last step.') };
            }
            if (assistantToolTurns === 0) return { role, reply: call('manage_plan', { operation: 'write', todoList: PLAN_WRITE }) };
            if (assistantToolTurns === 1) return { role, reply: lookup('latency') };
            if (assistantToolTurns === 2) return { role, reply: call('manage_plan', { operation: 'update', expectedVersion: 1, todoList: PLAN_UPDATE_1 }) };
            return { role, reply: text('FINAL-P1: the note was looked up and the plan advanced.') };
        // Planning OFF: one tool call, no plan tool offered.
        case 'NOPLAN':
            if (assistantToolTurns === 0) return { role, reply: lookup('latency') };
            return { role, reply: text('FINAL-NP: done without a plan.') };
        // Sub-agents (scenario S): delegate_to a registry child, then two ad-hoc children in parallel.
        case 'PARENT-S':
            if (assistantToolTurns === 0) return { role, reply: delegate('researcher', 'Look up the stored note for the topic "latency" and report it verbatim.') };
            if (assistantToolTurns === 1) {
                return {
                    role,
                    reply: call('spawn_subagents_parallel', {
                        tasks: [
                            { role: 'child-A', prompt: 'ROLE=CHILD-A You are child A.', input: 'TASK-A: say that A is done.' },
                            { role: 'child-B', prompt: 'ROLE=CHILD-B You are child B.', input: 'TASK-B: say that B is done.' },
                        ],
                    }),
                };
            }
            return { role, reply: text('FINAL-S: the researcher reported the note and both parallel children finished.') };
        // Approval inside the child (scenario B), with a plan written before and updated after the delegation.
        case 'PARENT-B':
            if (assistantToolTurns === 0) return { role, reply: call('manage_plan', { operation: 'write', todoList: PLAN_WRITE }) };
            if (assistantToolTurns === 1) return { role, reply: delegate('researcher', 'Look up the stored note for the topic "latency" and report it verbatim.') };
            if (assistantToolTurns === 2) return { role, reply: call('manage_plan', { operation: 'update', expectedVersion: 1, todoList: PLAN_UPDATE_1 }) };
            return { role, reply: text('FINAL-B: the researcher reported the note after approval.') };
        // Summarization in the flow (scenario C): three big notes, one per model turn.
        case 'PARENT-C':
            if (assistantToolTurns < 3) return { role, reply: lookup(`big-${assistantToolTurns + 1}`) };
            return { role, reply: text('FINAL-C: three notes were read.') };
        // Summarization inside a child (scenario C2): the parent only delegates; the child reads three big notes.
        case 'PARENT-CS':
            if (assistantToolTurns === 0) return { role, reply: delegate('reader', 'Read the three big notes one after the other and report that you finished.') };
            return { role, reply: text('FINAL-CS: the reader finished.') };
        case 'READER': {
            // After a summarization pass the thread is rewritten (calls and results are folded into the summary), so the
            // thread cannot say how far the reader got. There is one reader and it is never concurrent: its own call count can.
            readerCalls += 1;
            if (readerCalls <= 3) return { role, reply: lookup(`big-${readerCalls}`) };
            return { role, reply: text('reader done: three notes read') };
        }
        // The same, with a note big enough that a sub-agent step has to be cut to a preview when it is stored.
        case 'RESEARCHER-BIG': {
            if (toolResults.length === 0) return { role, reply: lookup('big-9') };
            return { role, reply: text('researcher-big done: read the big note') };
        }
        case 'RESEARCHER': {
            if (toolResults.length === 0) return { role, reply: lookup('latency') };
            const note = textOf(toolResults[toolResults.length - 1].content).slice(0, 120).replace(/\s+/g, ' ');
            return { role, reply: text(`researcher done: ${note}`) };
        }
        case 'CHILD-A': return { role, reply: text('child-A done') };
        case 'CHILD-B': return { role, reply: text('child-B done') };
        default:
            return { role, reply: text(`MOCK-ERROR: unknown caller (offered: ${offered.join(',') || 'none'}; system: ${system.slice(0, 80)})`) };
    }
}

export async function startMockFlowLlm(options: { debug?: boolean } = {}) {
    const issued: IssuedCall[] = [];
    let counter = 0;
    readerCalls = 0;

    const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
            const chunks: Buffer[] = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                handle(JSON.parse(Buffer.concat(chunks).toString('utf8'))).catch((error) => {
                    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: String(error) } }));
                });
            });
            return;
        }
        if (req.method === 'GET' && url.pathname.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-gpt', object: 'model' }] }));
            return;
        }
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `no route ${url.pathname}` } }));

        async function handle(body: Json) {
            const k = ++counter;
            const { role, reply } = planReply(body);
            const promptTokens = 1000 + k;
            const completionTokens = 10 + k;
            const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
            const stream = Boolean(body.stream);
            const includeUsage = Boolean(body.stream_options?.include_usage);
            const toolCalls = reply.kind === 'tool_calls'
                ? reply.calls.map((c, i) => ({ id: `call_${k}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }))
                : undefined;
            const record: IssuedCall = {
                k, role, stream, promptTokens, completionTokens,
                kind: reply.kind,
                toolCalls: reply.kind === 'tool_calls' ? reply.calls.map((c) => c.name) : [],
                toolCallIds: toolCalls ? toolCalls.map((t) => t.id) : [],
                ...(reply.kind === 'text' ? { text: reply.text } : {}),
                offered: (body.tools ?? []).map((t: Json) => t.function?.name).filter(Boolean),
            };
            if (options.debug) console.log(`    [mock] #${k} ${role} stream=${stream} offered=[${record.offered.join(',')}] -> ${reply.kind === 'text' ? `text "${reply.text.slice(0, 50)}"` : `tool ${record.toolCalls.join(',')}`}`);

            let aborted = false;
            res.on('close', () => { if (!res.writableEnded) aborted = true; });
            const model = body.model ?? 'mock-gpt';
            const created = Math.floor(Date.now() / 1000);
            const cid = `chatcmpl-mock-${k}`;

            await sleep(30 + (k % 3) * 20);
            if (aborted) return;

            if (!stream) {
                const message = toolCalls ? { role: 'assistant', content: null, tool_calls: toolCalls } : { role: 'assistant', content: (reply as { text: string }).text };
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ id: cid, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: toolCalls ? 'tool_calls' : 'stop' }], usage }));
                issued.push(record);
                return;
            }

            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
            const send = (obj: Json) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
            const chunk = (delta: Json, finish: string | null = null) => ({ id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] });
            if (toolCalls) {
                send(chunk({ role: 'assistant', content: null }));
                toolCalls.forEach((tc, i) => {
                    send(chunk({ tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] }));
                    const a = tc.function.arguments;
                    for (let p = 0; p < a.length; p += 16) send(chunk({ tool_calls: [{ index: i, function: { arguments: a.slice(p, p + 16) } }] }));
                });
                send(chunk({}, 'tool_calls'));
            } else {
                const text = (reply as { text: string }).text;
                send(chunk({ role: 'assistant', content: '' }));
                for (let p = 0; p < text.length; p += 12) send(chunk({ content: text.slice(p, p + 12) }));
                send(chunk({}, 'stop'));
            }
            if (includeUsage) send({ id: cid, object: 'chat.completion.chunk', created, model, choices: [], usage });
            res.write('data: [DONE]\n\n');
            res.end();
            issued.push(record);
        }
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
        url,
        issued,
        /** Calls delivered since `from` (an `issued.length` taken earlier). */
        since: (from: number) => issued.slice(from),
        close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
    };
}
