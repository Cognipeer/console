/**
 * The code samples of an agent's Usage tab, as plain strings.
 *
 * One pure function turns what the page already knows about the agent (origin, key, published version, the variables
 * a call has to supply, whether A2A is on) into every snippet the tab shows, grouped by section, so they can be tested
 * without rendering anything: each REST call is checked against openapi.yaml, each variables sample against the
 * validator the API runs, and so on.
 *
 * What the samples show, and where the truth is:
 *   - Runs API          POST /agents/{agentKey}/runs, GET /agents/runs/{runId}, ...   (openapi.yaml, client-agent-runs.ts)
 *   - SDK 4.x           agents.runs / agents.responses / agents.triggers             (console-sdk 4.0: src/resources)
 *   - OpenAI clients    POST /responses and POST /chat/completions with `model: "agent:<key>"`
 *   - A2A               the agent card and JSON-RPC `message/send`
 *
 * The samples are written to be pasted: every call the agent would refuse is left out. An agent that declares variables
 * (`config.variables`) refuses a call without its required ones (400 `invalid_variables`), on every surface, so each
 * sample carries a `variables` object prefilled with a value of the right type; an agent that declares none refuses
 * `variables`, so there is none. A call without `version` runs the published snapshot, so the page hands this module
 * the variables of that snapshot (the draft's only while nothing is published), not the draft's.
 */

import type { IAgentVariable } from '@/lib/database/provider/types.domain';
import type { DocId } from '@/lib/docs/docsLinks';

/** The API reference of the runs API (a docs-links page): the link in the header of the tab (the list of guides does not repeat it). */
export const AGENT_REFERENCE_DOC = 'agents-runs-api' satisfies DocId;

/** The guides the tab lists: `id` names the label (`agents.usage.docs.<id>`), `doc` the docs-links page. */
export const AGENT_DOC_LINKS = [
  { id: 'integrations', doc: 'agents-integrations' },
  { id: 'backgroundRuns', doc: 'agents-background-runs' },
  { id: 'triggers', doc: 'agents-triggers' },
  { id: 'webhookTriggers', doc: 'agents-webhook-triggers' },
  { id: 'openaiSdk', doc: 'agents-openai-sdk' },
  { id: 'n8n', doc: 'agents-n8n' },
  { id: 'openWebui', doc: 'agents-open-webui' },
  { id: 'litellmA2a', doc: 'agents-litellm-a2a' },
  { id: 'sdkAgents', doc: 'sdk-agents' },
] as const satisfies ReadonlyArray<{ id: string; doc: DocId }>;

export type AgentDocId = (typeof AGENT_DOC_LINKS)[number]['id'];

/** Where the agent card sits under the endpoint of an A2A agent. */
export const A2A_CARD_PATH = '/.well-known/agent-card.json';

export interface AgentUsageSnippetOptions {
  /** Scheme and host of this console, without a path (`https://console.example.com`). */
  origin: string;
  agentKey: string;
  /** The published version number; none (or 0) while the agent was never published. */
  publishedVersion?: number | null;
  /**
   * The variables a call has to supply (`config.variables`); none or an empty list = the agent takes none. A call runs
   * the published version and is checked against its declaration, so pass the published snapshot's variables (the
   * draft's only while nothing is published).
   */
  variables?: ReadonlyArray<IAgentVariable> | null;
  a2aEnabled: boolean;
  /** The JSON-RPC endpoint of the agent: the token route, or the public one while the agent is exposed publicly. */
  a2aEndpointUrl: string;
  /** The agent is exposed publicly: its endpoint takes no token. */
  a2aIsPublic: boolean;
}

/** What an SDK example uses from the examples above it (its caption names them). */
export type SdkReuse = 'client' | 'run' | 'done' | 'job' | 'variables';

export interface AgentUsageSnippets {
  /** `<origin>/api/client/v1` */
  baseUrl: string;
  agentKey: string;
  /** The version a call without `version` runs; null while nothing is published (the draft runs). */
  defaultVersion: number | null;
  /** The agent declares variables, so every sample passes them. */
  hasVariables: boolean;
  /** The API reference the header of the tab links to (a docs-links page). */
  referenceDoc: DocId;
  runs: {
    /** Ask and wait up to 30 seconds. */
    start: string;
    /** The shapes the call answers with: 200 (finished or paused) and 202 (still going). */
    answers: string;
    /** Long-poll a run that is still going. */
    poll: string;
    /** Follow its events (server-sent events). */
    events: string;
    /** Cancel it. */
    cancel: string;
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
    /** `events.stream`. */
    follow: string;
    /** `cancel` and `list`. */
    manage: string;
    /** `agents.responses.create` (chat style, streamed). */
    chat: string;
    /** `agents.triggers.create` (schedule) and `run`. */
    trigger: string;
  };
  /** What each SDK example (all but `install` and `start`) uses from the ones above it. */
  sdkReuses: Record<Exclude<keyof AgentUsageSnippets['sdk'], 'install' | 'start'>, SdkReuse[]>;
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
    card: string;
    /** `message/send`; null while A2A is off (there is no endpoint to call). */
    send: string | null;
  };
  docs: Array<{ id: AgentDocId; doc: DocId }>;
}

// ── Values the samples are built from ─────────────────────────────────────

const MESSAGE = 'Hello, how can you help me?';
const AUTH_HEADER = 'Authorization: Bearer YOUR_API_KEY';
const JSON_HEADER = 'Content-Type: application/json';
const API_KEY = 'YOUR_API_KEY';
/** The API resolves the host of a callback and refuses one that is not public (`400 invalid_callback`): the host must resolve. */
const CALLBACK_URL = 'https://example.com/hooks/agent-runs';
/** 16 characters or more: the API refuses a shorter callback secret. */
const CALLBACK_SECRET = 'a-long-random-secret';
/** One key per job: the same key on another request is `409 idempotency_key_conflict`, so it carries the agent's key. */
const idempotencyKeyFor = (agentKey: string) => `${agentKey}-weekly-digest-2026-w42`;
const FINISHED_RUN_ID = 'run_0b7e5a1c-3f2d-4c8e-9a61-5d2f7c8e4b10';
const SAMPLE_RUN_ID = 'run_0b7e5a1c-3f2d-4c8e-9a61-5d2f7c8e4b11';
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

// ── Variables ─────────────────────────────────────────────────────────────

/** A declared default is used as the sample only while it stays short; a long text would bury the call. */
const MAX_SAMPLE_DEFAULT_LENGTH = 60;

/**
 * A value that passes the API's check for one declared variable: its default (when short), else the first allowed
 * value, else a placeholder of the variable's type (`"<name>"`, 1, true, {}).
 */
export function variablePlaceholder(field: IAgentVariable): unknown {
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

/** The `variables` object of the samples, one entry per declared variable; null when the agent declares none. */
export function sampleVariables(declared: ReadonlyArray<IAgentVariable> | null | undefined): Record<string, unknown> | null {
  // A declaration that is not a list (a damaged snapshot) declares nothing.
  const fields = (Array.isArray(declared) ? declared : []).filter(
    (field) => field && typeof field.name === 'string' && field.name.length > 0,
  );
  if (fields.length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field.name] = variablePlaceholder(field);
  return out;
}

/**
 * The variables a call without `version` has to supply: those of the version it runs. That is the published snapshot,
 * so a draft edit that adds or drops a variable changes nothing for callers until it is published. The draft's only
 * count while nothing is published, or when the snapshot is not there (never fetched, missing, or the request failed:
 * the API treats a missing snapshot the same way, and the draft is the best guess left).
 */
export function variablesOfRunVersion(input: {
  publishedVersion?: number | null;
  /** `config` of the published snapshot once it was fetched; null while it is not there. */
  publishedConfig: Record<string, unknown> | null;
  /** `config.variables` of the draft. */
  draftVariables?: ReadonlyArray<IAgentVariable>;
}): ReadonlyArray<IAgentVariable> | undefined {
  const published = typeof input.publishedVersion === 'number' && input.publishedVersion > 0;
  if (published && input.publishedConfig) return input.publishedConfig.variables as ReadonlyArray<IAgentVariable> | undefined;
  return input.draftVariables;
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
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`;
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

/** One server-sent event as it appears on the wire, written as a comment so the block that holds it can be pasted. */
const sse = (event: string, data: unknown) => `# event: ${event}\n# data: ${JSON.stringify(data)}`;

// ── Calls the tab and the rest of the agent page share ────────────────────

/** `POST /chat/completions` for an agent (`agent:<key>`), with the sampled variables when it declares any. */
export function chatCompletionsCurl(options: {
  baseUrl: string;
  agentKey: string;
  /** The sampled variables (`sampleVariables`); null when the agent declares none. */
  variables: Record<string, unknown> | null;
  /** Stream the answer (the Usage tab does; a quick start reads one JSON answer). */
  stream: boolean;
}): string {
  const { baseUrl, agentKey, variables, stream } = options;
  return curl({
    url: `${baseUrl}/chat/completions`,
    method: 'POST',
    noBuffer: stream,
    headers: [AUTH_HEADER, JSON_HEADER],
    body: {
      model: `agent:${agentKey}`,
      messages: [{ role: 'user', content: MESSAGE }],
      ...(variables ? { variables } : {}),
      ...(stream ? { stream: true } : {}),
    },
  });
}

/** JSON-RPC `message/send` to the A2A endpoint of an agent; a public endpoint takes no token. */
export function a2aSendCurl(options: {
  endpointUrl: string;
  isPublic: boolean;
  /** The sampled variables (`sampleVariables`); they travel in a `data` part. */
  variables: Record<string, unknown> | null;
}): string {
  const { endpointUrl, isPublic, variables } = options;
  return [
    curl({
      url: endpointUrl,
      method: 'POST',
      headers: [...(isPublic ? [] : [AUTH_HEADER]), JSON_HEADER],
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            messageId: 'msg-1',
            parts: [{ kind: 'text', text: MESSAGE }, ...(variables ? [{ kind: 'data', data: variables }] : [])],
          },
        },
      },
    }),
    '',
    '# Continue the same conversation: set params.message.contextId',
    '# to the "contextId" returned in the previous task.',
  ].join('\n');
}

// ── The snippets ──────────────────────────────────────────────────────────

export function buildAgentUsageSnippets(options: AgentUsageSnippetOptions): AgentUsageSnippets {
  const { origin, agentKey, a2aEnabled, a2aEndpointUrl, a2aIsPublic } = options;
  const baseUrl = `${origin}/api/client/v1`;
  const defaultVersion = typeof options.publishedVersion === 'number' && options.publishedVersion > 0 ? options.publishedVersion : null;
  const pinned: number | 'draft' = defaultVersion ?? 'draft';
  const variables = sampleVariables(options.variables);
  const withVariables = variables ? { variables } : {};
  const idempotencyKey = idempotencyKeyFor(agentKey);

  const runsUrl = `${baseUrl}/agents/${agentKey}/runs`;
  const post = (body: unknown, extraHeaders: string[] = [], noBuffer = false) =>
    curl({ url: runsUrl, method: 'POST', noBuffer, headers: [AUTH_HEADER, JSON_HEADER, ...extraHeaders], body });
  const structuredFormat = { type: 'json_schema', json_schema: STRUCTURED_OUTPUT_SAMPLE };

  // ── Runs API (REST) ─────────────────────────────────────────────────────

  // Both answers carry every field the API returns for a run (`serializeAgentRun`); `result` is shortened.
  const finished = {
    id: FINISHED_RUN_ID,
    object: 'agent.run',
    status: 'succeeded',
    class: 'default',
    agent: agentKey,
    version: null,
    session_id: '7c3e9f20-5a1b-4d6e-8f42-1b9a0c6d2e51',
    conversation_id: '7c3e9f20-5a1b-4d6e-8f42-1b9a0c6d2e51',
    channel: 'runs',
    trigger: 'request',
    trigger_id: null,
    metadata: {},
    stop_reason: 'end_turn',
    result: {
      id: `resp_${FINISHED_RUN_ID.slice('run_'.length)}`,
      object: 'response',
      status: 'completed',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello! I can help with ...' }] },
      ],
      usage: { input_tokens: 1180, output_tokens: 64, total_tokens: 1244 },
    },
    output_text: 'Hello! I can help with ...',
    output_parsed: null,
    output_error: null,
    error: null,
    scheduled_for: null,
    created_at: 1760693510,
    started_at: 1760693510,
    completed_at: 1760693516,
    detached_at: null,
    cancel_requested_at: null,
    max_duration_ms: 1800000,
    callback: null,
  };
  // The call waited 30 seconds and gave up (`detached_at`): the run went on.
  const accepted = {
    id: SAMPLE_RUN_ID,
    object: 'agent.run',
    status: 'running',
    class: 'default',
    agent: agentKey,
    version: null,
    session_id: '7c3e9f20-5a1b-4d6e-8f42-1b9a0c6d2e52',
    conversation_id: '7c3e9f20-5a1b-4d6e-8f42-1b9a0c6d2e52',
    channel: 'runs',
    trigger: 'request',
    trigger_id: null,
    metadata: {},
    stop_reason: null,
    result: null,
    output_text: null,
    output_parsed: null,
    output_error: null,
    error: null,
    scheduled_for: null,
    created_at: 1760693520,
    started_at: 1760693520,
    completed_at: null,
    detached_at: 1760693550,
    cancel_requested_at: null,
    max_duration_ms: 1800000,
    callback: null,
  };

  const runUrl = `${baseUrl}/agents/runs/$RUN_ID`;
  /** Each call that follows a run starts from its id, so each one can be pasted on its own. */
  const runIdLines = ['# Replace with the "id" of the run you started (the 202 answer above carries it)', `RUN_ID=${SAMPLE_RUN_ID}`, ''];

  const runs: AgentUsageSnippets['runs'] = {
    start: post({ input: MESSAGE, ...withVariables, wait: 30 }),
    answers: [
      'HTTP/1.1 200 OK',
      formatLiteral(finished, 'json', 0, { expand: true }),
      '',
      'HTTP/1.1 202 Accepted',
      `Location: /api/client/v1/agents/runs/${SAMPLE_RUN_ID}`,
      'Retry-After: 2',
      formatLiteral(accepted, 'json', 0, { expand: true }),
    ].join('\n'),
    poll: [
      ...runIdLines,
      '# Answers as soon as the run finishes, or after 30 s with the run as it stands',
      curl({ url: `${runUrl}?wait=30`, headers: [AUTH_HEADER] }),
    ].join('\n'),
    events: [
      ...runIdLines,
      '# The stream does not end by itself: stop it (Ctrl-C) once session.status_idle arrives',
      curl({ url: `${runUrl}/events/stream`, noBuffer: true, headers: [AUTH_HEADER] }),
    ].join('\n'),
    cancel: [
      ...runIdLines,
      '# A run that already finished answers 409 agent_run_already_terminal',
      curl({ url: `${runUrl}/cancel`, method: 'POST', headers: [AUTH_HEADER] }),
    ].join('\n'),
    session: [
      '# Continue the conversation: send the session_id the first run answered with',
      post({ session_id: '<session_id>', input: 'Tell me more about that', ...withVariables, wait: 30 }),
    ].join('\n'),
    stream: [
      post({ input: MESSAGE, ...withVariables, stream: true }, [], true),
      '',
      '# The answer is a stream of Responses events (abridged; the first one names the run and the session):',
      sse('response.created', {
        type: 'response.created',
        response: { cognipeer: { run_id: 'run_0b7e5a1c...', session_id: '7c3e9f20...' } },
      }),
      '#',
      sse('response.output_text.delta', { type: 'response.output_text.delta', delta: 'Hello' }),
      '#',
      sse('response.completed', {
        type: 'response.completed',
        response: { status: 'completed', output_text: 'Hello! I can help with ...' },
      }),
    ].join('\n'),
    later: post(
      {
        input: 'Prepare the weekly digest.',
        ...withVariables,
        class: 'deferred',
        delay_seconds: 3600,
        callback: { url: CALLBACK_URL, secret: CALLBACK_SECRET },
      },
      [`Idempotency-Key: ${idempotencyKey}`],
    ),
    version: post({ input: MESSAGE, ...withVariables, wait: 30, version: pinned }),
    structured: [
      post({ input: STRUCTURED_MESSAGE, ...withVariables, wait: 30, response_format: structuredFormat }),
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
  // `agent:<key>` always names an agent; a bare key would pick a model with the same name first.
  const chatModel = scalar(`agent:${agentKey}`, 'ts');
  const hasVariables = variables !== null;
  const variablesLine = hasVariables ? ['  variables,'] : [];
  const pinnedLiteral = scalar(pinned, 'ts');
  const structuredResponseFormat = formatLiteral(structuredFormat, 'ts', 1);

  const sdk: AgentUsageSnippets['sdk'] = {
    // Release order: console-sdk 4.0.0 is not on npm yet; it has to be published before a console build that carries this
    // tab ships, or `^4` finds nothing to install.
    install: 'npm install @cognipeer/console-sdk@^4',
    start: [
      "import { ConsoleClient } from '@cognipeer/console-sdk';",
      '',
      'const client = new ConsoleClient({',
      `  apiKey: '${API_KEY}',`,
      `  baseURL: ${scalar(origin, 'ts')},`,
      '});',
      ...(variables ? ['', '// The variables this agent declares.', `const variables = ${formatLiteral(variables, 'ts', 0)};`] : []),
      '',
      '// Start a run, then wait for it (the SDK long-polls for you).',
      `const run = await client.agents.runs.create(${key}, {`,
      `  input: ${scalar(MESSAGE, 'ts')},`,
      ...variablesLine,
      '});',
      'const done = await client.agents.runs.wait(run.id);',
      '',
      '// A run can also pause (requires_action) for an approval or an answer: it is waiting, not failed.',
      '// Answer it with client.agents.runs.resolveAction(done.id, actionId, body).',
      "if (done.status === 'succeeded') console.log(done.output_text);",
      "else if (done.status === 'requires_action') console.log('Waiting for an approval or an answer:', done.id);",
      "else console.error('Run did not succeed:', done.status, done.error?.message);",
    ].join('\n'),
    options: [
      '// Hold the call for the answer. A run that takes longer comes back running, not as an error.',
      `const quick = await client.agents.runs.create(${key}, {`,
      "  input: 'Hi',",
      ...variablesLine,
      '  wait: 30,',
      '});',
      '',
      '// Continue the conversation with the session of the previous run.',
      `const next = await client.agents.runs.create(${key}, {`,
      "  input: 'Tell me more about that',",
      ...variablesLine,
      '  session_id: done.session_id,',
      '  wait: 30,',
      '});',
      '',
      "// Pin a version ('draft' runs the unpublished draft).",
      `const pinned = await client.agents.runs.create(${key}, {`,
      "  input: 'Hello!',",
      ...variablesLine,
      `  version: ${pinnedLiteral},`,
      '  wait: 30,',
      '});',
    ].join('\n'),
    later: [
      '// Low priority, in an hour, with a signed callback when it ends.',
      '// Put a public HTTPS endpoint of yours in the callback URL: the API refuses a host it cannot resolve.',
      '// A retry with the same idempotency key returns the same run, so give each job a key of its own.',
      '// The SDK adds a fresh key when you leave it out.',
      'const job = await client.agents.runs.create(',
      `  ${key},`,
      '  {',
      "    input: 'Prepare the weekly digest.',",
      ...(hasVariables ? ['    variables,'] : []),
      "    class: 'deferred',",
      '    delay_seconds: 3600,',
      `    callback: { url: '${CALLBACK_URL}', secret: '${CALLBACK_SECRET}' },`,
      '  },',
      `  { idempotencyKey: '${idempotencyKey}' },`,
      ');',
      "console.log(job.status); // 'scheduled'",
    ].join('\n'),
    structured: [
      `const structured = await client.agents.runs.create(${key}, {`,
      `  input: ${scalar(STRUCTURED_MESSAGE, 'ts')},`,
      ...variablesLine,
      `  response_format: ${structuredResponseFormat},`,
      '});',
      'const result = await client.agents.runs.wait(structured.id);',
      "console.log(result.output_parsed); // { priority: 'high', summary: '...' }",
    ].join('\n'),
    follow: [
      "import { isSessionEvent } from '@cognipeer/console-sdk';",
      '',
      '// Follow a run: its tool calls and the finished answer.',
      'let live = false;',
      'for await (const event of client.agents.runs.events.stream(run.id)) {',
      '  // Text deltas arrive only while an answer is written live; the full text is always the agent.message event.',
      "  if (event.type === 'agent.message.delta') {",
      '    live = true;',
      '    process.stdout.write((event.data as { text: string }).text);',
      '  }',
      "  if (isSessionEvent(event, 'agent.tool_use')) console.log('tool:', event.data.name);",
      "  if (isSessionEvent(event, 'agent.message') && !live) console.log(event.data.content);",
      '  // The stream does not end by itself: stop when the run is over or paused for an approval.',
      "  if (isSessionEvent(event, 'session.status_idle')) break;",
      '}',
    ].join('\n'),
    manage: [
      '// Cancel a run that has not finished: the deferred job from above still waits for its hour.',
      '// A run that already finished answers 409 agent_run_already_terminal.',
      'await client.agents.runs.cancel(job.id);',
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
      `  model: ${chatModel},`,
      `  input: ${scalar(MESSAGE, 'ts')},`,
      ...variablesLine,
      '});',
      'console.log(res.output_text);',
      '',
      hasVariables ? '// Continue the conversation: variables belong to one request, so send them again.' : '// Continue the conversation.',
      'const followUp = await client.agents.responses.create({',
      `  model: ${chatModel},`,
      "  input: 'Tell me more about that',",
      ...variablesLine,
      '  previous_response_id: res.id,',
      '});',
      '',
      '// Stream the answer.',
      'const stream = await client.agents.responses.create({',
      `  model: ${chatModel},`,
      "  input: 'Hello!',",
      ...variablesLine,
      '  stream: true,',
      '});',
      'for await (const event of stream) {',
      "  if (isResponseStreamEvent(event, 'response.output_text.delta')) process.stdout.write(event.delta);",
      '}',
    ].join('\n'),
    trigger: [
      '// A trigger starts the agent on its own: on a schedule, once at a set time, by hand or from a webhook.',
      `const trigger = await client.agents.triggers.create(${key}, {`,
      "  name: 'Weekday digest',",
      "  type: 'schedule',",
      "  schedule: { cron: '0 9 * * 1-5', timezone: 'UTC' },",
      "  prompt: 'Summarise yesterday.',",
      ...variablesLine,
      "  class: 'deferred',",
      '});',
      '',
      '// Fire it now.',
      `await client.agents.triggers.run(${key}, trigger.id);`,
    ].join('\n'),
  };

  const reuse = (...names: SdkReuse[]): SdkReuse[] => (hasVariables ? [...names, 'variables'] : names);
  const sdkReuses: AgentUsageSnippets['sdkReuses'] = {
    options: reuse('client', 'done'),
    later: reuse('client'),
    structured: reuse('client'),
    follow: ['client', 'run'],
    manage: ['client', 'job'],
    chat: reuse('client'),
    trigger: reuse('client'),
  };

  // ── OpenAI-compatible endpoints ─────────────────────────────────────────

  const model = `agent:${agentKey}`;
  const pyClient = `client = OpenAI(base_url="${baseUrl}", api_key="${API_KEY}")`;
  // The OpenAI SDK has no field for variables, so they go in `extra_body`. Each Python sample can be pasted on its own:
  // it makes its own client and carries its own variables. The first one names them once for its two calls; the others
  // spell them out.
  const extraBody = variables ? ['    extra_body={"variables": variables},'] : [];
  const extraBodyInline = variables ? [`    extra_body=${formatLiteral({ variables }, 'py', 1)},`] : [];

  const openai: AgentUsageSnippets['openai'] = {
    responses: [
      'from openai import OpenAI',
      '',
      pyClient,
      ...(variables ? ['', '# The variables this agent declares.', `variables = ${formatLiteral(variables, 'py', 0)}`] : []),
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
      'from openai import OpenAI',
      '',
      pyClient,
      '',
      '# background=True answers at once (HTTP 202) with the run queued',
      'job = client.responses.create(',
      `    model="${model}",`,
      '    input="Research this topic in depth and summarize the findings.",',
      '    background=True,',
      ...extraBodyInline,
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
      'from openai import OpenAI',
      '',
      pyClient,
      '',
      'stream = client.chat.completions.create(',
      `    model="${model}",`,
      `    messages=[{"role": "user", "content": "${MESSAGE}"}],`,
      '    stream=True,',
      ...extraBodyInline,
      ')',
      'for chunk in stream:',
      '    if chunk.choices:',
      '        print(chunk.choices[0].delta.content or "", end="")',
    ].join('\n'),
    chatCurl: chatCompletionsCurl({ baseUrl, agentKey, variables, stream: true }),
    models: curl({ url: `${baseUrl}/models`, headers: [AUTH_HEADER] }),
  };

  // ── A2A ─────────────────────────────────────────────────────────────────

  const a2a: AgentUsageSnippets['a2a'] = {
    enabled: a2aEnabled,
    card: curl({ url: `${a2aEndpointUrl}${A2A_CARD_PATH}`, headers: a2aIsPublic ? [] : [AUTH_HEADER] }),
    send: a2aEnabled ? a2aSendCurl({ endpointUrl: a2aEndpointUrl, isPublic: a2aIsPublic, variables }) : null,
  };

  return {
    baseUrl,
    agentKey,
    defaultVersion,
    hasVariables,
    referenceDoc: AGENT_REFERENCE_DOC,
    runs,
    sdk,
    sdkReuses,
    openai,
    a2a,
    docs: AGENT_DOC_LINKS.map((link) => ({ id: link.id, doc: link.doc })),
  };
}
