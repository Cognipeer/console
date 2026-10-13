import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeModelCall = vi.fn();
vi.mock('@/lib/services/models/gatewayCore', () => ({ executeModelCall: (...a: unknown[]) => executeModelCall(...a) }));

import { OutputTokenLimitError } from '@/lib/services/models/openaiErrors';
import { buildGatewayChatModel, raisedOutputLimit } from '@/lib/services/agents/gatewayChatModel';
import { describeTurnOutcome } from '@/lib/services/agents/agentTurnState';
import { incompleteReason } from '@/lib/services/agents/agentService';
import { outputLimitNotice, parseOutputLimitNotice } from '@/lib/services/agents/outputLimitNotice';

const model = { key: 'm', modelId: 'm-1', providerDriver: 'openai', settings: {} } as never;
const ok = { result: { response: { id: 'r', model: 'm', content: 'hello', toolCalls: [], usage: {}, finishReason: 'stop' } } };
const build = (extra: object = {}) => buildGatewayChatModel({
  tenantDbName: 't', tenantId: 't', projectId: 'p', model, overrides: { max_tokens: 100 }, ...extra,
});
const sentLimits = () => executeModelCall.mock.calls.map((c) => (c[0] as { wire: Record<string, unknown> }).wire.max_tokens);

beforeEach(() => { executeModelCall.mockReset(); });

describe('raisedOutputLimit', () => {
  it('doubles, capped by declared max and remaining budget', () => {
    expect(raisedOutputLimit(100, model)).toBe(200);
    expect(raisedOutputLimit(100, { settings: { maxOutputTokens: 150 } } as never)).toBe(150);
    expect(raisedOutputLimit(100, model, 130)).toBe(130);
    expect(raisedOutputLimit(100, model, 100)).toBeUndefined();
    expect(raisedOutputLimit(undefined, model)).toBeUndefined();
    expect(raisedOutputLimit(100, { settings: { maxOutputTokens: 100 } } as never)).toBeUndefined();
  });
});

describe('agent turn on output token limit', () => {
  it('retries once with a doubled limit and returns the answer', async () => {
    executeModelCall.mockRejectedValueOnce(new OutputTokenLimitError(100)).mockResolvedValueOnce(ok);
    const chat = await build();
    const result = await (chat as unknown as { invoke: (m: unknown) => Promise<{ content: string }> }).invoke([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('hello');
    expect(sentLimits()).toEqual([100, 200]);
  });

  it('ends gracefully with the notice when the retry also hits the limit', async () => {
    executeModelCall.mockImplementation(async () => { throw new OutputTokenLimitError(100); });
    const chat = await build();
    const result = await (chat as unknown as { invoke: (m: unknown) => Promise<{ content: string }> }).invoke([{ role: 'user', content: 'hi' }]);
    expect(executeModelCall).toHaveBeenCalledTimes(2);
    expect(parseOutputLimitNotice(String(result.content))).not.toBeNull();
  });

  it('does not retry when the run budget leaves no room', async () => {
    executeModelCall.mockImplementation(async () => { throw new OutputTokenLimitError(100); });
    const chat = await build({ maxTotalOutputTokens: 100 });
    const result = await (chat as unknown as { invoke: (m: unknown) => Promise<{ content: string }> }).invoke([{ role: 'user', content: 'hi' }]);
    expect(executeModelCall).toHaveBeenCalledTimes(1);
    expect(parseOutputLimitNotice(String(result.content))).not.toBeNull();
  });
});

describe('streamed agent turn on output token limit', () => {
  it('ends with the notice chunk after the raised retry also hits the limit', async () => {
    executeModelCall.mockImplementation(async () => { throw new OutputTokenLimitError(100); });
    const chat = await build() as unknown as { stream: (m: unknown) => AsyncIterable<unknown> };
    const out: unknown[] = [];
    for await (const part of chat.stream([{ role: 'user', content: 'hi' }])) out.push(part);
    expect(executeModelCall).toHaveBeenCalledTimes(2);
    expect(sentLimits()).toEqual([100, 200]);
    expect(JSON.stringify(out)).toContain('output token limit');
  });
});

describe('turn outcome', () => {
  it('reports the notice as an incomplete max_output_tokens stop', () => {
    const outcome = describeTurnOutcome({ content: outputLimitNotice(200), state: { messages: [] } } as never, 0);
    expect(outcome.stopReason).toBe('limit');
    expect(outcome.partial).toBe(true);
    expect(incompleteReason(outcome.stopReason, outcome.stopDetail)).toBe('max_output_tokens');
  });
  it('leaves normal answers alone', () => {
    expect(describeTurnOutcome({ content: 'fine', state: { messages: [] } } as never, 0).stopReason).toBe('completed');
  });
});
