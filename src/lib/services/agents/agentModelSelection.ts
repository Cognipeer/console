/**
 * Which model an agent run uses when the agent offers ADDITIONAL models (`config.additionalModels`).
 *
 *   1. The caller asked for a model (`requested`): it must be the main model or on the list
 *      (400 `model_not_allowed` otherwise). There is no separate permission: whoever may run the
 *      agent may use any model on its list.
 *   2. Nothing asked: the model the session last used (sticky). It is checked again against the
 *      list; if it is no longer on it the run quietly goes back to the main model.
 *   3. The agent's main model.
 *
 * `resolveAgentRunModel` is the one function the routes call; it knows nothing about HTTP or
 * the model records. The service layer then only APPLIES a choice (`applyAgentModelChoice`),
 * checking it against the list once more.
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

export type AgentModelErrorCode = 'model_not_allowed';

export class AgentModelError extends Error {
    readonly status = 400 as const;
    constructor(
        readonly code: AgentModelErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'AgentModelError';
    }
}

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

/** See the module comment. Throws `AgentModelError`; otherwise says which model the run uses and why. */
export async function resolveAgentRunModel(input: {
    config: ModelConfig;
    /** What the caller asked for (`model` / `agent_model` / the header); empty = nothing. */
    requested?: string | null;
    /** The session's stored metadata (`conversation.metadata`), when the run continues one. */
    sessionMetadata?: Record<string, unknown> | null;
}): Promise<AgentModelChoice> {
    const main = input.config.modelKey ?? '';
    const listed = additionalModelKeys(input.config);
    const requested = typeof input.requested === 'string' ? input.requested.trim() : '';

    if (requested) {
        if (requested === main) return { modelKey: main, reason: 'requested' };
        if (!listed.includes(requested)) {
            throw new AgentModelError('model_not_allowed', `The model "${requested}" is not offered by this agent`);
        }
        return { modelKey: requested, reason: 'requested' };
    }

    const sticky = sessionModelChoice(input.sessionMetadata)?.modelKey;
    if (sticky && sticky !== main && listed.includes(sticky)) return { modelKey: sticky, reason: 'session' };
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

/** Per-model name / description a surface (the portal) shows instead of the agent's own; keyed by model key. */
export type AdvertisedModelOverrides = Record<string, { label?: string; description?: string }>;

/**
 * The `models` field of an agent's info: only when the agent lists additional models; the main model first
 * (`default: true`), and nothing at all when fewer than two remain.
 * `nameOf` gives a model's display name. Per model, label and description come from `overrides[key]`
 * (trimmed, non-empty), then from the agent's own entry, then the model name (no description).
 */
export async function advertisedAgentModels(input: {
    config: ModelConfig;
    nameOf: (modelKey: string) => Promise<string | undefined>;
    overrides?: AdvertisedModelOverrides;
}): Promise<AdvertisedAgentModel[] | undefined> {
    const { config } = input;
    if (!config.modelKey || additionalModelKeys(config).length === 0) return undefined;
    const pick = (key: string, field: 'label' | 'description', own?: string): string | undefined => {
        const override = input.overrides?.[key]?.[field];
        const text = typeof override === 'string' ? override.trim() : '';
        return text || own?.trim() || undefined;
    };
    const mainDescription = pick(config.modelKey, 'description');
    const out: AdvertisedAgentModel[] = [{
        key: config.modelKey,
        label: pick(config.modelKey, 'label') ?? (await input.nameOf(config.modelKey)) ?? config.modelKey,
        ...(mainDescription ? { description: mainDescription } : {}),
        default: true,
    }];
    for (const entry of config.additionalModels ?? []) {
        const key = typeof entry?.modelKey === 'string' ? entry.modelKey.trim() : '';
        if (!key || key === config.modelKey || out.some((m) => m.key === key)) continue;
        if (out.length >= 11) break;
        const label = pick(key, 'label', entry.label) ?? (await input.nameOf(key)) ?? key;
        const description = pick(key, 'description', entry.description);
        out.push({ key, label, ...(description ? { description } : {}), default: false });
    }
    return out.length >= 2 ? out : undefined;
}
