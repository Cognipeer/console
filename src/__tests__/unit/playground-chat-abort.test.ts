/**
 * Stop in the model playground: the model call is given a signal that fires when the client hangs up
 * (streamed or not), so the upstream request - and its billing - stops. A reply that completed never aborts it.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const handleChatCompletion = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/models/inferenceService', () => ({
  handleChatCompletion,
  GuardrailBlockError: class extends Error {},
  handleOcrRequest: vi.fn(),
  handleEmbeddingRequest: vi.fn(),
  handleImageRequest: vi.fn(),
  handleSpeechRequest: vi.fn(),
  handleTranscriptionRequest: vi.fn(),
}));
vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: vi.fn().mockResolvedValue({ key: 'gpt-4', category: 'llm' }),
}));
vi.mock('@/lib/services/models/usageLogger', () => ({ logModelUsage: vi.fn() }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    withApiRequestContext: (handler: unknown) => handler,
    requireProjectContextForRequest: vi.fn().mockResolvedValue({
      projectId: 'proj-1',
      session: { tenantDbName: 'tenant_acme', userId: 'user-1' },
    }),
  };
});

import { abortSignalOnDisconnect } from '@/server/api/requestAbort';
import { dashboardApiPlugin } from '@/server/api/plugins/dashboard';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

function fakeReply(writableFinished: boolean) {
  const raw = Object.assign(new EventEmitter(), { writableFinished });
  return { raw } as never;
}

describe('abortSignalOnDisconnect', () => {
  it('aborts when the connection closes before the reply finished', () => {
    const reply = fakeReply(false);
    const signal = abortSignalOnDisconnect(reply);
    expect(signal.aborted).toBe(false);
    (reply as { raw: EventEmitter }).raw.emit('close');
    expect(signal.aborted).toBe(true);
  });

  it('does not abort once the reply was written in full', () => {
    const reply = fakeReply(true);
    const signal = abortSignalOnDisconnect(reply);
    (reply as { raw: EventEmitter }).raw.emit('close');
    expect(signal.aborted).toBe(false);
  });
});

describe('POST /api/dashboard/playground/chat', () => {
  beforeEach(() => {
    handleChatCompletion.mockReset();
    handleChatCompletion.mockResolvedValue({ response: { choices: [] }, requestId: 'req-1' });
  });

  it('passes a disconnect signal to the model call', async () => {
    const app = await createFastifyApiTestApp(dashboardApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/dashboard/playground/chat',
      payload: { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    const params = handleChatCompletion.mock.calls[0][0] as { signal: AbortSignal };
    expect(params.signal).toBeInstanceOf(AbortSignal);
    await app.close();
  });
});
