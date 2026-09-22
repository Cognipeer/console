/**
 * Bridges console's own Memory module (vector-backed stores, manageable at
 * `/dashboard/memory`) into the agent-sdk's `MemoryStore` interface.
 *
 * Why an adapter instead of the SDK's `provider: 'redis' | 'postgres' | ...`
 * knob: those provider kinds need their own driver/connection config that
 * `SmartAgentMemoryConfig` doesn't carry, and standing up a SEPARATE memory
 * backend next to console's existing, semantic-search-capable Memory module
 * would just be a second, worse place for the same facts to live. An agent
 * picks an EXISTING store (the same ones listed at `/dashboard/memory`, the
 * same picker shape as `knowledgeEngineKey`) and this file is what makes that
 * store speak the SDK's `get`/`upsert`/`markObsolete`/`semanticSearch`
 * contract, so the SDK's own structured-summarization pipeline
 * (`writeSummaryFactsToMemory`) is what decides what's worth remembering.
 *
 * A `MemoryFact` has no natural home in console's `IMemoryItem` schema (which
 * has no `key` field — items are deduped by content hash, not addressed by a
 * caller-chosen key), so a fact's `key` is carried in `metadata.factKey` and
 * looked up by scanning the scope. Scopes are small in practice (per session,
 * per user) — this is not built to scale to thousands of facts in one scope.
 */

import type {
    MemoryFact,
    MemoryScope as SdkMemoryScope,
    MemoryStore,
    SmartAgentMemoryConfig,
} from '@cognipeer/agent-sdk';
import type { IAgentMemoryConfig } from '@/lib/database';
import type { MemoryScope as ConsoleMemoryScope } from '@/lib/database/provider/types.extended';
import { addMemory, listMemoryItems, searchMemories, updateMemoryItem } from '@/lib/services/memory/memoryService';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('agent-memory');

/** How many candidate items a scope-scan considers when resolving a fact by key. */
const SCAN_LIMIT = 500;

export interface AgentMemoryContext {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    /** Console memory store key — `config.memory.memoryStoreKey`. */
    storeKey: string;
    /** Resolves an SDK scope to the id that scopes it within the store. */
    scopeIds: {
        session?: string;
        user?: string;
        /** "workspace" → this agent, so two agents never share ad-hoc facts. */
        workspace?: string;
        /** "tenant" → no scopeId at all; the store itself is already tenant-scoped. */
    };
}

/** Exported for direct testing — a silent scope mismatch would leak facts across sessions/users. */
export function toConsoleScope(scope: SdkMemoryScope): ConsoleMemoryScope {
    switch (scope) {
        case 'session':
            return 'session';
        case 'user':
            return 'user';
        case 'workspace':
            return 'agent';
        case 'tenant':
        default:
            return 'global';
    }
}

function scopeIdFor(scope: SdkMemoryScope, ctx: AgentMemoryContext): string | undefined {
    switch (scope) {
        case 'session':
            return ctx.scopeIds.session;
        case 'user':
            return ctx.scopeIds.user;
        case 'workspace':
            return ctx.scopeIds.workspace;
        case 'tenant':
        default:
            return undefined;
    }
}

function toFact(item: { _id?: unknown; content: string; summary?: string; importance: number; tags: string[]; status: string; updatedAt?: Date; metadata: Record<string, unknown> }): MemoryFact {
    const key = typeof item.metadata?.factKey === 'string' ? item.metadata.factKey : String(item._id ?? '');
    return {
        key,
        value: item.summary ?? item.content,
        sourceTurn: typeof item.metadata?.sourceTurn === 'number' ? item.metadata.sourceTurn : 0,
        confidence: item.importance,
        obsolete: item.status !== 'active',
        lastUpdatedAt: item.updatedAt?.toISOString(),
        tags: item.tags,
    };
}

export function createConsoleMemoryStore(ctx: AgentMemoryContext): MemoryStore {
    return {
        async get(sdkScope, options) {
            const scope = toConsoleScope(sdkScope);
            const scopeId = scopeIdFor(sdkScope, ctx);
            try {
                const { items } = await listMemoryItems(ctx.tenantDbName, ctx.tenantId, ctx.projectId, ctx.storeKey, {
                    scope,
                    scopeId,
                    status: options?.includeObsolete ? undefined : 'active',
                    limit: options?.limit ?? SCAN_LIMIT,
                });
                return items.map(toFact);
            } catch (error) {
                // A memory read failing must not fail the run — the agent still
                // answers, it just does so without recalled context this turn.
                logger.warn('Memory read failed', { storeKey: ctx.storeKey, scope, error: error instanceof Error ? error.message : String(error) });
                return [];
            }
        },

        async upsert(sdkScope, facts) {
            const scope = toConsoleScope(sdkScope);
            const scopeId = scopeIdFor(sdkScope, ctx);
            try {
                const { items: existing } = await listMemoryItems(ctx.tenantDbName, ctx.tenantId, ctx.projectId, ctx.storeKey, {
                    scope,
                    scopeId,
                    limit: SCAN_LIMIT,
                });
                const byKey = new Map(existing.filter((i) => typeof i.metadata?.factKey === 'string').map((i) => [i.metadata.factKey as string, i]));

                for (const fact of facts) {
                    const current = byKey.get(fact.key);
                    if (current) {
                        await updateMemoryItem(ctx.tenantDbName, ctx.tenantId, ctx.projectId, ctx.storeKey, String(current._id), {
                            content: fact.value,
                            importance: fact.confidence,
                            tags: fact.tags,
                            metadata: { factKey: fact.key, sourceTurn: fact.sourceTurn },
                            status: fact.obsolete ? 'archived' : 'active',
                        });
                    } else {
                        await addMemory(ctx.tenantDbName, ctx.tenantId, ctx.projectId, ctx.storeKey, {
                            content: fact.value,
                            scope,
                            scopeId,
                            tags: fact.tags,
                            importance: fact.confidence,
                            source: 'agent',
                            metadata: { factKey: fact.key, sourceTurn: fact.sourceTurn },
                        });
                    }
                }
            } catch (error) {
                logger.warn('Memory write failed', { storeKey: ctx.storeKey, scope, error: error instanceof Error ? error.message : String(error) });
            }
        },

        async markObsolete(sdkScope, keys) {
            const scope = toConsoleScope(sdkScope);
            const scopeId = scopeIdFor(sdkScope, ctx);
            try {
                const keySet = new Set(keys);
                const { items } = await listMemoryItems(ctx.tenantDbName, ctx.tenantId, ctx.projectId, ctx.storeKey, {
                    scope,
                    scopeId,
                    limit: SCAN_LIMIT,
                });
                for (const item of items) {
                    const factKey = item.metadata?.factKey;
                    if (typeof factKey === 'string' && keySet.has(factKey)) {
                        await updateMemoryItem(ctx.tenantDbName, ctx.tenantId, ctx.projectId, ctx.storeKey, String(item._id), {
                            status: 'archived',
                        });
                    }
                }
            } catch (error) {
                logger.warn('Memory markObsolete failed', { storeKey: ctx.storeKey, scope, error: error instanceof Error ? error.message : String(error) });
            }
        },

        async semanticSearch(sdkScope, query, options) {
            const scope = toConsoleScope(sdkScope);
            const scopeId = scopeIdFor(sdkScope, ctx);
            try {
                const result = await searchMemories(ctx.tenantDbName, ctx.tenantId, ctx.projectId, ctx.storeKey, {
                    query,
                    scope,
                    scopeId,
                    topK: options?.limit ?? 5,
                });
                return result.memories.map((match) =>
                    toFact({
                        _id: match.id,
                        content: match.content,
                        importance: match.importance,
                        tags: match.tags,
                        status: 'active',
                        metadata: match.metadata,
                    }),
                );
            } catch (error) {
                logger.warn('Memory semantic search failed', { storeKey: ctx.storeKey, scope, error: error instanceof Error ? error.message : String(error) });
                return [];
            }
        },
    };
}

/**
 * Builds the SDK's `SmartAgentMemoryConfig` for one run, or undefined when
 * memory is off / unconfigured. `scopeIds.session` is the conversation id —
 * a Session's memory is scoped to that conversation, not shared tenant-wide,
 * unless the operator picks a wider scope.
 */
export function buildAgentMemoryOption(
    memory: IAgentMemoryConfig | undefined,
    ctx: {
        tenantDbName: string;
        tenantId: string;
        projectId: string;
        agentKey: string;
        conversationId?: string;
        userId?: string;
    },
): SmartAgentMemoryConfig | undefined {
    if (!memory?.enabled || !memory.memoryStoreKey) return undefined;

    const store = createConsoleMemoryStore({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        storeKey: memory.memoryStoreKey,
        scopeIds: {
            session: ctx.conversationId,
            user: ctx.userId,
            workspace: ctx.agentKey,
        },
    });

    return {
        store,
        ...(memory.scope ? { scope: memory.scope } : {}),
        ...(memory.writePolicy ? { writePolicy: memory.writePolicy } : {}),
        ...(memory.readPolicy ? { readPolicy: memory.readPolicy } : {}),
    };
}
