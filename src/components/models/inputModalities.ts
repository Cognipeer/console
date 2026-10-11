/**
 * A model's input types in the create and edit forms, as pure functions.
 *
 * What a model can be sent is its stored input types when someone set them, and
 * otherwise what the model id is known to accept (`resolveModelCapabilities`).
 * The forms used to write the category default back on every save, so a model
 * that was never asked about images ended up with an explicit "text only" that
 * hid its real abilities. Now the boxes start from the detected types and a
 * choice is stored only when the person makes one; "detect automatically" takes
 * it back.
 */

import type { IModel } from '@/lib/database';
import {
    isLegacyTextOnlyDefault,
    resolveModelCapabilities,
    type ModelInputModality,
} from '@/lib/services/models/modelCapabilities';

export const INPUT_MODALITY_OPTIONS: readonly ModelInputModality[] = ['text', 'image', 'audio', 'video', 'file'];

const KNOWN = new Set<string>(INPUT_MODALITY_OPTIONS);

/** What the model accepts when nothing is set: the category default, or what the model id is known for. */
export function inferredInputModalities(
    category: IModel['category'],
    modelId: string,
    isMultimodal = false,
): ModelInputModality[] {
    return resolveModelCapabilities({
        category,
        modelId,
        isMultimodal,
        metadata: {},
        settings: {},
    } as unknown as IModel).inputModalities;
}

/**
 * The input types stored on the model as an explicit choice, or null when it has none.
 * With the model's `category` and `isMultimodal`, the plain "text only" that the
 * forms of earlier releases wrote on every save is no choice either
 * (`isLegacyTextOnlyDefault`): the page then shows the detected types and a
 * re-save does not write that value back.
 */
export function storedInputModalities(
    metadata: Record<string, unknown> | undefined,
    model?: { category: IModel['category']; isMultimodal?: boolean },
): ModelInputModality[] | null {
    const capabilities = metadata?.capabilities;
    const stored = capabilities && typeof capabilities === 'object'
        ? (capabilities as { inputModalities?: unknown; inputModalitiesExplicit?: unknown })
        : undefined;
    const raw = stored?.inputModalities;
    if (!Array.isArray(raw)) return null;
    const known = raw.filter((entry): entry is ModelInputModality => typeof entry === 'string' && KNOWN.has(entry));
    if (known.length === 0) return null;
    const chosen = INPUT_MODALITY_OPTIONS.filter((option) => known.includes(option));
    if (model && isLegacyTextOnlyDefault(model.category, model.isMultimodal, chosen, stored?.inputModalitiesExplicit)) return null;
    return chosen;
}

/**
 * The boxes as they are drawn: the explicit choice, else the detected types.
 * Never narrowed by the provider's driver: a driver's capabilities say what the
 * driver discovers by itself, not what the operator's model can be sent.
 */
export function shownInputModalities(
    chosen: ModelInputModality[] | null,
    inferred: ModelInputModality[],
): ModelInputModality[] {
    return [...(chosen ?? inferred)];
}

/** The next explicit choice after ticking or clearing one box; never empty, always in the boxes' order. */
export function toggleInputModality(
    current: readonly ModelInputModality[],
    modality: ModelInputModality,
    checked: boolean,
): ModelInputModality[] {
    const next = new Set(current);
    if (checked) next.add(modality);
    else next.delete(modality);
    if (next.size === 0) return [...current];
    return INPUT_MODALITY_OPTIONS.filter((option) => next.has(option));
}

/** `isMultimodal` of the model record: it takes something besides text and documents. */
export function isMultimodalFor(modalities: readonly ModelInputModality[]): boolean {
    return modalities.some((modality) => modality === 'image' || modality === 'audio' || modality === 'video');
}

/** The `inputModalities` to send: only an explicit choice is stored. */
export function inputModalitiesPayload(chosen: ModelInputModality[] | null): { inputModalities: ModelInputModality[] } | Record<string, never> {
    return chosen && chosen.length > 0 ? { inputModalities: chosen } : {};
}

/**
 * Whether a model record is shown as taking pictures ("vision") in the Model
 * Hub. For a chat model that is what the model resolves to — the explicit
 * choice, else what the model id is known for (the API sends it as
 * `capabilities.inputModalities`) — not only the stored `isMultimodal` flag,
 * which a model created before the detection existed, or through the API, never
 * had set. Other categories keep the flag.
 */
export function modelTakesImages(model: {
    category?: string;
    isMultimodal?: boolean;
    capabilities?: { inputModalities?: readonly string[] };
}): boolean {
    const resolved = model.capabilities?.inputModalities;
    if (model.category === 'llm' && Array.isArray(resolved)) return resolved.includes('image');
    return Boolean(model.isMultimodal);
}
