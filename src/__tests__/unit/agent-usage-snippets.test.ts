/**
 * The Usage tab of an agent: the code it shows, and that the code is true.
 *
 * Every sample comes from one pure function (`buildAgentUsageSnippets`), so what the tab teaches can be held against
 * what the API is: each REST call must exist in openapi.yaml under the same method, each body field must be a field
 * of the schema it is sent to, the inputs it prefills must pass the validator the API runs, the structured-output
 * sample must be a contract the agent can enforce, and the SDK samples are executed against a recording client so a
 * renamed method or a misspelled field fails here instead of in a customer's editor. (createElement, not JSX: the
 * suite only collects `.test.ts`.)
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement as h, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import ts from 'typescript';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import AgentUsagePanel, { withInlineCode } from '@/components/agents/AgentUsagePanel';
import {
  AGENT_DOC_LINKS,
  AGENT_DOCS_BASE_URL,
  STRUCTURED_OUTPUT_SAMPLE,
  buildAgentUsageSnippets,
  formatLiteral,
  inputPlaceholder,
  sampleInputs,
  type AgentUsageSnippetOptions,
  type AgentUsageSnippets,
} from '@/components/agents/agentUsageSnippets';
import type { IAgentInputField } from '@/lib/database/provider/types.domain';
import { I18nProvider } from '@/lib/i18n';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';
import { resolveRunInputs } from '@/lib/services/agents/agentInputs';
import { resolveResponseFormatSchema } from '@/lib/services/agents/agentRuntimeConfig';

// ── Fixtures ──────────────────────────────────────────────────────────────

const ORIGIN = 'https://console.example.com';
const BASE = `${ORIGIN}/api/client/v1`;
const CARD = `${BASE}/a2a/support-triage/.well-known/agent-card.json`;
const PUBLIC_CARD = `${ORIGIN}/api/public/a2a/tenant123/slug456/.well-known/agent-card.json`;

/** One input of every type, an enum, a default, and a default that holds an apostrophe (it must survive the shell). */
const DECLARED: IAgentInputField[] = [
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
  inputs: undefined,
  a2aEnabled: true,
  a2aCardUrl: CARD,
  ...over,
});

const VARIANTS: Array<[string, AgentUsageSnippetOptions]> = [
  ['an agent without inputs', options()],
  ['an agent with inputs, never published, A2A off', options({ inputs: DECLARED, publishedVersion: null, a2aEnabled: false })],
  ['an agent exposed publicly over A2A', options({ agentKey: 'faq-bot', publishedVersion: 1, a2aCardUrl: PUBLIC_CARD })],
];

// ── openapi.yaml ──────────────────────────────────────────────────────────

type Schema = { properties?: Record<string, unknown>; enum?: unknown[] };
type PathItem = { servers?: Array<{ url?: string }> } & Record<string, unknown>;
const spec = parse(readFileSync(path.resolve(__dirname, '../../../openapi.yaml'), 'utf8')) as {
  paths: Record<string, PathItem>;
  components: { schemas: Record<string, Schema> };
};

const schemaProperties = (name: string): string[] => Object.keys(spec.components.schemas[name]?.properties ?? {});

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
  body: Record<string, unknown> | undefined;
}

/** Every `curl` command of a snippet: its method (as curl would send it), its path, and its JSON body. */
function restCalls(text: string): RestCall[] {
  const starts = [...text.matchAll(/^curl\b/gm)].map((match) => match.index as number);
  return starts.map((start, index) => {
    const command = text.slice(start, starts[index + 1] ?? text.length);
    const url = new URL((command.match(/https?:\/\/[^\s"]+/) as RegExpMatchArray)[0]);
    const explicit = command.match(/-X\s+(\w+)/)?.[1]?.toLowerCase();
    const bodyText = command.match(/-d '((?:[^']|'\\'')*)'/)?.[1];
    const method = explicit ?? (bodyText === undefined ? 'get' : 'post');
    expect(['get', 'post']).toContain(method);
    return {
      method: method as 'get' | 'post',
      pathname: url.pathname,
      body: bodyText === undefined ? undefined : (JSON.parse(bodyText.replace(/'\\''/g, "'")) as Record<string, unknown>),
    };
  });
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

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

// ── The SDK samples, executed ─────────────────────────────────────────────

interface Recorded {
  method: string;
  args: unknown[];
}

const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<void>;

/**
 * Runs the SDK samples in order, as one script, against a client that records what it is asked. The samples are
 * TypeScript: the types are stripped, the imports are replaced by the two guards the SDK exports.
 */
async function runSdkSnippets(s: AgentUsageSnippets) {
  const calls: Recorded[] = [];
  const clients: unknown[] = [];
  const written: string[] = [];

  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
  };
  const run = { id: 'run_1', object: 'agent.run', status: 'queued', session_id: 'sess_1' };
  const settled = { ...run, status: 'succeeded', output_text: 'ok', output_parsed: { priority: 'high', summary: 'x' } };
  async function* runEvents() {
    yield { type: 'agent.message.delta', data: { text: 'He' } };
    yield { type: 'agent.tool_use', data: { name: 'lookup' } };
    yield { type: 'session.status_idle', data: {} };
    yield { type: 'never.read', data: {} };
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
      routines: {
        create: async (...args: unknown[]) => (record('agents.routines.create')(...args), { id: 'rtn_1' }),
        run: async (...args: unknown[]) => (record('agents.routines.run')(...args), run),
      },
    },
  };
  function ConsoleClient(this: unknown, clientOptions: unknown) {
    clients.push(clientOptions);
    return fake;
  }

  const source = [s.sdk.start, s.sdk.options, s.sdk.later, s.sdk.structured, s.sdk.follow, s.sdk.chat, s.sdk.routine]
    .join('\n\n')
    .replace(/^import .*;\n/gm, '');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const guard = (event: { type: string }, type: string) => event.type === type;
  await new AsyncFunction('ConsoleClient', 'isSessionEvent', 'isResponseStreamEvent', 'process', js)(
    ConsoleClient,
    guard,
    guard,
    { stdout: { write: (text: string) => (written.push(text), true) } },
  );
  return { calls, clients, written };
}

// ── The samples ───────────────────────────────────────────────────────────

describe('what the page passes shows up in the samples', () => {
  it('builds every URL from the origin and the key', () => {
    const s = buildAgentUsageSnippets(options({ origin: 'https://acme.example.org', agentKey: 'billing_bot' }));
    expect(s.baseUrl).toBe('https://acme.example.org/api/client/v1');
    expect(s.agentKey).toBe('billing_bot');
    expect(s.runs.start).toContain('curl -X POST https://acme.example.org/api/client/v1/agents/billing_bot/runs');
    expect(s.runs.list).toContain('"https://acme.example.org/api/client/v1/agents/runs?agent=billing_bot&');
    expect(s.sdk.start).toContain("baseURL: 'https://acme.example.org',");
    expect(s.sdk.start).toContain("client.agents.runs.create('billing_bot', {");
    expect(s.openai.responses).toContain('base_url="https://acme.example.org/api/client/v1"');
    expect(s.openai.responses).toContain('model="agent:billing_bot"');
    expect(s.openai.chatCurl).toContain('"model": "agent:billing_bot"');
    expect(s.a2a.cardUrl).toBe(CARD);
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

  it('links the docs under the docs site, one page each', () => {
    const s = buildAgentUsageSnippets(options());
    expect(AGENT_DOCS_BASE_URL).toBe('https://docs.cognipeer.com');
    expect(s.docs.map((link) => link.id)).toEqual(AGENT_DOC_LINKS.map((link) => link.id));
    expect(new Set(s.docs.map((link) => link.url)).size).toBe(AGENT_DOC_LINKS.length);
    for (const link of s.docs) expect(link.url).toMatch(/^https:\/\/docs\.cognipeer\.com\/(console|console-sdk)\/[a-z0-9\-/]+(#[a-z-]+)?$/);
    expect(s.docs.map((link) => link.url)).toEqual(
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
  });
});

describe('inputs', () => {
  it('prefills a value of the right type for every kind of input', () => {
    const byName = (fields: IAgentInputField[]) => sampleInputs(fields);
    expect(byName([{ name: 'text', type: 'string' }])).toEqual({ text: '<text>' });
    expect(byName([{ name: 'count', type: 'integer' }])).toEqual({ count: 1 });
    expect(byName([{ name: 'ratio', type: 'number' }])).toEqual({ ratio: 1 });
    expect(byName([{ name: 'flag', type: 'boolean' }])).toEqual({ flag: true });
    expect(byName([{ name: 'blob', type: 'json' }])).toEqual({ blob: {} });
    // The first allowed value, for a string and for a number.
    expect(byName([{ name: 'tier', type: 'string', enum: ['gold', 'silver'] }])).toEqual({ tier: 'gold' });
    expect(byName([{ name: 'level', type: 'integer', enum: [3, 5] }])).toEqual({ level: 3 });
    // A declared default is what the agent assumes, so it is the sample; a long one would bury the call.
    expect(byName([{ name: 'lang', type: 'string', default: 'en' }])).toEqual({ lang: 'en' });
    expect(byName([{ name: 'flag', type: 'boolean', default: false }])).toEqual({ flag: false });
    expect(inputPlaceholder({ name: 'essay', type: 'string', default: 'x'.repeat(200) })).toBe('<essay>');
  });

  it('is what the API accepts, for every kind of input at once', () => {
    const sample = sampleInputs(DECLARED);
    expect(sample).toEqual({
      customer_id: '<customer_id>',
      period: 'last_7_days',
      limit: 1,
      ratio: 1,
      dry_run: true,
      filters: {},
      note: "don't panic",
    });
    expect(resolveRunInputs(DECLARED, sample)).toEqual({ ok: true, inputs: sample });
  });

  it('is omitted when the agent declares none (the API refuses inputs an agent does not declare)', () => {
    expect(sampleInputs(undefined)).toBeNull();
    expect(sampleInputs(null)).toBeNull();
    expect(sampleInputs([])).toBeNull();
    for (const declared of [undefined, null, []]) {
      const s = buildAgentUsageSnippets(options({ inputs: declared }));
      expect(s.hasInputs).toBe(false);
      for (const text of everyText(s)) expect(text).not.toMatch(/\binputs\b/);
      for (const call of curlSnippets(s).flatMap(restCalls).filter((entry) => entry.body)) expect(call.body).not.toHaveProperty('inputs');
    }
  });

  it('rides every call that starts a run, on every surface, as the same object', () => {
    const s = buildAgentUsageSnippets(options({ inputs: DECLARED }));
    const sample = sampleInputs(DECLARED);
    expect(s.hasInputs).toBe(true);

    // REST: every body that starts a run carries it (the cancel, the lookups and the card carry no body).
    const bodies = curlSnippets(s).flatMap(restCalls).filter((call) => call.body);
    expect(bodies.length).toBeGreaterThanOrEqual(8);
    for (const call of bodies.filter((entry) => !entry.pathname.endsWith('/a2a/support-triage'))) {
      expect(call.body?.inputs, call.pathname).toEqual(sample);
    }
    // A2A: a `data` part whose keys are inputs the agent declares.
    const a2a = restCalls(s.a2a.send as string)[0].body as { params: { message: { parts: Array<Record<string, unknown>> } } };
    expect(a2a.params.message.parts.find((part) => part.kind === 'data')).toEqual({ kind: 'data', data: sample });

    // The OpenAI SDK has no field for it, so it goes in `extra_body`; one per call (3 calls: 2 responses, 1 background, 1 chat).
    expect(s.openai.responses).toContain('inputs = {');
    expect(s.openai.responses).toContain('"dry_run": True,');
    expect(s.openai.responses).toContain('"note": "don\'t panic",');
    const extra = (text: string) => text.match(/extra_body=\{"inputs": inputs\}/g)?.length ?? 0;
    expect([extra(s.openai.responses), extra(s.openai.background), extra(s.openai.chat)]).toEqual([2, 1, 1]);
  });

  it('survives the shell: an apostrophe in a value is escaped, and the body is still the same JSON', () => {
    const s = buildAgentUsageSnippets(options({ inputs: DECLARED }));
    expect(s.runs.start).toContain(`"note": "don'\\''t panic"`);
    expect(restCalls(s.runs.start)[0].body?.inputs).toMatchObject({ note: "don't panic" });
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
    expect(formatLiteral({ 'not-an-identifier': 1 }, 'ts')).toBe('{ "not-an-identifier": 1 }');
  });
});

// ── Against the API contract ──────────────────────────────────────────────

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
    const isPublic = variant.a2aCardUrl === PUBLIC_CARD;
    expect([...used].sort()).toEqual(
      [
        'POST /agents/{agentKey}/runs',
        'GET /agents/runs/{runId}',
        'GET /agents/runs/{runId}/events/stream',
        'POST /agents/runs/{runId}/cancel',
        'GET /agents/runs',
        'POST /chat/completions',
        'GET /models',
        ...(isPublic
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

  it('sends only fields the run request has, with values the API accepts', () => {
    const runFields = schemaProperties('AgentRunCreateRequest');
    const runBodies = [s.runs.start, s.runs.session, s.runs.stream, s.runs.later, s.runs.version, s.runs.structured]
      .map((text) => restCalls(text)[0])
      .map((call) => call.body as Record<string, unknown>);
    for (const body of runBodies) {
      expect(Object.keys(body).filter((key) => !runFields.includes(key))).toEqual([]);
      if ('class' in body) expect(spec.components.schemas.AgentRunCreateRequest.properties?.class).toMatchObject({ enum: expect.arrayContaining([body.class]) });
      if ('version' in body) expect(body.version === 'draft' || Number.isInteger(body.version)).toBe(true);
      if ('delay_seconds' in body) expect(Number.isInteger(body.delay_seconds) && (body.delay_seconds as number) >= 0).toBe(true);
      if ('wait' in body) expect(typeof body.wait).toBe('number');
    }
    // The callback: its two fields, an https URL, and a secret the API will take (16 to 256 characters).
    const callback = asRecord(restCalls(s.runs.later)[0].body?.callback);
    expect(Object.keys(callback).sort()).toEqual(schemaProperties('AgentRunCallbackRequest').sort());
    expect(String(callback.url)).toMatch(/^https:\/\//);
    expect(String(callback.secret).length).toBeGreaterThanOrEqual(16);
    expect(String(callback.secret).length).toBeLessThanOrEqual(256);
    // The header an idempotent retry needs.
    expect(s.runs.later).toContain('-H "Idempotency-Key: ');
    // A deferred run cannot be streamed, so the streamed sample is not deferred, and neither waits and streams.
    expect(restCalls(s.runs.stream)[0].body).toMatchObject({ stream: true });
    expect(restCalls(s.runs.stream)[0].body).not.toHaveProperty('class');
    expect(restCalls(s.runs.stream)[0].body).not.toHaveProperty('wait');
    // Streams are read as they arrive.
    expect(s.runs.stream.startsWith('curl -N ')).toBe(true);
    expect(s.runs.follow).toContain('curl -N "');
  });

  it('asks chat completions for the agent the way the spec says, and for a stream', () => {
    const body = restCalls(s.openai.chatCurl)[0].body as Record<string, unknown>;
    expect(Object.keys(body).filter((key) => !schemaProperties('ChatCompletionRequest').includes(key))).toEqual([]);
    expect(body.model).toBe(`agent:${variant.agentKey}`);
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([{ role: 'user', content: expect.any(String) }]);
  });

  it('speaks A2A as JSON-RPC message/send, and only while A2A is on', () => {
    expect(s.a2a.enabled).toBe(variant.a2aEnabled);
    expect(s.a2a.isPublic).toBe(variant.a2aCardUrl === PUBLIC_CARD);
    expect(s.a2a.endpointUrl).toBe(variant.a2aCardUrl.replace('/.well-known/agent-card.json', ''));
    if (!variant.a2aEnabled) {
      expect(s.a2a.send).toBeNull();
      return;
    }
    const body = restCalls(s.a2a.send as string)[0].body as { jsonrpc: string; method: string; params: { message: { role: string; parts: Array<{ kind: string }> } } };
    expect(body.jsonrpc).toBe('2.0');
    expect(spec.components.schemas.AgentA2aRpcRequest.properties?.method).toMatchObject({ enum: expect.arrayContaining([body.method]) });
    expect(body.method).toBe('message/send');
    expect(body.params.message.role).toBe('user');
    expect(body.params.message.parts.map((part) => part.kind)).toEqual(variant.inputs?.length ? ['text', 'data'] : ['text']);
  });
});

describe('the answers the tab shows are the answers the API gives', () => {
  const s = buildAgentUsageSnippets(options({ agentKey: 'report-bot' }));
  const [finishedBlock, acceptedBlock] = s.runs.answers.split('\n\n');
  const body = (block: string) => JSON.parse(block.slice(block.indexOf('{'))) as Record<string, unknown>;
  const finished = body(finishedBlock);
  const accepted = body(acceptedBlock);
  const states = (spec.components.schemas.AgentRun.properties?.status as Schema).enum as string[];

  it('are runs: only fields of AgentRun, with a status it can have', () => {
    for (const run of [finished, accepted]) {
      expect(Object.keys(run).filter((key) => !schemaProperties('AgentRun').includes(key))).toEqual([]);
      expect(run.object).toBe('agent.run');
      expect(String(run.id)).toMatch(/^run_[0-9a-f]{24}$/);
      expect(states).toContain(run.status);
      expect(run.agent).toBe('report-bot');
      // Not pinned, so the run names no version.
      expect(run.version).toBeNull();
    }
  });

  it('say 200 for a run that finished and 202, with where to follow it, for one that is still going', () => {
    expect(finishedBlock.startsWith('HTTP/1.1 200 OK\n')).toBe(true);
    expect(['succeeded', 'failed', 'canceled', 'requires_action']).toContain(finished.status);
    expect(finished.status).toBe('succeeded');
    expect(finished.error).toBeNull();
    expect(typeof finished.output_text).toBe('string');
    expect(asRecord(finished.result).id).toBe(`resp_${String(finished.id).slice('run_'.length)}`);
    expect(Object.keys(asRecord(finished.result)).filter((key) => !schemaProperties('AgentResponse').includes(key))).toEqual([]);

    expect(acceptedBlock.startsWith('HTTP/1.1 202 Accepted\n')).toBe(true);
    expect(['scheduled', 'queued', 'running']).toContain(accepted.status);
    expect(accepted.result).toBeNull();
    expect(accepted.output_text).toBeNull();
    expect(acceptedBlock).toContain(`Location: /api/client/v1/agents/runs/${String(accepted.id)}\n`);
    expect(acceptedBlock).toContain('\nRetry-After: 2\n');
    // The calls that follow it use that run.
    expect(s.runs.follow).toContain(`RUN_ID=${String(accepted.id)}`);
  });

  it('stream the way the Responses API does: an event name, then the same type in the data', () => {
    const events = [...s.runs.stream.matchAll(/^event: (\S+)\ndata: (.+)$/gm)].map((match) => ({ name: match[1], data: JSON.parse(match[2]) as Record<string, unknown> }));
    expect(events.map((event) => event.name)).toEqual(['response.created', 'response.output_text.delta', 'response.completed']);
    for (const event of events) expect(event.data.type).toBe(event.name);
    expect(asRecord(asRecord(events[0].data.response).cognipeer).run_id).toBe(String(accepted.id));
    expect(events.map((event) => event.data.sequence_number)).toEqual([0, 4, 9]);
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
  /** Method of the client -> the REST operation it is; every call a sample makes must be on this list and in the spec. */
  const SDK_OPERATIONS: Record<string, [method: string, template: string]> = {
    'agents.runs.create': ['post', '/agents/{agentKey}/runs'],
    'agents.runs.wait': ['get', '/agents/runs/{runId}'],
    'agents.runs.cancel': ['post', '/agents/runs/{runId}/cancel'],
    'agents.runs.list': ['get', '/agents/runs'],
    'agents.runs.events.stream': ['get', '/agents/runs/{runId}/events/stream'],
    'agents.responses.create': ['post', '/responses'],
    'agents.routines.create': ['post', '/agents/{agentKey}/routines'],
    'agents.routines.run': ['post', '/agents/{agentKey}/routines/{routineId}/run'],
  };
  const OPENAI_OPERATIONS: Record<string, [method: string, template: string]> = {
    'responses.create': ['post', '/responses'],
    'responses.retrieve': ['get', '/responses/{responseId}'],
    'chat.completions.create': ['post', '/chat/completions'],
  };

  const methodsUsed = (text: string, pattern: RegExp) => [...new Set([...text.matchAll(pattern)].map((match) => match[1]))];

  it.each(VARIANTS)('use only client methods that are REST operations the spec documents (%s)', (_name, variant) => {
    const s = buildAgentUsageSnippets(variant);
    const sdk = methodsUsed(Object.values(s.sdk).join('\n'), /\bclient\.(agents\.[A-Za-z.]+?)\(/g);
    const openai = methodsUsed(Object.values(s.openai).join('\n'), /\bclient\.((?:responses|chat\.completions)\.[a-z_]+)\(/g);
    expect(sdk.sort()).toEqual(Object.keys(SDK_OPERATIONS).sort());
    expect(openai.sort()).toEqual(Object.keys(OPENAI_OPERATIONS).sort());
    for (const [method, template] of [...Object.values(SDK_OPERATIONS), ...Object.values(OPENAI_OPERATIONS)]) {
      expect(Object.keys(spec.paths[template] ?? {}), template).toContain(method);
    }
  });

  it('install version 4, the first that has the runs API', () => {
    const s = buildAgentUsageSnippets(options());
    expect(s.sdk.install).toBe('npm install @cognipeer/console-sdk@^4');
  });

  it('run, in order, against a client that records the calls: the bodies are the ones the API takes', async () => {
    // Never published, so the version the sample pins is the draft.
    const s = buildAgentUsageSnippets(options({ inputs: DECLARED, publishedVersion: null }));
    const { calls, clients, written } = await runSdkSnippets(s);
    const sample = sampleInputs(DECLARED);

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
      'agents.routines.create',
      'agents.routines.run',
    ]);

    const creates = calls.filter((call) => call.method === 'agents.runs.create');
    expect(creates).toHaveLength(6);
    for (const call of creates) {
      expect(call.args[0]).toBe('support-triage');
      const body = asRecord(call.args[1]);
      expect(Object.keys(body).filter((key) => !schemaProperties('AgentRunCreateRequest').includes(key))).toEqual([]);
      expect(body.inputs).toEqual(sample);
    }
    const [start, quick, next, pinned, later, typed] = creates.map((call) => asRecord(call.args[1]));
    expect(start).toMatchObject({ input: expect.any(String) });
    expect(quick.wait).toBe(30);
    // Continuing a session names the session of the run that was just waited for.
    expect(next.session_id).toBe('sess_1');
    expect(pinned.version).toBe('draft');
    expect(later).toMatchObject({ class: 'deferred', delay_seconds: 3600 });
    expect(Object.keys(asRecord(later.callback)).sort()).toEqual(['secret', 'url']);
    expect(String(asRecord(later.callback).secret).length).toBeGreaterThanOrEqual(16);
    expect(asRecord(creates[4].args[2])).toEqual({ idempotencyKey: 'weekly-digest-2026-w42' });
    // The structured answer: valid for the API in its chat spelling, and it is read back as output_parsed.
    const format = asRecord(typed.response_format);
    expect(format.type).toBe('json_schema');
    const spelled = asRecord(format.json_schema);
    expect(resolveResponseFormatSchema({ type: 'json_schema', name: String(spelled.name), schema: asRecord(spelled.schema), strict: spelled.strict === true })).toMatchObject({ ok: true });

    // Chat style: the Responses fields, with the same inputs, continued by the id of the previous response.
    const responses = calls.filter((call) => call.method === 'agents.responses.create').map((call) => asRecord(call.args[0]));
    for (const body of responses) {
      expect(Object.keys(body).filter((key) => !schemaProperties('AgentResponsesRequest').includes(key))).toEqual([]);
      expect(body).toMatchObject({ model: 'support-triage', inputs: sample });
    }
    expect(responses[1].previous_response_id).toBe('resp_1');
    expect(responses[2].stream).toBe(true);

    // A routine: a schedule trigger the API takes, a prompt, and the inputs.
    const routine = asRecord(calls.find((call) => call.method === 'agents.routines.create')?.args[1]);
    expect(Object.keys(routine).filter((key) => !schemaProperties('AgentRoutineCreateRequest').includes(key))).toEqual([]);
    expect(routine).toMatchObject({ trigger: { type: 'schedule', cron: '0 9 * * 1-5', timezone: 'UTC' }, inputs: sample, class: 'deferred' });
    expect(resolveRunInputs(DECLARED, asRecord(routine.inputs))).toMatchObject({ ok: true });
    expect(calls.find((call) => call.method === 'agents.routines.run')?.args).toEqual(['support-triage', 'rtn_1']);

    // The live part of the event stream was written out, and the loop stopped at the idle event.
    expect(written.join('')).toContain('He');
    expect(written.join('')).toContain('Hi');
  });

  it('pass no inputs when the agent declares none', async () => {
    const { calls } = await runSdkSnippets(buildAgentUsageSnippets(options()));
    for (const call of calls.filter((entry) => entry.method === 'agents.runs.create' || entry.method === 'agents.routines.create')) {
      expect(asRecord(call.args[1])).not.toHaveProperty('inputs');
    }
    for (const call of calls.filter((entry) => entry.method === 'agents.responses.create')) {
      expect(asRecord(call.args[0])).not.toHaveProperty('inputs');
    }
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
  it('name the agent with the prefix that always means an agent, and carry the inputs in extra_body', () => {
    const s = buildAgentUsageSnippets(options({ inputs: DECLARED, agentKey: 'report-bot' }));
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

  it('lists agents under /models as agent:<key>, as the spec says', () => {
    const listed = JSON.stringify(spec.paths['/models']);
    expect(listed).toContain('agent:<key>');
  });
});

describe('what the old tab said and the API no longer does', () => {
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
  });

  it('is gone from the words, in both languages', () => {
    for (const messages of [en.agents.usage, tr.agents.usage]) {
      const text = JSON.stringify(messages);
      expect(text).not.toMatch(/assistants?\b|asistan/i);
      expect(text).not.toMatch(/x-cognipeer-background/i);
    }
    // The six keys of the old tab are gone with it.
    for (const messages of [en.agents.usage, tr.agents.usage] as Array<Record<string, unknown>>) {
      for (const key of ['sdkTitle', 'installLabel', 'chatLabel', 'restTitle', 'restLabel', 'responseTitle']) expect(messages, key).not.toHaveProperty(key);
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
    inputs: undefined,
    origin: ORIGIN,
    a2aEnabled: true,
    a2aCardUrl: CARD,
    ...over,
  });

/** Text as it comes out of the markup: entities decoded. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

describe('the Usage tab', () => {
  it('shows the header, then Runs API, SDK, OpenAI, A2A and the docs, in that order', () => {
    const html = render(panel());
    const text = textOf(html);
    const order = ['API usage', 'Base URL', 'Agent key', 'Runs API (recommended)', 'TypeScript SDK 4.0', 'OpenAI-compatible endpoints', 'A2A (agent-to-agent)', 'Documentation'];
    const positions = order.map((title) => html.indexOf(`>${title}<`));
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

  it('links every docs page, in a new tab, safely', () => {
    const html = render(panel());
    for (const link of buildAgentUsageSnippets(options()).docs) {
      expect(html).toContain(`href="${link.url}"`);
    }
    expect(html.match(/rel="noopener noreferrer"/g)?.length).toBe(AGENT_DOC_LINKS.length + 1);
    expect(html.match(/target="_blank"/g)?.length).toBe(AGENT_DOC_LINKS.length + 1);
  });

  it('says the draft runs while nothing is published, and the number once something is', () => {
    expect(textOf(render(panel({ publishedVersion: null })))).toContain('Nothing is published yet, so calls run the draft.');
    expect(textOf(render(panel({ publishedVersion: 12 })))).toContain('Calls run the published version, v12.');
  });

  it('mentions inputs only for an agent that declares some', () => {
    expect(textOf(render(panel()))).not.toContain('This agent declares inputs');
    const withInputs = textOf(render(panel({ inputs: DECLARED })));
    expect(withInputs).toContain('This agent declares inputs');
    expect(withInputs).toContain('"customer_id": "<customer_id>"');
    expect(withInputs).toContain('The inputs this agent declares travel in a data part');
  });

  it('says whether A2A is on, and offers message/send only when it is', () => {
    const on = textOf(render(panel()));
    expect(on).toContain('Exposed. Other agents discover it');
    expect(on).toContain('"method": "message/send"');
    const off = textOf(render(panel({ a2aEnabled: false })));
    expect(off).toContain('Not exposed yet.');
    expect(off).not.toContain('"method": "message/send"');
    expect(off).toContain(`curl ${CARD}`);
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
    expect(html).not.toMatch(/agents\.usage\./);
    expect(text).not.toContain('Runs API (recommended)');
  });

  it('is what the Agent page renders in its Usage tab, from what the page already has', () => {
    const page = readFileSync(path.resolve(__dirname, '../../components/agents/AgentDetailPage.tsx'), 'utf8');
    expect(page).toContain("import AgentUsagePanel from './AgentUsagePanel';");
    expect(page).toMatch(/<Tabs\.Panel value="usage">\s*\{activeTab === 'usage' \? \(\s*<AgentUsagePanel\s+agentName=\{agent\.name\}\s+agentKey=\{agent\.key\}\s+publishedVersion=\{agent\.publishedVersion\}\s+inputs=\{agent\.config\?\.inputs\}\s+origin=\{origin\}\s+a2aEnabled=\{a2aEnabled\}\s+a2aCardUrl=\{a2aCardUrl\}\s*\/>/);
    // The old tab's body, and the redacted header it carried, are gone from the page.
    expect(page).not.toContain('Background execution (long-running turns)');
    expect(page).not.toContain('x-cognipeer-background');
    expect(page).not.toContain('******');
    expect(page).not.toMatch(/t\('usage\./);
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
  });

  it('translates the words, and leaves only names as they are', () => {
    const names = new Set(['sdk.title', 'docs.openaiSdk', 'docs.n8n', 'docs.openWebui', 'docs.sdkAgents']);
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
    for (const file of ['AgentUsagePanel.tsx', 'CopyableCode.tsx']) {
      const source = readFileSync(path.resolve(__dirname, '../../components/agents', file), 'utf8');
      for (const match of source.matchAll(/\bt\('([^']+)'/g)) read.add(match[1]);
    }
    // The docs labels are looked up by the id of each link.
    for (const link of AGENT_DOC_LINKS) read.add(`docs.${link.id}`);
    expect([...read].sort()).toEqual(Object.keys(english).sort());
  });
});
