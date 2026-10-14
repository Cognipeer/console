/**
 * Live reasoning ("thinking") for agent runs: the tap that collects the SDK's
 * `reasoning` events, the session-event live type, the Studio live segments and
 * the OpenAI-shaped chat-completions chunks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createReasoningTap } from '@/lib/services/agents/agentService';
import { createSessionEventWriter, type SessionEventBus } from '@/lib/services/agents/sessionEvents';
import { appendLiveReasoning, appendLiveText, applyLiveToolEvent, type LiveSegment } from '@/components/agents/session/LiveToolCalls';
import { interpretSessionEvent } from '@/components/agents/session/sessionFollow';
import { extractAnswerReasoning, toChatChunk, toChatCompletion } from '@/server/api/plugins/agent-openai-bridge';
import type { AgentChatResponse } from '@/lib/services/agents/agentService';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const reasoningEvent = (text: string) => ({ type: 'reasoning', text }) as never;

describe('createReasoningTap', () => {
  it('forwards each piece and keeps the whole text', () => {
    const seen: string[] = [];
    const tap = createReasoningTap((text) => seen.push(text), 'a1');
    expect(tap.listening).toBe(true);
    tap.onEvent(reasoningEvent('Let me '));
    tap.onEvent(reasoningEvent('think.'));
    expect(seen).toEqual(['Let me ', 'think.']);
    expect(tap.text()).toBe('Let me think.');
  });

  it('starts a new paragraph for thinking after a tool call or answer text', () => {
    const seen: string[] = [];
    const tap = createReasoningTap((text) => seen.push(text), 'a1');
    tap.onEvent(reasoningEvent('First.'));
    tap.onEvent({ type: 'tool_call', phase: 'start', name: 'search' } as never);
    tap.onEvent(reasoningEvent('Second.'));
    expect(tap.text()).toBe('First.\n\nSecond.');
    expect(seen[1]).toBe('\n\nSecond.');
  });

  it('a hidden reasoning (enabled=false) swallows everything and asks for no stream', () => {
    const cb = vi.fn();
    const tap = createReasoningTap(cb, 'a1', false);
    tap.onEvent(reasoningEvent('secret'));
    expect(cb).not.toHaveBeenCalled();
    expect(tap.text()).toBe('');
    expect(tap.listening).toBe(false);
  });

  it('without a callback it does not ask for a stream, and a throwing callback never breaks the run', () => {
    expect(createReasoningTap(undefined, 'a1').listening).toBe(false);
    const tap = createReasoningTap(() => { throw new Error('boom'); }, 'a1');
    expect(() => tap.onEvent(reasoningEvent('x'))).not.toThrow();
    expect(tap.text()).toBe('x');
  });
});

describe('session events: live reasoning deltas', () => {
  it('are published live (never persisted) under their own type', async () => {
    const published: Array<{ type: string; data: unknown; seq?: number }> = [];
    const bus: SessionEventBus = {
      publish: (_id, frame) => { published.push(frame as never); },
      subscribe: () => () => undefined,
    };
    const db = { listAgentSessionEvents: vi.fn().mockResolvedValue([]), appendAgentSessionEvents: vi.fn().mockResolvedValue([]) };
    const writer = createSessionEventWriter({
      db: db as never, tenantId: 't', projectId: 'p', agentKey: 'a', conversationId: 'c', bus, retentionDays: 1,
    } as never);
    writer.emitLive('agent.reasoning.delta', { text: 'hmm' });
    await writer.close();
    const local = published.filter((frame) => frame.type === 'agent.reasoning.delta');
    expect(local.length).toBeGreaterThan(0);
    expect(local[0]).toMatchObject({ data: { text: 'hmm' } });
    expect(local[0].seq).toBeUndefined();
    expect(db.appendAgentSessionEvents).not.toHaveBeenCalled();
  });
});

describe('Studio live view', () => {
  it('thinking joins its block; text or a tool call in between starts a new one', () => {
    let segments: LiveSegment[] = [];
    segments = appendLiveReasoning(segments, 'a');
    segments = appendLiveReasoning(segments, 'b');
    segments = applyLiveToolEvent(segments, { phase: 'start', name: 'search', id: 'c1' });
    segments = appendLiveReasoning(segments, '\n\nc');
    segments = appendLiveText(segments, 'answer');
    expect(segments.map((s) => (s.kind === 'tools' ? 'tools' : `${s.kind}:${s.text}`))).toEqual([
      'reasoning:ab', 'tools', 'reasoning:c', 'text:answer',
    ]);
  });

  it('a followed session turns agent.reasoning.delta into reasoning', () => {
    expect(interpretSessionEvent('agent.reasoning.delta', { data: { text: 'x' } })).toEqual({ kind: 'reasoning', text: 'x' });
  });

  it('the transcript shows reasoning directly: one block component, no show/hide switch', () => {
    const view = read('src/components/agents/session/AgentSessionView.tsx');
    expect(view).not.toContain('session-reasoning-view');
    expect(view).not.toContain('ReasoningViewContext');
    expect(view).toContain('<ReasoningBlock reasoning={message.reasoning} />');
    expect(view).toContain("event === 'reasoning'");
    const block = read('src/components/agents/session/ReasoningBlock.tsx');
    expect(block).toContain('useState(true)');
  });
});

describe('chat-completions bridge', () => {
  const result = {
    output: [
      { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'first' }, { type: 'summary_text', text: 'second' }] },
      { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] },
    ],
  } as unknown as AgentChatResponse;

  it('reads the reasoning item, not the answer', () => {
    expect(extractAnswerReasoning(result)).toBe('first\n\nsecond');
    expect(extractAnswerReasoning({ output: [] } as unknown as AgentChatResponse)).toBe('');
  });

  it('puts it on message.reasoning_content, only when there is some', () => {
    const withIt = toChatCompletion({ id: 'x', model: 'agent', content: 'Hi', conversationId: 'c', reasoning: 'thought' });
    expect(withIt.choices[0].message).toMatchObject({ content: 'Hi', reasoning_content: 'thought' });
    const without = toChatCompletion({ id: 'x', model: 'agent', content: 'Hi', conversationId: 'c' });
    expect(without.choices[0].message).not.toHaveProperty('reasoning_content');
  });

  it('streams it as delta.reasoning_content chunks without content', () => {
    const chunk = toChatChunk({ id: 'x', model: 'agent', reasoning: 'hm' });
    expect(chunk.choices[0].delta).toEqual({ reasoning_content: 'hm' });
    expect(toChatChunk({ id: 'x', model: 'agent', delta: 'Hi' }).choices[0].delta).toEqual({ content: 'Hi' });
  });
});
