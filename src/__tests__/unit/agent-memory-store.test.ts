/**
 * Unit tests — an agent uses ONE memory store. Configs saved while agents
 * could mount several stores still run on their first one, in the namespace
 * they wrote to, and the panel saves them as a single store.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { createTool } from '@cognipeer/agent-sdk';
import type { MemoryStore } from '@cognipeer/agent-sdk';

const mocks = vi.hoisted(() => ({
    getMemoryStore: vi.fn(),
    listMemoryItems: vi.fn(),
    addMemory: vi.fn(),
    updateMemoryItem: vi.fn(),
    searchMemories: vi.fn(),
}));

vi.mock('@/lib/services/memory/memoryService', () => mocks);

import { resolveAgentMemoryStore, toSingleStoreMemoryConfig } from '@/lib/services/agents/agentMemoryStore';
import { buildAgentMemoryOption } from '@/lib/services/agents/agentMemoryAdapter';
import { buildMemoryTools, memoryToolDefinitions } from '@/lib/services/agents/agentMemoryTools';
import { validateAgentConfigShape } from '@/lib/services/agents/agentConfigValidation';
import type { IAgentConfig, IAgentMemoryConfig } from '@/lib/database/provider/types.domain';

const ctx = { tenantDbName: 'd', tenantId: 't', projectId: 'p', agentKey: 'ag' };

/** The scopeId the store queried with, for one read in `workspace` scope. */
async function workspaceScopeId(memory: IAgentMemoryConfig): Promise<unknown> {
    const opt = buildAgentMemoryOption(memory, ctx);
    await opt!.store!.get('workspace');
    return mocks.listMemoryItems.mock.calls.at(-1)?.[4]?.scopeId;
}

describe('resolveAgentMemoryStore', () => {
    it('a single store key is this agent\'s, in workspace scope unless one is picked', () => {
        expect(resolveAgentMemoryStore({ enabled: true, memoryStoreKey: 'a' })).toEqual({
            storeKey: 'a', scope: 'workspace', readOnly: false, sharedWorkspace: false, ignoredStoreKeys: [],
        });
        expect(resolveAgentMemoryStore({ memoryStoreKey: 'a', scope: 'user', sharedWorkspace: true })).toMatchObject({
            scope: 'user', sharedWorkspace: true,
        });
    });

    it('no store, or nulls a Mongo save left behind, is no store', () => {
        expect(resolveAgentMemoryStore(undefined)).toBeUndefined();
        expect(resolveAgentMemoryStore({ enabled: true })).toBeUndefined();
        expect(resolveAgentMemoryStore({ enabled: true, memoryStoreKey: '  ' })).toBeUndefined();
        expect(resolveAgentMemoryStore({ enabled: true, memoryStoreKey: null, mounts: null } as never)).toBeUndefined();
        expect(resolveAgentMemoryStore({ enabled: true, memoryStoreKey: 'a', mounts: null } as never)?.storeKey).toBe('a');
    });

    it('a former mounts config runs on its first mount, shared project-wide, and lists the rest as ignored', () => {
        const resolved = resolveAgentMemoryStore({
            enabled: true,
            memoryStoreKey: 'legacy',
            scope: 'user',
            mounts: [{ storeKey: 'a', access: 'read_only', scope: 'tenant' }, { storeKey: 'b' }, { storeKey: 'a' }, { storeKey: 'b' }],
        });
        expect(resolved).toEqual({ storeKey: 'a', scope: 'tenant', readOnly: true, sharedWorkspace: true, ignoredStoreKeys: ['b'] });
        expect(resolveAgentMemoryStore({ scope: 'user', mounts: [{ storeKey: 'a' }] })).toMatchObject({ scope: 'user', readOnly: false });
    });
});

describe('toSingleStoreMemoryConfig', () => {
    it('leaves a single-store config as it is', () => {
        const memory: IAgentMemoryConfig = { enabled: true, memoryStoreKey: 'a', scope: 'user' };
        expect(toSingleStoreMemoryConfig(memory)).toBe(memory);
    });

    it('keeps the first mount as the store, its scope, and the project-wide workspace it wrote to', () => {
        const next = toSingleStoreMemoryConfig({ enabled: true, writePolicy: 'always', mounts: [{ storeKey: 'a', description: 'x' }, { storeKey: 'b' }] });
        expect(next).toEqual({ enabled: true, writePolicy: 'always', memoryStoreKey: 'a', mounts: undefined, scope: 'workspace', sharedWorkspace: true });
        expect(resolveAgentMemoryStore(next)).toMatchObject({ storeKey: 'a', sharedWorkspace: true, ignoredStoreKeys: [] });
    });

    it('only workspace scope needs the shared namespace', () => {
        const next = toSingleStoreMemoryConfig({ mounts: [{ storeKey: 'a', scope: 'user' }] });
        expect(next.sharedWorkspace).toBeUndefined();
        expect(next.scope).toBe('user');
    });

    it('a read-only first mount becomes manual writes and search-only tools', () => {
        expect(toSingleStoreMemoryConfig({ writePolicy: 'always', tools: 'readwrite', mounts: [{ storeKey: 'a', access: 'read_only' }] }))
            .toMatchObject({ writePolicy: 'manual', tools: 'read' });
        expect(toSingleStoreMemoryConfig({ tools: 'off', mounts: [{ storeKey: 'a', access: 'read_only' }] }).tools).toBe('off');
    });
});

describe('buildAgentMemoryOption', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getMemoryStore.mockResolvedValue({ key: 'a', status: 'active' });
        mocks.listMemoryItems.mockResolvedValue({ items: [], total: 0 });
    });

    it('is undefined when memory is off or has no store', () => {
        expect(buildAgentMemoryOption({ enabled: false, memoryStoreKey: 'a' }, ctx)).toBeUndefined();
        expect(buildAgentMemoryOption({ enabled: true }, ctx)).toBeUndefined();
    });

    it('workspace is this agent for a single store key, the project for a shared or former mounts config', async () => {
        expect(await workspaceScopeId({ enabled: true, memoryStoreKey: 'a' })).toBe('ag');
        expect(await workspaceScopeId({ enabled: true, memoryStoreKey: 'a', sharedWorkspace: true })).toBe('p');
        expect(await workspaceScopeId({ enabled: true, mounts: [{ storeKey: 'a' }] })).toBe('p');
        // What the panel saves for that former mounts config reads the same facts.
        expect(await workspaceScopeId({ enabled: true, ...toSingleStoreMemoryConfig({ mounts: [{ storeKey: 'a' }] }) })).toBe('p');
    });

    it('passes scope and policies to the SDK', () => {
        expect(buildAgentMemoryOption({ enabled: true, memoryStoreKey: 'a', writePolicy: 'always', readPolicy: 'semantic' }, ctx))
            .toMatchObject({ scope: 'workspace', writePolicy: 'always', readPolicy: 'semantic' });
    });

    it('a read-only first mount is never written by the SDK path', async () => {
        const opt = buildAgentMemoryOption({ enabled: true, writePolicy: 'always', mounts: [{ storeKey: 'a', access: 'read_only' }, { storeKey: 'b' }] }, ctx);
        expect(opt?.writePolicy).toBe('manual');
        await opt!.store!.upsert('workspace', [{ key: 'k', value: 'v', sourceTurn: 0, confidence: 1, obsolete: false }]);
        expect(mocks.addMemory).not.toHaveBeenCalled();
        expect(mocks.getMemoryStore).not.toHaveBeenCalledWith('d', 't', 'p', 'b');
    });
});

describe('validateAgentConfigShape', () => {
    const issues = (memory: IAgentMemoryConfig) => validateAgentConfigShape({ memory } as IAgentConfig);

    it('needs a store when memory is on', () => {
        expect(issues({ enabled: true }).errors.map((e) => e.field)).toContain('memory.memoryStoreKey');
        expect(issues({ enabled: true, mounts: [{ storeKey: 'a' }] }).errors.map((e) => e.field)).not.toContain('memory.memoryStoreKey');
    });

    it('warns, not fails, about stores a former mounts config no longer uses', () => {
        const result = issues({ enabled: true, mounts: [{ storeKey: 'a' }, { storeKey: 'b' }, { storeKey: 'c' }] });
        expect(result.errors.filter((e) => e.field.startsWith('memory'))).toEqual([]);
        expect(result.warnings).toContainEqual({ field: 'memory.mounts', message: expect.stringContaining('"b", "c"') });
    });
});

describe('memory tools', () => {
    const store: MemoryStore = { get: async () => [], upsert: async () => undefined, markObsolete: async () => undefined };
    const guard = { protect: (_spec: unknown, fn: (a: Record<string, unknown>) => Promise<unknown>) => fn };

    it('take no store argument', () => {
        const tools = buildMemoryTools({ store, scope: 'workspace', createToolFn: createTool, zod: z, guard, allowWrites: true } as never);
        const search = tools.find((t) => t.name === 'memory_search') as unknown as { schema: z.ZodObject<z.ZodRawShape> };
        const write = tools.find((t) => t.name === 'memory_write') as unknown as { schema: z.ZodObject<z.ZodRawShape> };
        expect(Object.keys(search.schema.shape)).toEqual(['query', 'limit']);
        expect(Object.keys(write.schema.shape)).not.toContain('store');
        expect(memoryToolDefinitions(true).map((d) => d.parameters)).not.toContainEqual(expect.objectContaining({ properties: expect.objectContaining({ store: expect.anything() }) }));
    });
});
