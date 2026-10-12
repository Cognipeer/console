/**
 * Which model an agent run uses when the agent offers ADDITIONAL models (`config.additionalModels`).
 *
 *   1. The caller asked for a model (`requested`): it must be the main model or on the list
 *      (400 `model_not_allowed` otherwise). Anything but the main model also needs the policy
 *      engine's `agent.use_model` (403 `model_forbidden`, with the decision id; an engine that
 *      cannot decide is a 503 and never a "no"). The main model is never asked about.
 *   2. Nothing asked: the model the session last used (sticky). It is checked again against the
 *      list and the engine; if it no longer passes the run quietly goes back to the main model.
 *   3. The agent's main model.
 *
 * `resolveAgentRunModel` is the one function the routes call; it knows nothing about HTTP or
 * the engine (the route hands it `authorize`). The service layer then only APPLIES a choice
 * (`applyAgentModelChoice`): the choice is checked against the list once more, but the policy
 * decision was the route's.
 *
 * The choice rides on the session (`conversation.metadata.activeModel`, server-owned) so a queued
 * (background) run executes with what its request was authorized for, and on the run's session
 * events and trace tags.
 */

import type { IAgentConfig } from '@/lib/database';

export type AgentModelReason = 'requested' | 'session' | 'default';

export interface AgentModelChoice {
    modelKey: string;
    reason: AgentModelReason;
}

export type AgentModelErrorCode = 'model_not_allowed' | 'model_forbidden' | 'authorization_unavailable';

export class AgentModelError extends Error {
    readonly status: 400 | 403 | 503;
    constructor(
        readonly code: AgentModelErrorCode,
        message: string,
        readonly decisionId?: string,
    ) {
        super(message);
        this.name = 'AgentModelError';
        this.status = code === 'model_not_allowed' ? 400 : code === 'model_forbidden' ? 403 : 503;
    }
}

/** The engine's answer to "may this caller run the agent on that additional model?". */
export interface AgentModelVerdict {
    allowed: boolean;
    decisionId?: string;
    /** The engine could not decide: never read as a "no". */
    unavailable?: boolean;
}

export type AgentModelAuthorizer = (modelKey: string, options: { quiet: boolean }) => Promise<AgentModelVerdict>;

type ModelConfig = Pick<IAgentConfig, 'modelKey' | 'additionalModels'>;

/** The additional models of a config (never the main one, never twice, at most the contract's ten). */
export function additionalModelKeys(config: ModelConfig): string[] {
    const out: string[] = [];
    for (const entry of config.additionalModels ?? []) {
        const key = typeof entry?.modelKey === 'string' ? entry.modelKey.trim() : '';
        if (key && key !== config.modelKey && !out.includes(key)) out.push(key);
        if (out.length >= 10) break;
    }
    return out;
}

/** The choice stored on a session (`conversation.metadata.activeModel`), if it is well-formed. */
export function sessionModelChoice(metadata: Record<string, unknown> | undefined | null): AgentModelChoice | null {
    const raw = metadata?.activeModel as { modelKey?: unknown; reason?: unknown } | undefined;
    if (!raw || typeof raw.modelKey !== 'string' || !raw.modelKey) return null;
    const reason: AgentModelReason = raw.reason === 'requested' || raw.reason === 'session' ? raw.reason : 'default';
    return { modelKey: raw.modelKey, reason };
}

function refuse(verdict: AgentModelVerdict, modelKey: string): never {
    if (verdict.unavailable) {
        throw new AgentModelError('authorization_unavailable', 'Authorization is temporarily unavailable', verdict.decisionId);
    }
    throw new AgentModelError('model_forbidden', `You are not allowed to use the model "${modelKey}" with this agent`, verdict.decisionId);
}

/** See the module comment. Throws `AgentModelError`; otherwise says which model the run uses and why. */
export async function resolveAgentRunModel(input: {
    config: ModelConfig;
    /** What the caller asked for (`model` / `agent_model` / the header); empty = nothing. */
    requested?: string | null;
    /** The session's stored metadata (`conversation.metadata`), when the run continues one. */
    sessionMetadata?: Record<string, unknown> | null;
    authorize: AgentModelAuthorizer;
}): Promise<AgentModelChoice> {
    const main = input.config.modelKey ?? '';
    const listed = additionalModelKeys(input.config);
    const requested = typeof input.requested === 'string' ? input.requested.trim() : '';

    if (requested) {
        if (requested === main) return { modelKey: main, reason: 'requested' };
        if (!listed.includes(requested)) {
            throw new AgentModelError('model_not_allowed', `The model "${requested}" is not offered by this agent`);
        }
        const verdict = await input.authorize(requested, { quiet: false });
        if (!verdict.allowed) refuse(verdict, requested);
        return { modelKey: requested, reason: 'requested' };
    }

    const sticky = sessionModelChoice(input.sessionMetadata)?.modelKey;
    if (sticky && sticky !== main && listed.includes(sticky)) {
        const verdict = await input.authorize(sticky, { quiet: true });
        // An outage must not silently change the model of a running session either way: it is the caller's 503.
        if (verdict.unavailable) refuse(verdict, sticky);
        if (verdict.allowed) return { modelKey: sticky, reason: 'session' };
    }
    return { modelKey: main, reason: 'default' };
}

/**
 * The service side: the model a turn runs on. `chosen` is what the route resolved (and authorized) for a
 * synchronous turn; a background turn (`background`) takes the choice stored on its session. Either must still
 * be the main model or on the agent's list, otherwise the main model runs.
 */
export function applyAgentModelChoice(
    config: ModelConfig,
    input: { chosen?: string | null; sessionMetadata?: Record<string, unknown> | null; background?: boolean },
): AgentModelChoice {
    const main = config.modelKey ?? '';
    const fromSession = input.background ? sessionModelChoice(input.sessionMetadata) : null;
    const wanted = (input.chosen && input.chosen.trim()) || fromSession?.modelKey || '';
    if (wanted && wanted !== main && additionalModelKeys(config).includes(wanted)) {
        return { modelKey: wanted, reason: input.chosen ? 'requested' : fromSession?.reason ?? 'session' };
    }
    return { modelKey: main, reason: 'default' };
}

export interface AdvertisedAgentModel {
    key: string;
    label: string;
    description?: string;
    default: boolean;
}

/**
 * The `models` field of an agent's info: only when the agent lists additional models; the main model first
 * (`default: true`), entries the caller is denied left out, and nothing at all when fewer than two remain.
 * `nameOf` gives a model's display name (its label when the agent does not set one).
 */
export async function advertisedAgentModels(input: {
    config: ModelConfig;
    authorize: AgentModelAuthorizer;
    nameOf: (modelKey: string) => Promise<string | undefined>;
}): Promise<AdvertisedAgentModel[] | undefined> {
    const { config } = input;
    if (!config.modelKey || additionalModelKeys(config).length === 0) return undefined;
    const out: AdvertisedAgentModel[] = [{ key: config.modelKey, label: (await input.nameOf(config.modelKey)) ?? config.modelKey, default: true }];
    for (const entry of config.additionalModels ?? []) {
        const key = typeof entry?.modelKey === 'string' ? entry.modelKey.trim() : '';
        if (!key || key === config.modelKey || out.some((m) => m.key === key)) continue;
        if (out.length >= 11) break;
        const verdict = await input.authorize(key, { quiet: true });
        if (!verdict.allowed) continue;
        const label = entry.label?.trim() || (await input.nameOf(key)) || key;
        const description = entry.description?.trim();
        out.push({ key, label, ...(description ? { description } : {}), default: false });
    }
    return out.length >= 2 ? out : undefined;
}
