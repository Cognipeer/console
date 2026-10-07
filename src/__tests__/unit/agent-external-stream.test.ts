/**
 * Connected (external) agent streaming — the SSE parser, the three protocol
 * accumulators, the body pump, and `invokeExternalAgent`'s streaming /
 * fallback / abort behaviour over a mocked `safeFetch`.
 *
 * `safeFetch` is mocked at its module so every request is observable: the
 * assertions that it is the ONLY way out (SSRF guard kept for streamed calls)
 * and that the streaming request carries `stream: true` / `message/stream`
 * depend on it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  safeFetch: vi.fn(),
}));

vi.mock('@/lib/security/outboundFetch', () => ({
  safeFetch: hoisted.safeFetch,
}));

vi.mock('@/lib/services/providers/providerService', () => ({
  loadProviderRuntimeData: vi.fn(),
}));

import type { IExternalAgentConnection } from '@/lib/database';
import {
  createA2aAccumulator,
  createOpenAiChatAccumulator,
  createOpenAiResponsesAccumulator,
  createSseParser,
  ExternalAgentStreamError,
  readEventStream,
  SSE_MAX_EVENT_CHARS,
  type ExternalStreamAccumulator,
  type SseEvent,
} from '@/lib/services/agents/externalAgentStream';
import { invokeExternalAgent, resetExternalStreamSupportCache } from '@/lib/services/agents/externalAgent';

const encoder = new TextEncoder();

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function parseAll(chunks: string[]): SseEvent[] {
  const events: SseEvent[] = [];
  const parser = createSseParser((event) => events.push(event));
  for (const chunk of chunks) parser.push(chunk);
  parser.flush();
  return events;
}

/** `data: <json>\n\n` for each payload. */
function sse(...payloads: Array<unknown>): string {
  return payloads
    .map((p) => (typeof p === 'string' ? `data: ${p}\n\n` : `data: ${JSON.stringify(p)}\n\n`))
    .join('');
}

/**
 * A CPU-time stopwatch: the function it returns gives the ms of CPU this
 * process has used since. The speed guards compare it with a ceiling well
 * under what the slow implementation costs; unlike wall time it does not grow
 * when the machine is busy running something else.
 */
function startCpuTimer(): () => number {
  const before = process.cpuUsage();
  return () => {
    const spent = process.cpuUsage(before);
    return (spent.user + spent.system) / 1_000;
  };
}

/** Feed the given SSE text through an accumulator; returns emitted chunks and whether `done` fired. */
function run(acc: ExternalStreamAccumulator, text: string): { emitted: string[]; done: boolean } {
  const emitted: string[] = [];
  let done = false;
  const parser = createSseParser((event) => {
    if (done) return;
    const step = acc.handle(event);
    if (step.emit) emitted.push(step.emit);
    if (step.done) done = true;
  });
  parser.push(text);
  parser.flush();
  return { emitted, done };
}

/** A body that yields `chunks` (split exactly as given), then ends — or hangs open with `hang`. */
function bodyOf(chunks: string[], opts: { hang?: boolean } = {}): ReadableStream<Uint8Array> & { cancelled: () => boolean } {
  let index = 0;
  let cancelled = false;
  let release: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
        return undefined;
      }
      if (opts.hang) {
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      controller.close();
      return undefined;
    },
    cancel() {
      cancelled = true;
      release?.();
    },
  });
  return Object.assign(stream, { cancelled: () => cancelled });
}

/** Generous limits for tests that are not about them. */
const LIMITS = { idleTimeoutMs: 5_000, maxBodyBytes: 1 << 20, maxDurationMs: 60_000 };

/**
 * A body that produces `next()` chunks on demand and never ends by itself — the
 * hostile endpoint: it only stops when the reader cancels it. `produced()` is
 * how many bytes it had to hand out by then (a reader that does not stop pulls
 * until the test times out).
 */
function endlessBody(next: (index: number) => string, opts: { delayMs?: number } = {}) {
  let index = 0;
  let bytes = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      const chunk = encoder.encode(next(index));
      index += 1;
      bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return Object.assign(stream, { cancelled: () => cancelled, produced: () => bytes });
}

function sseResponse(chunks: string[], opts: { hang?: boolean; status?: number } = {}) {
  const body = bodyOf(chunks, opts);
  const response = new Response(body, {
    status: opts.status ?? 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
  return { response, body };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

const CTX = { tenantDbName: 'tenant_acme', tenantId: 'tenant-acme', projectId: 'proj-1' };
const MESSAGES = [{ role: 'user', content: 'What is the rate?' }];

const CHAT: IExternalAgentConnection = { protocol: 'openai-chat', url: 'https://agent.example.com/v1', model: 'm-1' };
const RESPONSES: IExternalAgentConnection = { protocol: 'openai-responses', url: 'https://agent.example.com/v1', model: 'm-1' };
const A2A: IExternalAgentConnection = { protocol: 'a2a', url: 'https://a2a.example.com/rpc' };

function sentBody(call = 0): Record<string, unknown> {
  const init = hoisted.safeFetch.mock.calls[call][1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function sentHeaders(call = 0): Record<string, string> {
  return (hoisted.safeFetch.mock.calls[call][1] as RequestInit).headers as Record<string, string>;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetExternalStreamSupportCache();
});

/* ── SSE parser ──────────────────────────────────────────────────────────── */

describe('createSseParser', () => {
  it('reassembles events split anywhere across network chunks, including inside a CRLF', () => {
    const wire = 'event: delta\r\ndata: {"a":1}\r\n\r\ndata: second\r\n\r\n';
    // Every possible split point must yield the same two events.
    for (let cut = 1; cut < wire.length; cut += 1) {
      const events = parseAll([wire.slice(0, cut), wire.slice(cut)]);
      expect(events).toEqual([
        { event: 'delta', data: '{"a":1}' },
        { event: 'message', data: 'second' },
      ]);
    }
  });

  it('byte-at-a-time delivery still produces whole events', () => {
    const wire = sse({ x: 'héllo' }, '[DONE]');
    expect(parseAll(wire.split(''))).toEqual([
      { event: 'message', data: '{"x":"héllo"}' },
      { event: 'message', data: '[DONE]' },
    ]);
  });

  it('joins multi-line data, ignores comments and unknown fields, honours a lone CR terminator', () => {
    const events = parseAll([': keep-alive\n', 'retry: 1000\nfoo: bar\ndata: line one\ndata:line two\n\n', 'data: cr\r\r']);
    expect(events).toEqual([
      { event: 'message', data: 'line one\nline two' },
      { event: 'message', data: 'cr' },
    ]);
  });

  it('carries the last id and resets the event type after each dispatch', () => {
    const events = parseAll(['id: 7\nevent: a\ndata: 1\n\ndata: 2\n\n']);
    expect(events).toEqual([
      { event: 'a', data: '1', id: '7' },
      { event: 'message', data: '2', id: '7' },
    ]);
  });

  it('a blank line with no data dispatches nothing', () => {
    expect(parseAll(['event: ping\n\n\n'])).toEqual([]);
  });

  it('flush dispatches a final event the server never terminated with a blank line', () => {
    expect(parseAll(['data: {"last":true}'])).toEqual([{ event: 'message', data: '{"last":true}' }]);
  });

  it('dispatches an event the moment its blank line arrives, also when that line ends the chunk with a lone CR', () => {
    const events: SseEvent[] = [];
    const parser = createSseParser((event) => events.push(event));
    parser.push('data: one\r\r');
    expect(events).toEqual([{ event: 'message', data: 'one' }]);
    // The `\n` that follows belongs to the CR that ended the chunk, not to a new blank line.
    parser.push('\ndata: two\n\n');
    expect(events.map((e) => e.data)).toEqual(['one', 'two']);
  });

  it('agrees with a plain split of the whole text on the line terminators, however the network cut it', () => {
    // The reference sees the complete text at once: split on \r\n | \r | \n and
    // apply the field rules. An incremental parser has to produce exactly that
    // for EVERY chunking of the same bytes.
    const reference = (wire: string): SseEvent[] => {
      const events: SseEvent[] = [];
      let eventType = '';
      let data: string[] = [];
      let lastId: string | undefined;
      const dispatch = () => {
        if (data.length > 0) {
          events.push({ event: eventType || 'message', data: data.join('\n'), ...(lastId !== undefined ? { id: lastId } : {}) });
        }
        eventType = '';
        data = [];
      };
      for (const line of wire.split(/\r\n|\r|\n/)) {
        if (line === '') {
          dispatch();
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') eventType = value;
        else if (field === 'data') data.push(value);
        else if (field === 'id' && !value.includes('\0')) lastId = value;
      }
      dispatch();
      return events;
    };

    let seed = 424242;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
    const atoms = ['data: a', 'data:b', 'data', 'event: x', 'event:y', 'id: 7', 'id: 8\0', ': keep', 'retry: 5', 'foo: bar', '', '', 'data: ', 'data:  two', 'héllo', 'data: {"k":1}'];
    const terminators = ['\n', '\r\n', '\r', '\n\n', '\r\r', '\r\n\r\n', '\n\r'];

    for (let run = 0; run < 3_000; run += 1) {
      let wire = '';
      for (let i = 0, lines = 1 + Math.floor(random() * 12); i < lines; i += 1) wire += pick(atoms) + pick(terminators);
      if (random() < 0.4) wire += pick(atoms); // a tail that never got its terminator
      if (random() < 0.15) wire += '\r';
      const chunks: string[] = [];
      for (let at = 0; at < wire.length;) {
        const size = 1 + Math.floor(random() * (random() < 0.5 ? 3 : 12));
        chunks.push(wire.slice(at, at + size));
        at += size;
        if (random() < 0.05) chunks.push('');
      }
      expect(parseAll(chunks), JSON.stringify(chunks)).toEqual(reference(wire));
    }
  });

  it('reads a body with no line break in one pass: the buffered line is not rescanned per chunk', () => {
    // 4 MB in 4 KB chunks. Re-scanning (and re-copying) everything buffered on
    // every push reads ~2 GB of characters — seconds; one pass takes milliseconds.
    const parser = createSseParser(() => undefined, { maxEventChars: 64 * 1024 * 1024 });
    const piece = `data: ${'x'.repeat(4 * 1024 - 6)}`;
    const cpu = startCpuTimer();
    for (let i = 0; i < 1024; i += 1) parser.push(piece);
    parser.flush();
    expect(cpu()).toBeLessThan(1_000);
  });

  describe('limits', () => {
    it('refuses a line that never ends once it outgrows maxEventChars', () => {
      const parser = createSseParser(() => undefined, { maxEventChars: 1_000 });
      parser.push(`data: ${'x'.repeat(900)}`);
      expect(() => parser.push('x'.repeat(200))).toThrow(ExternalAgentStreamError);
    });

    it('refuses an event whose data lines never reach a blank line', () => {
      const parser = createSseParser(() => undefined, { maxEventChars: 1_000 });
      const feed = () => {
        for (let i = 0; i < 200; i += 1) parser.push('data: 123456789\n');
      };
      expect(feed).toThrow(/event exceeds 1000 characters/);
    });

    it('refuses an oversized line that arrives whole inside one chunk', () => {
      const parser = createSseParser(() => undefined, { maxEventChars: 1_000 });
      expect(() => parser.push(`event: ${'x'.repeat(2_000)}\n`)).toThrow(ExternalAgentStreamError);
      expect(() => createSseParser(() => undefined, { maxEventChars: 1_000 }).push(`: ${'x'.repeat(2_000)}\n`))
        .toThrow(ExternalAgentStreamError);
    });

    it('counts per event: any number of small events passes, and the count starts over after each', () => {
      const events: SseEvent[] = [];
      const parser = createSseParser((event) => events.push(event), { maxEventChars: 1_000 });
      for (let i = 0; i < 5_000; i += 1) parser.push(`data: ${'y'.repeat(900)}\n\n`);
      parser.flush();
      expect(events).toHaveLength(5_000);
    });

    it('lets a 1 MB event through with the default limit', () => {
      const events = parseAll([`data: ${'z'.repeat(1_000_000)}`, '\n\n']);
      expect(events).toHaveLength(1);
      expect(events[0].data).toHaveLength(1_000_000);
    });

    it('stops a stream at the default limit', () => {
      const parser = createSseParser(() => undefined);
      const piece = `data: ${'x'.repeat(16 * 1024)}`;
      let pushed = 0;
      expect(() => {
        for (; pushed < 1_000; pushed += 1) parser.push(piece);
      }).toThrow(ExternalAgentStreamError);
      expect(pushed * piece.length).toBeLessThanOrEqual(SSE_MAX_EVENT_CHARS + piece.length);
    });
  });
});

/* ── openai-chat ─────────────────────────────────────────────────────────── */

describe('openai-chat accumulator', () => {
  const chunk = (content: unknown, extra: Record<string, unknown> = {}) => ({
    choices: [{ index: 0, delta: content === undefined ? {} : { content }, ...extra }],
  });

  it('emits each delta, stops at [DONE], content is the concatenation', () => {
    const acc = createOpenAiChatAccumulator();
    const { emitted, done } = run(
      acc,
      sse(chunk(undefined, { delta: { role: 'assistant' } }), chunk('Hel'), chunk('lo'), chunk(undefined, { finish_reason: 'stop' }), '[DONE]', chunk('IGNORED')),
    );
    expect(emitted).toEqual(['Hel', 'lo']);
    expect(done).toBe(true);
    expect(acc.content()).toBe('Hello');
    expect(acc.remainder()).toBe('');
    expect(acc.raw()).toMatchObject({ stream: true, protocol: 'openai-chat', finish_reason: 'stop' });
  });

  it('accepts array content parts in a delta', () => {
    const acc = createOpenAiChatAccumulator();
    expect(run(acc, sse(chunk([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]))).emitted).toEqual(['AB']);
  });

  it('uses a whole `message` only when no delta ever arrived, and owes it as the remainder', () => {
    const acc = createOpenAiChatAccumulator();
    const { emitted } = run(acc, sse({ choices: [{ message: { role: 'assistant', content: 'All at once' } }] }, '[DONE]'));
    expect(emitted).toEqual([]);
    expect(acc.content()).toBe('All at once');
    expect(acc.remainder()).toBe('All at once');
    expect(acc.emitted()).toBe('All at once');
  });

  it('an error payload in the stream throws', () => {
    const acc = createOpenAiChatAccumulator();
    expect(() => run(acc, sse(chunk('x'), { error: { message: 'rate limited' } }))).toThrow(/rate limited/);
  });

  it('an `event: error` frame throws even without a JSON body', () => {
    const acc = createOpenAiChatAccumulator();
    expect(() => run(acc, 'event: error\ndata: upstream exploded\n\n')).toThrow(ExternalAgentStreamError);
  });

  it('skips unparseable lines instead of failing the turn', () => {
    const acc = createOpenAiChatAccumulator();
    expect(run(acc, sse('not json', chunk('ok'))).emitted).toEqual(['ok']);
  });
});

/* ── openai-responses ────────────────────────────────────────────────────── */

describe('openai-responses accumulator', () => {
  const ev = (type: string, extra: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;

  it('emits output_text deltas and ends at response.completed', () => {
    const acc = createOpenAiResponsesAccumulator();
    const { emitted, done } = run(
      acc,
      ev('response.created', { response: { id: 'r1' } })
        + ev('response.output_item.added', { item: { type: 'message' } })
        + ev('response.output_text.delta', { delta: 'Bon' })
        + ev('response.output_text.delta', { delta: 'jour' })
        + ev('response.output_text.done', { text: 'Bonjour' })
        + ev('response.completed', { response: { output_text: 'Bonjour' } })
        + ev('response.output_text.delta', { delta: 'AFTER' }),
    );
    expect(emitted).toEqual(['Bon', 'jour']);
    expect(done).toBe(true);
    expect(acc.content()).toBe('Bonjour');
    expect(acc.raw()).toMatchObject({ status: 'completed' });
  });

  it('reads the type from the payload when the server sends no `event:` line', () => {
    const acc = createOpenAiResponsesAccumulator();
    expect(run(acc, sse({ type: 'response.output_text.delta', delta: 'x' })).emitted).toEqual(['x']);
  });

  it('with no deltas, the completed response is the answer and is owed as the remainder', () => {
    const acc = createOpenAiResponsesAccumulator();
    run(acc, ev('response.completed', { response: { output: [{ content: [{ type: 'output_text', text: 'Whole' }] }] } }));
    expect(acc.content()).toBe('Whole');
    expect(acc.remainder()).toBe('Whole');
  });

  it('response.incomplete ends the stream with what arrived', () => {
    const acc = createOpenAiResponsesAccumulator();
    const { done } = run(acc, ev('response.output_text.delta', { delta: 'Part' }) + ev('response.incomplete', { response: {} }));
    expect(done).toBe(true);
    expect(acc.content()).toBe('Part');
    expect(acc.raw()).toMatchObject({ status: 'incomplete' });
  });

  it('response.failed and error events throw with the server message', () => {
    expect(() => run(createOpenAiResponsesAccumulator(), ev('response.failed', { response: { error: { message: 'model overloaded' } } })))
      .toThrow(/model overloaded/);
    expect(() => run(createOpenAiResponsesAccumulator(), ev('error', { message: 'bad key' }))).toThrow(/bad key/);
  });
});

/* ── a2a ─────────────────────────────────────────────────────────────────── */

describe('a2a accumulator', () => {
  const rpc = (result: unknown) => ({ jsonrpc: '2.0', id: 'req-1', result });
  const text = (t: string) => [{ kind: 'text', text: t }];
  const status = (state: string, message?: string, final = false) => rpc({
    kind: 'status-update',
    taskId: 't1',
    contextId: 'c1',
    status: { state, ...(message ? { message: { role: 'agent', parts: text(message), messageId: 'm' } } : {}) },
    final,
  });
  const artifact = (t: string, opts: { append?: boolean; id?: string; last?: boolean } = {}) => rpc({
    kind: 'artifact-update',
    taskId: 't1',
    contextId: 'c1',
    artifact: { artifactId: opts.id ?? 'a1', parts: text(t) },
    ...(opts.append ? { append: true } : {}),
    ...(opts.last ? { lastChunk: true } : {}),
  });

  it('streams appended artifact chunks; a working status message is progress, not the answer', () => {
    const acc = createA2aAccumulator();
    const { emitted, done } = run(
      acc,
      sse(
        rpc({ kind: 'task', id: 't1', contextId: 'c1', status: { state: 'submitted' } }),
        status('working', 'Looking up the exchange rates...'),
        artifact('1 USD = '),
        artifact('34 TRY', { append: true, last: true }),
        status('completed', undefined, true),
      ),
    );
    expect(emitted).toEqual(['1 USD = ', '34 TRY']);
    expect(done).toBe(true);
    expect(acc.content()).toBe('1 USD = 34 TRY');
    expect(acc.remainder()).toBe('');
  });

  it('the final status message is the reply when no artifact carried one (a2a-js pattern)', () => {
    const acc = createA2aAccumulator();
    const { emitted, done } = run(acc, sse(status('working', 'Processing...'), status('completed', 'The film is 2h long.', true)));
    expect(emitted).toEqual(['The film is 2h long.']);
    expect(done).toBe(true);
    expect(acc.content()).toBe('The film is 2h long.');
  });

  it('input-required ends the turn with its question as the reply', () => {
    const acc = createA2aAccumulator();
    const { emitted, done } = run(acc, sse(status('input-required', 'Which currency?')));
    expect(emitted).toEqual(['Which currency?']);
    expect(done).toBe(true);
  });

  it('a stream that only ever said "working" delivers its last message through remainder()', () => {
    const acc = createA2aAccumulator();
    const { emitted, done } = run(acc, sse(status('working', 'first'), status('working', 'Final words')));
    expect(emitted).toEqual([]);
    expect(done).toBe(false);
    expect(acc.content()).toBe('Final words');
    expect(acc.remainder()).toBe('Final words');
  });

  it('a direct Message reply streams its text', () => {
    const acc = createA2aAccumulator();
    const { emitted } = run(acc, sse(rpc({ kind: 'message', role: 'agent', parts: text('Hi there'), messageId: 'm1' })));
    expect(emitted).toEqual(['Hi there']);
    expect(acc.content()).toBe('Hi there');
  });

  it('several artifacts join with a newline, like the non-streaming extractor', () => {
    const acc = createA2aAccumulator();
    const { emitted } = run(acc, sse(artifact('first', { id: 'a1' }), artifact('second', { id: 'a2' })));
    expect(emitted.join('')).toBe('first\nsecond');
    expect(acc.content()).toBe('first\nsecond');
  });

  it('a non-append update that extends an artifact emits only the new tail; a rewrite emits nothing', () => {
    const acc = createA2aAccumulator();
    const { emitted } = run(acc, sse(artifact('Hello'), artifact('Hello world'), artifact('Goodbye')));
    expect(emitted).toEqual(['Hello', ' world']);
    expect(acc.content()).toBe('Goodbye');
    expect(acc.remainder()).toBe(''); // diverged: never contradict what was spoken
  });

  it('a terminal Task snapshot (server answered the stream with one object) is the reply', () => {
    const acc = createA2aAccumulator();
    const { emitted, done } = run(acc, sse(rpc({
      kind: 'task', id: 't1', status: { state: 'completed' }, artifacts: [{ artifactId: 'x', parts: text('Done.') }],
    })));
    expect(emitted).toEqual(['Done.']);
    expect(done).toBe(true);
  });

  it('infers the kind from the shape for servers on drafts without `kind`', () => {
    const acc = createA2aAccumulator();
    const { emitted } = run(acc, sse(
      rpc({ taskId: 't1', artifact: { parts: [{ type: 'text', text: 'legacy' }] } }),
    ));
    expect(emitted).toEqual(['legacy']);
  });

  it('a JSON-RPC error event throws', () => {
    expect(() => run(createA2aAccumulator(), sse({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'boom' } })))
      .toThrow(/A2A error: boom/);
  });

  describe('a long answer', () => {
    const artifactEvent = (artifactId: string, text: string, append: boolean) =>
      sse({ jsonrpc: '2.0', id: 1, result: { kind: 'artifact-update', taskId: 't', artifact: { artifactId, parts: [{ kind: 'text', text }] }, append } });
    const messageEvent = (text: string) =>
      sse({ jsonrpc: '2.0', id: 1, result: { kind: 'message', role: 'agent', parts: [{ kind: 'text', text }] } });

    it('streams appended artifact text in time linear in its length (no re-read of the answer per event)', () => {
      // Comparing the whole answer with what was emitted on every event costs
      // the square of its length: ~4 s for these 60 000 one-character events.
      const events = 60_000;
      const acc = createA2aAccumulator();
      const cpu = startCpuTimer();
      const { emitted } = run(acc, artifactEvent('a', 'x', true).repeat(events));
      expect(cpu()).toBeLessThan(1_500);
      expect(emitted).toHaveLength(events);
      expect(acc.content()).toBe('x'.repeat(events));
      expect(acc.remainder()).toBe('');
    });

    it('does the same for the pieces of one message', () => {
      const events = 60_000;
      const acc = createA2aAccumulator();
      const cpu = startCpuTimer();
      const { emitted } = run(acc, messageEvent('x').repeat(events));
      expect(cpu()).toBeLessThan(1_500);
      expect(emitted).toHaveLength(events);
      expect(acc.content()).toBe('x'.repeat(events));
    });

    it('keeps emitting appended text after progress notes, and re-syncs after a rewrite', () => {
      const note = (text: string) => sse({ jsonrpc: '2.0', id: 1, result: { kind: 'status-update', taskId: 't', status: { state: 'working', message: { parts: [{ kind: 'text', text }] } }, final: false } });
      const acc = createA2aAccumulator();
      const { emitted } = run(
        acc,
        note('Looking things up…')       // not the answer: nothing is emitted for it
          + artifactEvent('a', 'Hel', true)
          + note('Still working…')
          + artifactEvent('a', 'lo', true)
          + artifactEvent('a', 'Hello, wor', false)   // a snapshot that extends: only the new tail goes out
          + artifactEvent('a', 'ld', true),
      );
      expect(emitted).toEqual(['Hel', 'lo', ', wor', 'ld']);
      expect(acc.content()).toBe('Hello, world');
      expect(acc.remainder()).toBe('');
    });

    it('stops following a rewrite storm over a big answer live, and hands the rest over at the end', () => {
      // 1 MB is held, then every event rewrites ANOTHER artifact (one character
      // longer each time). Each rewrite would compare the whole answer again:
      // 3 000 events x ~2 MB. The compare budget ends that long before.
      const acc = createA2aAccumulator();
      const storm = [artifactEvent('big', 'x'.repeat(1_000_000), false)];
      for (let i = 1; i <= 3_000; i += 1) storm.push(artifactEvent('tail', 'y'.repeat(i), false));
      const cpu = startCpuTimer();
      const { emitted } = run(acc, storm.join(''));
      expect(cpu()).toBeLessThan(2_000);

      const content = acc.content();
      expect(content).toBe(`${'x'.repeat(1_000_000)}\n${'y'.repeat(3_000)}`);
      const sentLive = acc.emitted();
      expect(emitted.join('')).toBe(sentLive);
      expect(content.startsWith(sentLive)).toBe(true);
      expect(sentLive.length).toBeLessThan(content.length); // it did stop following ...
      expect(sentLive.length).toBeGreaterThan(1_000_000);   // ... but only after the big answer went out
      expect(acc.remainder()).toBe(content.slice(sentLive.length)); // nothing is lost
    });
  });
});

/* ── readEventStream ─────────────────────────────────────────────────────── */

describe('readEventStream', () => {
  it('stops at a terminal event and cancels the rest of the body', async () => {
    const body = bodyOf([sse('a'), sse('b'), sse('c')], { hang: true });
    const seen: string[] = [];
    const result = await readEventStream(body, (event) => {
      seen.push(event.data);
      return event.data === 'b';
    }, LIMITS);
    expect(result).toEqual({ aborted: false });
    expect(seen).toEqual(['a', 'b']);
    expect(body.cancelled()).toBe(true);
  });

  it('resolves { aborted: true } when the signal fires mid-stream, and closes the body', async () => {
    const controller = new AbortController();
    const body = bodyOf([sse('a')], { hang: true });
    const seen: string[] = [];
    const pending = readEventStream(body, (event) => {
      seen.push(event.data);
      controller.abort();
    }, { ...LIMITS, signal: controller.signal });
    await expect(pending).resolves.toEqual({ aborted: true });
    expect(seen).toEqual(['a']);
    expect(body.cancelled()).toBe(true);
  });

  it('an already-aborted signal reads nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const onEvent = vi.fn();
    await expect(readEventStream(bodyOf([sse('a')]), onEvent, { ...LIMITS, signal: controller.signal }))
      .resolves.toEqual({ aborted: true });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('a stream that goes silent past the idle timeout fails', async () => {
    const body = bodyOf([sse('a')], { hang: true });
    await expect(readEventStream(body, () => undefined, { ...LIMITS, idleTimeoutMs: 30 })).rejects.toThrow(/stalled/);
    expect(body.cancelled()).toBe(true);
  });

  it('dispatches an unterminated final event at end of body', async () => {
    const seen: string[] = [];
    await readEventStream(bodyOf(['data: one\n\n', 'data: two']), (e) => {
      seen.push(e.data);
    }, LIMITS);
    expect(seen).toEqual(['one', 'two']);
  });

  describe('limits (an endpoint that never stops)', () => {
    it('rejects a body longer than maxBodyBytes and closes the connection', async () => {
      // Comment lines only: no event, no long line — only the size limit can end this.
      const body = endlessBody(() => `: ${'k'.repeat(1_000)}\n`);
      await expect(readEventStream(body, () => undefined, { ...LIMITS, maxBodyBytes: 10_000 }))
        .rejects.toThrow(/exceeds 10000 bytes/);
      expect(body.cancelled()).toBe(true);
      expect(body.produced()).toBeLessThan(50_000); // stopped at once, not drained
    });

    it('rejects a body that keeps flowing past maxDurationMs although it is never idle', async () => {
      const body = endlessBody(() => ': tick\n', { delayMs: 5 });
      await expect(readEventStream(body, () => undefined, { ...LIMITS, maxDurationMs: 80 }))
        .rejects.toThrow(ExternalAgentStreamError);
      expect(body.cancelled()).toBe(true);
    });

    it('names the limit that was broken', async () => {
      const slow = endlessBody(() => ': tick\n', { delayMs: 5 });
      await expect(readEventStream(slow, () => undefined, { ...LIMITS, maxDurationMs: 80 })).rejects.toThrow(/ran longer than/);
    });

    it('rejects one event that outgrows maxEventChars, however the bytes are chunked', async () => {
      const body = endlessBody((index) => (index === 0 ? 'data: ' : 'x'.repeat(1_024)));
      await expect(readEventStream(body, () => undefined, { ...LIMITS, maxBodyBytes: 1 << 30, maxEventChars: 8 * 1_024 }))
        .rejects.toThrow(/event exceeds 8192 characters/);
      expect(body.cancelled()).toBe(true);
    });

    it('a caller abort still wins over the limits: it resolves, it does not reject', async () => {
      const controller = new AbortController();
      const body = endlessBody(() => `: ${'k'.repeat(1_000)}\n`, { delayMs: 2 });
      setTimeout(() => controller.abort(), 25);
      await expect(readEventStream(body, () => undefined, { ...LIMITS, signal: controller.signal }))
        .resolves.toEqual({ aborted: true });
      expect(body.cancelled()).toBe(true);
    });
  });
});

/* ── invokeExternalAgent ─────────────────────────────────────────────────── */

describe('invokeExternalAgent — streaming', () => {
  it('openai-chat: asks for a stream through safeFetch and emits deltas as they arrive', async () => {
    const { response } = sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
      '\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DO',
      'NE]\n\n',
    ]);
    hoisted.safeFetch.mockResolvedValueOnce(response);
    const chunks: string[] = [];

    const result = await invokeExternalAgent(CHAT, MESSAGES, CTX, undefined, { onTextChunk: (t) => chunks.push(t) });

    expect(chunks).toEqual(['Hel', 'lo']);
    expect(result).toMatchObject({ content: 'Hello', streamed: true });
    expect(result.cancelled).toBeUndefined();
    expect(hoisted.safeFetch).toHaveBeenCalledTimes(1);
    const [url, , options] = hoisted.safeFetch.mock.calls[0];
    expect(url).toBe('https://agent.example.com/v1/chat/completions');
    expect(options).toEqual({ timeoutMs: 120_000 });
    expect(sentBody()).toMatchObject({ model: 'm-1', stream: true, messages: MESSAGES });
    expect(sentHeaders()).toMatchObject({ Accept: 'text/event-stream', 'Content-Type': 'application/json' });
  });

  it('openai-responses: streams output_text deltas', async () => {
    const { response } = sseResponse([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"A"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"B"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"output_text":"AB"}}\n\n',
    ], { hang: true });
    hoisted.safeFetch.mockResolvedValueOnce(response);
    const chunks: string[] = [];

    const result = await invokeExternalAgent(RESPONSES, MESSAGES, CTX, undefined, { onTextChunk: (t) => chunks.push(t) });

    expect(chunks).toEqual(['A', 'B']);
    expect(result).toMatchObject({ content: 'AB', streamed: true });
    expect(hoisted.safeFetch.mock.calls[0][0]).toBe('https://agent.example.com/v1/responses');
    expect(sentBody()).toMatchObject({ stream: true, input: [{ role: 'user', content: 'What is the rate?' }] });
  });

  it('a2a: sends message/stream and streams artifact text', async () => {
    const { response } = sseResponse([
      sse({ jsonrpc: '2.0', id: 'req-1', result: { kind: 'status-update', taskId: 't', status: { state: 'working' }, final: false } }),
      sse({ jsonrpc: '2.0', id: 'req-1', result: { kind: 'artifact-update', taskId: 't', artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'Rate: ' }] } } }),
      sse({ jsonrpc: '2.0', id: 'req-1', result: { kind: 'artifact-update', taskId: 't', append: true, artifact: { artifactId: 'a', parts: [{ kind: 'text', text: '34' }] } } }),
      sse({ jsonrpc: '2.0', id: 'req-1', result: { kind: 'status-update', taskId: 't', status: { state: 'completed' }, final: true } }),
    ]);
    hoisted.safeFetch.mockResolvedValueOnce(response);
    const chunks: string[] = [];

    const result = await invokeExternalAgent(A2A, MESSAGES, CTX, undefined, { onTextChunk: (t) => chunks.push(t) });

    expect(sentBody()).toMatchObject({ method: 'message/stream' });
    expect(chunks).toEqual(['Rate: ', '34']);
    expect(result).toMatchObject({ content: 'Rate: 34', streamed: true });
  });

  it('a stream whose only text never got emitted hands it over at the end (remainder)', async () => {
    const { response } = sseResponse([
      sse({ jsonrpc: '2.0', id: 'r', result: { kind: 'status-update', taskId: 't', status: { state: 'working', message: { parts: [{ kind: 'text', text: 'Only this' }] } } } }),
    ]);
    hoisted.safeFetch.mockResolvedValueOnce(response);
    const chunks: string[] = [];
    const result = await invokeExternalAgent(A2A, MESSAGES, CTX, undefined, { onTextChunk: (t) => chunks.push(t) });
    expect(chunks).toEqual(['Only this']);
    expect(result.content).toBe('Only this');
  });

  it('an error inside the stream rejects the call', async () => {
    const { response } = sseResponse([
      'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
      'data: {"error":{"message":"context length exceeded"}}\n\n',
    ], { hang: true });
    hoisted.safeFetch.mockResolvedValueOnce(response);
    await expect(invokeExternalAgent(CHAT, MESSAGES, CTX, undefined, { onTextChunk: () => undefined }))
      .rejects.toThrow(/context length exceeded/);
  });

  it('a throwing onTextChunk never fails the turn', async () => {
    const { response } = sseResponse(['data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n']);
    hoisted.safeFetch.mockResolvedValueOnce(response);
    const result = await invokeExternalAgent(CHAT, MESSAGES, CTX, undefined, {
      onTextChunk: () => {
        throw new Error('listener broke');
      },
    });
    expect(result.content).toBe('x');
  });
});

describe('invokeExternalAgent — non-streaming fallbacks', () => {
  it('without onTextChunk the request is exactly the pre-streaming one', async () => {
    hoisted.safeFetch.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'Plain' } }] }));
    const result = await invokeExternalAgent(CHAT, MESSAGES, CTX);
    expect(sentBody()).not.toHaveProperty('stream');
    expect(sentHeaders()).not.toHaveProperty('Accept');
    expect(result).toEqual({ content: 'Plain', raw: { choices: [{ message: { content: 'Plain' } }] }, streamed: false });
  });

  it('a JSON answer to a streaming request is parsed as before and NOT emitted (the caller emits the guarded text)', async () => {
    hoisted.safeFetch.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'One piece' } }] }));
    const onTextChunk = vi.fn();
    const result = await invokeExternalAgent(CHAT, MESSAGES, CTX, undefined, { onTextChunk });
    expect(sentBody()).toMatchObject({ stream: true });
    expect(onTextChunk).not.toHaveBeenCalled();
    expect(result).toMatchObject({ content: 'One piece', streamed: false });
    expect(hoisted.safeFetch).toHaveBeenCalledTimes(1);
  });

  it('a2a: "method not found" for message/stream falls back to message/send, and is remembered', async () => {
    hoisted.safeFetch
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 'req-1', error: { code: -32601, message: 'Method not found' } }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 'req-1', result: { kind: 'message', parts: [{ kind: 'text', text: 'Sent!' }] } }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 'req-1', result: { kind: 'message', parts: [{ kind: 'text', text: 'Again' }] } }));
    const onTextChunk = vi.fn();

    const first = await invokeExternalAgent(A2A, MESSAGES, CTX, undefined, { onTextChunk });
    expect(sentBody(0)).toMatchObject({ method: 'message/stream' });
    expect(sentBody(1)).toMatchObject({ method: 'message/send' });
    expect(first).toMatchObject({ content: 'Sent!', streamed: false });

    const second = await invokeExternalAgent(A2A, MESSAGES, CTX, undefined, { onTextChunk });
    expect(hoisted.safeFetch).toHaveBeenCalledTimes(3);
    expect(sentBody(2)).toMatchObject({ method: 'message/send' }); // no failed round trip first
    expect(second.content).toBe('Again');
    expect(onTextChunk).not.toHaveBeenCalled();
  });

  it('a2a: UnsupportedOperationError (-32004) also falls back', async () => {
    hoisted.safeFetch
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 'x', error: { code: -32004, message: 'Streaming not supported' } }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 'x', result: { kind: 'task', id: 't', status: { state: 'completed' }, artifacts: [{ parts: [{ kind: 'text', text: 'ok' }] }] } }));
    const result = await invokeExternalAgent(A2A, MESSAGES, CTX, undefined, { onTextChunk: vi.fn() });
    expect(result.content).toBe('ok');
  });

  it('a2a: any other JSON-RPC error is the turn failing — no retry', async () => {
    hoisted.safeFetch.mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 'x', error: { code: -32603, message: 'internal' } }));
    await expect(invokeExternalAgent(A2A, MESSAGES, CTX, undefined, { onTextChunk: vi.fn() })).rejects.toThrow(/A2A error: internal/);
    expect(hoisted.safeFetch).toHaveBeenCalledTimes(1);
  });

  it('openai: a 400 that names `stream` retries once without it', async () => {
    hoisted.safeFetch
      .mockResolvedValueOnce(jsonResponse({ error: { message: "Unsupported parameter: 'stream'" } }, 400))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'Fine' } }] }));
    const result = await invokeExternalAgent(CHAT, MESSAGES, CTX, undefined, { onTextChunk: vi.fn() });
    expect(sentBody(0)).toMatchObject({ stream: true });
    expect(sentBody(1)).not.toHaveProperty('stream');
    expect(result).toMatchObject({ content: 'Fine', streamed: false });
  });

  it('openai: `error.param: "stream"` is a refusal even when the message does not say so', async () => {
    hoisted.safeFetch
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Invalid value', param: 'stream' } }, 400))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'Fine' } }] }));
    const result = await invokeExternalAgent(CHAT, MESSAGES, CTX, undefined, { onTextChunk: vi.fn() });
    expect(sentBody(1)).not.toHaveProperty('stream');
    expect(result).toMatchObject({ content: 'Fine', streamed: false });
  });

  it('openai: an error that only mentions a "stream"-named model is the turn failing, not a refusal', async () => {
    const tenantA = { ...CTX, tenantId: 'tenant-a' };
    const shared: IExternalAgentConnection = { ...CHAT, url: 'https://llm-gateway.example.com/v1', model: 'stream-me' };
    hoisted.safeFetch.mockResolvedValueOnce(jsonResponse({ error: { message: 'The model `stream-me` does not exist' } }, 404));
    await expect(invokeExternalAgent(shared, MESSAGES, tenantA, undefined, { onTextChunk: vi.fn() }))
      .rejects.toThrow(/External agent returned 404/);
    expect(hoisted.safeFetch).toHaveBeenCalledTimes(1);

    // Nothing was remembered: the next call on the same endpoint still streams.
    const { response } = sseResponse(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', 'data: [DONE]\n\n']);
    hoisted.safeFetch.mockResolvedValueOnce(response);
    const onTextChunk = vi.fn();
    const result = await invokeExternalAgent({ ...shared, model: 'm-1' }, MESSAGES, tenantA, undefined, { onTextChunk });
    expect(sentBody(1)).toMatchObject({ stream: true });
    expect(result).toMatchObject({ content: 'Hi', streamed: true });
  });

  it('a "cannot stream" verdict is remembered per tenant: another tenant on the same URL still streams', async () => {
    hoisted.safeFetch
      .mockResolvedValueOnce(jsonResponse({ error: { message: "Unsupported parameter: 'stream'" } }, 400))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'A' } }] }));
    await invokeExternalAgent(CHAT, MESSAGES, { ...CTX, tenantId: 'tenant-a' }, undefined, { onTextChunk: vi.fn() });

    const { response } = sseResponse(['data: {"choices":[{"delta":{"content":"B"}}]}\n\n', 'data: [DONE]\n\n']);
    hoisted.safeFetch.mockResolvedValueOnce(response);
    const onTextChunk = vi.fn();
    const result = await invokeExternalAgent(CHAT, MESSAGES, { ...CTX, tenantId: 'tenant-b' }, undefined, { onTextChunk });
    expect(sentBody(2)).toMatchObject({ stream: true });
    expect(onTextChunk).toHaveBeenCalledWith('B');
    expect(result).toMatchObject({ content: 'B', streamed: true });

    // …while tenant A skips the failed round trip.
    hoisted.safeFetch.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'A2' } }] }));
    await invokeExternalAgent(CHAT, MESSAGES, { ...CTX, tenantId: 'tenant-a' }, undefined, { onTextChunk: vi.fn() });
    expect(sentBody(3)).not.toHaveProperty('stream');
  });

  it('openai: any other HTTP error is reported as before, without a retry', async () => {
    hoisted.safeFetch.mockResolvedValueOnce(jsonResponse({ error: { message: 'invalid api key' } }, 401));
    await expect(invokeExternalAgent(CHAT, MESSAGES, CTX, undefined, { onTextChunk: vi.fn() }))
      .rejects.toThrow(/External agent returned 401/);
    expect(hoisted.safeFetch).toHaveBeenCalledTimes(1);
  });

  it('a connection with a custom responsePath is never asked to stream', async () => {
    hoisted.safeFetch.mockResolvedValueOnce(jsonResponse({ data: { answer: 'Custom' } }));
    const result = await invokeExternalAgent({ ...CHAT, responsePath: 'data.answer' }, MESSAGES, CTX, undefined, { onTextChunk: vi.fn() });
    expect(sentBody()).not.toHaveProperty('stream');
    expect(result).toMatchObject({ content: 'Custom', streamed: false });
  });
});

describe('invokeExternalAgent — abort', () => {
  it('mid-stream: resolves (does not reject) with the text emitted so far and closes the body', async () => {
    const controller = new AbortController();
    const { response, body } = sseResponse(['data: {"choices":[{"delta":{"content":"Half an "}}]}\n\n'], { hang: true });
    hoisted.safeFetch.mockResolvedValueOnce(response);
    const chunks: string[] = [];

    const result = await invokeExternalAgent(CHAT, MESSAGES, CTX, undefined, {
      signal: controller.signal,
      onTextChunk: (t) => {
        chunks.push(t);
        controller.abort();
      },
    });

    expect(result).toMatchObject({ content: 'Half an ', cancelled: true, streamed: true });
    expect(chunks).toEqual(['Half an ']);
    expect(body.cancelled()).toBe(true);
  });

  it('the signal is handed to safeFetch, and an abort before the headers resolves cancelled', async () => {
    const controller = new AbortController();
    hoisted.safeFetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException('This operation was aborted', 'AbortError');
    });
    const result = await invokeExternalAgent(CHAT, MESSAGES, CTX, undefined, { signal: controller.signal, onTextChunk: vi.fn() });
    expect(result).toEqual({ content: '', raw: undefined, streamed: false, cancelled: true });
  });

  it('an already-aborted signal makes no request at all', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await invokeExternalAgent(CHAT, MESSAGES, CTX, undefined, { signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(hoisted.safeFetch).not.toHaveBeenCalled();
  });

  it('non-streaming: an abort while the JSON body is still arriving resolves cancelled', async () => {
    const controller = new AbortController();
    const body = bodyOf(['{"choices":[{"mess'], { hang: true });
    hoisted.safeFetch.mockResolvedValueOnce(new Response(body, { headers: { 'content-type': 'application/json' } }));
    const pending = invokeExternalAgent(CHAT, MESSAGES, CTX, undefined, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).resolves.toMatchObject({ content: '', cancelled: true, streamed: false });
    expect(body.cancelled()).toBe(true);
  });

  it('a network failure that is NOT an abort still rejects', async () => {
    const controller = new AbortController();
    hoisted.safeFetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(invokeExternalAgent(CHAT, MESSAGES, CTX, undefined, { signal: controller.signal })).rejects.toThrow('ECONNRESET');
  });
});

describe('invokeExternalAgent — an endpoint that streams without end', () => {
  it('a line that never ends fails the turn at the event limit and closes the connection', async () => {
    const body = endlessBody((index) => (index === 0 ? 'data: ' : 'x'.repeat(16 * 1_024)));
    hoisted.safeFetch.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const cpu = startCpuTimer();

    await expect(invokeExternalAgent(CHAT, MESSAGES, CTX, undefined, { onTextChunk: vi.fn() }))
      .rejects.toThrow(ExternalAgentStreamError);

    expect(body.cancelled()).toBe(true);
    expect(body.produced()).toBeLessThanOrEqual(SSE_MAX_EVENT_CHARS + 64 * 1_024);
    expect(cpu()).toBeLessThan(2_000);
  });

  it('a stream of nothing but keep-alives fails the turn at the body limit', async () => {
    const body = endlessBody(() => `: ${'k'.repeat(63 * 1_024)}\n`);
    hoisted.safeFetch.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );

    await expect(invokeExternalAgent(A2A, MESSAGES, CTX, undefined, { onTextChunk: vi.fn() }))
      .rejects.toThrow(/exceeds \d+ bytes/);

    expect(body.cancelled()).toBe(true);
    expect(body.produced()).toBeLessThan(17 * 1_024 * 1_024);
  });

  it('text emitted before the limit was hit stays emitted, and the turn still fails', async () => {
    const delta = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi ' } }] })}\n\n`;
    const body = endlessBody((index) => (index === 0 ? delta : `: ${'k'.repeat(63 * 1_024)}\n`));
    hoisted.safeFetch.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const chunks: string[] = [];

    await expect(invokeExternalAgent(CHAT, MESSAGES, CTX, undefined, { onTextChunk: (t) => chunks.push(t) }))
      .rejects.toThrow(ExternalAgentStreamError);
    expect(chunks).toEqual(['Hi ']);
  });
});
