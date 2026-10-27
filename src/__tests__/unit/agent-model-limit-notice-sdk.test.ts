/**
 * The limit notice against the REAL agent-sdk (GAP2-01): the call that carries it finishes `length`
 * (gatewayChatModel.ts), so a reader of the finish reason can tell it from an answer, and the SDK's
 * loop still ends the turn on it as it does on `stop` - with no tool call there is nothing cut off to
 * drop, no further model call follows, and the notice is the turn's answer. The gateway core is a
 * script that always hits the output limit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeModelCall = vi.fn();
vi.mock('@/lib/services/models/gatewayCore', () => ({ executeModelCall: (...a: unknown[]) => executeModelCall(...a) }));

import { OutputTokenLimitError } from '@/lib/services/models/openaiErrors';
import { buildGatewayChatModel } from '@/lib/services/agents/gatewayChatModel';
import { createOutputLimitTap, outputLimitNotice } from '@/lib/services/agents/outputLimitNotice';

const model = { key: 'm', modelId: 'm-1', providerDriver: 'openai', settings: {} } as never;
const USER = [{ role: 'user', content: 'hi' }];

const build = (extra: object = {}) => buildGatewayChatModel({
  tenantDbName: 't', tenantId: 't', projectId: 'p', model, overrides: { max_tokens: 100 }, ...extra,
});

async function runAgent(chat: unknown, config?: object) {
  const { createSmartAgent, createTool } = await import('@cognipeer/agent-sdk');
  const { z } = await import('zod');
  const lookup = createTool({
    name: 'lookup', description: 'Find a thing', schema: z.object({ q: z.string() }), func: async (args: { q: string }) => `found ${args.q}`,
  });
  const agent = createSmartAgent({ model: chat, tools: [lookup], systemPrompt: 'Be brief.' } as never);
  return agent.invoke({ messages: [{ role: 'user', content: 'find apples' }] } as never, config as never) as Promise<{
    content?: string;
    messages: Array<Record<string, any>>;
  }>;
}

beforeEach(() => {
  executeModelCall.mockReset();
  // Every attempt runs out of output tokens: the first one and the raised retry.
  executeModelCall.mockImplementation(async () => { throw new OutputTokenLimitError(100); });
});

describe('the notice call through the SDK adapter', () => {
  it('invoke: the message the SDK builds finishes length and carries no tool call', async () => {
    const tap = createOutputLimitTap();
    const reply = await (await build({ outputLimitTap: tap })).invoke(USER) as unknown as Record<string, any>;
    expect(executeModelCall).toHaveBeenCalledTimes(2);
    expect(reply.content).toBe(outputLimitNotice(100));
    expect(reply.response_metadata?.finish_reason).toBe('length');
    expect(reply.tool_calls).toBeUndefined();
    // What the turn's outcome is read from is the structural report, not the finish reason or the text.
    expect(tap.latest()).toEqual({ kind: 'notice', limit: 100 });
  });

  it('stream: the final message the SDK assembles finishes length and carries no tool call', async () => {
    const parts: any[] = [];
    for await (const part of (await build()).stream!(USER)) parts.push(part);
    const final = parts.find((part) => typeof part === 'object' && part.role);
    expect(executeModelCall).toHaveBeenCalledTimes(2);
    expect(final.content).toBe(outputLimitNotice(100));
    expect(final.response_metadata?.finish_reason).toBe('length');
    expect(final.tool_calls).toBeUndefined();
  });
});

describe('a real agent loop on the notice', () => {
  it('ends the turn there: no further model call, and the notice is the answer', async () => {
    const tap = createOutputLimitTap();
    const result = await runAgent(await build({ outputLimitTap: tap }));
    // The attempt and its raised retry are all the loop asked of the model.
    expect(executeModelCall).toHaveBeenCalledTimes(2);
    expect(result.content).toBe(outputLimitNotice(100));
    expect(tap.latest()).toEqual({ kind: 'notice', limit: 100 });
  });

  it('streamed, it ends the same way', async () => {
    const tap = createOutputLimitTap();
    const result = await runAgent(await build({ outputLimitTap: tap }), { stream: true, onStream: () => undefined });
    expect(executeModelCall).toHaveBeenCalledTimes(2);
    expect(result.content).toBe(outputLimitNotice(100));
    expect(tap.latest()).toEqual({ kind: 'notice', limit: 100 });
  });
});
