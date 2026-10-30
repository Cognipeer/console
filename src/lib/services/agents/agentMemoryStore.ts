/**
 * The one memory store an agent uses, resolved from its config.
 *
 * Agents briefly could mount several stores (`memory.mounts`). Configs saved
 * then are still read: the first mount is the store, with its access and
 * scope, and any further mounts are ignored. Those configs wrote 'workspace'
 * facts project-wide, so they keep that namespace (`sharedWorkspace`).
 */

import type { AgentMemoryScope, IAgentMemoryConfig } from '@/lib/database/provider/types.domain';

export interface ResolvedAgentMemoryStore {
    storeKey: string;
    scope: AgentMemoryScope;
    /** Only a read-only first mount sets this: neither the SDK nor the tools write to it. */
    readOnly: boolean;
    /** 'workspace' is keyed by the project instead of the agent. */
    sharedWorkspace: boolean;
    /** Store keys of the mounts after the first, which no run reads any more. */
    ignoredStoreKeys: string[];
}

/** Undefined when no store is picked. Mounts win over `memoryStoreKey`, as they did when they were read. */
export function resolveAgentMemoryStore(memory: IAgentMemoryConfig | undefined): ResolvedAgentMemoryStore | undefined {
    if (!memory) return undefined;
    const mounts = (memory.mounts ?? []).filter((m) => typeof m?.storeKey === 'string' && m.storeKey.trim());
    if (mounts.length > 0) {
        const [first, ...rest] = mounts;
        const storeKey = first.storeKey.trim();
        return {
            storeKey,
            scope: first.scope ?? memory.scope ?? 'workspace',
            readOnly: first.access === 'read_only',
            sharedWorkspace: true,
            ignoredStoreKeys: [...new Set(rest.map((m) => m.storeKey.trim()))].filter((key) => key !== storeKey),
        };
    }
    const storeKey = typeof memory.memoryStoreKey === 'string' ? memory.memoryStoreKey.trim() : '';
    if (!storeKey) return undefined;
    return {
        storeKey,
        scope: memory.scope ?? 'workspace',
        readOnly: false,
        sharedWorkspace: memory.sharedWorkspace === true,
        ignoredStoreKeys: [],
    };
}

/**
 * The config the panel saves: one `memoryStoreKey`, no mounts. A read-only
 * first mount becomes manual writes and search-only tools, which is what it
 * did for that store; 'workspace' keeps the project-wide namespace it wrote to.
 */
export function toSingleStoreMemoryConfig(memory: IAgentMemoryConfig): IAgentMemoryConfig {
    if (!memory.mounts?.length) return memory;
    const resolved = resolveAgentMemoryStore(memory);
    if (!resolved) return { ...memory, mounts: undefined };
    return {
        ...memory,
        memoryStoreKey: resolved.storeKey,
        mounts: undefined,
        scope: resolved.scope,
        ...(resolved.scope === 'workspace' ? { sharedWorkspace: true } : {}),
        ...(resolved.readOnly ? { writePolicy: 'manual' as const, ...(memory.tools === 'off' ? {} : { tools: 'read' as const }) } : {}),
    };
}
