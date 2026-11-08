import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeModelCall = vi.fn();
vi.mock('@/lib/services/models/gatewayCore', () => ({ executeModelCall: (...a: unknown[]) => executeModelCall(...a) }));

import { OutputTokenLimitError } from '@/lib/services/models/openaiErrors';
import { buildGatewayChatModel } from '@/lib/services/agents/gatewayChatModel';

const model = { key: 'm', modelId: 'm-1', providerDriver: 'openai', settings: {} } as never;
const build = () => buildGatewayChatModel({
  tenantDbName: 't', tenantId: 't', projectId: 'p', model, overrides: { max_tokens: 100 },
});
const USER = [{ role: 'user', content: 'hi' }];
const ok = { result: { response: { id: 'r', model: 'm', content: 'hello', toolCalls: [], usage: {}, finishReason: 'stop' } } };

type Invoke = { invoke: (m: unknown) => Promise<{ content: string }> };

beforeEach(() => { executeModelCall.mockReset(); });

describe('agent output-limit retry and a hard cap', () => {
  it('retries with a raised limit when the limit is not a hard cap (control)', async () => {
    executeModelCall.mockRejectedValueOnce(new OutputTokenLimitError(100)).mockResolvedValueOnce(ok);
    const result = await ((await build()) as unknown as Invoke).invoke(USER);
    expect(result.content).toBe('hello');
    expect(executeModelCall).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the limit that was hit is a hard cap (a retry would be clamped and charged again)', async () => {
    executeModelCall.mockImplementation(async () => { throw new OutputTokenLimitError(100, { hardCap: true }); });
    const chat = await build();
    const result = await (chat as unknown as Invoke).invoke(USER);
    expect(result.content).toMatch(/output token limit/i);
    expect(executeModelCall).toHaveBeenCalledTimes(1);
  });

  it('does not retry a streamed hard-cap hit either', async () => {
    executeModelCall.mockResolvedValue({
      requestId: 'q',
      stream: (async function* () {
        yield { type: 'output_limit', error: { message: 'cut', type: 'invalid_request_error' }, limit: 100, rawFinishReason: 'max_tokens', hardCap: true };
      })(),
    });
    const stream = ((await build()) as unknown as { stream: (m: unknown) => AsyncIterable<unknown> }).stream(USER);
    for await (const chunk of stream) void chunk;
    expect(executeModelCall).toHaveBeenCalledTimes(1);
  });
});
