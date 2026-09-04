import { splitInlineReasoning } from '@/lib/shared/inlineReasoning';

/**
 * Normalizes an OpenAI-schema chat completion ON THE WIRE, before any client
 * SDK reads it.
 *
 * This has to happen here, not after the call returns, because of what the
 * OpenAI SDK does with `response_format`. LangChain routes a non-streamed
 * request that carries `response_format: {type: "json_schema"}` through
 * `client.chat.completions.parse()` instead of `.create()`, and that helper runs
 * a bare `JSON.parse(choice.message.content)` with no error handling
 * (`openai/src/lib/parser.ts`). An upstream that leaks a reasoning block into
 * `content` — AWS Bedrock's `/openai/v1` does, for the gpt-oss and MiniMax
 * families — therefore blows up INSIDE the provider call with
 * `Unexpected token '<', "<reasoning"... is not valid JSON`, is retried three
 * times by the resilience wrapper, and reaches the caller as an opaque
 * `500 inference_error`. Nothing downstream of the call can repair that, because
 * the response never gets there.
 *
 * So the gateway cleans the body first: the leaked block moves to
 * `message.reasoning_content`, where the OpenAI schema says it belongs, and
 * `content` becomes what the caller (and the SDK's parser) was promised.
 *
 * Deliberately narrow: streamed responses (SSE), non-JSON bodies, error
 * responses and any payload that is not a chat completion are passed through
 * untouched, and a body that carries no leaked markup is returned byte-for-byte.
 */
export function withInlineReasoningNormalization(baseFetch?: typeof fetch): typeof fetch {
  const inner: typeof fetch = baseFetch ?? ((input, init) => fetch(input, init));

  return async (input, init) => {
    const response = await inner(input, init);
    if (!response.ok) return response;

    const contentType = response.headers.get('content-type') ?? '';
    // `text/event-stream` is the streamed path, which the gateway normalizes
    // chunk by chunk with its own splitter; buffering it here would break it.
    if (!contentType.includes('application/json')) return response;

    const raw = await response.text();
    const normalized = normalizeChatCompletionBody(raw);
    if (normalized === raw) {
      return new Response(raw, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    }

    // `content-length` no longer matches, and the body is already consumed, so
    // the header set is rebuilt rather than reused.
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(normalized, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}

/** Returns the input unchanged unless a choice actually carried leaked markup. */
function normalizeChatCompletionBody(raw: string): string {
  if (!raw.includes('<')) return raw;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return raw;
  }

  const choices = (payload as { choices?: unknown })?.choices;
  if (!Array.isArray(choices)) return raw;

  let changed = false;
  for (const choice of choices) {
    const message = (choice as { message?: Record<string, unknown> })?.message;
    if (!message || typeof message.content !== 'string') continue;

    const split = splitInlineReasoning(message.content);
    if (!split.reasoning) continue;

    message.content = split.content;
    const existing = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
    message.reasoning_content = `${existing}${split.reasoning}`;
    changed = true;
  }

  return changed ? JSON.stringify(payload) : raw;
}
