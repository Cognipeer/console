/**
 * In-process mock of an OpenAI-compatible chat-completions endpoint for the
 * sub-agent tracing e2e. It decides the reply from the request itself (the
 * role marker in the system prompt, the tools offered, the tool calls already
 * in the thread), never from a global counter, because parallel sub-agents
 * call it concurrently.
 *
 * Every call gets a distinct usage (prompt_tokens 1000+k, completion_tokens
 * 10+k for call number k) and is logged once its reply has been delivered, so
 * the harness can compare the trace's token totals with exactly what the
 * "provider" issued, and map every ai_call event back to the call it records.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Json = Record<string, any>;

export interface IssuedCall {
    k: number;
    role: string;
    stream: boolean;
    includeUsage: boolean;
    promptTokens: number;
    completionTokens: number;
    kind: 'tool_calls' | 'text';
    toolCalls: string[];
    text?: string;
    offered: string[];
    delivered: boolean;
}

type Reply = { kind: 'text'; text: string } | { kind: 'tool_calls'; calls: Array<{ name: string; args: Json }> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : (p as Json)?.text ?? '')).join(' ');
    return '';
}

/** The role markers the harness puts in each agent's system prompt (`ROLE=…`). */
function roleOf(system: string): string {
    return /ROLE=([A-Za-z0-9-]+)/.exec(system)?.[1] ?? 'UNKNOWN';
}

export type Scenario = 'A' | 'B' | 'D';

export function planReply(body: Json): { role: string; reply: Reply } {
    const msgs: Json[] = body.messages ?? [];
    const offered: string[] = (body.tools ?? []).map((t: Json) => t.function?.name).filter(Boolean);
    const system = msgs.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => textOf(m.content)).join('\n');
    const role = roleOf(system);
    const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
    const after = msgs.slice(lastUser + 1);
    const assistantToolTurns = after.filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
    const toolResults = after.filter((m) => m.role === 'tool');
    const call = (name: string, args: Json): Reply => (offered.includes(name)
        ? { kind: 'tool_calls', calls: [{ name, args }] }
        : { kind: 'text', text: `MOCK-ERROR: ${role} wanted to call ${name} but it was not offered (offered: ${offered.join(',') || 'none'})` });

    switch (role) {
        case 'PARENT-A':
            if (assistantToolTurns === 0) return { role, reply: call('delegate_to', { subagent: 'researcher', input: 'Look up the stored note for the topic "latency" and report it verbatim.' }) };
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
            return { role, reply: { kind: 'text', text: 'FINAL: the researcher reported the note and both parallel children finished.' } };
        case 'PARENT-B':
            if (assistantToolTurns === 0) return { role, reply: call('delegate_to', { subagent: 'researcher', input: 'Look up the stored note for the topic "latency" and report it verbatim.' }) };
            return { role, reply: { kind: 'text', text: 'FINAL-B: the researcher reported the note after approval.' } };
        case 'PARENT-D':
            if (assistantToolTurns === 0) return { role, reply: call('delegate_to', { subagent: 'auditor', input: 'Look up the stored notes for "latency" and then for "throughput" and report both.' }) };
            return { role, reply: { kind: 'text', text: 'FINAL-D: the auditor reported both notes after two approvals.' } };
        case 'AUDITOR': {
            // Two lookups, each one asks for approval: the child pauses twice.
            if (toolResults.length < 2) {
                const tool = offered.find((n) => n === 'lookup_note');
                return { role, reply: tool ? call(tool, { topic: toolResults.length === 0 ? 'latency' : 'throughput' }) : { kind: 'text', text: `MOCK-ERROR: auditor has no notes tool (offered: ${offered.join(',') || 'none'})` } };
            }
            const notes = toolResults.map((m) => textOf(m.content).slice(0, 60).replace(/\s+/g, ' ')).join(' | ');
            return { role, reply: { kind: 'text', text: `auditor done: ${notes}` } };
        }
        case 'RESEARCHER': {
            if (toolResults.length === 0) {
                const tool = offered.find((n) => n === 'lookup_note') ?? offered.find((n) => /note/i.test(n));
                return { role, reply: tool ? call(tool, { topic: 'latency' }) : { kind: 'text', text: `MOCK-ERROR: researcher has no notes tool (offered: ${offered.join(',') || 'none'})` } };
            }
            const note = textOf(toolResults[toolResults.length - 1].content).slice(0, 120).replace(/\s+/g, ' ');
            return { role, reply: { kind: 'text', text: `researcher done: ${note}` } };
        }
        case 'CHILD-A': return { role, reply: { kind: 'text', text: 'child-A done' } };
        case 'CHILD-B': return { role, reply: { kind: 'text', text: 'child-B done' } };
        default:
            return { role, reply: { kind: 'text', text: `MOCK-ERROR: unknown caller (offered: ${offered.join(',') || 'none'}; system: ${system.slice(0, 80)})` } };
    }
}

export async function startMockLlm(options: { debug?: boolean } = {}) {
    const issued: IssuedCall[] = [];
    let counter = 0;

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
            const record: IssuedCall = {
                k, role, stream, includeUsage, promptTokens, completionTokens,
                kind: reply.kind,
                toolCalls: reply.kind === 'tool_calls' ? reply.calls.map((c) => c.name) : [],
                ...(reply.kind === 'text' ? { text: reply.text } : {}),
                offered: (body.tools ?? []).map((t: Json) => t.function?.name).filter(Boolean),
                delivered: false,
            };
            if (options.debug) console.log(`    [mock] #${k} ${role} stream=${stream} usage=${includeUsage} offered=[${record.offered.join(',')}] -> ${reply.kind === 'text' ? `text "${reply.text.slice(0, 50)}"` : `tool ${record.toolCalls.join(',')}`}`);

            let aborted = false;
            res.on('close', () => { if (!res.writableEnded) aborted = true; });
            const model = body.model ?? 'mock-gpt';
            const created = Math.floor(Date.now() / 1000);
            const cid = `chatcmpl-mock-${k}`;
            const toolCalls = reply.kind === 'tool_calls'
                ? reply.calls.map((c, i) => ({ id: `call_${k}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }))
                : undefined;

            await sleep(30 + (k % 3) * 20);
            if (aborted) return;

            if (!stream) {
                const message = toolCalls ? { role: 'assistant', content: null, tool_calls: toolCalls } : { role: 'assistant', content: (reply as { text: string }).text };
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ id: cid, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: toolCalls ? 'tool_calls' : 'stop' }], usage }));
                record.delivered = true;
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
            record.delivered = true;
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

/** The sum of what a list of calls issued. */
export function usageOf(calls: readonly IssuedCall[]) {
    return {
        calls: calls.length,
        input: calls.reduce((n, c) => n + c.promptTokens, 0),
        output: calls.reduce((n, c) => n + c.completionTokens, 0),
    };
}
