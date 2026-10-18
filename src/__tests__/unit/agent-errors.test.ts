/**
 * Finding #7: a wrong provider API key surfaced as nothing the operator could
 * act on — a generic 500 on the client API, a vanishing toast in a session.
 */

import { describe, it, expect } from 'vitest';
import {
    AgentBudgetReachedError,
    AgentRunInterruptedError,
    AgentRunTimeoutError,
    GENERIC_RUN_FAILURE_MESSAGE,
    annotateAgentRunError,
    classifyAgentRunError,
    publicRunFailureMessage,
} from '@/lib/services/agents/agentErrors';

const providerError = (status: number, message: string) => Object.assign(new Error(message), { status });

describe('classifyAgentRunError', () => {
    it('a provider rejecting its key is a 502 naming the model and provider — never the caller\'s 401', () => {
        const error = annotateAgentRunError(
            providerError(401, 'Incorrect API key provided: sk-proj-abcdefghijklmnop'),
            { modelKey: 'gpt-main', providerKey: 'azure-prod' },
        );
        const classified = classifyAgentRunError(error);
        expect(classified.status).toBe(502);
        expect(classified.error.type).toBe('provider_authentication_error');
        expect(classified.error.message).toContain('model "gpt-main", provider "azure-prod"');
        expect(JSON.stringify(classified)).not.toContain('sk-proj');
    });

    it('a provider refusing access is a 502 permission error', () => {
        const classified = classifyAgentRunError(providerError(403, 'deployment access denied'));
        expect(classified).toMatchObject({ status: 502, error: { type: 'provider_permission_error' } });
    });

    it('the agent\'s own configuration errors are 409 agent_config_error', () => {
        expect(classifyAgentRunError(new Error('Model "gpt-old" not found'))).toMatchObject({
            status: 409,
            error: { type: 'agent_config_error', code: 'agent_model_not_found' },
        });
        expect(classifyAgentRunError(new Error('Agent has no model configured')).error.code).toBe('agent_model_missing');
    });

    it('keeps the gateway\'s own classes for rate limits and timeouts', () => {
        expect(classifyAgentRunError(providerError(429, 'Too many requests')).status).toBe(429);
        expect(classifyAgentRunError(providerError(504, 'upstream timed out')).status).toBe(504);
    });

    it('hides an unrecognized failure\'s message from API callers, shows it to the operator', () => {
        const error = new Error('Cannot read properties of undefined (reading "foo")');
        expect(classifyAgentRunError(error).error.message).toBe('The agent run failed.');
        expect(classifyAgentRunError(error, { exposeInternal: true }).error.message).toContain('reading "foo"');
    });
});

describe('publicRunFailureMessage: what a client reads of a failed run', () => {
    it('is the generic line for the provider\'s own faults and for bugs, whose text can name endpoints and request ids', () => {
        for (const error of [
            providerError(502, 'Bad gateway from https://10.2.4.7:8443/openai/deployments/prod (request id req_1)'),
            providerError(503, 'upstream connect error'),
            new Error('fetch failed: connect ECONNREFUSED 10.2.4.7:8443'),
            new Error('Cannot read properties of undefined (reading "foo")'),
        ]) {
            expect(publicRunFailureMessage(error)).toBe(GENERIC_RUN_FAILURE_MESSAGE);
        }
    });

    it('keeps the message of a failure the caller can act on', () => {
        expect(publicRunFailureMessage(providerError(429, 'Too many requests'))).toBe('Too many requests');
        expect(publicRunFailureMessage(providerError(400, "This model's maximum context length is 128000 tokens."))).toContain('maximum context length');
        expect(publicRunFailureMessage(new AgentBudgetReachedError(1, 1))).toContain('reached its budget');
        expect(publicRunFailureMessage(new Error('Model "gpt-old" not found'))).toBe('Model "gpt-old" not found');
    });

    it('keeps the message of a retryable authorization_unavailable (503), which is written for the caller', () => {
        const error = Object.assign(new Error('Authorization is temporarily unavailable'), { status: 503, code: 'authorization_unavailable', type: 'api_error' });
        expect(publicRunFailureMessage(error)).toBe('Authorization is temporarily unavailable');
    });

    it('keeps the words of a run the platform itself ended: they are not the provider\'s', () => {
        expect(publicRunFailureMessage(new AgentRunInterruptedError('worker_lost'))).toBe('The agent run was stopped before it finished. It was not completed; retry it.');
        expect(publicRunFailureMessage(new AgentRunTimeoutError())).toContain('exceeded its maximum duration');
    });

    it('takes a classification already made instead of making another', () => {
        const error = providerError(502, 'upstream connect error');
        expect(publicRunFailureMessage(error, classifyAgentRunError(error))).toBe(GENERIC_RUN_FAILURE_MESSAGE);
    });
});
