/**
 * Reads an SSE body from `fetch`.
 *
 * `EventSource` is GET-only, and a playground turn's message, session and
 * runtime context belong in a body — so the stream arrives as a plain
 * `Response.body` and someone has to frame it. That someone is this file.
 *
 * Framing rules that matter, because getting them wrong produces a stream
 * that works until it doesn't:
 *  - A chunk boundary can fall anywhere, including mid-event and mid-UTF-8
 *    character, so the decoder streams and the tail is carried over.
 *  - Events are separated by a BLANK line, not by a chunk.
 *  - `data:` may repeat within one event and is joined with newlines.
 */

export type SseHandler = (event: string, data: unknown) => void;

export async function consumeSse(body: ReadableStream<Uint8Array>, onEvent: SseHandler): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let separator = buffer.indexOf('\n\n');
            while (separator !== -1) {
                dispatch(buffer.slice(0, separator), onEvent);
                buffer = buffer.slice(separator + 2);
                separator = buffer.indexOf('\n\n');
            }
        }
        // A server that ends without a trailing blank line still sent a
        // complete final event; dropping it would lose the run's result.
        if (buffer.trim()) dispatch(buffer, onEvent);
    } finally {
        reader.releaseLock();
    }
}

function dispatch(raw: string, onEvent: SseHandler): void {
    let event = 'message';
    const dataLines: string[] = [];

    for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        // `:` comments and unknown fields are ignored, per the spec.
    }
    if (dataLines.length === 0) return;

    const payload = dataLines.join('\n');

    // Parsed OUTSIDE the handler call on purpose: wrapping both together
    // meant a handler that throws — which is how a caller signals a stream
    // error — was mistaken for unparseable JSON and re-delivered the same
    // event as raw text, running the handler twice.
    let data: unknown;
    try {
        data = JSON.parse(payload);
    } catch {
        data = payload;
    }
    onEvent(event, data);
}
