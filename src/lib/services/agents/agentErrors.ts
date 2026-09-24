/**
 * What a failed agent run tells its caller.
 *
 * Every channel used to answer a failed run the same way — `500 Internal
 * server error` on the client API, a bare string on the session stream — so a
 * wrong provider API key, a deleted model and a real bug were
 * indistinguishable, and the operator had nothing to act on. This maps a run
 * failure to a status and an error body that say which of those it was.
 *
 * Provider failures reuse the gateway's own classifier (`normalizeInferenceError`,
 * which also redacts keys from provider messages), with one change: a provider
 * that rejects ITS credentials is a 502, not a 401. The caller authenticated
 * fine; a 401 would tell them to fix their own token.
 */

import { normalizeInferenceError } from '@/lib/services/models/openaiErrors';
import { AgentRunConflictError } from '@/lib/database/provider/errors';

export interface AgentRunErrorBody {
    message: string;
    /**
     * `agent_config_error` — the agent itself is misconfigured (no model, a
     *   model that no longer exists, …): fix the agent.
     * `provider_authentication_error` / `provider_permission_error` — the
     *   model provider rejected the credentials stored for it: fix the provider.
     * `rate_limit_error`, `server_error`, `invalid_request_error`, … — as the
     *   gateway reports them.
     */
    type: string;
    code?: string | null;
}

export interface ClassifiedAgentRunError {
    status: number;
    error: AgentRunErrorBody;
}

/** Errors the agent runtime throws itself about its own configuration. */
const CONFIG_ERRORS: Array<{ pattern: RegExp; status: number; code: string }> = [
    { pattern: /^Agent has no model configured/, status: 409, code: 'agent_model_missing' },
    { pattern: /^Model ".*" not found/, status: 409, code: 'agent_model_not_found' },
    { pattern: /^Configured model is not compatible with chat/, status: 409, code: 'agent_model_incompatible' },
    { pattern: /^Provider runtime does not support chat model creation/, status: 409, code: 'agent_provider_unsupported' },
    { pattern: /^Provider ".*" (not found|is not available)/i, status: 409, code: 'agent_provider_not_found' },
];

const NOT_FOUND_ERRORS = [
    /^Agent ".*" not found/,
    /^Conversation ".*" not found/,
    /^Session ".*" not found/,
    /^Version \d+ not found/,
];

/**
 * Tags an error thrown by a run with the model it was running, so the message
 * can name what to fix. Returns the same error object.
 */
export function annotateAgentRunError<E>(error: E, context: { modelKey?: string; providerKey?: string }): E {
    if (error && typeof error === 'object') {
        const target = error as Record<string, unknown>;
        if (context.modelKey && target.agentModelKey === undefined) target.agentModelKey = context.modelKey;
        if (context.providerKey && target.agentProviderKey === undefined) target.agentProviderKey = context.providerKey;
    }
    return error;
}

export function classifyAgentRunError(
    error: unknown,
    options?: {
        /**
         * Keep the message of an unrecognized failure. For the dashboard,
         * where the reader is the operator debugging the agent; the client
         * API keeps it in the server log instead.
         */
        exposeInternal?: boolean;
    },
): ClassifiedAgentRunError {
    const message = error instanceof Error ? error.message : String(error ?? '');

    // Another turn (sync or background) already holds this conversation.
    if (error instanceof AgentRunConflictError) {
        return {
            status: 409,
            error: {
                message: 'An active run (queued or running) already exists for this conversation.',
                type: 'agent_run_conflict',
                code: 'agent_run_conflict',
            },
        };
    }

    for (const entry of CONFIG_ERRORS) {
        if (entry.pattern.test(message)) {
            return { status: entry.status, error: { message, type: 'agent_config_error', code: entry.code } };
        }
    }
    if (NOT_FOUND_ERRORS.some((pattern) => pattern.test(message))) {
        return { status: 404, error: { message, type: 'not_found_error', code: 'not_found' } };
    }

    const normalized = normalizeInferenceError(error);
    const context = (error && typeof error === 'object' ? error : {}) as { agentModelKey?: unknown; agentProviderKey?: unknown };
    const where = [
        typeof context.agentModelKey === 'string' ? `model "${context.agentModelKey}"` : undefined,
        typeof context.agentProviderKey === 'string' ? `provider "${context.agentProviderKey}"` : undefined,
    ].filter(Boolean).join(', ');

    if (normalized.error.type === 'authentication_error') {
        return {
            status: 502,
            error: {
                message: `The model provider rejected its credentials${where ? ` (${where})` : ''}. `
                    + 'Check the API key configured on the provider.',
                type: 'provider_authentication_error',
                code: normalized.error.code ?? 'invalid_api_key',
            },
        };
    }
    if (normalized.error.type === 'permission_error') {
        return {
            status: 502,
            error: {
                message: `The model provider refused the request${where ? ` (${where})` : ''}: ${normalized.error.message}`,
                type: 'provider_permission_error',
                code: normalized.error.code ?? 'permission_denied',
            },
        };
    }
    if (normalized.status === 500 && normalized.error.code === 'inference_error') {
        // Unrecognized: an internal fault, not something the caller can fix.
        // Its message may describe internals, so it stays in the server log —
        // unless the reader is the operator (redacted either way).
        return {
            status: 500,
            error: {
                message: options?.exposeInternal && normalized.error.message ? normalized.error.message : 'The agent run failed.',
                type: 'server_error',
                code: 'agent_run_failed',
            },
        };
    }
    return {
        status: normalized.status,
        error: {
            message: where && normalized.status >= 500
                ? `${normalized.error.message} (${where})`
                : normalized.error.message,
            type: normalized.error.type,
            code: normalized.error.code ?? null,
        },
    };
}
