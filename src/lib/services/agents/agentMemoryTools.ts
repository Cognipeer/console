/**
 * Memory as tools the agent can actually call.
 *
 * The SDK's own memory support is entirely out-of-band: `readMemoryFacts`
 * injects recalled facts as a `memory_context` system message before the model
 * call, and `persistLatestSummary` writes facts back only when a COMPACTION
 * produced a structured summary. It registers no tools at all. Two consequences
 * operators reliably trip over:
 *
 *  - The agent cannot look anything up. If the pre-injected slice missed the
 *    relevant fact, the fact may as well not exist for that turn.
 *  - A conversation that never grows past the summarization threshold writes
 *    nothing, however much it was told to remember. Short sessions read memory
 *    without ever adding to it — and `writePolicy: 'manual'` meant the agent
 *    never wrote at all, since there was no tool to write with.
 *
 * These tools close both gaps over the SAME console store the SDK path uses
 * (`createConsoleMemoryStore`), so a fact written by the tool is read by the
 * SDK's injection next turn and vice versa — one set of facts, two ways in.
 *
 * They go through the agent's tool guard like any other tool, so `tool.pre` /
 * `tool.post` guardrails see memory traffic too. That matters more here than
 * for most tools: memory is where a prompt-injected instruction would try to
 * plant something durable.
 */

import type { MemoryStore, ToolInterface as AgentSdkToolInterface } from '@cognipeer/agent-sdk';
import { createLogger } from '@/lib/core/logger';
import type { TraceToolDefinition } from '@/lib/services/tracingToolDefinitions';

const logger = createLogger('agent-memory-tools');

/** A memory store failure is answered with `fallback` (and logged), never thrown into the run. */
async function orFallback(event: string, fallback: string, run: () => Promise<string>): Promise<string> {
    try {
        return await run();
    } catch (error) {
        logger.warn(event, { error: error instanceof Error ? error.message : String(error) });
        return fallback;
    }
}

/** How many facts one `memory_search` may return, whatever the model asks for. */
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_SEARCH_LIMIT = 5;

export interface MemoryToolDeps {
    store: MemoryStore;
    /** The scope the agent's config selected — tools never widen it. */
    scope: 'session' | 'user' | 'workspace' | 'tenant';
    createToolFn: typeof import('@cognipeer/agent-sdk').createTool;
    zod: typeof import('zod').z;
    guard: {
        protect<A extends Record<string, unknown>, R>(
            spec: { name: string; requestedName: string },
            execute: (safeArgs: A) => Promise<R>,
        ): (args: A) => Promise<R | string>;
    };
    /** False drops the write/forget tools, leaving recall read-only. */
    allowWrites: boolean;
    /**
     * Mounted stores. Absent or a single entry = today's single-store schema
     * and behaviour (`store`/`scope` above). With several, the tools gain a
     * `store` argument and each mount carries its own scope.
     */
    mounts?: MemoryToolMount[];
}

export interface MemoryToolMount {
    key: string;
    access: 'read_write' | 'read_only';
    scope: 'session' | 'user' | 'workspace' | 'tenant';
    store: MemoryStore;
}

/**
 * Builds the memory toolset for one run.
 *
 * The scope is fixed from config rather than exposed as an argument: letting
 * the model choose would let one prompt move a fact from this session into the
 * tenant-wide store, which is a data-boundary decision an operator makes, not
 * a model.
 */
export function buildMemoryTools(deps: MemoryToolDeps): AgentSdkToolInterface[] {
    const { createToolFn, zod, guard, allowWrites } = deps;
    const mounts: MemoryToolMount[] = deps.mounts?.length
        ? deps.mounts
        : [{ key: 'default', access: 'read_write', scope: deps.scope, store: deps.store }];
    const multi = mounts.length > 1;
    const writable = mounts.filter((m) => m.access === 'read_write');
    const storeKeys = mounts.map((m) => m.key).join(', ');

    /** Resolves the `store` arg for a write; a string is a tool error returned to the model. */
    const pickWritable = (name: unknown): MemoryToolMount | string => {
        const wanted = typeof name === 'string' ? name.trim() : '';
        if (!wanted) {
            if (writable.length === 1) return writable[0];
            return `Specify "store": one of ${writable.map((m) => m.key).join(', ') || '(none writable)'}.`;
        }
        const mount = mounts.find((m) => m.key === wanted);
        if (!mount) return `Unknown memory store "${wanted}". Available: ${storeKeys}.`;
        if (mount.access !== 'read_write') return `Memory store "${wanted}" is read-only; it cannot be written to or forgotten from.`;
        return mount;
    };
    const storeArg: Record<string, import('zod').ZodTypeAny> = multi
        ? { store: zod.string().optional().describe(`Memory store key. One of: ${storeKeys}.`) }
        : {};
    const tools: AgentSdkToolInterface[] = [];

    tools.push(createToolFn({
        name: 'memory_search',
        description: [
            'Search what you remember about this user/conversation before answering.',
            'Use it when the question refers to something established earlier, to a preference,',
            'or to a fact you are not certain you were told in this conversation.',
            'Returns remembered facts, most relevant first; an empty list means nothing is stored.',
        ].join(' '),
        schema: zod.object({
            query: zod.string().describe('What to look for, in natural language.'),
            limit: zod.number().int().min(1).max(MAX_SEARCH_LIMIT).optional()
                .describe(`How many facts to return (default ${DEFAULT_SEARCH_LIMIT}).`),
            ...(multi ? { store: zod.string().optional().describe(`Limit the search to one store (${storeKeys}); omit to search all.`) } : {}),
        }),
        func: guard.protect(
            { name: 'agent.memory.search', requestedName: 'memory_search' },
            async (args: { query?: string; limit?: number; store?: string }) => {
                const limit = Math.min(args.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
                const query = typeof args.query === 'string' ? args.query.trim() : '';
                let targets = mounts;
                const only = typeof args.store === 'string' ? args.store.trim() : '';
                if (multi && only) {
                    const hit = mounts.find((m) => m.key === only);
                    if (!hit) return `Unknown memory store "${only}". Available: ${storeKeys}.`;
                    targets = [hit];
                }
                return orFallback('memory_search failed', 'Memory search is unavailable right now.', async () => {
                    // `semanticSearch` needs a query to embed; with none, the
                    // honest fallback is "the most recent facts", not an empty
                    // result the model would read as "nothing is remembered".
                    const perStore = await Promise.all(targets.map(async (m) => {
                        const facts = query && typeof m.store.semanticSearch === 'function'
                            ? await m.store.semanticSearch(m.scope, query, { limit })
                            : await m.store.get(m.scope, { limit });
                        return facts.map((fact) => ({ mount: m, fact }));
                    }));
                    // Facts carry no cross-store score, so merge by rank:
                    // each store's own relevance order, interleaved.
                    const merged: { mount: MemoryToolMount; fact: (typeof perStore)[number][number]['fact'] }[] = [];
                    for (let i = 0; merged.length < limit; i++) {
                        let any = false;
                        for (const list of perStore) {
                            if (i < list.length && merged.length < limit) { merged.push(list[i]); any = true; }
                        }
                        if (!any) break;
                    }
                    if (merged.length === 0) return 'No stored memory matched.';
                    return JSON.stringify(
                        merged.map(({ mount, fact }) => ({
                            ...(multi ? { store: mount.key } : {}),
                            key: fact.key,
                            value: fact.value,
                            confidence: fact.confidence,
                            updatedAt: fact.lastUpdatedAt,
                        })),
                    );
                });
            },
        ),
    }) as AgentSdkToolInterface);

    if (!allowWrites) return tools;

    tools.push(createToolFn({
        name: 'memory_write',
        description: [
            'Remember a durable fact so it survives into later turns and later sessions.',
            'Use it for stable things — a preference, an identifier, a decision that was made.',
            'Do NOT use it for the content of the current question, for anything the user asked you to forget,',
            'or for secrets such as passwords and tokens.',
            'Writing the same key again replaces what it held.',
        ].join(' '),
        schema: zod.object({
            key: zod.string().min(1).max(120)
                .describe('Short stable identifier, e.g. "preferred_language". Reusing a key overwrites it.'),
            value: zod.string().min(1).max(2000).describe('The fact itself, as one self-contained sentence.'),
            confidence: zod.number().min(0).max(1).optional()
                .describe('How sure you are, 0–1. Default 0.8.'),
            ...storeArg,
        }),
        func: guard.protect(
            { name: 'agent.memory.write', requestedName: 'memory_write' },
            async (args: { key?: string; value?: string; confidence?: number; store?: string }) => {
                const key = typeof args.key === 'string' ? args.key.trim() : '';
                const value = typeof args.value === 'string' ? args.value.trim() : '';
                if (!key || !value) return 'Both key and value are required.';
                const target = pickWritable(args.store);
                if (typeof target === 'string') return target;
                return orFallback('memory_write failed', 'Could not save that to memory.', async () => {
                    await target.store.upsert(target.scope, [{
                        key,
                        value,
                        sourceTurn: 0,
                        confidence: args.confidence ?? 0.8,
                        obsolete: false,
                        tags: ['agent_tool'],
                    }]);
                    return `Remembered "${key}".`;
                });
            },
        ),
    }) as AgentSdkToolInterface);

    tools.push(createToolFn({
        name: 'memory_forget',
        description: [
            'Mark a remembered fact obsolete, by its key, when it is wrong or the user asks you to forget it.',
            'Call memory_search first if you do not know the key.',
        ].join(' '),
        schema: zod.object({
            key: zod.string().min(1).describe('The key of the fact to forget.'),
            ...storeArg,
        }),
        func: guard.protect(
            { name: 'agent.memory.forget', requestedName: 'memory_forget' },
            async (args: { key?: string; store?: string }) => {
                const key = typeof args.key === 'string' ? args.key.trim() : '';
                if (!key) return 'A key is required.';
                const target = pickWritable(args.store);
                if (typeof target === 'string') return target;
                return orFallback('memory_forget failed', 'Could not update memory.', async () => {
                    await target.store.markObsolete(target.scope, [key]);
                    return `Forgot "${key}".`;
                });
            },
        ),
    }) as AgentSdkToolInterface);

    return tools;
}

/**
 * Trace-menu entries mirroring the zod schemas above, so a trace lists the
 * memory tools alongside every other tool the run could call rather than
 * leaving three unexplained names in the timeline.
 */
export function memoryToolDefinitions(allowWrites: boolean, storeKeys: string[] = []): TraceToolDefinition[] {
    const definitions: TraceToolDefinition[] = [{
        name: 'memory_search',
        description: 'Search stored memory for facts about this user/conversation.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'What to look for, in natural language.' },
                limit: { type: 'number', description: `How many facts to return (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).` },
            },
            required: ['query'],
        },
    }];

    const storeProp = storeKeys.length > 1
        ? { store: { type: 'string', description: `Memory store key. One of: ${storeKeys.join(', ')}.` } }
        : {};
    (definitions[0].parameters as { properties: Record<string, unknown> }).properties = {
        ...(definitions[0].parameters as { properties: Record<string, unknown> }).properties,
        ...storeProp,
    };

    if (!allowWrites) return definitions;

    definitions.push(
        {
            name: 'memory_write',
            description: 'Store a durable fact under a stable key; reusing a key overwrites it.',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'Short stable identifier.' },
                    value: { type: 'string', description: 'The fact, as one self-contained sentence.' },
                    confidence: { type: 'number', description: 'How sure you are, 0–1. Default 0.8.' },
                    ...storeProp,
                },
                required: ['key', 'value'],
            },
        },
        {
            name: 'memory_forget',
            description: 'Mark a stored fact obsolete by its key.',
            parameters: {
                type: 'object',
                properties: { key: { type: 'string', description: 'The key of the fact to forget.' }, ...storeProp },
                required: ['key'],
            },
        },
    );

    return definitions;
}
