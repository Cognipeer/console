import { describe, expect, it, vi, beforeEach } from 'vitest';

const handleChatCompletion = vi.fn();
const handleTranscriptionRequest = vi.fn();
const handleSpeechRequest = vi.fn();

vi.mock('@/lib/services/models/inferenceService', () => ({
  GuardrailBlockError: class GuardrailBlockError extends Error {},
  handleChatCompletion: (...args: unknown[]) => handleChatCompletion(...args),
  handleTranscriptionRequest: (...args: unknown[]) => handleTranscriptionRequest(...args),
  handleSpeechRequest: (...args: unknown[]) => handleSpeechRequest(...args),
}));
vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/services/models/usageLogger', () => ({
  calculateCost: vi.fn().mockReturnValue({ totalCost: 0, currency: 'USD' }),
}));
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkBudget: vi.fn().mockResolvedValue({ allowed: true }),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('@/lib/services/models/runtimeService', () => ({
  buildModelRuntime: vi.fn().mockResolvedValue({ runtime: {} }),
}));
// Session logging is fire-and-forget; stub the DB and task runner so the
// session never touches a real database in unit tests.
const dbMock = {
  switchToTenant: vi.fn().mockResolvedValue(undefined),
  createRealtimeSessionLog: vi.fn().mockResolvedValue({ _id: 'log-1' }),
  updateRealtimeSessionLog: vi.fn().mockResolvedValue(null),
  incrementRealtimeSessionLog: vi.fn().mockResolvedValue(null),
};
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => dbMock),
}));
vi.mock('@/lib/core/asyncTask', () => ({
  fireAndForget: (_label: string, fn: () => Promise<unknown>) => { void fn().catch(() => {}); },
}));

import { RealtimeSession, consumeChatSseStream } from '@/lib/services/realtime/realtimeSession';

const ctx = { tenantDbName: 'tenant_t1', tenantId: 't1', projectId: 'p1' };

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
}

function chatChunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('consumeChatSseStream', () => {
  it('concatenates deltas and surfaces usage from the final chunk', async () => {
    const stream = sseStream([
      chatChunk('Hel'),
      chatChunk('lo'),
      `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`,
      'data: [DONE]\n\n',
    ]);
    const deltas: string[] = [];
    const result = await consumeChatSseStream(stream, {
      onDelta: (d) => deltas.push(d),
      isCancelled: () => false,
    });
    expect(result.text).toBe('Hello');
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(result.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2 });
    expect(result.cancelled).toBe(false);
  });

  it('handles frames split across chunk boundaries', async () => {
    const whole = chatChunk('abc');
    const stream = sseStream([whole.slice(0, 12), whole.slice(12), 'data: [DONE]\n\n']);
    const result = await consumeChatSseStream(stream, {
      onDelta: () => {},
      isCancelled: () => false,
    });
    expect(result.text).toBe('abc');
  });
});

describe('RealtimeSession', () => {
  function createSession(initial?: { model?: string }) {
    const events: Array<Record<string, unknown>> = [];
    const session = new RealtimeSession(ctx, (event) => events.push(event), {
      initialConfig: initial,
    });
    return { session, events };
  }

  it('emits session.created on construction and session.updated on update', async () => {
    const { session, events } = createSession();
    expect(events[0].type).toBe('session.created');

    await session.handleEvent({ type: 'session.update', session: { model: 'gpt', voice: 'alloy' } });
    const updated = events.find((event) => event.type === 'session.updated');
    expect(updated).toBeDefined();
    expect((updated!.session as Record<string, unknown>).model).toBe('gpt');
  });

  it('streams a response from the SSE stream and records the assistant turn', async () => {
    handleChatCompletion.mockResolvedValue({
      requestId: 'req-1',
      stream: sseStream([chatChunk('Hi '), chatChunk('there'), 'data: [DONE]\n\n']),
    });

    const { session, events } = createSession({ model: 'gpt' });
    await session.handleEvent({
      type: 'conversation.item.create',
      item: { role: 'user', content: 'Hello?' },
    });
    await session.handleEvent({ type: 'response.create' });

    const types = events.map((event) => event.type);
    expect(types).toContain('conversation.item.created');
    expect(types).toContain('response.created');
    expect(events.filter((event) => event.type === 'response.output_text.delta')).toHaveLength(2);

    const done = events.find((event) => event.type === 'response.output_text.done');
    expect(done!.text).toBe('Hi there');
    const responseDone = events.find((event) => event.type === 'response.done');
    expect(responseDone!.status).toBe('completed');

    // System instructions are not set; user turn forwarded as-is.
    const call = handleChatCompletion.mock.calls[0][0] as { body: { messages: unknown[] } };
    expect(call.body.messages).toEqual([{ role: 'user', content: 'Hello?' }]);
  });

  it('refuses response.create without a model or conversation', async () => {
    const { session, events } = createSession();
    await session.handleEvent({ type: 'response.create' });
    expect(events.some((event) =>
      event.type === 'error'
      && (event.error as { code?: string }).code === 'config_missing')).toBe(true);

    await session.handleEvent({ type: 'session.update', session: { model: 'gpt' } });
    await session.handleEvent({ type: 'response.create' });
    expect(events.some((event) =>
      event.type === 'error'
      && (event.error as { code?: string }).code === 'conversation_empty')).toBe(true);
    expect(handleChatCompletion).not.toHaveBeenCalled();
  });

  it('transcribes committed audio and appends the transcript as a user turn', async () => {
    handleTranscriptionRequest.mockResolvedValue({
      response: { text: 'spoken words', language: 'en', duration: 1.2 },
    });
    handleChatCompletion.mockResolvedValue({
      requestId: 'req-2',
      stream: sseStream([chatChunk('ok'), 'data: [DONE]\n\n']),
    });

    const { session, events } = createSession({ model: 'gpt' });
    await session.handleEvent({ type: 'session.update', session: { transcription_model: 'whisper' } });
    await session.handleEvent({
      type: 'input_audio_buffer.append',
      audio: Buffer.from('fake-audio').toString('base64'),
    });
    await session.handleEvent({ type: 'input_audio_buffer.commit' });

    const committed = events.find((event) => event.type === 'input_audio_buffer.committed');
    expect(committed!.transcript).toBe('spoken words');

    await session.handleEvent({ type: 'response.create' });
    const call = handleChatCompletion.mock.calls[0][0] as { body: { messages: Array<{ content: string }> } };
    expect(call.body.messages[0].content).toBe('spoken words');
  });

  it('synthesizes audio when tts model + voice are configured', async () => {
    handleChatCompletion.mockResolvedValue({
      requestId: 'req-3',
      stream: sseStream([chatChunk('answer'), 'data: [DONE]\n\n']),
    });
    handleSpeechRequest.mockResolvedValue({
      audio: Buffer.from('mp3-bytes'),
      contentType: 'audio/mpeg',
    });

    const { session, events } = createSession({ model: 'gpt' });
    await session.handleEvent({
      type: 'session.update',
      session: { tts_model: 'tts-1', voice: 'alloy' },
    });
    await session.handleEvent({
      type: 'conversation.item.create',
      item: { role: 'user', content: 'Say something' },
    });
    await session.handleEvent({ type: 'response.create' });

    const audioDelta = events.find((event) => event.type === 'response.audio.delta');
    expect(audioDelta).toBeDefined();
    expect(audioDelta!.audio).toBe(Buffer.from('mp3-bytes').toString('base64'));
    expect(events.some((event) => event.type === 'response.audio.done')).toBe(true);
    expect(handleSpeechRequest).toHaveBeenCalledWith(expect.objectContaining({
      modelKey: 'tts-1',
      input: expect.objectContaining({ text: 'answer', voice: 'alloy' }),
    }));
  });
});
