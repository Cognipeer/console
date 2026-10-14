'use client';

/**
 * Whether the agent's model can be sent an image — so the session composer can
 * say so before the person attaches one, instead of the image being dropped
 * silently and replaced by a note.
 *
 * The answer is the model's own input types as the models API resolves them
 * (an explicit setting, or what the model id is known to accept). Nothing is
 * guessed here: a model that cannot be found says nothing at all.
 */

import { useEffect, useState } from 'react';

export interface AgentModelVision {
    key: string;
    name: string;
    /** The model's page in Models, where its input types are set. */
    href: string;
    acceptsImages: boolean;
}

interface ModelListItem {
    _id?: string;
    key?: string;
    name?: string;
    capabilities?: { inputModalities?: unknown };
}

/** The vision verdict for the model with this key, or null when it is not in the list. */
export function visionOf(models: ModelListItem[], modelKey: string | undefined): AgentModelVision | null {
    if (!modelKey) return null;
    const model = models.find((candidate) => candidate.key === modelKey);
    if (!model || !model._id) return null;
    const modalities = Array.isArray(model.capabilities?.inputModalities) ? (model.capabilities!.inputModalities as unknown[]) : null;
    // No resolved list at all = unknown; do not warn about what is not known.
    if (!modalities) return null;
    return {
        key: modelKey,
        name: model.name || modelKey,
        href: `/dashboard/models/${encodeURIComponent(model._id)}/edit`,
        acceptsImages: modalities.includes('image'),
    };
}

/** The agent's model and whether it takes images; null while unknown. Looked up once per model key. */
export function useAgentModelVision(modelKey: string | undefined, enabled = true): AgentModelVision | null {
    const [vision, setVision] = useState<AgentModelVision | null>(null);

    useEffect(() => {
        if (!enabled || !modelKey) {
            setVision(null);
            return;
        }
        let cancelled = false;
        fetch('/api/models?category=llm', { cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : null))
            .then((data: { models?: ModelListItem[] } | null) => {
                if (!cancelled) setVision(visionOf(data?.models ?? [], modelKey));
            })
            .catch(() => { if (!cancelled) setVision(null); });
        return () => { cancelled = true; };
    }, [modelKey, enabled]);

    return vision;
}
