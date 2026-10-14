import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createTool } from '@cognipeer/agent-sdk';
import type { MemoryFact, MemoryStore } from '@cognipeer/agent-sdk';
import { buildMemoryPromptSection, normalizeMemoryMounts } from '@/lib/services/agents/agentMemoryMounts';
import { buildMemoryTools, memoryToolDefinitions } from '@/lib/services/agents/agentMemoryTools';
import { buildAgentMemoryOption } from '@/lib/services/agents/agentMemoryAdapter';

const fact = (key: string): MemoryFact => ({ key, value: `v-${key}`, sourceTurn: 0, confidence: 1, obsolete: false });

function fakeStore(facts: MemoryFact[]) {
    const calls = { upsert: [] as unknown[], obsolete: [] as unknown[] };
    const store: MemoryStore = {
        get: async () => facts,
        upsert: async (_s, f) => { calls.upsert.push(f); },
        markObsolete: async (_s, k) => { calls.obsolete.push(k); },
        semanticSearch: async () => facts,
    };
    return { store, calls };
}

const guard = { protect: (_spec: unknown, fn: (a: Record<string, unknown>) => Promise<unknown>) => fn };
const run = async (tools: ReturnType<typeof buildMemoryTools>, name: string, args: Record<string, unknown>) =>
    (tools.find((t) => t.name === name) as unknown as { invoke: (a: unknown) => Promise<string> }).invoke(args);

function mk(mounts: { key: string; access: 'read_write' | 'read_only'; facts?: MemoryFact[] }[]) {
    const built = mounts.map((m) => ({ m, ...fakeStore(m.facts ?? []) }));
    const tools = buildMemoryTools({
        store: built[0].store, scope: 'workspace', createToolFn: createTool, zod: z, guard, allowWrites: true,
        mounts: built.map((b) => ({ key: b.m.key, access: b.m.access, scope: 'workspace' as const, store: b.store })),
    } as never);
    return { tools, built };
}

describe('normalizeMemoryMounts', () => {
    it('turns the legacy key into one read_write mount', () => {
        expect(normalizeMemoryMounts({ enabled: true, memoryStoreKey: 'a' })).toEqual([
            { storeKey: 'a', access: 'read_write', scope: 'workspace', legacy: true },
        ]);
    });
    it('mounts win over the legacy key, dedupe and cap', () => {
        const out = normalizeMemoryMounts({
            memoryStoreKey: 'legacy', scope: 'user',
            mounts: [{ storeKey: 'a', access: 'read_only', description: 'x' }, { storeKey: 'a' }, { storeKey: 'b', scope: 'tenant' }],
        });
        expect(out.map((m) => m.storeKey)).toEqual(['a', 'b']);
        expect(out[0]).toMatchObject({ access: 'read_only', description: 'x', scope: 'user', legacy: false });
        expect(out[1].scope).toBe('tenant');
        expect(normalizeMemoryMounts({ mounts: Array.from({ length: 9 }, (_, i) => ({ storeKey: `s${i}` })) })).toHaveLength(5);
    });
});

describe('buildMemoryPromptSection', () => {
    it('is empty for legacy configs and lists mounts otherwise', () => {
        expect(buildMemoryPromptSection({ enabled: true, memoryStoreKey: 'a' })).toBe('');
        const text = buildMemoryPromptSection({ enabled: true, mounts: [{ storeKey: 'kb', access: 'read_only', description: 'policies' }, { storeKey: 'notes' }] });
        expect(text).toContain('kb (read-only) — Use for: policies');
        expect(text).toContain('notes (read/write)');
    });
});

describe('buildMemoryTools with mounts', () => {
    it('merges search across stores and tags each fact', async () => {
        const { tools } = mk([{ key: 'a', access: 'read_write', facts: [fact('a1'), fact('a2')] }, { key: 'b', access: 'read_only', facts: [fact('b1')] }]);
        const out = JSON.parse(await run(tools, 'memory_search', { query: 'q', limit: 3 }));
        expect(out.map((f: { store: string; key: string }) => `${f.store}:${f.key}`)).toEqual(['a:a1', 'b:b1', 'a:a2']);
        const only = JSON.parse(await run(tools, 'memory_search', { query: 'q', store: 'b' }));
        expect(only).toHaveLength(1);
        expect(await run(tools, 'memory_search', { query: 'q', store: 'zzz' })).toContain('Unknown memory store');
    });
    it('routes writes by store and rejects read_only', async () => {
        const { tools, built } = mk([{ key: 'a', access: 'read_write' }, { key: 'b', access: 'read_write' }, { key: 'c', access: 'read_only' }]);
        expect(await run(tools, 'memory_write', { key: 'k', value: 'v' })).toContain('Specify "store"');
        expect(await run(tools, 'memory_write', { key: 'k', value: 'v', store: 'c' })).toContain('read-only');
        expect(await run(tools, 'memory_forget', { key: 'k', store: 'c' })).toContain('read-only');
        expect(await run(tools, 'memory_write', { key: 'k', value: 'v', store: 'b' })).toContain('Remembered');
        expect(built[1].calls.upsert).toHaveLength(1);
        expect(built[0].calls.upsert).toHaveLength(0);
        await run(tools, 'memory_forget', { key: 'k', store: 'a' });
        expect(built[0].calls.obsolete).toEqual([['k']]);
    });
    it('defaults to the single writable mount', async () => {
        const { tools, built } = mk([{ key: 'a', access: 'read_only' }, { key: 'b', access: 'read_write' }]);
        await run(tools, 'memory_write', { key: 'k', value: 'v' });
        expect(built[1].calls.upsert).toHaveLength(1);
    });
    it('single mount keeps the legacy schema', () => {
        const { tools } = mk([{ key: 'a', access: 'read_write' }]);
        const search = tools.find((t) => t.name === 'memory_search') as unknown as { schema: z.ZodObject<z.ZodRawShape> };
        expect(Object.keys(search.schema.shape)).toEqual(['query', 'limit']);
        expect(memoryToolDefinitions(true)[0].parameters).not.toHaveProperty('properties.store');
        expect(memoryToolDefinitions(true, ['a', 'b'])[0].parameters).toHaveProperty('properties.store');
    });
});

describe('buildAgentMemoryOption with mounts', () => {
    const ctx = { tenantDbName: 'd', tenantId: 't', projectId: 'p', agentKey: 'ag' };
    it('uses the first mount as primary; read_only primary forces manual writes', async () => {
        const opt = buildAgentMemoryOption({ enabled: true, writePolicy: 'always', mounts: [{ storeKey: 'a', access: 'read_only' }, { storeKey: 'b' }] }, ctx);
        expect(opt?.writePolicy).toBe('manual');
        await expect(opt!.store!.upsert('workspace', [fact('x')])).resolves.toBeUndefined();
        const rw = buildAgentMemoryOption({ enabled: true, writePolicy: 'always', mounts: [{ storeKey: 'a' }] }, ctx);
        expect(rw?.writePolicy).toBe('always');
    });
});
