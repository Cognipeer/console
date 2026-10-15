/**
 * Pure helpers for an agent's knowledge bindings: normalising the legacy single
 * `knowledgeEngineKey` into bindings, tool-name slugs, and merging hits from
 * several knowledge bases into one ranked list.
 */
import type { IAgentKnowledgeBinding } from '@/lib/database/provider/types.domain';

export interface KnowledgeBindingSource {
    knowledgeEngineKey?: string;
    knowledgeBindings?: IAgentKnowledgeBinding[];
    knowledgeToolMode?: 'combined' | 'separate';
}

/** Cap on hits returned by the combined search tool. */
export const COMBINED_KNOWLEDGE_MAX_HITS = 10;

/**
 * Enabled, de-duplicated bindings. `knowledgeBindings` wins over the legacy
 * `knowledgeEngineKey`; a lone legacy key becomes one binding with no overrides.
 */
export function normalizeKnowledgeBindings(config: KnowledgeBindingSource): IAgentKnowledgeBinding[] {
    const list = Array.isArray(config.knowledgeBindings) && config.knowledgeBindings.length > 0
        ? config.knowledgeBindings
        : config.knowledgeEngineKey ? [{ key: config.knowledgeEngineKey }] : [];
    const seen = new Set<string>();
    const out: IAgentKnowledgeBinding[] = [];
    for (const binding of list) {
        const key = typeof binding?.key === 'string' ? binding.key.trim() : '';
        if (!key || seen.has(key) || binding.enabled === false) continue;
        seen.add(key);
        out.push({ ...binding, key });
    }
    return out;
}

/** True when the agent has any knowledge base configured (enabled or not). */
export function hasKnowledgeConfigured(config: KnowledgeBindingSource): boolean {
    return Boolean(config.knowledgeEngineKey) || (config.knowledgeBindings?.length ?? 0) > 0;
}

/** Every KB key referenced by the config, including disabled ones (for dependency edges / validation). */
export function allKnowledgeKeys(config: KnowledgeBindingSource): string[] {
    const keys = new Set<string>();
    if (Array.isArray(config.knowledgeBindings) && config.knowledgeBindings.length > 0) {
        for (const b of config.knowledgeBindings) if (b?.key) keys.add(b.key);
    } else if (config.knowledgeEngineKey) keys.add(config.knowledgeEngineKey);
    return [...keys];
}

/** Tool-name-safe slug of a KB key. */
export function knowledgeKeySlug(key: string): string {
    return key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'kb';
}

export interface KnowledgeHit {
    kb: string;
    documentId?: string;
    fileName?: string;
    score: number;
    content: string;
}

/** Merge hits across KBs by score descending, capped; keeps order stable for ties. */
export function mergeKnowledgeHits(hits: KnowledgeHit[], max = COMBINED_KNOWLEDGE_MAX_HITS): KnowledgeHit[] {
    return hits
        .map((hit, index) => ({ hit, index }))
        .sort((a, b) => (b.hit.score - a.hit.score) || (a.index - b.index))
        .slice(0, max)
        .map((entry) => entry.hit);
}

export function formatKnowledgeHit(hit: KnowledgeHit): string {
    const parts = [`kb: ${hit.kb}`];
    if (hit.documentId) parts.push(`documentId: ${hit.documentId}`);
    if (hit.fileName) parts.push(`file: ${hit.fileName}`);
    parts.push(`score: ${hit.score.toFixed(2)}`);
    return `[${parts.join(', ')}]\n${hit.content}`;
}
