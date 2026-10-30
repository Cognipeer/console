/**
 * The Usage tab of an agent: the code it shows, and that the code is true.
 *
 * Every sample comes from one pure function (`buildAgentUsageSnippets`), so what the tab teaches can be held against
 * what the API is.
 *
 * Checked here:
 *   - every `curl` of the tab against openapi.yaml: the operation and its method, the header and query parameters
 *     (names and values), and the JSON body against the request schema (unknown fields, types, enum values, required
 *     fields);
 *   - the sample answers (the 200 and the 202 run) against the AgentRun schema, field for field, enum values included;
 *   - the variables the samples prefill against the validator the API runs (`resolveRunVariables`), and the
 *     structured-output sample against the one it uses (`resolveResponseFormatSchema`);
 *   - the TypeScript SDK samples, executed in order against a recording client: every call has to be on the table of
 *     SDK methods below (each one is a REST operation of the spec), and its arguments (body, query, options) have to be
 *     ones that table lists, with the bodies and queries held against the same request schemas and parameters;
 *   - that each SDK sample names what it takes from the ones above it, and that the Python samples stand alone.
 *
 * Not checked here: that the SDK's own types accept the samples. The SDK is not a dependency of this repo and the table
 * of SDK methods is written by hand from console-sdk 4.0, so a rename on the SDK side is caught by type-checking the
 * generated samples against the SDK's dist (`tsc --strict`), not by this file. Neither is it checked that the Python
 * and shell samples parse (`py_compile` and `bash -n` do that), that the docs pages exist (the docs repo checks every
 * docs-links page against its pages), or what a running server answers (none is started).
 *
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement as h, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import ts from 'typescript';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import AgentUsagePanel, { USAGE_SECTIONS, usageSectionId, withInlineCode } from '@/components/agents/AgentUsagePanel';
import AgentOverviewPanel from '@/components/agents/studio/AgentOverviewPanel';
import {
  AGENT_DOC_LINKS,
  AGENT_REFERENCE_DOC,
  STRUCTURED_OUTPUT_SAMPLE,
  a2aSendCurl,
  buildAgentUsageSnippets,
  chatCompletionsCurl,
  formatLiteral,
  sampleVariables,
  variablePlaceholder,
  variablesOfRunVersion,
  type AgentUsageSnippetOptions,
  type AgentUsageSnippets,
} from '@/components/agents/agentUsageSnippets';
import type { IAgentVariable } from '@/lib/database/provider/types.domain';
import { buildDocsUrl, DEFAULT_DOCS_BASE_URL } from '@/lib/docs/docsLinks';
import { I18nProvider } from '@/lib/i18n';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';
import { resolveResponseFormatSchema } from '@/lib/services/agents/agentRuntimeConfig';
import { resolveRunVariables } from '@/lib/services/agents/agentVariables';

// ── Fixtures ──────────────────────────────────────────────────────────────

const ORIGIN = 'https://console.example.com';
const BASE = `${ORIGIN}/api/client/v1`;
const ENDPOINT = `${BASE}/a2a/support-triage`;
const PUBLIC_ENDPOINT = `${ORIGIN}/api/public/a2a/tenant123/slug456`;

/** One variable of every type, an enum, a default, and a default that holds an apostrophe (it must survive the shell). */
const DECLARED: IAgentVariable[] = [
  { name: 'customer_id', type: 'string', required: true },
  { name: 'period', type: 'string', enum: ['last_7_days', 'last_30_days'], required: true },
  { name: 'limit', type: 'integer' },
  { name: 'ratio', type: 'number' },
  { name: 'dry_run', type: 'boolean' },
  { name: 'filters', type: 'json' },
  { name: 'note', type: 'string', default: "don't panic" },
];

const options = (over: Partial<AgentUsageSnippetOptions> = {}): AgentUsageSnippetOptions => ({
  origin: ORIGIN,
  agentKey: 'support-triage',
  publishedVersion: 3,
  variables: undefined,
  a2aEnabled: true,
  a2aEndpointUrl: ENDPOINT,
  a2aIsPublic: false,
  ...over,
});

const VARIANTS: Array<[string, AgentUsageSnippetOptions]> = [
  ['an agent without variables', options()],
  ['an agent with variables, never published, A2A off', options({ variables: DECLARED, publishedVersion: null, a2aEnabled: false })],
  ['an agent exposed publicly over A2A', options({ agentKey: 'faq-bot', publishedVersion: 1, a2aEndpointUrl: PUBLIC_ENDPOINT, a2aIsPublic: true })],
  [
    'an agent with variables, published, exposed publicly over A2A',
    options({ agentKey: 'faq-bot', variables: DECLARED, publishedVersion: 2, a2aEndpointUrl: PUBLIC_ENDPOINT, a2aIsPublic: true }),
  ],
];

const SRC = path.resolve(__dirname, '../..');
const sourceOf = (file: string) => readFileSync(path.join(SRC, file), 'utf8');

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

// ── openapi.yaml ──────────────────────────────────────────────────────────

/** The part of JSON Schema the spec uses, as far as `issuesOf` reads it. */
interface JsonSchema {
  $ref?: string;
  type?: string;
  nullable?: boolean;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  maxProperties?: number;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
}
interface Parameter {
  $ref?: string;
  name: string;
  in: string;
  schema?: JsonSchema;
}
interface Operation {
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
}
type PathItem = { servers?: Array<{ url?: string }> } & Record<string, unknown>;

const spec = parse(readFileSync(path.resolve(__dirname, '../../../openapi.yaml'), 'utf8')) as {
  paths: Record<string, PathItem>;
  components: { schemas: Record<string, JsonSchema>; parameters: Record<string, Parameter> };
};

const schemaRef = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
const schemaProperties = (name: string): string[] => Object.keys(spec.components.schemas[name]?.properties ?? {});
const operationOf = (template: string, method: string): Operation => spec.paths[template][method] as Operation;
const requestSchemaOf = (template: string, method: string): JsonSchema | undefined =>
  operationOf(template, method).requestBody?.content?.['application/json']?.schema;
const parametersOf = (operation: Operation, location: 'query' | 'header'): Parameter[] =>
  (operation.parameters ?? [])
    .map((entry) => (entry.$ref ? spec.components.parameters[entry.$ref.replace('#/components/parameters/', '')] : entry))
    .filter((entry) => entry.in === location);

const resolveSchema = (schema: JsonSchema): JsonSchema =>
  schema.$ref ? resolveSchema(spec.components.schemas[schema.$ref.replace('#/components/schemas/', '')]) : schema;

/**
 * What is wrong with `value` as an instance of `schema`, in the words of a failing test (empty = fine). Reads what the
 * spec uses: types, nullable, enum, bounds, `required`, `oneOf`/`allOf`, and the properties of an object, where a field
 * the schema does not list counts as wrong unless `additionalProperties` allows it. `skipRequired` lists the places (as
 * `at` paths) where a sample is shortened on purpose.
 */
function issuesOf(input: JsonSchema, value: unknown, at: string, skipRequired: string[] = []): string[] {
  const schema = resolveSchema(input);
  if (value === null) return schema.nullable === true ? [] : [`${at}: null is not allowed`];
  if (schema.oneOf) {
    const attempts = schema.oneOf.map((alternative) => issuesOf(alternative, value, at, skipRequired));
    return attempts.some((found) => found.length === 0) ? [] : [`${at}: fits none of the alternatives (${attempts.map((found) => found[0]).join(' | ')})`];
  }
  const issues = (schema.allOf ?? []).flatMap((member) => issuesOf(member, value, at, skipRequired));
  if (schema.enum && !schema.enum.includes(value)) issues.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  switch (schema.type ?? (schema.properties ? 'object' : undefined)) {
    case 'string':
      if (typeof value !== 'string') return [...issues, `${at}: not a string`];
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) issues.push(`${at}: does not match ${schema.pattern}`);
      if (schema.minLength !== undefined && value.length < schema.minLength) issues.push(`${at}: shorter than ${schema.minLength}`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push(`${at}: longer than ${schema.maxLength}`);
      break;
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || (schema.type === 'integer' && !Number.isInteger(value))) {
        return [...issues, `${at}: not ${schema.type === 'integer' ? 'an integer' : 'a number'}`];
      }
      if (schema.minimum !== undefined && value < schema.minimum) issues.push(`${at}: below ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) issues.push(`${at}: above ${schema.maximum}`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') issues.push(`${at}: not a boolean`);
      break;
    case 'array':
      if (!Array.isArray(value)) return [...issues, `${at}: not a list`];
      if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push(`${at}: more than ${schema.maxItems} items`);
      if (schema.items) value.forEach((item, index) => issues.push(...issuesOf(schema.items as JsonSchema, item, `${at}[${index}]`, skipRequired)));
      break;
    case 'object': {
      if (!isRecord(value)) return [...issues, `${at}: not an object`];
      if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) issues.push(`${at}: more than ${schema.maxProperties} fields`);
      if (!skipRequired.includes(at)) for (const name of schema.required ?? []) if (value[name] === undefined) issues.push(`${at}.${name}: required`);
      for (const [name, item] of Object.entries(value)) {
        const known = schema.properties?.[name];
        if (known) issues.push(...issuesOf(known, item, `${at}.${name}`, skipRequired));
        else if (typeof schema.additionalProperties === 'object') issues.push(...issuesOf(schema.additionalProperties, item, `${at}.${name}`, skipRequired));
        else if (schema.properties && schema.additionalProperties !== true) issues.push(`${at}.${name}: not a field of the schema`);
      }
      break;
    }
    default:
  }
  return issues;
}

const pathTemplates = Object.keys(spec.paths).map((template) => ({
  template,
  // `{agentKey}` is any one path segment; everything else is literal.
  regex: new RegExp(
    `^${template
      .split(/(\{[^}]+\})/)
      .map((part) => (part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('')}$`,
  ),
  params: (template.match(/\{[^}]+\}/g) ?? []).length,
  prefix: spec.paths[template].servers?.some((server) => server.url?.endsWith('/api/public')) ? '/api/public' : '/api/client/v1',
}));

/** The documented path a URL path is (the most literal template wins: `/agents/runs` is not `/agents/{agentKey}`). */
function documentedPath(pathname: string): { template: string; methods: string[] } | null {
  const matches = pathTemplates
    .filter((entry) => pathname.startsWith(`${entry.prefix}/`) && entry.regex.test(pathname.slice(entry.prefix.length)))
    .sort((a, b) => a.params - b.params);
  const best = matches[0];
  if (!best) return null;
  return { template: best.template, methods: Object.keys(spec.paths[best.template]).filter((key) => ['get', 'post', 'put', 'patch', 'delete'].includes(key)) };
}

// ── Reading the samples back ──────────────────────────────────────────────

interface RestCall {
  method: 'get' | 'post';
  pathname: string;
  query: Array<[name: string, value: string]>;
  /** The names of the headers it sends. */
  headers: string[];
  body: Record<string, unknown> | undefined;
}

/** Every `curl` command of a snippet: its method (as curl would send it), path, query, headers and JSON body. */
function restCalls(text: string): RestCall[] {
  const lines = text.split('\n');
  const calls: RestCall[] = [];
  lines.forEach((line, start) => {
    if (!/^curl\b/.test(line)) return;
    // The command runs to the first blank or comment line: a line of a JSON body never starts with `#`, nor is empty.
    let end = start + 1;
    while (end < lines.length && lines[end].trim() !== '' && !lines[end].startsWith('#')) end += 1;
    const command = lines.slice(start, end).join('\n');
    const url = new URL((command.match(/https?:\/\/[^\s"]+/) as RegExpMatchArray)[0]);
    const explicit = command.match(/-X\s+(\w+)/)?.[1]?.toLowerCase();
    const bodyText = command.match(/-d '((?:[^']|'\\'')*)'/)?.[1];
    const method = explicit ?? (bodyText === undefined ? 'get' : 'post');
    expect(['get', 'post']).toContain(method);
    calls.push({
      method: method as 'get' | 'post',
      pathname: url.pathname,
      query: [...url.searchParams.entries()],
      headers: [...command.matchAll(/-H "([^":]+):/g)].map((match) => match[1]),
      body: bodyText === undefined ? undefined : (JSON.parse(bodyText.replace(/'\\''/g, "'")) as Record<string, unknown>),
    });
  });
  return calls;
}

/** The snippets that are curl commands. */
function curlSnippets(s: AgentUsageSnippets): string[] {
  return [...Object.values(s.runs), s.openai.chatCurl, s.openai.models, s.a2a.card, ...(s.a2a.send ? [s.a2a.send] : [])].filter((text) =>
    /^curl\b/m.test(text),
  );
}

/** Every snippet and every sentence next to one. */
function everyText(s: AgentUsageSnippets): string[] {
  return [...Object.values(s.runs), ...Object.values(s.sdk), ...Object.values(s.openai), s.a2a.card, s.a2a.send ?? '', s.baseUrl, s.agentKey];
}

/** The literal that starts right after `marker` (`variables = `, `extra_body=`): from its opening brace to the matching one. */
function literalAfter(text: string, marker: string): string {
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`no ${marker} in the sample`);
  const start = at + marker.length;
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`${marker} is never closed`);
}

/** A Python dict/list literal as the value it writes (JSON strings, `True`/`False`/`None`, trailing commas). */
function fromPython(literal: string): unknown {
  const words: Record<string, string> = { True: 'true', False: 'false', None: 'null' };
  const json = literal
    .replace(/"(?:[^"\\]|\\.)*"|\bTrue\b|\bFalse\b|\bNone\b/g, (token) => (token.startsWith('"') ? token : words[token]))
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(json);
}

/** The names an earlier example declares that this one reads without declaring them (`client`, `run`, ...). */
function reusedNames(code: string): string[] {
  const reusable = ['client', 'run', 'done', 'job', 'variables'];
  const file = ts.createSourceFile('sample.ts', code, ts.ScriptTarget.ES2022, true);
  const declared = new Set<string>();
  const read = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      if (ts.isVariableDeclaration(parent) && parent.name === node) declared.add(node.text);
      else if (ts.isImportSpecifier(parent)) declared.add(node.text);
      else if (!((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === node)) read.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return reusable.filter((name) => read.has(name) && !declared.has(name));
}

// ── The SDK samples, executed ─────────────────────────────────────────────

interface Recorded {
  method: string;
  args: unknown[];
}
interface Logged {
  level: 'log' | 'error';
  args: unknown[];
}
type SdkExample = Exclude<keyof AgentUsageSnippets['sdk'], 'install' | 'start'>;
const SDK_EXAMPLES: SdkExample[] = ['options', 'later', 'structured', 'follow', 'manage', 'chat', 'trigger'];

interface SdkScenario {
  /** The examples that run after `start`, in order (all of them by default). */
  then?: SdkExample[];
  /** What the event stream of a run yields. */
  events?: Array<{ type: string; data: unknown }>;
  /** The status `runs.wait` settles with. */
  status?: string;
}

/** A run whose answer is written live: deltas first, then the stored message, then the run goes idle. */
const LIVE_EVENTS = [
  { type: 'agent.message.delta', data: { text: 'He' } },
  { type: 'agent.tool_use', data: { name: 'lookup' } },
  { type: 'agent.message', data: { content: 'Hello' } },
  { type: 'session.status_idle', data: {} },
  { type: 'never.read', data: {} },
];
/** A run started with `runs.create`: no deltas, only the stored message. */
const STORED_EVENTS = [
  { type: 'agent.tool_use', data: { name: 'lookup' } },
  { type: 'agent.message', data: { content: 'Hello from the stored message' } },
  { type: 'session.status_idle', data: {} },
  { type: 'never.read', data: {} },
];

const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<void>;

/**
 * Runs the SDK samples in order, as one script, against a client that records what it is asked. The samples are
 * TypeScript: the types are stripped, the imports are replaced by the two guards the SDK exports.
 */
async function runSdkSnippets(s: AgentUsageSnippets, scenario: SdkScenario = {}) {
  const { then = SDK_EXAMPLES, events = LIVE_EVENTS, status = 'succeeded' } = scenario;
  const calls: Recorded[] = [];
  const clients: unknown[] = [];
  const written: string[] = [];
  const logged: Logged[] = [];

  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
  };
  const run = { id: 'run_1', object: 'agent.run', status: 'queued', session_id: 'sess_1' };
  const settled = { ...run, status, output_text: 'ok', output_parsed: { priority: 'high', summary: 'x' }, error: { message: 'boom' } };
  async function* runEvents() {
    yield* events;
  }
  async function* responseEvents() {
    yield { type: 'response.output_text.delta', delta: 'Hi' };
  }
  async function* runPage() {
    yield settled;
  }

  const fake = {
    agents: {
      runs: {
        create: async (...args: unknown[]) => (record('agents.runs.create')(...args), run),
        wait: async (...args: unknown[]) => (record('agents.runs.wait')(...args), settled),
        cancel: async (...args: unknown[]) => (record('agents.runs.cancel')(...args), settled),
        list: (...args: unknown[]) => (record('agents.runs.list')(...args), runPage()),
        events: { stream: (...args: unknown[]) => (record('agents.runs.events.stream')(...args), runEvents()) },
      },
      responses: {
        create: async (...args: unknown[]) => {
          record('agents.responses.create')(...args);
          return asRecord(args[0]).stream ? responseEvents() : { id: 'resp_1', output_text: 'ok' };
        },
      },
      triggers: {
        create: async (...args: unknown[]) => (record('agents.triggers.create')(...args), { id: 'trg_1' }),
        run: async (...args: unknown[]) => (record('agents.triggers.run')(...args), run),
      },
    },
  };
  function ConsoleClient(this: unknown, clientOptions: unknown) {
    clients.push(clientOptions);
    return fake;
  }

  const source = [s.sdk.start, ...then.map((key) => s.sdk[key])].join('\n\n').replace(/^import .*;\n/gm, '');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const guard = (event: { type: string }, type: string) => event.type === type;
  const fakeConsole = {
    log: (...args: unknown[]) => void logged.push({ level: 'log', args }),
    error: (...args: unknown[]) => void logged.push({ level: 'error', args }),
  };
  await new AsyncFunction('ConsoleClient', 'isSessionEvent', 'isResponseStreamEvent', 'process', 'console', js)(
    ConsoleClient,
    guard,
    guard,
    { stdout: { write: (text: string) => (written.push(text), true) } },
    fakeConsole,
  );
  return { calls, clients, written, logged };
}

/** The methods of the table the samples only name (in a comment): nothing runs them, so the recording client never sees them. */
const NAMED_IN_COMMENTS = new Set(['agents.runs.resolveAction']);

/** What each argument of an SDK method is. */
type SdkArg =
  | { kind: 'agent' }
  | { kind: 'run' }
  | { kind: 'action' }
  | { kind: 'trigger' }
  | { kind: 'body'; schema: string }
  | { kind: 'query'; operation: [method: string, template: string] }
  | { kind: 'options'; keys: string[] };

/**
 * The methods of console-sdk 4.0 the samples call: the REST operation each one is, and its positional arguments in
 * order (`required` of them are needed). Written by hand: the unit test cannot see the SDK (see the top of this file).
 */
const SDK_METHODS: Record<string, { operation: [method: string, template: string]; args: SdkArg[]; required: number }> = {
  'agents.runs.create': {
    operation: ['post', '/agents/{agentKey}/runs'],
    args: [{ kind: 'agent' }, { kind: 'body', schema: 'AgentRunCreateRequest' }, { kind: 'options', keys: ['idempotencyKey', 'prefer', 'signal'] }],
    required: 2,
  },
  'agents.runs.wait': {
    operation: ['get', '/agents/runs/{runId}'],
    args: [{ kind: 'run' }, { kind: 'options', keys: ['waitSeconds', 'pollIntervalMs', 'timeoutMs', 'signal'] }],
    required: 1,
  },
  'agents.runs.cancel': {
    operation: ['post', '/agents/runs/{runId}/cancel'],
    args: [{ kind: 'run' }, { kind: 'options', keys: ['signal'] }],
    required: 1,
  },
  'agents.runs.list': {
    operation: ['get', '/agents/runs'],
    args: [{ kind: 'query', operation: ['get', '/agents/runs'] }, { kind: 'options', keys: ['signal'] }],
    required: 0,
  },
  'agents.runs.events.stream': {
    operation: ['get', '/agents/runs/{runId}/events/stream'],
    args: [
      { kind: 'run' },
      { kind: 'options', keys: ['after', 'types', 'signal', 'maxReconnects', 'reconnectDelayMs', 'maxReconnectDelayMs', 'idleTimeoutMs'] },
    ],
    required: 1,
  },
  // Named in a comment of the first example (where to answer a paused run), not called by it.
  'agents.runs.resolveAction': {
    operation: ['post', '/agents/runs/{runId}/actions/{actionId}'],
    args: [{ kind: 'run' }, { kind: 'action' }, { kind: 'body', schema: 'AgentActionResolution' }, { kind: 'options', keys: ['background', 'signal'] }],
    required: 3,
  },
  'agents.responses.create': {
    operation: ['post', '/responses'],
    args: [{ kind: 'body', schema: 'AgentResponsesRequest' }, { kind: 'options', keys: ['idempotencyKey', 'signal'] }],
    required: 1,
  },
  'agents.triggers.create': {
    operation: ['post', '/agents/{agentKey}/triggers'],
    args: [{ kind: 'agent' }, { kind: 'body', schema: 'AgentTriggerCreateRequest' }, { kind: 'options', keys: ['signal'] }],
    required: 2,
  },
  'agents.triggers.run': {
    operation: ['post', '/agents/{agentKey}/triggers/{triggerId}/run'],
    args: [{ kind: 'agent' }, { kind: 'trigger' }, { kind: 'body', schema: 'AgentTriggerRunRequest' }, { kind: 'options', keys: ['wait', 'prefer', 'idempotencyKey', 'signal'] }],
    required: 2,
  },
};

/** The query parameters of a REST operation, as the values the SDK accepts for the same names (a list of statuses is joined). */
function queryIssues(operation: Operation, query: Array<[string, string]>, at: string): string[] {
  const issues: string[] = [];
  const documented = parametersOf(operation, 'query');
  for (const [name, value] of query) {
    // `metadata[key]` belongs to the `metadata` parameter.
    const parameter = documented.find((entry) => entry.name === name || name.startsWith(`${entry.name}[`));
    if (!parameter) {
      issues.push(`${at}: ${name} is not a query parameter of the operation`);
      continue;
    }
    if (parameter.schema === undefined) continue;
    if (parameter.name === 'status') {
      // Several, comma-separated: each one is a status a run can have.
      const states = (spec.components.schemas.AgentRun.properties?.status as JsonSchema).enum;
      for (const state of value.split(',')) if (!states?.includes(state)) issues.push(`${at}: status ${state} is not a status of AgentRun`);
      continue;
    }
    const typed = parameter.schema.type === 'integer' || parameter.schema.type === 'number' ? Number(value) : value;
    issues.push(...issuesOf(parameter.schema, typed, `${at}: ${name}`));
  }
  return issues;
}

/** What is wrong with one recorded SDK call: unknown method, arguments the table does not list, bad body or query. */
function sdkCallIssues(call: Recorded, agentKey: string): string[] {
  const method = SDK_METHODS[call.method];
  if (!method) return [`${call.method} is not a method of the SDK table`];
  const [verb, template] = method.operation;
  const issues: string[] = [];
  if (!Object.keys(spec.paths[template] ?? {}).includes(verb)) issues.push(`${call.method}: ${verb.toUpperCase()} ${template} is not in openapi.yaml`);
  if (call.args.length < method.required) issues.push(`${call.method}: needs ${method.required} arguments, got ${call.args.length}`);
  if (call.args.length > method.args.length) issues.push(`${call.method}: takes ${method.args.length} arguments at most, got ${call.args.length}`);
  call.args.forEach((arg, index) => {
    const expected = method.args[index];
    const at = `${call.method} #${index + 1}`;
    if (!expected) return;
    switch (expected.kind) {
      case 'agent':
        if (arg !== agentKey) issues.push(`${at}: ${JSON.stringify(arg)} is not the agent key`);
        break;
      case 'run':
        if (!/^run_/.test(String(arg))) issues.push(`${at}: ${JSON.stringify(arg)} is not a run id`);
        break;
      case 'action':
        if (typeof arg !== 'string' || arg === '') issues.push(`${at}: ${JSON.stringify(arg)} is not an action id`);
        break;
      case 'trigger':
        if (arg !== 'trg_1') issues.push(`${at}: ${JSON.stringify(arg)} is not the id the create call answered with`);
        break;
      case 'body':
        issues.push(...issuesOf(schemaRef(expected.schema), arg, at));
        break;
      case 'query': {
        const query = asRecord(arg);
        const pairs = Object.entries(query).map(([name, value]): [string, string] => [name, Array.isArray(value) ? value.join(',') : String(value)]);
        issues.push(...queryIssues(operationOf(expected.operation[1], expected.operation[0]), pairs, at));
        break;
      }
      case 'options':
        for (const key of Object.keys(asRecord(arg))) if (!expected.keys.includes(key)) issues.push(`${at}: ${key} is not an option of the method`);
        break;
    }
  });
  return issues;
}

// ── The samples ───────────────────────────────────────────────────────────

describe('what the page passes shows up in the samples', () => {
  it('builds every URL from the origin and the key', () => {
    const s = buildAgentUsageSnippets(options({ origin: 'https://acme.example.org', agentKey: 'billing_bot', a2aEndpointUrl: 'https://acme.example.org/api/client/v1/a2a/billing_bot' }));
    expect(s.baseUrl).toBe('https://acme.example.org/api/client/v1');
    expect(s.agentKey).toBe('billing_bot');
    expect(s.runs.start).toContain('curl -X POST https://acme.example.org/api/client/v1/agents/billing_bot/runs');
    expect(s.runs.list).toContain('"https://acme.example.org/api/client/v1/agents/runs?agent=billing_bot&');
    expect(s.sdk.start).toContain("baseURL: 'https://acme.example.org',");
    expect(s.sdk.start).toContain("client.agents.runs.create('billing_bot', {");
    expect(s.openai.responses).toContain('base_url="https://acme.example.org/api/client/v1"');
    expect(s.openai.responses).toContain('model="agent:billing_bot"');
    expect(s.openai.chatCurl).toContain('"model": "agent:billing_bot"');
    expect(s.a2a.card).toContain('curl https://acme.example.org/api/client/v1/a2a/billing_bot/.well-known/agent-card.json');
  });

  it('runs the published version by default and pins that number', () => {
    const s = buildAgentUsageSnippets(options({ publishedVersion: 7 }));
    expect(s.defaultVersion).toBe(7);
    expect(restCalls(s.runs.version)[0].body).toMatchObject({ version: 7 });
    expect(s.sdk.options).toContain('version: 7,');
  });

  it.each([[null], [undefined], [0]])('with %s published the draft is what runs, so that is what is pinned', (publishedVersion) => {
    const s = buildAgentUsageSnippets(options({ publishedVersion }));
    expect(s.defaultVersion).toBeNull();
    expect(restCalls(s.runs.version)[0].body).toMatchObject({ version: 'draft' });
    expect(s.sdk.options).toContain("version: 'draft',");
  });

  it.each(VARIANTS)('leaves no hole in the text of %s', (_name, variant) => {
    for (const text of everyText(buildAgentUsageSnippets(variant))) {
      expect(text).not.toMatch(/undefined|\[object Object\]|NaN|\$\{/);
    }
  });

  it('exposes only what the tab reads: no copy of the endpoint or of the public flag in the A2A part', () => {
    const s = buildAgentUsageSnippets(options());
    expect(Object.keys(s.a2a).sort()).toEqual(['card', 'enabled', 'send']);
    // The page says whether the endpoint is public (it knows), and nothing guesses it from a URL.
    for (const file of ['components/agents/agentUsageSnippets.ts', 'components/agents/AgentUsagePanel.tsx']) {
      expect(sourceOf(file), file).not.toContain('/api/public');
    }
  });

  it('links the docs under the docs site, one page each, and the API reference once, in the header', () => {
    const s = buildAgentUsageSnippets(options());
    const urls = s.docs.map((link) => buildDocsUrl(DEFAULT_DOCS_BASE_URL, link.doc));
    expect(s.docs.map((link) => link.id)).toEqual(AGENT_DOC_LINKS.map((link) => link.id));
    expect(AGENT_DOC_LINKS).toHaveLength(9);
    expect(new Set(urls).size).toBe(AGENT_DOC_LINKS.length);
    for (const url of urls) expect(url).toMatch(/^https:\/\/docs\.cognipeer\.com\/(console|console-sdk)\/[a-z0-9\-/]+(#[a-z-]+)?$/);
    expect(urls).toEqual(
      expect.arrayContaining([
        'https://docs.cognipeer.com/console/guide/integrations/agents/overview',
        'https://docs.cognipeer.com/console/guide/agents/background-runs',
        'https://docs.cognipeer.com/console/guide/integrations/agents/triggers',
        'https://docs.cognipeer.com/console/guide/integrations/agents/webhook-triggers',
        'https://docs.cognipeer.com/console/guide/integrations/agents/openai-sdk',
        'https://docs.cognipeer.com/console/guide/integrations/agents/n8n',
        'https://docs.cognipeer.com/console/guide/integrations/agents/open-webui',
        'https://docs.cognipeer.com/console/guide/integrations/agents/litellm-and-a2a',
        'https://docs.cognipeer.com/console-sdk/api/agents',
      ]),
    );
    // The reference is the link in the header; the list does not repeat it under another name.
    expect(s.referenceDoc).toBe(AGENT_REFERENCE_DOC);
    expect(buildDocsUrl(DEFAULT_DOCS_BASE_URL, s.referenceDoc)).toBe('https://docs.cognipeer.com/console/developer/api/agents#runs-api');
    expect(s.docs.map((link) => link.doc)).not.toContain(s.referenceDoc);
    expect(AGENT_DOC_LINKS.map((link) => link.id)).not.toContain('runsApi');
  });

  it('keeps the release-order note next to the install line', () => {
    const source = sourceOf('components/agents/agentUsageSnippets.ts');
    expect(source).toMatch(/Release order: console-sdk 4\.0\.0 is not on npm yet[^]*?install: 'npm install @cognipeer\/console-sdk@\^4'/);
  });
});

describe('which variables a call has to supply', () => {
  const published = { variables: [{ name: 'customer_id', type: 'string', required: true }] };
  const draft: IAgentVariable[] = [
    { name: 'customer_id', type: 'string', required: true },
    { name: 'region', type: 'string', required: true },
  ];

  it('are those of the published snapshot, not of a draft that moved on', () => {
    expect(variablesOfRunVersion({ publishedVersion: 3, publishedConfig: published, draftVariables: draft })).toEqual(published.variables);
    // Handed to the samples, the variable of the draft that nobody can send yet does not show up.
    const s = buildAgentUsageSnippets(options({ variables: variablesOfRunVersion({ publishedVersion: 3, publishedConfig: published, draftVariables: draft }) }));
    expect(everyText(s).join('\n')).toContain('<customer_id>');
    expect(everyText(s).join('\n')).not.toContain('region');
  });

  it('are none when the snapshot declares none, whatever the draft declares by now', () => {
    expect(variablesOfRunVersion({ publishedVersion: 3, publishedConfig: {}, draftVariables: draft })).toBeUndefined();
    expect(variablesOfRunVersion({ publishedVersion: 3, publishedConfig: { variables: [] }, draftVariables: draft })).toEqual([]);
  });

  it.each([[null], [undefined], [0]])('are the draft’s while nothing is published (%s)', (publishedVersion) => {
    expect(variablesOfRunVersion({ publishedVersion, publishedConfig: null, draftVariables: draft })).toEqual(draft);
    expect(variablesOfRunVersion({ publishedVersion, publishedConfig: published, draftVariables: draft })).toEqual(draft);
  });

  it('are the draft’s while the snapshot is not there (still fetching, missing, or the request failed)', () => {
    expect(variablesOfRunVersion({ publishedVersion: 3, publishedConfig: null, draftVariables: draft })).toEqual(draft);
  });
});

describe('variables', () => {
  it('prefills a value of the right type for every kind of variable', () => {
    const sample = (fields: IAgentVariable[]) => sampleVariables(fields);
    expect(sample([{ name: 'text', type: 'string' }])).toEqual({ text: '<text>' });
    expect(sample([{ name: 'count', type: 'integer' }])).toEqual({ count: 1 });
    expect(sample([{ name: 'ratio', type: 'number' }])).toEqual({ ratio: 1 });
    expect(sample([{ name: 'flag', type: 'boolean' }])).toEqual({ flag: true });
    expect(sample([{ name: 'blob', type: 'json' }])).toEqual({ blob: {} });
    // The first allowed value, for a string and for a number.
    expect(sample([{ name: 'tier', type: 'string', enum: ['gold', 'silver'] }])).toEqual({ tier: 'gold' });
    expect(sample([{ name: 'level', type: 'integer', enum: [3, 5] }])).toEqual({ level: 3 });
    // A declared default is what the agent assumes, so it is the sample; a long one would bury the call.
    expect(sample([{ name: 'lang', type: 'string', default: 'en' }])).toEqual({ lang: 'en' });
    expect(sample([{ name: 'flag', type: 'boolean', default: false }])).toEqual({ flag: false });
    expect(variablePlaceholder({ name: 'essay', type: 'string', default: 'x'.repeat(200) })).toBe('<essay>');
  });

  it('is what the API accepts, for every kind of variable at once', () => {
    const sample = sampleVariables(DECLARED);
    expect(sample).toEqual({
      customer_id: '<customer_id>',
      period: 'last_7_days',
      limit: 1,
      ratio: 1,
      dry_run: true,
      filters: {},
      note: "don't panic",
    });
    expect(resolveRunVariables(DECLARED, sample)).toEqual({ ok: true, variables: sample });
  });

  it('is omitted when the agent declares none (the API refuses variables an agent does not declare)', () => {
    expect(sampleVariables(undefined)).toBeNull();
    expect(sampleVariables(null)).toBeNull();
    expect(sampleVariables([])).toBeNull();
    for (const declared of [undefined, null, []]) {
      const s = buildAgentUsageSnippets(options({ variables: declared }));
      expect(s.hasVariables).toBe(false);
      for (const text of everyText(s)) expect(text).not.toMatch(/\bvariables\b/);
      for (const call of curlSnippets(s).flatMap(restCalls).filter((entry) => entry.body)) expect(call.body).not.toHaveProperty('variables');
    }
  });

  it('rides every call that starts a run, on every surface, as the same object', () => {
    const s = buildAgentUsageSnippets(options({ variables: DECLARED }));
    const sample = sampleVariables(DECLARED);
    expect(s.hasVariables).toBe(true);

    // REST: every body that starts a run carries it (the cancel, the lookups and the card carry no body).
    const bodies = curlSnippets(s).flatMap(restCalls).filter((call) => call.body);
    expect(bodies.length).toBeGreaterThanOrEqual(8);
    for (const call of bodies.filter((entry) => !entry.pathname.endsWith('/a2a/support-triage'))) {
      expect(call.body?.variables, call.pathname).toEqual(sample);
    }
    // A2A: a `data` part whose keys are variables the agent declares.
    const a2a = restCalls(s.a2a.send as string)[0].body as { params: { message: { parts: Array<Record<string, unknown>> } } };
    expect(a2a.params.message.parts.find((part) => part.kind === 'data')).toEqual({ kind: 'data', data: sample });

    // The OpenAI SDK has no field for it, so it goes in `extra_body`: named once in the first sample, spelled out in the others.
    expect(fromPython(literalAfter(s.openai.responses, 'variables = '))).toEqual(sample);
    expect(s.openai.responses).toContain('"dry_run": True,');
    expect(s.openai.responses).toContain('"note": "don\'t panic",');
    expect(s.openai.responses.match(/extra_body=\{"variables": variables\}/g)).toHaveLength(2);
    for (const code of [s.openai.background, s.openai.chat]) {
      expect(fromPython(literalAfter(code, 'extra_body='))).toEqual({ variables: sample });
    }
  });

  it('survives the shell: an apostrophe in a value is escaped, and the body is still the same JSON', () => {
    const s = buildAgentUsageSnippets(options({ variables: DECLARED }));
    expect(s.runs.start).toContain(`"note": "don'\\''t panic"`);
    expect(restCalls(s.runs.start)[0].body?.variables).toMatchObject({ note: "don't panic" });
  });

  it('survives the languages: a default with a line break is still a literal each of them reads', () => {
    const broken: IAgentVariable[] = [{ name: 'note', type: 'string', default: 'one\r\ntwo \\ "three"' }];
    const s = buildAgentUsageSnippets(options({ variables: broken }));
    expect(restCalls(s.runs.start)[0].body?.variables).toEqual({ note: 'one\r\ntwo \\ "three"' });
    expect(fromPython(literalAfter(s.openai.responses, 'variables = '))).toEqual({ note: 'one\r\ntwo \\ "three"' });
    for (const code of Object.values(s.sdk).filter((text) => !text.startsWith('npm '))) {
      const result = ts.transpileModule(code, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
      expect(result.diagnostics?.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) ?? []).toEqual([]);
    }
  });

  it('ignores a declaration that is not a list (a damaged snapshot declares nothing)', () => {
    expect(sampleVariables({ customer_id: 'x' } as unknown as IAgentVariable[])).toBeNull();
    expect(buildAgentUsageSnippets(options({ variables: 'x' as unknown as IAgentVariable[] })).hasVariables).toBe(false);
  });
});

describe('formatLiteral', () => {
  it('keeps a short value on one line and breaks a long one, in the three languages', () => {
    const value = {
      name: 'x',
      tags: ['a', 'b'],
      flag: false,
      none: null,
      nested: { deep: { deeper: 'a string that is long enough to push its parent object over the line width' } },
    };
    expect(formatLiteral({ a: 1, b: ['x'] }, 'json')).toBe('{ "a": 1, "b": ["x"] }');
    expect(formatLiteral({ a: 1, b: ['x'] }, 'ts')).toBe("{ a: 1, b: ['x'] }");
    expect(formatLiteral({ a: true, b: null }, 'py')).toBe('{"a": True, "b": None}');
    expect(formatLiteral({ a: 1 }, 'json', 0, { expand: true })).toBe('{\n  "a": 1\n}');
    expect(formatLiteral({}, 'json', 0, { expand: true })).toBe('{}');
    expect(formatLiteral(value, 'json')).toBe(
      '{\n  "name": "x",\n  "tags": ["a", "b"],\n  "flag": false,\n  "none": null,\n  "nested": {\n    "deep": {\n      "deeper": "a string that is long enough to push its parent object over the line width"\n    }\n  }\n}',
    );
    // TypeScript and Python are written with trailing commas, Python with four spaces.
    expect(formatLiteral(value, 'ts')).toBe(
      "{\n  name: 'x',\n  tags: ['a', 'b'],\n  flag: false,\n  none: null,\n  nested: {\n    deep: {\n      deeper: 'a string that is long enough to push its parent object over the line width',\n    },\n  },\n}",
    );
    expect(formatLiteral(value, 'py')).toBe(
      '{\n    "name": "x",\n    "tags": ["a", "b"],\n    "flag": False,\n    "none": None,\n    "nested": {\n        "deep": {\n            "deeper": "a string that is long enough to push its parent object over the line width",\n        },\n    },\n}',
    );
  });

  it('indents what it breaks to the level of the line it starts on', () => {
    const long = { first: 'a value that needs a line of its own, so the object breaks', second: 'and a second one' };
    expect(formatLiteral(long, 'ts', 1)).toBe(
      "{\n    first: 'a value that needs a line of its own, so the object breaks',\n    second: 'and a second one',\n  }",
    );
  });

  it('quotes TypeScript strings the way a person would', () => {
    expect(formatLiteral("it's", 'ts')).toBe('"it\'s"');
    expect(formatLiteral('say "hi"', 'ts')).toBe("'say \"hi\"'");
    expect(formatLiteral('both \' and "', 'ts')).toBe("'both \\' and \"'");
    expect(formatLiteral('a\nb', 'ts')).toBe("'a\\nb'");
    expect(formatLiteral('a\r\nb', 'ts')).toBe("'a\\r\\nb'");
    expect(formatLiteral({ 'not-an-identifier': 1 }, 'ts')).toBe('{ "not-an-identifier": 1 }');
  });
});

// ── Against the API contract ──────────────────────────────────────────────

describe('the checker of the spec', () => {
  // The REST, SDK and answer tests lean on `issuesOf`: it has to see what it is there to see.
  it('flags an unknown field, a wrong type, a value outside an enum and a missing required field', () => {
    const run = schemaRef('AgentRunCreateRequest');
    expect(issuesOf(run, { input: 'Hi', wait: 30 }, 'body')).toEqual([]);
    expect(issuesOf(run, { input: 'Hi', unknown_field: {} }, 'body')).toEqual(['body.unknown_field: not a field of the schema']);
    expect(issuesOf(run, { input: 'Hi', wait: '30' }, 'body')).toEqual(['body.wait: not a number']);
    expect(issuesOf(run, { input: 'Hi', class: 'urgent' }, 'body')[0]).toContain('body.class: "urgent" is not one of');
    expect(issuesOf(run, { version: 0 }, 'body')[0]).toContain('body.version: fits none of the alternatives');
    expect(issuesOf(schemaRef('AgentResponseFormat'), {}, 'format')).toEqual(['format.type: required']);
    expect(issuesOf(schemaRef('AgentTriggerCreateRequest'), { type: 'schedule' }, 'trigger')).toEqual(['trigger.name: required']);
  });

  it('flags a status a run cannot have and a query parameter an operation does not take', () => {
    expect(issuesOf(schemaRef('AgentRun'), { status: 'done' }, 'run')[0]).toContain('run.status: "done" is not one of');
    const list = operationOf('/agents/runs', 'get');
    expect(queryIssues(list, [['agent', 'a'], ['status', 'queued,running'], ['limit', '20']], 'list')).toEqual([]);
    expect(queryIssues(list, [['agnt', 'a']], 'list')).toEqual(['list: agnt is not a query parameter of the operation']);
    expect(queryIssues(list, [['status', 'queued,finished']], 'list')).toEqual(['list: status finished is not a status of AgentRun']);
    expect(queryIssues(list, [['limit', '500']], 'list')[0]).toContain('above 100');
  });
});

describe.each(VARIANTS)('%s: the REST samples against openapi.yaml', (_name, variant) => {
  const s = buildAgentUsageSnippets(variant);
  const calls = curlSnippets(s).flatMap(restCalls);

  it('only calls operations the spec documents, with the method the spec gives them', () => {
    expect(calls.length).toBeGreaterThanOrEqual(12);
    for (const call of calls) {
      const found = documentedPath(call.pathname);
      expect(found, `${call.method.toUpperCase()} ${call.pathname} is not in openapi.yaml`).not.toBeNull();
      expect(found?.methods, `${found?.template} has no ${call.method}`).toContain(call.method);
    }
  });

  it('calls exactly the operations it teaches', () => {
    const used = new Set(calls.map((call) => `${call.method.toUpperCase()} ${documentedPath(call.pathname)?.template}`));
    expect([...used].sort()).toEqual(
      [
        'POST /agents/{agentKey}/runs',
        'GET /agents/runs/{runId}',
        'GET /agents/runs/{runId}/events/stream',
        'POST /agents/runs/{runId}/cancel',
        'GET /agents/runs',
        'POST /chat/completions',
        'GET /models',
        ...(variant.a2aIsPublic
          ? ['GET /a2a/{tenantId}/{endpointSlug}/.well-known/agent-card.json', 'POST /a2a/{tenantId}/{endpointSlug}']
          : ['GET /a2a/{agentKey}/.well-known/agent-card.json', ...(variant.a2aEnabled ? ['POST /a2a/{agentKey}'] : [])]),
      ].sort(),
    );
  });

  it('sends the key it is given, and a token everywhere except to a public A2A endpoint', () => {
    for (const text of curlSnippets(s)) {
      const isPublicCall = /\/api\/public\//.test(text);
      expect(text.includes('Authorization: Bearer YOUR_API_KEY'), text.split('\n')[0]).toBe(!isPublicCall);
    }
  });

  it('sends only the query parameters and headers the operation documents, with values it accepts', () => {
    for (const call of calls) {
      const found = documentedPath(call.pathname);
      const operation = operationOf(found?.template as string, call.method);
      expect(queryIssues(operation, call.query, call.pathname), call.pathname).toEqual([]);
      const documented = parametersOf(operation, 'header').map((entry) => entry.name.toLowerCase());
      for (const name of call.headers.filter((header) => !['authorization', 'content-type'].includes(header.toLowerCase()))) {
        expect(documented, `${call.pathname}: ${name}`).toContain(name.toLowerCase());
      }
      // The body, when there is one, is JSON; a call without one sends no content type.
      expect(call.headers.includes('Content-Type'), call.pathname).toBe(call.body !== undefined);
    }
    // What the list asks for, and how the long-poll is asked to hold.
    const list = restCalls(s.runs.list)[0];
    expect(list.query.map(([name]) => name).sort()).toEqual(['agent', 'limit', 'status']);
    expect(restCalls(s.runs.poll)[0].query).toEqual([['wait', '30']]);
  });

  it('sends bodies the request schema of the operation takes: fields, types, enum values', () => {
    const withBody = calls.filter((call) => call.body);
    // Six run requests and the chat completion; the A2A `message/send` while A2A is on.
    expect(withBody).toHaveLength(variant.a2aEnabled ? 8 : 7);
    for (const call of withBody) {
      const found = documentedPath(call.pathname);
      const schema = requestSchemaOf(found?.template as string, call.method);
      expect(schema, `${call.pathname} has no request schema`).toBeDefined();
      expect(issuesOf(schema as JsonSchema, call.body, `${found?.template} body`), call.pathname).toEqual([]);
    }
  });

  it('sends the run request the way each sample says: waiting, streaming, deferred, pinned, structured', () => {
    // Every sample that waits holds the call for 30 seconds, so the first thing a reader sees is an answer.
    for (const text of [s.runs.start, s.runs.session, s.runs.version, s.runs.structured]) {
      expect(restCalls(text)[0].body, text.split('\n')[0]).toMatchObject({ wait: 30 });
    }
    // The callback: its two fields, an https URL on a host that resolves, and a secret the API will take (16 to 256 characters).
    const later = restCalls(s.runs.later)[0];
    const callback = asRecord(later.body?.callback);
    expect(Object.keys(callback).sort()).toEqual(schemaProperties('AgentRunCallbackRequest').sort());
    expect(new URL(String(callback.url)).protocol).toBe('https:');
    expect(new URL(String(callback.url)).hostname).toBe('example.com');
    expect(String(callback.secret).length).toBeGreaterThanOrEqual(16);
    expect(String(callback.secret).length).toBeLessThanOrEqual(256);
    expect(later.body).toMatchObject({ class: 'deferred', delay_seconds: 3600 });
    // The header an idempotent retry needs: one key per job, so it carries the agent's key.
    expect(s.runs.later).toContain(`-H "Idempotency-Key: ${variant.agentKey}-weekly-digest-2026-w42"`);
    // A deferred run cannot be streamed, so the streamed sample is not deferred, and neither waits and streams.
    const streamed = restCalls(s.runs.stream)[0].body;
    expect(streamed).toMatchObject({ stream: true });
    expect(streamed).not.toHaveProperty('class');
    expect(streamed).not.toHaveProperty('wait');
    // Streams are read as they arrive.
    expect(s.runs.stream.startsWith('curl -N ')).toBe(true);
    expect(s.runs.events).toContain('curl -N "');
  });

  it('asks chat completions for the agent the way the spec says, and for a stream', () => {
    const body = restCalls(s.openai.chatCurl)[0].body as Record<string, unknown>;
    expect(body.model).toBe(`agent:${variant.agentKey}`);
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([{ role: 'user', content: expect.any(String) }]);
  });

  it('speaks A2A as JSON-RPC message/send, and only while A2A is on', () => {
    expect(s.a2a.enabled).toBe(variant.a2aEnabled);
    if (!variant.a2aEnabled) {
      expect(s.a2a.send).toBeNull();
      return;
    }
    const body = restCalls(s.a2a.send as string)[0].body as { jsonrpc: string; method: string; params: { message: { role: string; parts: Array<{ kind: string }> } } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.method).toBe('message/send');
    expect(body.params.message.role).toBe('user');
    expect(body.params.message.parts.map((part) => part.kind)).toEqual(variant.variables?.length ? ['text', 'data'] : ['text']);
  });
});

describe('following a run, one call at a time', () => {
  const s = buildAgentUsageSnippets(options());

  it('splits the poll, the event stream and the cancel into calls that can each be pasted on their own', () => {
    for (const text of [s.runs.poll, s.runs.events, s.runs.cancel]) {
      expect(restCalls(text), text).toHaveLength(1);
      // The id is a placeholder to replace, set once at the top of the block; the call reads it from there.
      expect(text).toContain('# Replace with the "id" of the run you started');
      expect(text).toMatch(/^RUN_ID=run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/m);
      expect(text).toContain('/agents/runs/$RUN_ID');
    }
    // The stream is the one that does not end, and its block says so.
    expect(s.runs.events).toContain('The stream does not end by itself');
    expect(s.runs.poll).not.toContain('curl -N');
    expect(s.runs.cancel).not.toContain('curl -N');
    expect(s.runs.cancel).toContain('409 agent_run_already_terminal');
  });
});

describe('the answers the tab shows are the answers the API gives', () => {
  const s = buildAgentUsageSnippets(options({ agentKey: 'report-bot' }));
  const [finishedBlock, acceptedBlock] = s.runs.answers.split('\n\n');
  const body = (block: string) => JSON.parse(block.slice(block.indexOf('{'))) as Record<string, unknown>;
  const finished = body(finishedBlock);
  const accepted = body(acceptedBlock);
  const runSchema = spec.components.schemas.AgentRun;

  it('are runs, field for field: every field the API returns, of a type and a value the schema allows', () => {
    for (const run of [finished, accepted]) {
      // Every field of AgentRun (what `serializeAgentRun` returns), none that is not one.
      expect(Object.keys(run).sort()).toEqual(schemaProperties('AgentRun').sort());
      // `result` is shortened on purpose (the caption says so); the rest is checked in full.
      expect(issuesOf(schemaRef('AgentRun'), run, 'run', ['run.result'])).toEqual([]);
      // The enum-valued fields, named: each is one of the values the schema lists.
      for (const [name, property] of Object.entries(runSchema.properties ?? {})) {
        if (property.enum && run[name] !== null) expect(property.enum, `${name}: ${String(run[name])}`).toContain(run[name]);
      }
      expect(run.object).toBe('agent.run');
      expect(String(run.id)).toMatch(/^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(run.agent).toBe('report-bot');
      // Not pinned, so the run names no version; started by a request, not by a trigger.
      expect(run.version).toBeNull();
      expect(run.trigger).toBe('request');
      expect(run.trigger_id).toBeNull();
    }
  });

  it('say 200 for a run that finished and 202, with where to follow it, for one that is still going', () => {
    expect(finishedBlock.startsWith('HTTP/1.1 200 OK\n')).toBe(true);
    expect(finished.status).toBe('succeeded');
    expect(finished.error).toBeNull();
    expect(finished.detached_at).toBeNull();
    expect(typeof finished.output_text).toBe('string');
    expect(asRecord(finished.result).id).toBe(`resp_${String(finished.id).slice('run_'.length)}`);
    expect(Object.keys(asRecord(finished.result)).filter((key) => !schemaProperties('AgentResponse').includes(key))).toEqual([]);
    expect(Object.keys(asRecord(asRecord(finished.result).usage)).filter((key) => !schemaProperties('AgentResponseUsage').includes(key))).toEqual([]);

    expect(acceptedBlock.startsWith('HTTP/1.1 202 Accepted\n')).toBe(true);
    expect(['scheduled', 'queued', 'running']).toContain(accepted.status);
    expect(accepted.result).toBeNull();
    expect(accepted.output_text).toBeNull();
    // It comes from a call whose `wait` ran out: the run went on, and the answer says when the caller stopped waiting.
    expect(Number.isInteger(accepted.detached_at)).toBe(true);
    expect(acceptedBlock).toContain(`Location: /api/client/v1/agents/runs/${String(accepted.id)}\n`);
    expect(acceptedBlock).toContain('\nRetry-After: 2\n');
    // The calls that follow it use that run.
    for (const text of [s.runs.poll, s.runs.events, s.runs.cancel]) expect(text).toContain(`RUN_ID=${String(accepted.id)}`);
  });

  it('stream the way the Responses API does: an event name, then the same type in the data', () => {
    const events = [...s.runs.stream.matchAll(/^# event: (\S+)\n# data: (.+)$/gm)].map((match) => ({ name: match[1], data: JSON.parse(match[2]) as Record<string, unknown> }));
    expect(events.map((event) => event.name)).toEqual(['response.created', 'response.output_text.delta', 'response.completed']);
    for (const event of events) expect(event.data.type).toBe(event.name);
    // The first event names the run and the session (the caption says so): abridged ids, but a run and a session.
    const cognipeer = asRecord(asRecord(events[0].data.response).cognipeer);
    expect(String(cognipeer.run_id)).toMatch(/^run_/);
    expect(typeof cognipeer.session_id).toBe('string');
    // The sample is abridged to a reading width, and the block is a comment: it can be pasted with the curl above it.
    for (const line of s.runs.stream.split('\n')) expect(line.length, line).toBeLessThanOrEqual(120);
    for (const line of s.runs.stream.split('\n').slice(s.runs.stream.split('\n').findIndex((entry) => entry.startsWith('# The answer')))) {
      expect(line.startsWith('#'), line).toBe(true);
    }
  });
});

describe('structured output', () => {
  it('is a contract the agent can enforce, in the form the API takes', () => {
    const sample = STRUCTURED_OUTPUT_SAMPLE;
    expect(resolveResponseFormatSchema({ type: 'json_schema', name: sample.name, schema: sample.schema as unknown as Record<string, unknown>, strict: sample.strict })).toMatchObject({ ok: true });
    const format = restCalls(buildAgentUsageSnippets(options()).runs.structured)[0].body?.response_format as Record<string, unknown>;
    expect(format.type).toBe('json_schema');
    expect(format.json_schema).toEqual(JSON.parse(JSON.stringify(sample)));
    expect(Object.keys(format).filter((key) => !schemaProperties('AgentResponseFormat').includes(key))).toEqual([]);
    expect(sample.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe('the SDK samples', () => {
  const OPENAI_OPERATIONS: Record<string, [method: string, template: string]> = {
    'responses.create': ['post', '/responses'],
    'responses.retrieve': ['get', '/responses/{responseId}'],
    'chat.completions.create': ['post', '/chat/completions'],
  };

  const methodsUsed = (text: string, pattern: RegExp) => [...new Set([...text.matchAll(pattern)].map((match) => match[1]))];

  it('install version 4, the first that has the runs API', () => {
    const s = buildAgentUsageSnippets(options());
    expect(s.sdk.install).toBe('npm install @cognipeer/console-sdk@^4');
  });

  it('are all run: every example the module has is in the script', () => {
    const s = buildAgentUsageSnippets(options());
    expect(['install', 'start', ...SDK_EXAMPLES].sort()).toEqual(Object.keys(s.sdk).sort());
    expect(Object.keys(s.sdkReuses).sort()).toEqual([...SDK_EXAMPLES].sort());
  });

  it.each(VARIANTS)('call only SDK methods that are REST operations the spec documents, with arguments they take (%s)', async (_name, variant) => {
    const s = buildAgentUsageSnippets(variant);
    // By text: every `client.agents.*(` the examples write, in code or in a comment, is on the table, and every method of
    // the table is written somewhere.
    const written = methodsUsed(Object.values(s.sdk).join('\n'), /\bclient\.(agents\.[A-Za-z.]+?)\(/g);
    expect(written.sort()).toEqual(Object.keys(SDK_METHODS).sort());
    // By execution: the script calls every other method of the table, each with the arguments the table lists, held against the spec.
    const { calls } = await runSdkSnippets(s);
    expect(new Set(calls.map((call) => call.method))).toEqual(new Set(Object.keys(SDK_METHODS).filter((method) => !NAMED_IN_COMMENTS.has(method))));
    for (const call of calls) expect(sdkCallIssues(call, variant.agentKey), call.method).toEqual([]);
  });

  it('are checked as hard as the REST samples: a body the spec refuses fails the table', () => {
    const create = (body: unknown, options?: unknown): Recorded => ({ method: 'agents.runs.create', args: ['support-triage', body, ...(options ? [options] : [])] });
    expect(sdkCallIssues(create({ input: 'Hi', wait: 30 }, { idempotencyKey: 'k' }), 'support-triage')).toEqual([]);
    expect(sdkCallIssues(create({ input: 'Hi', unknown_field: {} }), 'support-triage')).toEqual(['agents.runs.create #2.unknown_field: not a field of the schema']);
    expect(sdkCallIssues(create({ input: 'Hi' }, { idempotency: 'k' }), 'support-triage')).toEqual(['agents.runs.create #3: idempotency is not an option of the method']);
    expect(sdkCallIssues({ method: 'agents.runs.cancel', args: ['run_1', {}, 'extra'] }, 'support-triage')).toEqual(['agents.runs.cancel: takes 2 arguments at most, got 3']);
    expect(sdkCallIssues({ method: 'agents.runs.fire', args: [] }, 'support-triage')).toEqual(['agents.runs.fire is not a method of the SDK table']);
    expect(sdkCallIssues({ method: 'agents.runs.list', args: [{ status: ['queued', 'finished'] }] }, 'support-triage')[0]).toContain('status finished');
  });

  it('use only the Python client methods the spec documents', () => {
    const s = buildAgentUsageSnippets(options());
    const openai = methodsUsed(Object.values(s.openai).join('\n'), /\bclient\.((?:responses|chat\.completions)\.[a-z_]+)\(/g);
    expect(openai.sort()).toEqual(Object.keys(OPENAI_OPERATIONS).sort());
    for (const [method, template] of Object.values(OPENAI_OPERATIONS)) expect(Object.keys(spec.paths[template] ?? {}), template).toContain(method);
  });

  it('run, in order, against a client that records the calls: the bodies are the ones the API takes', async () => {
    // Never published, so the version the sample pins is the draft.
    const s = buildAgentUsageSnippets(options({ variables: DECLARED, publishedVersion: null }));
    const { calls, clients, written } = await runSdkSnippets(s);
    const sample = sampleVariables(DECLARED);

    expect(clients).toEqual([{ apiKey: 'YOUR_API_KEY', baseURL: ORIGIN }]);
    expect(calls.map((call) => call.method)).toEqual([
      'agents.runs.create',
      'agents.runs.wait',
      'agents.runs.create',
      'agents.runs.create',
      'agents.runs.create',
      'agents.runs.create',
      'agents.runs.create',
      'agents.runs.wait',
      'agents.runs.events.stream',
      'agents.runs.cancel',
      'agents.runs.list',
      'agents.responses.create',
      'agents.responses.create',
      'agents.responses.create',
      'agents.triggers.create',
      'agents.triggers.run',
    ]);

    const creates = calls.filter((call) => call.method === 'agents.runs.create');
    expect(creates).toHaveLength(6);
    for (const call of creates) {
      expect(call.args[0]).toBe('support-triage');
      expect(asRecord(call.args[1]).variables).toEqual(sample);
    }
    const [start, quick, next, pinned, later, structured] = creates.map((call) => asRecord(call.args[1]));
    expect(start).toMatchObject({ input: expect.any(String) });
    // The samples that hold the call for the answer say how long.
    expect(quick.wait).toBe(30);
    // Continuing a session names the session of the run that was just waited for.
    expect(next).toMatchObject({ session_id: 'sess_1', wait: 30 });
    expect(pinned).toMatchObject({ version: 'draft', wait: 30 });
    expect(later).toMatchObject({ class: 'deferred', delay_seconds: 3600 });
    expect(asRecord(later.callback).url).toBe('https://example.com/hooks/agent-runs');
    expect(String(asRecord(later.callback).secret).length).toBeGreaterThanOrEqual(16);
    expect(asRecord(creates[4].args[2])).toEqual({ idempotencyKey: 'support-triage-weekly-digest-2026-w42' });
    // The structured answer: valid for the API in its chat spelling, and it is read back as output_parsed.
    const format = asRecord(structured.response_format);
    expect(format.type).toBe('json_schema');
    const spelled = asRecord(format.json_schema);
    expect(resolveResponseFormatSchema({ type: 'json_schema', name: String(spelled.name), schema: asRecord(spelled.schema), strict: spelled.strict === true })).toMatchObject({ ok: true });

    // The run that is followed is the one that was started; the deferred job is what the cancel is for; the list asks for what is going.
    expect(calls.find((call) => call.method === 'agents.runs.events.stream')?.args).toEqual(['run_1']);
    expect(calls.find((call) => call.method === 'agents.runs.cancel')?.args).toEqual(['run_1']);
    expect(calls.find((call) => call.method === 'agents.runs.list')?.args).toEqual([{ agent: 'support-triage', status: ['queued', 'running'] }]);

    // Chat style: the Responses fields, with the same variables, continued by the id of the previous response. The model
    // is `agent:<key>`: a bare key would pick a model of that name first.
    const responses = calls.filter((call) => call.method === 'agents.responses.create').map((call) => asRecord(call.args[0]));
    for (const request of responses) expect(request).toMatchObject({ model: 'agent:support-triage', variables: sample });
    expect(responses[1].previous_response_id).toBe('resp_1');
    expect(responses[2].stream).toBe(true);

    // A trigger: a schedule the API takes, a prompt, and the variables; then fired by hand.
    const trigger = asRecord(calls.find((call) => call.method === 'agents.triggers.create')?.args[1]);
    expect(trigger).toMatchObject({
      name: 'Weekday digest',
      type: 'schedule',
      schedule: { cron: '0 9 * * 1-5', timezone: 'UTC' },
      variables: sample,
      class: 'deferred',
    });
    expect(resolveRunVariables(DECLARED, asRecord(trigger.variables))).toMatchObject({ ok: true });
    expect(calls.find((call) => call.method === 'agents.triggers.run')?.args).toEqual(['support-triage', 'trg_1']);

    // The live part of the event stream was written out, and the loop stopped at the idle event.
    expect(written.join('')).toContain('He');
    expect(written.join('')).toContain('Hi');
  });

  it('pass no variables when the agent declares none', async () => {
    const { calls } = await runSdkSnippets(buildAgentUsageSnippets(options()));
    for (const call of calls.filter((entry) => ['agents.runs.create', 'agents.triggers.create'].includes(entry.method))) {
      expect(asRecord(call.args[1])).not.toHaveProperty('variables');
    }
    for (const call of calls.filter((entry) => entry.method === 'agents.responses.create')) {
      expect(asRecord(call.args[0])).not.toHaveProperty('variables');
    }
  });

  it('follow a run: print the stored answer when none was written live, print live text once, and leave the run alone', async () => {
    const s = buildAgentUsageSnippets(options());
    // A run started with `runs.create` never streams text deltas: the answer is the stored `agent.message`.
    const stored = await runSdkSnippets(s, { then: ['follow'], events: STORED_EVENTS });
    expect(stored.calls.map((call) => call.method)).toEqual(['agents.runs.create', 'agents.runs.wait', 'agents.runs.events.stream']);
    expect(stored.logged).toContainEqual({ level: 'log', args: ['tool:', 'lookup'] });
    expect(stored.logged).toContainEqual({ level: 'log', args: ['Hello from the stored message'] });
    expect(stored.written).toEqual([]);
    // A run that does write live: the deltas are the answer, and the stored message is not printed a second time.
    const live = await runSdkSnippets(s, { then: ['follow'], events: LIVE_EVENTS });
    expect(live.written.join('')).toBe('He');
    expect(live.logged.filter((entry) => entry.args[0] === 'Hello')).toEqual([]);
    expect(live.calls.map((call) => call.method)).toEqual(['agents.runs.create', 'agents.runs.wait', 'agents.runs.events.stream']);
  });

  it('tell a run that paused for an approval from one that failed', async () => {
    const s = buildAgentUsageSnippets(options());
    const outcome = async (status: string) => (await runSdkSnippets(s, { then: [], status })).logged;
    expect(await outcome('succeeded')).toEqual([{ level: 'log', args: ['ok'] }]);
    expect(await outcome('requires_action')).toEqual([{ level: 'log', args: ['Waiting for an approval or an answer:', 'run_1'] }]);
    expect(await outcome('failed')).toEqual([{ level: 'error', args: ['Run did not succeed:', 'failed', 'boom'] }]);
    // And it says where the answer to a paused run goes.
    expect(s.sdk.start).toContain('client.agents.runs.resolveAction(done.id, actionId, body)');
  });

  it.each(VARIANTS)('say what each example takes from the ones above it (%s)', (_name, variant) => {
    const s = buildAgentUsageSnippets(variant);
    // The first example makes everything it uses.
    expect(reusedNames(s.sdk.start)).toEqual([]);
    // The others name what they read without making it, and the caption of each says so.
    for (const key of SDK_EXAMPLES) expect(reusedNames(s.sdk[key]).sort(), key).toEqual([...s.sdkReuses[key]].sort());
    expect(s.sdkReuses.options).toEqual(variant.variables?.length ? ['client', 'done', 'variables'] : ['client', 'done']);
    expect(s.sdkReuses.follow).toEqual(['client', 'run']);
    expect(s.sdkReuses.manage).toEqual(['client', 'job']);
  });

  it('are valid TypeScript (the types are stripped without complaint) for every kind of agent', () => {
    for (const [, variant] of VARIANTS) {
      const s = buildAgentUsageSnippets(variant);
      for (const code of Object.values(s.sdk).filter((text) => !text.startsWith('npm '))) {
        const result = ts.transpileModule(code, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
        expect(result.diagnostics?.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) ?? []).toEqual([]);
      }
    }
  });
});

describe('the OpenAI samples', () => {
  it('name the agent with the prefix that always means an agent', () => {
    const s = buildAgentUsageSnippets(options({ variables: DECLARED, agentKey: 'report-bot' }));
    for (const code of [s.openai.responses, s.openai.background, s.openai.chat]) {
      expect(code.match(/model="([^"]+)"/g)).not.toBeNull();
      for (const model of code.matchAll(/model="([^"]+)"/g)) expect(model[1]).toBe('agent:report-bot');
    }
    // Read back until the run leaves its two live states; a 202 is how a background response answers.
    expect(s.openai.background).toContain('background=True');
    expect(s.openai.background).toContain('while job.status in ("queued", "in_progress"):');
    expect(s.openai.background).toContain('client.responses.retrieve(job.id)');
    expect(s.openai.responses).toContain('previous_response_id=response.id');
  });

  it.each(VARIANTS)('can each be pasted on its own: the client it calls is made in it (%s)', (_name, variant) => {
    const s = buildAgentUsageSnippets(variant);
    for (const code of [s.openai.responses, s.openai.background, s.openai.chat]) {
      expect(code).toContain('from openai import OpenAI');
      expect(code).toMatch(/^client = OpenAI\(base_url="[^"]+", api_key="YOUR_API_KEY"\)$/m);
      // A name it passes is a name it defines.
      if (code.includes('extra_body={"variables": variables}')) expect(code).toMatch(/^variables = /m);
    }
    expect(s.openai.background).toMatch(/^import time$/m);
  });

  it('lists agents under /models as agent:<key>, as the spec says', () => {
    const listed = JSON.stringify(spec.paths['/models']);
    expect(listed).toContain('agent:<key>');
  });
});

describe('the calls the rest of the Agent page shares with the tab', () => {
  it('are one function each: the A2A example of Ship and the quick start of the Overview are the tab’s samples', () => {
    const s = buildAgentUsageSnippets(options({ variables: DECLARED }));
    const sample = sampleVariables(DECLARED);
    expect(a2aSendCurl({ endpointUrl: ENDPOINT, isPublic: false, variables: sample })).toBe(s.a2a.send);
    expect(chatCompletionsCurl({ baseUrl: BASE, agentKey: 'support-triage', variables: sample, stream: true })).toBe(s.openai.chatCurl);
  });

  it('follow the rules of the tab: agent:<key>, YOUR_API_KEY, variables when declared, a token only where one is needed', () => {
    const sample = sampleVariables(DECLARED);
    const quick = chatCompletionsCurl({ baseUrl: BASE, agentKey: 'support-triage', variables: sample, stream: false });
    const call = restCalls(quick)[0];
    expect(call).toMatchObject({ method: 'post', pathname: '/api/client/v1/chat/completions', headers: ['Authorization', 'Content-Type'] });
    expect(call.body).toEqual({ model: 'agent:support-triage', messages: [{ role: 'user', content: expect.any(String) }], variables: sample });
    expect(quick).toContain('Authorization: Bearer YOUR_API_KEY');
    expect(quick).not.toMatch(/ -N | stream/);
    expect(restCalls(chatCompletionsCurl({ baseUrl: BASE, agentKey: 'faq', variables: null, stream: false }))[0].body).not.toHaveProperty('variables');

    const open = a2aSendCurl({ endpointUrl: PUBLIC_ENDPOINT, isPublic: true, variables: null });
    expect(open).not.toContain('Authorization');
    expect(restCalls(open)[0].body).toMatchObject({ method: 'message/send', params: { message: { parts: [{ kind: 'text' }] } } });
    const keyed = a2aSendCurl({ endpointUrl: ENDPOINT, isPublic: false, variables: sample });
    expect(keyed).toContain('Authorization: Bearer YOUR_API_KEY');
    expect(keyed).toContain('"kind": "data"');
    for (const text of [quick, open, keyed]) expect(issuesOf(requestSchemaOf(documentedPath(restCalls(text)[0].pathname)?.template as string, 'post') as JsonSchema, restCalls(text)[0].body, 'body')).toEqual([]);
  });

  it('are what the page and the Overview call, not a second copy of the text', () => {
    const page = sourceOf('components/agents/AgentDetailPage.tsx');
    expect(page).toContain('a2aSendCurl({ endpointUrl: a2aEndpointUrl, isPublic: a2aIsPublic, variables: sampleVariables(callVariables) })');
    expect(page).not.toContain('"method": "message/send"');
    // It waits for the variables of the published version rather than show the draft's for a moment.
    expect(page).toMatch(/\{!variablesLoading && \(\s*<>\s*<Text size="sm" c="dimmed">\{t\('a2a\.exampleLabel'\)\}<\/Text>\s*<Code block>\s*\{a2aSendCurl\(/);
    const overview = sourceOf('components/agents/studio/AgentOverviewPanel.tsx');
    expect(overview).toContain('chatCompletionsCurl({');
    expect(overview).not.toMatch(/YOUR_API_TOKEN|"model": "\$\{agent\.key\}"/);
  });
});

describe('what the old tab said and the API no longer does', () => {
  // The vocabulary the rename retired. Each word has one letter in brackets (and the keys are joined from pieces), so a
  // search for the old names finds only code that still uses them, not this guard.
  const RETIRED_WORDS = /rout[i]ne|rut[i]n|\binput[s]\b|gird[i]|\btype[d]\b|tipl[i]/i;
  const word = (...pieces: string[]) => pieces.join('');

  it.each(VARIANTS)('is gone from the samples of %s', (_name, variant) => {
    const text = everyText(buildAgentUsageSnippets(variant)).join('\n');
    // The Assistants wire was removed; background mode is the runs API (`wait`, `class`, a 202) or `background: true`.
    expect(text).not.toMatch(/\/assistants|\/threads|assistant_id|thread_id|assistants api/i);
    expect(text).not.toMatch(/x-cognipeer-background/i);
    expect(text).not.toMatch(/callback_url|callback_secret/);
    // A secret is never printed as asterisks, and the old agent-default-mode wording is gone.
    expect(text).not.toContain('******');
    expect(text).not.toMatch(/default mode/i);
    // A response id of the old scheme (the conversation id) is not how a conversation is continued any more.
    expect(text).not.toContain('resp_<conversation_id>');
    // The words of the vocabulary the rename retired are gone.
    expect(text).not.toMatch(RETIRED_WORDS);
  });

  it('is gone from the words, in both languages', () => {
    for (const messages of [en.agents.usage, tr.agents.usage]) {
      const text = JSON.stringify(messages);
      expect(text).not.toMatch(/assistants?\b|asistan/i);
      expect(text).not.toMatch(/x-cognipeer-background/i);
      expect(text).not.toMatch(RETIRED_WORDS);
    }
    // The keys of the old tab are gone with it, and so are the ones the rename retired.
    for (const messages of [en.agents.usage, tr.agents.usage] as Array<Record<string, unknown>>) {
      for (const key of ['sdkTitle', 'installLabel', 'chatLabel', 'restTitle', 'restLabel', 'responseTitle', word('input', 's', 'Note'), 'copy', 'copied']) {
        expect(messages, key).not.toHaveProperty(key);
      }
      const retired: Record<string, string[]> = {
        runs: ['follow'],
        sdk: [word('rout', 'ine')],
        a2a: [word('send', 'Input', 's')],
        docs: ['runsApi', word('rout', 'ines')],
      };
      for (const [group, keys] of Object.entries(retired)) {
        for (const key of keys) expect(asRecord(messages[group]), `${group}.${key}`).not.toHaveProperty(key);
      }
    }
  });

  it('is gone from the code of the tab, with the card URL that was never read', () => {
    for (const file of ['components/agents/agentUsageSnippets.ts', 'components/agents/AgentUsagePanel.tsx', 'components/agents/CopyableCode.tsx']) {
      const source = sourceOf(file);
      expect(source, file).not.toMatch(RETIRED_WORDS);
      expect(source, file).not.toMatch(/IAgentInput[F]ield|agentInput[s]|a2aCard[U]rl/);
    }
  });
});

// ── The tab ───────────────────────────────────────────────────────────────

const render = (node: ReactNode, locale: 'en' | 'tr' = 'en') =>
  renderToStaticMarkup(h(MantineProvider, null, h(I18nProvider, { locale, children: node })));

const panel = (over: Partial<Parameters<typeof AgentUsagePanel>[0]> = {}) =>
  h(AgentUsagePanel, {
    agentName: 'Support Triage',
    agentKey: 'support-triage',
    publishedVersion: 3,
    variables: undefined,
    origin: ORIGIN,
    a2aEnabled: true,
    a2aEndpointUrl: ENDPOINT,
    a2aIsPublic: false,
    ...over,
  });

const ENTITIES: Record<string, string> = { quot: '"', '#x27': "'", amp: '&', lt: '<', gt: '>' };

/** Text as it comes out of the markup: tags dropped, entities decoded in one pass (`&amp;lt;` stays `&lt;`). */
const textOf = (html: string) => {
  let text = html;
  for (let before = ''; before !== text;) {
    before = text;
    text = text.replace(/<[^>]*>/g, '');
  }
  return text.replace(/&(quot|#x27|amp|lt|gt);/g, (_, name: string) => ENTITIES[name]);
};

describe('the Usage tab', () => {
  it('shows the header, then Runs API, SDK, OpenAI, A2A and the docs, in that order', () => {
    const html = render(panel());
    const text = textOf(html);
    const order = ['API usage', 'Base URL', 'Agent key', 'Runs API (recommended)', 'TypeScript SDK 4.0', 'OpenAI-compatible endpoints', 'A2A (agent-to-agent)', 'Documentation'];
    // The titles are paragraphs; the links of the nav at the top carry some of the same words.
    const positions = order.map((title) => html.indexOf(`>${title}</p>`));
    expect(positions.every((position) => position >= 0), JSON.stringify(positions)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    expect(text).toContain('Call Support Triage from your own code.');
    // The header: the base URL, the key, the version that runs, the token it needs.
    expect(text).toContain(`${ORIGIN}/api/client/v1`);
    expect(text).toContain('Calls run the published version, v3.');
    expect(text).toContain('write access to the Agents service');
    // Snippets are on the page, copyable.
    expect(text).toContain(`curl -X POST ${ORIGIN}/api/client/v1/agents/support-triage/runs`);
    expect(text).toContain('npm install @cognipeer/console-sdk@^4');
    expect(text).toContain('client.responses.create(');
    expect(text).toContain('"jsonrpc": "2.0"');
    // One copy button for the base URL, one for the key, and one per snippet.
    const shown = buildAgentUsageSnippets(options());
    const snippetCount = [shown.runs, shown.sdk, shown.openai].reduce((sum, group) => sum + Object.keys(group).length, 0) + 1 + 1;
    expect(html.match(/aria-label="Copy"/g)?.length).toBe(2 + snippetCount);
    // No key printed as its own path: every sentence resolved.
    expect(html).not.toMatch(/agents\.usage\./);
  });

  it('opens with a nav of links to its sections, and every link lands on a section of the page', () => {
    const html = render(panel());
    const nav = html.match(/<nav aria-label="On this page">([^]*?)<\/nav>/)?.[1] ?? '';
    // Links, not buttons: they work without script and are announced as links.
    expect(nav).not.toContain('<button');
    const links = [...nav.matchAll(/<a [^>]*href="#([^"]+)"[^>]*>([^<]*)<\/a>/g)].map((match) => ({ id: match[1], label: match[2] }));
    expect(links.map((link) => link.label)).toEqual(['Runs API', 'SDK', 'OpenAI-compatible', 'A2A', 'Documentation']);
    expect(links.map((link) => link.id)).toEqual(USAGE_SECTIONS.map(usageSectionId));
    // Each target exists once, in the order of the nav, below it.
    const positions = links.map((link) => html.indexOf(`id="${link.id}"`));
    expect(positions.every((position) => position > html.indexOf('</nav>'))).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const link of links) expect(html.match(new RegExp(`id="${link.id}"`, 'g'))).toHaveLength(1);
  });

  it('links every docs page, in a new tab, safely', () => {
    const html = render(panel());
    for (const link of buildAgentUsageSnippets(options()).docs) {
      expect(html).toContain(`href="${buildDocsUrl(DEFAULT_DOCS_BASE_URL, link.doc)}"`);
    }
    // The nine guides and the API reference of the header; the links of the nav stay on the page.
    expect(html).toContain('href="https://docs.cognipeer.com/console/developer/api/agents#runs-api"');
    expect(html.match(/rel="noopener noreferrer"/g)?.length).toBe(AGENT_DOC_LINKS.length + 1);
    expect(html.match(/target="_blank"/g)?.length).toBe(AGENT_DOC_LINKS.length + 1);
  });

  it('says the draft runs while nothing is published, and the number once something is', () => {
    expect(textOf(render(panel({ publishedVersion: null })))).toContain('Nothing is published yet, so calls run the draft.');
    expect(textOf(render(panel({ publishedVersion: 12 })))).toContain('Calls run the published version, v12.');
  });

  it('mentions variables only for an agent that declares some, and names what each SDK example reuses', () => {
    const plain = textOf(render(panel()));
    expect(plain).not.toContain('This agent declares variables');
    expect(plain).toContain('Uses client, done from the examples above:');
    expect(plain).toContain('Uses client, run from the examples above:');
    expect(plain).toContain('Uses client, job from the examples above:');

    const withVariables = textOf(render(panel({ variables: DECLARED })));
    expect(withVariables).toContain('This agent declares variables');
    expect(withVariables).toContain('"customer_id": "<customer_id>"');
    expect(withVariables).toContain('The variables this agent declares travel in a data part');
    expect(withVariables).toContain('Uses client, done, variables from the examples above:');
    expect(withVariables).toContain('Uses client, variables from the examples above:');
  });

  it('shows no samples while the variables of the published version are still being fetched', () => {
    const html = render(panel({ variables: DECLARED, variablesLoading: true }));
    const text = textOf(html);
    expect(text).not.toContain('curl');
    expect(text).not.toContain('API usage');
    expect(html).not.toContain('aria-label="Copy"');
  });

  it('says whether A2A is on, and offers message/send only when it is', () => {
    const on = textOf(render(panel()));
    expect(on).toContain('Exposed. Other agents discover it');
    expect(on).toContain('"method": "message/send"');
    const off = textOf(render(panel({ a2aEnabled: false })));
    expect(off).toContain('Not exposed yet.');
    expect(off).not.toContain('"method": "message/send"');
    expect(off).toContain(`curl ${ENDPOINT}/.well-known/agent-card.json`);
  });

  it('asks for no token where the A2A endpoint is public', () => {
    const open = textOf(render(panel({ a2aEndpointUrl: PUBLIC_ENDPOINT, a2aIsPublic: true })));
    expect(open).toContain(`curl ${PUBLIC_ENDPOINT}/.well-known/agent-card.json`);
    expect(open).toContain(`curl -X POST ${PUBLIC_ENDPOINT} \\`);
  });

  it('draws what is between backticks as code', () => {
    const html = renderToStaticMarkup(h(MantineProvider, null, h('p', null, withInlineCode('Send `version` or `"draft"` now'))));
    expect(html).toMatch(/Send <code[^>]*>version<\/code> or <code[^>]*>&quot;draft&quot;<\/code> now/);
    expect(renderToStaticMarkup(h('p', null, withInlineCode('no code here')))).toBe('<p>no code here</p>');
  });

  it('renders in Turkish, with the code unchanged', () => {
    const html = render(panel({ publishedVersion: null }), 'tr');
    const text = textOf(html);
    expect(text).toContain('API kullanımı');
    expect(text).toContain('Runs API (önerilen)');
    expect(text).toContain('Henüz yayınlanmış sürüm yok');
    expect(text).toContain(`curl -X POST ${ORIGIN}/api/client/v1/agents/support-triage/runs`);
    expect(html).toContain('aria-label="Kopyala"');
    expect(html).toContain('<nav aria-label="Bu sayfada">');
    expect(html).not.toMatch(/agents\.usage\./);
    expect(text).not.toContain('Runs API (recommended)');
  });

  it('is what the Agent page renders in its Usage tab, from what the page already has', () => {
    const page = sourceOf('components/agents/AgentDetailPage.tsx');
    expect(page).toContain("import AgentUsagePanel from './AgentUsagePanel';");
    expect(page).toMatch(
      /<Tabs\.Panel value="usage">\s*\{activeTab === 'usage'(?: && !ownedByFlow)? \? \(\s*<AgentUsagePanel\s+agentName=\{agent\.name\}\s+agentKey=\{agent\.key\}\s+publishedVersion=\{agent\.publishedVersion\}\s+variables=\{callVariables\}\s+variablesLoading=\{variablesLoading\}\s+origin=\{origin\}\s+a2aEnabled=\{a2aEnabled\}\s+a2aEndpointUrl=\{a2aEndpointUrl\}\s+a2aIsPublic=\{a2aIsPublic\}\s*\/>/,
    );
    // The variables are those of the version a call runs (the published snapshot), and the Overview gets the same ones.
    expect(page).toMatch(
      /const callVariables = variablesOfRunVersion\(\{\s*publishedVersion: publishedVersionNumber,\s*publishedConfig,\s*draftVariables: agent\.config\?\.variables,\s*\}\);/,
    );
    expect(page).toMatch(/const variablesLoading = Boolean\(publishedVersionNumber\) && publishedConfigKey !== `\$\{agentId\}@\$\{publishedVersionNumber\}`;/);
    expect(page).toMatch(/<AgentOverviewPanel\s+agent=\{agent\}\s+variables=\{callVariables\}\s+variablesLoading=\{variablesLoading\}/);
    // The old tab's body, and the redacted header it carried, are gone from the page.
    expect(page).not.toContain('Background execution (long-running turns)');
    expect(page).not.toContain('x-cognipeer-background');
    expect(page).not.toContain('******');
    expect(page).not.toMatch(/t\('usage\./);
  });
});

describe('the Overview quick start', () => {
  const overview = (over: Partial<Parameters<typeof AgentOverviewPanel>[0]> = {}) =>
    h(AgentOverviewPanel, {
      agent: { key: 'support-triage', name: 'Support Triage', status: 'active', publishedVersion: 3 },
      isConnected: false,
      sessionCount: 0,
      onStartSession: () => undefined,
      onGoToTab: () => undefined,
      ...over,
    });

  it('is the chat completions call of the tab: agent:<key>, YOUR_API_KEY, the variables of the version a call runs', () => {
    const plain = textOf(render(overview()));
    expect(plain).toMatch(/curl -X POST \S+\/api\/client\/v1\/chat\/completions/);
    expect(plain).toContain('Authorization: Bearer YOUR_API_KEY');
    expect(plain).toContain('"model": "agent:support-triage"');
    expect(plain).not.toContain('"variables"');
    expect(plain).not.toContain('YOUR_API_TOKEN');

    const withVariables = textOf(render(overview({ variables: DECLARED })));
    expect(withVariables).toContain('"variables": {');
    expect(withVariables).toContain('"customer_id": "<customer_id>"');
  });

  it('waits for the published version before it shows a call', () => {
    const waiting = textOf(render(overview({ variables: DECLARED, variablesLoading: true })));
    expect(waiting).not.toContain('chat/completions');
    expect(waiting).not.toContain('agent:support-triage');
    // The rest of the panel is there.
    expect(waiting).toContain('Quick start');
  });
});

// ── Words ─────────────────────────────────────────────────────────────────

describe('strings', () => {
  const flatten = (node: unknown, prefix = ''): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string') out[`${prefix}${key}`] = value;
      else if (value && typeof value === 'object') Object.assign(out, flatten(value, `${prefix}${key}.`));
    }
    return out;
  };
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  const english = flatten(en.agents.usage);
  // `tr.agents` spreads the English block, which hides a missing Turkish key; the Turkish tree is checked on its own.
  const turkish = flatten(tr.agents.usage);

  it('has the same keys and placeholders in English and Turkish, none empty', () => {
    expect(Object.keys(turkish).sort()).toEqual(Object.keys(english).sort());
    for (const key of Object.keys(english)) {
      expect(english[key].trim(), key).not.toBe('');
      expect(turkish[key].trim(), key).not.toBe('');
      expect(placeholders(turkish[key]), key).toEqual(placeholders(english[key]));
    }
    expect(placeholders(english.description)).toEqual(['name']);
    expect(placeholders(english.versionPublished)).toEqual(['version']);
    expect(placeholders(english['openai.description'])).toEqual(['key']);
    expect(placeholders(english['sdk.reuses'])).toEqual(['names']);
  });

  it('translates the words, and leaves only names as they are', () => {
    const names = new Set(['sdk.title', 'nav.runs', 'nav.sdk', 'nav.a2a', 'docs.openaiSdk', 'docs.n8n', 'docs.openWebui', 'docs.sdkAgents']);
    const same = Object.keys(english).filter((key) => english[key] === turkish[key] && !names.has(key));
    expect(same).toEqual([]);
  });

  it('draws every code span: backticks come in pairs', () => {
    for (const [locale, messages] of [['en', english], ['tr', turkish]] as const) {
      for (const [key, text] of Object.entries(messages)) expect((text.match(/`/g) ?? []).length % 2, `${locale}:${key}`).toBe(0);
    }
  });

  it('has no key the tab does not read, and no key the tab reads that is missing', () => {
    const read = new Set<string>();
    for (const match of sourceOf('components/agents/AgentUsagePanel.tsx').matchAll(/\bt\('([^']+)'/g)) read.add(match[1]);
    // The labels of the nav and of the docs are looked up by the id of each section and each link.
    for (const section of USAGE_SECTIONS) read.add(`nav.${section}`);
    for (const link of AGENT_DOC_LINKS) read.add(`docs.${link.id}`);
    expect([...read].sort()).toEqual(Object.keys(english).sort());
  });

  it('keeps the copy button of a code block outside the tab, where the A2A section can read it too', () => {
    const source = sourceOf('components/agents/CopyableCode.tsx');
    expect(source).toContain("useTranslations('agents')");
    expect(source).toContain("t('copy')");
    expect(source).toContain("t('copied')");
    expect([en.agents.copy, en.agents.copied]).toEqual(['Copy', 'Copied']);
    expect([tr.agents.copy, tr.agents.copied]).toEqual(['Kopyala', 'Kopyalandı']);
    // The A2A section of Ship draws its example with the same component.
    expect(sourceOf('components/agents/AgentDetailPage.tsx')).toContain("import CopyableCode from './CopyableCode';");
  });

  it('says what the runs API does in the words of the API', () => {
    // 200 is a run that finished OR paused; a paused one is answered where the SDK and the API say.
    for (const text of [english['runs.answers'], turkish['runs.answers']]) {
      expect(text).toContain('requires_action');
      expect(text).toContain('/agents/runs/{runId}/actions/{actionId}');
      expect(text).toContain('`200`');
      expect(text).toContain('`202`');
    }
    expect(english['sdk.start']).toContain('requires_action');
    expect(turkish['sdk.start']).toContain('requires_action');
    // The callback is signed with its secret and the signature has a header; the URL is a placeholder to replace.
    expect(english['runs.later']).toContain('The `callback` is signed with its `secret`; the signature arrives in an `X-Cognipeer-Signature` header.');
    expect(english['runs.later']).toContain('Replace the callback URL with your own endpoint');
    expect(english['runs.later']).toContain('use a key unique to the request');
    expect(turkish['runs.later']).toContain('X-Cognipeer-Signature');
    // The answer a request asks for in a shape is a structured answer.
    expect(english['runs.structured']).toContain('JSON answer');
    expect(english['sdk.structured']).toContain('structured answer');
    expect(turkish['sdk.structured']).toContain('Yapılandırılmış');
  });

  it('words the Turkish the way the console does, with the characters of the language', () => {
    // The token scope is 'Ajanlar' with 'Yazma' access; the triggers panel says 'Callback URL’si' and 'İmzalama sırrı'.
    expect(turkish.token).toContain('Ajanlar: Yazma');
    expect(turkish.token).not.toMatch(/Agents|\bWrite\b/);
    expect(turkish['runs.later']).toContain('Callback URL’sini');
    expect(turkish['runs.later']).toContain('imzalama sırrıyla');
    expect(turkish['runs.stream']).toContain('OpenAI Responses biçiminde');
    expect(turkish['sdk.trigger']).toContain('Ship → Tetikleyiciler');
    expect(JSON.stringify(tr.agents.usage)).not.toMatch(/sözlüğ/i);
    // No Turkish word written in plain ASCII where the language has a letter of its own.
    expect(JSON.stringify(tr.agents.usage)).not.toMatch(/\b(?:yayinla\w*|calistir\w*|gonder\w*|surum\w*|olustur\w*|degistir\w*|kullanim\w*|oncelik\w*|aciklama\w*|dogrulan\w*|yaniti?\w*|isteg\w*)\b/i);
  });

  it('names the sections of the nav in both languages', () => {
    expect(Object.keys(en.agents.usage.nav).sort()).toEqual(['a2a', 'docs', 'label', 'openai', 'runs', 'sdk']);
    expect(Object.keys(tr.agents.usage.nav).sort()).toEqual(['a2a', 'docs', 'label', 'openai', 'runs', 'sdk']);
    expect([en.agents.usage.nav.label, tr.agents.usage.nav.label]).toEqual(['On this page', 'Bu sayfada']);
  });
});
