import { describe, expect, it } from 'vitest';
import {
  completionFrom,
  pausedMessage,
  toChatChunk,
  toChatCompletion,
} from '@/server/api/plugins/agent-openai-bridge';

const approval = { id: 'act_1', kind: 'tool_approval', tool_name: 'get_weather', subagent: 'worker', status: 'pending' };
const question = { id: 'act_2', kind: 'user_question', questions: [{ question: 'Which city?' }], status: 'pending' };
const paused = (actions: unknown[]) => ({
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] }],
  status: 'requires_action',
  stop_reason: 'requires_action',
  required_action: { type: 'agent_actions', actions },
}) as never;

describe('a paused agent turn over chat completions', () => {
  it('says what waits and where to answer it, instead of an empty content', () => {
    const result = completionFrom(paused([approval]), 'conv_1');
    expect(result).toMatchObject({ requiredAction: { type: 'agent_actions' } });
    const content = (result as { content: string }).content;
    expect(content).toContain('"get_weather"');
    expect(content).toContain('sub-agent "worker"');
    expect(content).toContain('act_1');
    expect(content).toContain('/agents/sessions/conv_1/actions/');
  });

  it('names the question text of an ask_user pause', () => {
    expect(pausedMessage([question as never], 'c')).toContain('"Which city?"');
  });

  it('keeps finish_reason stop and carries conversation_id with the pending actions', () => {
    const result = completionFrom(paused([approval]), 'conv_1') as never;
    const body = toChatCompletion({ id: 'x', model: 'agent:a', ...(result as object) } as never);
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.choices[0].message.content).not.toBe('');
    expect(body).toMatchObject({ stop_reason: 'requires_action', conversation_id: 'conv_1', required_action: { actions: [{ id: 'act_1' }] } });
    const chunk = toChatChunk({ id: 'x', model: 'm', finish: true, stopReason: 'requires_action', conversationId: 'conv_1', requiredAction: (result as { requiredAction: never }).requiredAction });
    expect(chunk).toMatchObject({ required_action: { actions: [{ id: 'act_1' }] }, stop_reason: 'requires_action' });
  });
});
