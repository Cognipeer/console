import { describe, expect, it } from 'vitest';
import { withInlineReasoningNormalization } from '@/lib/providers/contracts/wireNormalization';

/** A stub upstream that always answers with `body` and the given content type. */
const upstream = (body: string, contentType = 'application/json', status = 200): typeof fetch =>
  (async () =>
    new Response(body, {
      status,
      headers: { 'content-type': contentType, 'content-length': String(body.length) },
    })) as unknown as typeof fetch;

const completion = (content: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    choices: [
      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content, ...extra } },
    ],
  });

describe('withInlineReasoningNormalization', () => {
  it('moves a leaked reasoning block out of content before any SDK parses it', async () => {
    // Verbatim shape from bedrock-runtime eu-central-1, `openai.gpt-oss-120b-1:0`.
    const raw = completion('<reasoning>The user wants JSON.</reasoning>{"ok": true}');
    const res = await withInlineReasoningNormalization(upstream(raw))('https://upstream/x');
    const message = (await res.json()).choices[0].message;

    expect(message.content).toBe('{"ok": true}');
    expect(message.reasoning_content).toBe('The user wants JSON.');
    // The whole point: `JSON.parse(content)` — what `openai`'s `.parse()` helper
    // does under `response_format: json_schema` — no longer throws.
    expect(JSON.parse(message.content)).toEqual({ ok: true });
  });

  it('appends to a reasoning_content the upstream already set', async () => {
    const raw = completion('<think>more</think>answer', { reasoning_content: 'first;' });
    const res = await withInlineReasoningNormalization(upstream(raw))('https://upstream/x');
    const message = (await res.json()).choices[0].message;

    expect(message.reasoning_content).toBe('first;more');
    expect(message.content).toBe('answer');
  });

  it('returns a clean body unchanged', async () => {
    const raw = completion('just the answer');
    const res = await withInlineReasoningNormalization(upstream(raw))('https://upstream/x');
    expect(await res.text()).toBe(raw);
  });

  it('never buffers a streamed response', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"<reasoning>x</reasoning>"}}]}\n\n';
    const res = await withInlineReasoningNormalization(upstream(sse, 'text/event-stream'))('https://u/x');
    expect(await res.text()).toBe(sse);
  });

  it('passes an error response straight through', async () => {
    const body = '{"error":{"message":"boom"}}';
    const res = await withInlineReasoningNormalization(upstream(body, 'application/json', 500))('https://u/x');
    expect(res.status).toBe(500);
    expect(await res.text()).toBe(body);
  });

  it('passes a non-completion JSON payload through', async () => {
    const body = '{"object":"list","data":[{"id":"m"}]}';
    const res = await withInlineReasoningNormalization(upstream(body))('https://u/x');
    expect(await res.text()).toBe(body);
  });

  it('survives a body that is not JSON at all', async () => {
    const body = '<UnknownOperationException/>';
    const res = await withInlineReasoningNormalization(upstream(body))('https://u/x');
    expect(await res.text()).toBe(body);
  });

  it('drops the stale content-length after rewriting', async () => {
    const raw = completion('<reasoning>long long long</reasoning>hi');
    const res = await withInlineReasoningNormalization(upstream(raw))('https://upstream/x');
    expect(res.headers.get('content-length')).toBeNull();
  });
});
