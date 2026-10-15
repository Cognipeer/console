/**
 * Memory mounts: an agent can mount several console memory stores. The legacy
 * single `memoryStoreKey` is normalized into one read_write mount so every
 * consumer (adapter, tools, prompt) deals with one shape.
 */

import type { AgentMemoryScope, IAgentMemoryConfig } from '@/lib/database/provider/types.domain';

export const MAX_MEMORY_MOUNTS = 5;

export interface ResolvedMemoryMount {
    storeKey: string;
    access: 'read_write' | 'read_only';
    description?: string;
    scope: AgentMemoryScope;
    /** True when synthesized from the legacy `memoryStoreKey` (keeps per-agent workspace ids). */
    legacy: boolean;
}

/** Mounts win over the legacy key; the legacy key becomes the first read_write mount. Deduped by storeKey. */
export function normalizeMemoryMounts(memory: IAgentMemoryConfig | undefined): ResolvedMemoryMount[] {
    if (!memory) return [];
    const defaultScope: AgentMemoryScope = memory.scope ?? 'workspace';
    const raw = memory.mounts?.filter((m) => m && typeof m.storeKey === 'string' && m.storeKey.trim());
    if (raw && raw.length > 0) {
        const seen = new Set<string>();
        const out: ResolvedMemoryMount[] = [];
        for (const m of raw) {
            const storeKey = m.storeKey.trim();
            if (seen.has(storeKey)) continue;
            seen.add(storeKey);
            out.push({
                storeKey,
                access: m.access === 'read_only' ? 'read_only' : 'read_write',
                ...(m.description?.trim() ? { description: m.description.trim() } : {}),
                scope: m.scope ?? defaultScope,
                legacy: false,
            });
            if (out.length >= MAX_MEMORY_MOUNTS) break;
        }
        return out;
    }
    if (memory.memoryStoreKey) {
        return [{ storeKey: memory.memoryStoreKey, access: 'read_write', scope: defaultScope, legacy: true }];
    }
    return [];
}

/** System-prompt section telling the model where it can read and write. Empty when no explicit mounts. */
export function buildMemoryPromptSection(memory: IAgentMemoryConfig | undefined): string {
    if (!memory?.enabled || !memory.mounts?.length) return '';
    const mounts = normalizeMemoryMounts(memory);
    if (mounts.length === 0) return '';
    const lines = mounts.map((m) =>
        `- ${m.storeKey} (${m.access === 'read_only' ? 'read-only' : 'read/write'})${m.description ? ` — Use for: ${m.description}` : ''}`);
    return [
        '## Memory stores',
        'You have these memory stores available through memory_search / memory_write / memory_forget (pass the store key as `store`):',
        ...lines,
    ].join('\n');
}
