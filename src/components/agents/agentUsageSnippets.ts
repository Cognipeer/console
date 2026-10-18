/**
 * The code samples of an agent's Usage tab, as plain strings.
 *
 * One pure function turns what the page already knows about the agent (origin, key, published version, the inputs
 * it declares, whether A2A is on) into every snippet the tab shows, grouped by section, so they can be tested
 * without rendering anything: each REST call is checked against openapi.yaml, each input sample against the
 * validator the API runs, and so on.
 *
 * What the samples show, and where the truth is:
 *   - Runs API          POST /agents/{agentKey}/runs, GET /agents/runs/{runId}, ...   (openapi.yaml, client-agent-runs.ts)
 *   - SDK 4.x           agents.runs / agents.responses / agents.routines             (console-sdk 4.0: src/resources)
 *   - OpenAI clients    POST /responses and POST /chat/completions with `model: "agent:<key>"`
 *   - A2A               the agent card and JSON-RPC `message/send`
 *
 * The samples are written to be pasted: every call the agent would refuse is left out. An agent that declares inputs
 * (`config.inputs`) refuses a call without its required ones, on every surface, so each sample carries an `inputs`
 * object prefilled with a value of the right type; an agent that declares none refuses `inputs`, so there is none.
 */

import type { IAgentInputField } from '@/lib/database/provider/types.domain';

/** Where the product documentation lives. */
export const AGENT_DOCS_BASE_URL = 'https://docs.cognipeer.com';

/** The documentation pages the tab links to (`path` is the route of the page on the docs site). */
export const AGENT_DOC_LINKS = [
  { id: 'integrations', path: '/console/guide/integrations/agents/overview' },
  { id: 'runsApi', path: '/console/developer/api/agents#runs-api' },
  { id: 'backgroundRuns', path: '/console/guide/agents/background-runs' },
  // The docs page that covers routines is called "triggers" there.
  { id: 'routines', path: '/console/guide/integrations/agents/triggers' },
  { id: 'webhookTriggers', path: '/console/guide/integrations/agents/webhook-triggers' },
  { id: 'openaiSdk', path: '/console/guide/integrations/agents/openai-sdk' },
  { id: 'n8n', path: '/console/guide/integrations/agents/n8n' },
  { id: 'openWebui', path: '/console/guide/integrations/agents/open-webui' },
  { id: 'litellmA2a', path: '/console/guide/integrations/agents/litellm-and-a2a' },
  { id: 'sdkAgents', path: '/console-sdk/api/agents' },
] as const;

export type AgentDocId = (typeof AGENT_DOC_LINKS)[number]['id'];

export interface AgentUsageSnippetOptions {
  /** Scheme and host of this console, without a path (`https://console.example.com`). */
  origin: string;
  agentKey: string;
  /** The published version number; none (or 0) while the agent was never published. */
  publishedVersion?: number | null;
  /** The inputs the agent declares (`config.inputs`); none or an empty list = it takes none. */
  inputs?: ReadonlyArray<IAgentInputField> | null;
  a2aEnabled: boolean;
  /** The agent card URL of the agent (the token route, or the public one when the agent is exposed publicly). */
  a2aCardUrl: string;
}

export interface AgentUsageSnippets {
  /** `<origin>/api/client/v1` */
  baseUrl: string;
  agentKey: string;
  /** The version a call without `version` runs; null while nothing is published (the draft runs). */
  defaultVersion: number | null;
  /** The agent declares inputs, so every sample passes them. */
  hasInputs: boolean;
  runs: {
    /** Ask and wait up to 30 seconds. */
    start: string;
    /** The two shapes the call answers with: 200 (finished) and 202 (still going). */
    answers: string;
    /** Long-poll, follow the events, cancel. */
    follow: string;
    /** Continue a session. */
    session: string;
    /** `stream: true` and the events it answers with. */
    stream: string;
    /** Deferred / delayed run with a callback and an Idempotency-Key. */
    later: string;
    /** Pin a version. */
    version: string;
    /** Per-request structured output. */
    structured: string;
    /** List runs. */
    list: string;
  };
  sdk: {
    install: string;
    /** Client, start a run, wait for it. */
    start: string;
    /** `wait`, continue a session, pin a version. */
    options: string;
    /** `class: 'deferred'`, `delay_seconds`, `callback`, `idempotencyKey`. */
    later: string;
    /** `response_format` -> `output_parsed`. */
    structured: string;
    /** `events.stream`, `cancel`, `list`. */
    follow: string;
    /** `agents.responses.create` (chat style, streamed). */
    chat: string;
    /** `agents.routines.create` (schedule). */
    routine: string;
  };
  openai: {
    /** Responses API with the OpenAI Python SDK. */
    responses: string;
    /** `background=True` and reading the response back. */
    background: string;
    /** Chat completions, streamed. */
    chat: string;
    chatCurl: string;
    /** `GET /models`: agents are listed as `agent:<key>`. */
    models: string;
  };
  a2a: {
    enabled: boolean;
    cardUrl: string;
    /** The JSON-RPC endpoint (the card URL without `/.well-known/agent-card.json`). */
    endpointUrl: string;
    /** The agent is exposed publicly: no token on the endpoint. */
    isPublic: boolean;
    card: string;
    /** `message/send`; null while A2A is off (there is no endpoint to call). */
    send: string | null;
  };
  docs: Array<{ id: AgentDocId; url: string }>;
}

// ── Values the samples are built from ─────────────────────────────────────

const MESSAGE = 'Hello, how can you help me?';
const AUTH_HEADER = 'Authorization: Bearer YOUR_API_KEY';
const JSON_HEADER = 'Content-Type: application/json';
const API_KEY = 'YOUR_API_KEY';
const CALLBACK_URL = 'https://your-server.example.com/hooks/agent-runs';
/** 16 characters or more: the API refuses a shorter callback secret. */
const CALLBACK_SECRET = 'a-long-random-secret';
const IDEMPOTENCY_KEY = 'weekly-digest-2026-w42';
const SAMPLE_RUN_ID = 'run_6710f3a2c1d4e5b8a9c0d1e3';
const STRUCTURED_MESSAGE = 'Triage this ticket: the checkout page returns a 500 error.';

/** A JSON Schema the agent can enforce: an object with declared properties (see `resolveResponseFormatSchema`). */
export const STRUCTURED_OUTPUT_SAMPLE = {
  name: 'ticket_triage',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      priority: { type: 'string', enum: ['low', 'medium', 'high'] },
      summary: { type: 'string' },
    },
    required: ['priority', 'summary'],
    additionalProperties: false,
  },
} as const;

// ── Inputs ────────────────────────────────────────────────────────────────

/** A declared default is used as the sample only while it stays short; a long text would bury the call. */
const MAX_SAMPLE_DEFAULT_LENGTH = 60;

/**
 * A value that passes the API's check for one declared input: its default (when short), else the first allowed
 * value, else a placeholder of the input's type (`"<name>"`, 1, true, {}).
 */
export function inputPlaceholder(field: IAgentInputField): unknown {
  const preset = field.default;
  if (preset !== undefined && preset !== null && JSON.stringify(preset).length <= MAX_SAMPLE_DEFAULT_LENGTH) return preset;
  if (Array.isArray(field.enum) && field.enum.length > 0) return field.enum[0];
  switch (field.type) {
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return true;
    case 'json':
      return {};
    default:
      return `<${field.name}>`;
  }
}

/** The `inputs` object of the samples, one entry per declared input; null when the agent declares none. */
export function sampleInputs(declared: ReadonlyArray<IAgentInputField> | null | undefined): Record<string, unknown> | null {
  const fields = (declared ?? []).filter((field) => field && typeof field.name === 'string' && field.name.length > 0);
  if (fields.length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field.name] = inputPlaceholder(field);
  return out;
}

// ── Source text of a value ────────────────────────────────────────────────

export type LiteralStyle = 'json' | 'ts' | 'py';

/** A value stays on one line while it is this wide (counting the indent of the line it starts on). */
const INLINE_WIDTH = 72;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function scalar(value: unknown, style: LiteralStyle): string {
  if (value === null || value === undefined) return style === 'py' ? 'None' : 'null';
  if (typeof value === 'boolean') return style === 'py' ? (value ? 'True' : 'False') : String(value);
  if (typeof value === 'string' && style === 'ts') {
    // Single quotes, unless the text holds one and no double quote.
    if (value.includes("'") && !value.includes('"')) return JSON.stringify(value);
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
  }
  return JSON.stringify(value);
}

function propertyName(name: string, style: LiteralStyle): string {
  return style === 'ts' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function inline(value: unknown, style: LiteralStyle): string {
  if (Array.isArray(value)) return `[${value.map((item) => inline(item, style)).join(', ')}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value).map(([name, item]) => `${propertyName(name, style)}: ${inline(item, style)}`);
    if (entries.length === 0) return '{}';
    return style === 'py' ? `{${entries.join(', ')}}` : `{ ${entries.join(', ')} }`;
  }
  return scalar(value, style);
}

/**
 * `value` as source text in the given language. A short object or list stays on one line; a longer one breaks into
 * one entry per line (`expand` forces that for the outermost one). Two spaces per level, four for Python.
 */
export function formatLiteral(value: unknown, style: LiteralStyle, level = 0, options: { expand?: boolean } = {}): string {
  const step = style === 'py' ? '    ' : '  ';
  const render = (node: unknown, depth: number, expand: boolean): string => {
    const flat = inline(node, style);
    const container = Array.isArray(node) ? node.length > 0 : isRecord(node) && Object.keys(node).length > 0;
    if (!container || (!expand && flat.length + depth * step.length <= INLINE_WIDTH)) return flat;
    const pad = step.repeat(depth + 1);
    const close = step.repeat(depth);
    // JSON takes no trailing comma; the other two languages are written with one.
    const tail = style === 'json' ? '' : ',';
    if (Array.isArray(node)) {
      return `[\n${node.map((item) => `${pad}${render(item, depth + 1, false)}`).join(',\n')}${tail}\n${close}]`;
    }
    const lines = Object.entries(node as Record<string, unknown>).map(
      ([name, item]) => `${pad}${propertyName(name, style)}: ${render(item, depth + 1, false)}`,
    );
    return `{\n${lines.join(',\n')}${tail}\n${close}}`;
  };
  return render(value, level, options.expand === true);
}

// ── curl ──────────────────────────────────────────────────────────────────

interface CurlOptions {
  url: string;
  /** GET unless given. */
  method?: 'POST';
  /** `-N`: print an event stream as it arrives. */
  noBuffer?: boolean;
  headers?: string[];
  body?: unknown;
}

/** A JSON body as a `-d '...'` argument; an apostrophe inside it is escaped for the shell. */
function jsonBody(body: unknown): string {
  const json = formatLiteral(body, 'json', 0, { expand: true }).replace(/'/g, "'\\''");
  return `-d '${json.split('\n').join('\n  ')}'`;
}

function curl({ url, method, noBuffer, headers = [], body }: CurlOptions): string {
  // A `?`, `&` or `$` in the URL needs quotes in a shell.
  const target = /[?&$]/.test(url) ? `"${url}"` : url;
  const first = ['curl', noBuffer ? '-N' : '', method === 'POST' ? '-X POST' : '', target].filter(Boolean).join(' ');
  const pieces = [first, ...headers.map((header) => `-H "${header}"`)];
  if (body !== undefined) pieces.push(jsonBody(body));
  return pieces.map((piece, index) => (index === 0 ? piece : `  ${piece}`)).join(' \\\n');
}

/** One server-sent event as it appears on the wire. */
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}`;

// ── The snippets ──────────────────────────────────────────────────────────

export function buildAgentUsageSnippets(options: AgentUsageSnippetOptions): AgentUsageSnippets {
  const { origin, agentKey, a2aEnabled, a2aCardUrl } = options;
  const baseUrl = `${origin}/api/client/v1`;
  const defaultVersion = typeof options.publishedVersion === 'number' && options.publishedVersion > 0 ? options.publishedVersion : null;
  const pinned: number | 'draft' = defaultVersion ?? 'draft';
  const inputs = sampleInputs(options.inputs);
  const withInputs = inputs ? { inputs } : {};

  const runsUrl = `${baseUrl}/agents/${agentKey}/runs`;
  const post = (body: unknown, extraHeaders: string[] = [], noBuffer = false) =>
    curl({ url: runsUrl, method: 'POST', noBuffer, headers: [AUTH_HEADER, JSON_HEADER, ...extraHeaders], body });
  const structuredFormat = { type: 'json_schema', json_schema: STRUCTURED_OUTPUT_SAMPLE };

  // ── Runs API (REST) ─────────────────────────────────────────────────────

  const finished = {
    id: 'run_6710f3a2c1d4e5b8a9c0d1e2',
    object: 'agent.run',
    status: 'succeeded',
    class: 'default',
    agent: agentKey,
    version: null,
    session_id: '6710f3a2c1d4e5b8a9c0d1e1',
    channel: 'runs',
    trigger: 'request',
    stop_reason: 'end_turn',
    result: {
      id: 'resp_6710f3a2c1d4e5b8a9c0d1e2',
      object: 'response',
      status: 'completed',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello! I can help with ...' }] },
      ],
      usage: { input_tokens: 1180, output_tokens: 64, total_tokens: 1244 },
    },
    output_text: 'Hello! I can help with ...',
    output_parsed: null,
    error: null,
    created_at: 1760693510,
    started_at: 1760693510,
    completed_at: 1760693516,
  };
  const accepted = {
    id: SAMPLE_RUN_ID,
    object: 'agent.run',
    status: 'queued',
    class: 'default',
    agent: agentKey,
    version: null,
    session_id: '6710f3a2c1d4e5b8a9c0d1e4',
    channel: 'runs',
    trigger: 'request',
    result: null,
    output_text: null,
    error: null,
    created_at: 1760693520,
  };

  const runs: AgentUsageSnippets['runs'] = {
    start: post({ input: MESSAGE, ...withInputs, wait: 30 }),
    answers: [
      'HTTP/1.1 200 OK',
      formatLiteral(finished, 'json', 0, { expand: true }),
      '',
      'HTTP/1.1 202 Accepted',
      `Location: /api/client/v1/agents/runs/${SAMPLE_RUN_ID}`,
      'Retry-After: 2',
      formatLiteral(accepted, 'json', 0, { expand: true }),
    ].join('\n'),
    follow: [
      '# The run id is the "id" of the answer',
      `RUN_ID=${SAMPLE_RUN_ID}`,
      '',
      '# Long-poll: answers as soon as the run finishes, or after 30 s with the run as it stands',
      curl({ url: `${baseUrl}/agents/runs/$RUN_ID?wait=30`, headers: [AUTH_HEADER] }),
      '',
      '# Server-sent events of the run; close the stream on session.status_idle',
      curl({ url: `${baseUrl}/agents/runs/$RUN_ID/events/stream`, noBuffer: true, headers: [AUTH_HEADER] }),
      '',
      '# Cancel it',
      curl({ url: `${baseUrl}/agents/runs/$RUN_ID/cancel`, method: 'POST', headers: [AUTH_HEADER] }),
    ].join('\n'),
    session: [
      '# Continue the conversation: send the session_id the first run answered with',
      post({ session_id: '<session_id>', input: 'Tell me more about that', ...withInputs, wait: 30 }),
    ].join('\n'),
    stream: [
      post({ input: MESSAGE, ...withInputs, stream: true }, [], true),
      '',
      '# The answer is a stream of Responses events:',
      sse('response.created', {
        type: 'response.created',
        sequence_number: 0,
        response: {
          id: `resp_${SAMPLE_RUN_ID.slice('run_'.length)}`,
          object: 'response',
          status: 'in_progress',
          model: agentKey,
          cognipeer: { run_id: SAMPLE_RUN_ID, session_id: '6710f3a2c1d4e5b8a9c0d1e4' },
        },
      }),
      '',
      sse('response.output_text.delta', {
        type: 'response.output_text.delta',
        sequence_number: 4,
        item_id: 'msg_01',
        output_index: 0,
        content_index: 0,
        delta: 'Hello',
      }),
      '',
      sse('response.completed', {
        type: 'response.completed',
        sequence_number: 9,
        response: { id: `resp_${SAMPLE_RUN_ID.slice('run_'.length)}`, object: 'response', status: 'completed', output_text: 'Hello! I can help with ...' },
      }),
    ].join('\n'),
    later: post(
      {
        input: 'Prepare the weekly digest.',
        ...withInputs,
        class: 'deferred',
        delay_seconds: 3600,
        callback: { url: CALLBACK_URL, secret: CALLBACK_SECRET },
      },
      [`Idempotency-Key: ${IDEMPOTENCY_KEY}`],
    ),
    version: post({ input: MESSAGE, ...withInputs, version: pinned }),
    structured: [
      post({ input: STRUCTURED_MESSAGE, ...withInputs, wait: 30, response_format: structuredFormat }),
      '',
      '# The run answers with the validated object in "output_parsed":',
      '# { "priority": "high", "summary": "Checkout fails with a server error." }',
    ].join('\n'),
    list: curl({
      url: `${baseUrl}/agents/runs?agent=${agentKey}&status=queued,running&limit=20`,
      headers: [AUTH_HEADER],
    }),
  };

  // ── TypeScript SDK 4.x ──────────────────────────────────────────────────

  const key = scalar(agentKey, 'ts');
  const hasInputs = inputs !== null;
  const inputsLine = hasInputs ? ['  inputs,'] : [];
  const pinnedLiteral = scalar(pinned, 'ts');
  const typedResponseFormat = formatLiteral(structuredFormat, 'ts', 1);

  const sdk: AgentUsageSnippets['sdk'] = {
    install: 'npm install @cognipeer/console-sdk@^4',
    start: [
      "import { ConsoleClient } from '@cognipeer/console-sdk';",
      '',
      'const client = new ConsoleClient({',
      `  apiKey: '${API_KEY}',`,
      `  baseURL: ${scalar(origin, 'ts')},`,
      '});',
      ...(inputs ? ['', '// The inputs this agent declares.', `const inputs = ${formatLiteral(inputs, 'ts', 0)};`] : []),
      '',
      '// Start a run, then wait for it (the SDK long-polls for you).',
      `const run = await client.agents.runs.create(${key}, {`,
      `  input: ${scalar(MESSAGE, 'ts')},`,
      ...inputsLine,
      '});',
      'const done = await client.agents.runs.wait(run.id);',
      '',
      "if (done.status === 'succeeded') console.log(done.output_text);",
      "else console.error('Run did not succeed:', done.status, done.error?.message);",
    ].join('\n'),
    options: [
      '// Hold the call for the answer. A run that takes longer comes back running, not as an error.',
      `const quick = await client.agents.runs.create(${key}, {`,
      "  input: 'Hi',",
      ...inputsLine,
      '  wait: 30,',
      '});',
      '',
      '// Continue the conversation with the session of the previous run.',
      `const next = await client.agents.runs.create(${key}, {`,
      "  input: 'Tell me more about that',",
      ...inputsLine,
      '  session_id: done.session_id,',
      '});',
      '',
      "// Pin a version ('draft' runs the unpublished draft).",
      `const pinned = await client.agents.runs.create(${key}, {`,
      "  input: 'Hello!',",
      ...inputsLine,
      `  version: ${pinnedLiteral},`,
      '});',
    ].join('\n'),
    later: [
      '// Low priority, in an hour, with a signed callback when it ends.',
      '// The idempotency key makes a retried call return the same run; the SDK adds one when you leave it out.',
      'const job = await client.agents.runs.create(',
      `  ${key},`,
      '  {',
      "    input: 'Prepare the weekly digest.',",
      ...(hasInputs ? ['    inputs,'] : []),
      "    class: 'deferred',",
      '    delay_seconds: 3600,',
      `    callback: { url: '${CALLBACK_URL}', secret: '${CALLBACK_SECRET}' },`,
      '  },',
      `  { idempotencyKey: '${IDEMPOTENCY_KEY}' },`,
      ');',
      "console.log(job.status); // 'scheduled'",
    ].join('\n'),
    structured: [
      `const typed = await client.agents.runs.create(${key}, {`,
      `  input: ${scalar(STRUCTURED_MESSAGE, 'ts')},`,
      ...inputsLine,
      `  response_format: ${typedResponseFormat},`,
      '});',
      'const result = await client.agents.runs.wait(typed.id);',
      "console.log(result.output_parsed); // { priority: 'high', summary: '...' }",
    ].join('\n'),
    follow: [
      "import { isSessionEvent } from '@cognipeer/console-sdk';",
      '',
      "// Follow a run live: the answer as it is written, tool calls, status.",
      'for await (const event of client.agents.runs.events.stream(run.id)) {',
      "  if (event.type === 'agent.message.delta') process.stdout.write((event.data as { text: string }).text); // live only",
      "  if (isSessionEvent(event, 'agent.tool_use')) console.log('tool:', event.data.name);",
      "  if (isSessionEvent(event, 'session.status_idle')) break; // the stream does not end by itself",
      '}',
      '',
      '// Stop a run that is still going.',
      'await client.agents.runs.cancel(run.id);',
      '',
      '// List runs, newest first; pages are fetched as you iterate.',
      `for await (const item of client.agents.runs.list({ agent: ${key}, status: ['queued', 'running'] })) {`,
      '  console.log(item.id, item.status);',
      '}',
    ].join('\n'),
    chat: [
      "import { isResponseStreamEvent } from '@cognipeer/console-sdk';",
      '',
      '// Chat style: the OpenAI Responses shape, one call per turn.',
      'const res = await client.agents.responses.create({',
      `  model: ${key},`,
      `  input: ${scalar(MESSAGE, 'ts')},`,
      ...inputsLine,
      '});',
      'console.log(res.output_text);',
      '',
      '// Continue the conversation.',
      'const followUp = await client.agents.responses.create({',
      `  model: ${key},`,
      "  input: 'Tell me more about that',",
      ...inputsLine,
      '  previous_response_id: res.id,',
      '});',
      '',
      '// Stream the answer.',
      'const stream = await client.agents.responses.create({',
      `  model: ${key},`,
      "  input: 'Hello!',",
      ...inputsLine,
      '  stream: true,',
      '});',
      'for await (const event of stream) {',
      "  if (isResponseStreamEvent(event, 'response.output_text.delta')) process.stdout.write(event.delta);",
      '}',
    ].join('\n'),
    routine: [
      '// A routine starts the agent on a schedule, once, by hand or from a webhook.',
      `const routine = await client.agents.routines.create(${key}, {`,
      "  name: 'Weekday digest',",
      "  trigger: { type: 'schedule', cron: '0 9 * * 1-5', timezone: 'UTC' },",
      "  prompt: 'Summarise yesterday.',",
      ...inputsLine,
      "  class: 'deferred',",
      '});',
      '',
      '// Fire it now.',
      `await client.agents.routines.run(${key}, routine.id);`,
    ].join('\n'),
  };

  // ── OpenAI-compatible endpoints ─────────────────────────────────────────

  const model = `agent:${agentKey}`;
  const extraBody = inputs ? ['    extra_body={"inputs": inputs},'] : [];
  const pyClient = `client = OpenAI(base_url="${baseUrl}", api_key="${API_KEY}")`;

  const openai: AgentUsageSnippets['openai'] = {
    responses: [
      'from openai import OpenAI',
      '',
      pyClient,
      ...(inputs ? ['', '# The inputs this agent declares.', `inputs = ${formatLiteral(inputs, 'py', 0)}`] : []),
      '',
      'response = client.responses.create(',
      `    model="${model}",`,
      `    input="${MESSAGE}",`,
      ...extraBody,
      ')',
      'print(response.output_text)',
      '',
      '# Continue the conversation',
      'follow_up = client.responses.create(',
      `    model="${model}",`,
      '    input="Tell me more about that",',
      '    previous_response_id=response.id,',
      ...extraBody,
      ')',
      'print(follow_up.output_text)',
    ].join('\n'),
    background: [
      'import time',
      '',
      '# background=True answers at once (HTTP 202) with the run queued',
      'job = client.responses.create(',
      `    model="${model}",`,
      '    input="Research this topic in depth and summarize the findings.",',
      '    background=True,',
      ...extraBody,
      ')',
      '',
      '# Read it back by id until it leaves "queued" and "in_progress"',
      'while job.status in ("queued", "in_progress"):',
      '    time.sleep(2)',
      '    job = client.responses.retrieve(job.id)',
      '',
      'print(job.status, job.output_text)',
    ].join('\n'),
    chat: [
      'stream = client.chat.completions.create(',
      `    model="${model}",`,
      `    messages=[{"role": "user", "content": "${MESSAGE}"}],`,
      '    stream=True,',
      ...extraBody,
      ')',
      'for chunk in stream:',
      '    if chunk.choices:',
      '        print(chunk.choices[0].delta.content or "", end="")',
    ].join('\n'),
    chatCurl: curl({
      url: `${baseUrl}/chat/completions`,
      method: 'POST',
      noBuffer: true,
      headers: [AUTH_HEADER, JSON_HEADER],
      body: { model, messages: [{ role: 'user', content: MESSAGE }], ...withInputs, stream: true },
    }),
    models: curl({ url: `${baseUrl}/models`, headers: [AUTH_HEADER] }),
  };

  // ── A2A ─────────────────────────────────────────────────────────────────

  const endpointUrl = a2aCardUrl.replace(/\/\.well-known\/agent-card\.json$/, '');
  const isPublic = endpointUrl.includes('/api/public/');
  const a2aHeaders = isPublic ? [] : [AUTH_HEADER];
  const a2a: AgentUsageSnippets['a2a'] = {
    enabled: a2aEnabled,
    cardUrl: a2aCardUrl,
    endpointUrl,
    isPublic,
    card: curl({ url: a2aCardUrl, headers: a2aHeaders }),
    send: a2aEnabled
      ? [
        curl({
          url: endpointUrl,
          method: 'POST',
          headers: [...a2aHeaders, JSON_HEADER],
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'message/send',
            params: {
              message: {
                role: 'user',
                messageId: 'msg-1',
                parts: [{ kind: 'text', text: MESSAGE }, ...(inputs ? [{ kind: 'data', data: inputs }] : [])],
              },
            },
          },
        }),
        '',
        '# Continue the same conversation: set params.message.contextId',
        '# to the "contextId" returned in the previous task.',
      ].join('\n')
      : null,
  };

  return {
    baseUrl,
    agentKey,
    defaultVersion,
    hasInputs,
    runs,
    sdk,
    openai,
    a2a,
    docs: AGENT_DOC_LINKS.map((link) => ({ id: link.id, url: `${AGENT_DOCS_BASE_URL}${link.path}` })),
  };
}
