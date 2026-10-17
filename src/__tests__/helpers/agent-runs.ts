/**
 * A queued agent run, the way the Responses route's `background: true` starts
 * one: `startAgentRun` with queued execution, the callback given as url + secret.
 */
import { startAgentRun, type StartAgentRunInput, type StartAgentRunOutcome } from '@/lib/services/agents/agentRunService';

export interface QueueAgentRunInput extends Omit<StartAgentRunInput, 'execution' | 'callback'> {
  callbackUrl?: string;
  callbackSecret?: string;
  notBefore?: Date;
}

export function queueAgentRun(input: QueueAgentRunInput): Promise<StartAgentRunOutcome> {
  const { callbackUrl, callbackSecret, notBefore, ...rest } = input;
  return startAgentRun({
    actorType: 'api_token',
    channel: 'responses',
    ...rest,
    callback: callbackUrl ? { url: callbackUrl, ...(callbackSecret ? { secret: callbackSecret } : {}) } : null,
    execution: { kind: 'queued', ...(notBefore ? { notBefore } : {}) },
  });
}
