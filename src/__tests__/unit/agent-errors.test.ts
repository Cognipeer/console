/**
 * Finding #7: a wrong provider API key surfaced as nothing the operator could
 * act on — a generic 500 on the client API, a vanishing toast in a session.
 */

import { describe, it, expect } from 'vitest';
import { annotateAgentRunError, classifyAgentRunError } from '@/lib/services/agents/agentErrors';

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
