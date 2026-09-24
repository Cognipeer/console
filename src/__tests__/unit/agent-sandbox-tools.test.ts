/**
 * Sandbox access for agents: what gets bound, when a machine is provisioned,
 * how secrets travel, and what happens to the machine when the run ends.
 *
 * The runner is the enterprise seam; here it is a recording fake. The license
 * check is mocked per test — the gate itself is the point of several cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { createTool } from '@cognipeer/agent-sdk';

const licensed = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/license/tenantLicense', () => ({
    isTenantEnterpriseLicensed: vi.fn(async () => licensed.value),
}));

const conversations = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock('@/lib/database', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/database')>();
    return {
        ...actual,
        getDatabase: vi.fn(async () => ({
            switchToTenant: vi.fn(),
            findAgentConversationById: vi.fn(async (id: string) => conversations.get(id) ?? null),
            updateAgentConversation: vi.fn(async (id: string, data: Record<string, unknown>) => {
                conversations.set(id, { ...(conversations.get(id) ?? {}), ...data });
                return conversations.get(id);
            }),
        })),
    };
});

import { agentSandboxRunner, type AgentSandboxRunner } from '@/enterprise/registry';
import { buildAgentSandboxTools, destroyConversationSandbox } from '@/lib/services/agents/agentSandboxTools';
import { sealAgentSandboxConfig } from '@/lib/services/agents/agentSandboxSecrets';
import type { IAgentSandboxConfig } from '@/lib/database';

function fakeRunner() {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    let seq = 0;
    const runner: AgentSandboxRunner = {
        listTemplates: async () => [{ key: 'multi-base', name: 'Multi base' }],
        ensureInstance: async (...args) => {
            calls.push({ op: 'ensureInstance', args });
            const reuse = args[1].instanceId;
            return reuse ? { instanceId: reuse, created: false } : { instanceId: `sbx-${++seq}`, created: true };
        },
        exec: async (...args) => {
            calls.push({ op: 'exec', args });
            const env = args[2].env ?? {};
            return { exitCode: 0, stdout: `token=${env.API_TOKEN ?? ''}\nok`, stderr: '' };
        },
        runCode: async (...args) => {
            calls.push({ op: 'runCode', args });
            return { exitCode: 0, stdout: '42', stderr: '' };
        },
        readFile: async (...args) => { calls.push({ op: 'readFile', args }); return 'file body'; },
        writeFile: async (...args) => { calls.push({ op: 'writeFile', args }); },
        listFiles: async (...args) => { calls.push({ op: 'listFiles', args }); return []; },
        stop: async (...args) => { calls.push({ op: 'stop', args }); },
        destroy: async (...args) => { calls.push({ op: 'destroy', args }); },
    };
    return { runner, calls, ops: () => calls.map((c) => c.op) };
}

const passthroughProtect = (_name: string, tool: unknown) => tool;

async function build(sandbox: IAgentSandboxConfig | undefined, extra: Partial<Parameters<typeof buildAgentSandboxTools>[0]> = {}) {
    const warnings: string[] = [];
    const result = await buildAgentSandboxTools({
        sandbox,
        tenantDbName: 'tenant_acme',
        tenantId: 't1',
        projectId: 'p1',
        agentKey: 'builder',
        createToolFn: createTool,
        zod: z,
        protect: passthroughProtect,
        onWarning: (message) => warnings.push(message),
        ...extra,
    });
    const byName = (name: string) => result.tools.find((tool: { name: string }) => tool.name === name) as {
        invoke: (args: Record<string, unknown>) => Promise<unknown>;
    };
    return { ...result, warnings, byName };
}

let fake: ReturnType<typeof fakeRunner>;
beforeEach(() => {
    licensed.value = true;
    conversations.clear();
    fake = fakeRunner();
    agentSandboxRunner.current = fake.runner;
});
afterEach(() => {
    agentSandboxRunner.current = null;
});

describe('which tools an agent gets', () => {
    it('binds nothing when sandbox access is off', async () => {
        const { tools, warnings } = await build({ enabled: false, templateKey: 'multi-base' });
        expect(tools).toHaveLength(0);
        expect(warnings).toEqual([]);
    });

    it('binds all five tools by default, and only the enabled groups otherwise', async () => {
        expect((await build({ enabled: true })).tools.map((t: { name: string }) => t.name)).toEqual([
            'sandbox_exec', 'sandbox_run_code', 'sandbox_read_file', 'sandbox_write_file', 'sandbox_list_files',
        ]);
        expect((await build({ enabled: true, tools: { exec: false, files: false } })).tools.map((t: { name: string }) => t.name))
            .toEqual(['sandbox_run_code']);
    });

    it('LICENSE: an unlicensed tenant gets no sandbox tools, and the run is told why', async () => {
        licensed.value = false;
        const { tools, warnings } = await build({ enabled: true });
        expect(tools).toHaveLength(0);
        expect(warnings[0]).toMatch(/Enterprise license/);
        expect(fake.calls).toHaveLength(0);
    });

    it('a community build (no sandbox module) gets no tools and a warning', async () => {
        agentSandboxRunner.current = null;
        const { tools, warnings } = await build({ enabled: true });
        expect(tools).toHaveLength(0);
        expect(warnings[0]).toMatch(/no sandbox module/);
    });
});

describe('ephemeral sandbox', () => {
    it('provisions nothing until the model uses a sandbox tool', async () => {
        const { cleanup } = await build({ enabled: true });
        await cleanup();
        expect(fake.calls).toHaveLength(0);
    });

    it('provisions once, runs with the configured timeout, and deletes the machine at the end', async () => {
        const { byName, cleanup } = await build({ enabled: true, templateKey: 'py', commandTimeoutSec: 120, blockNetwork: true });
        await byName('sandbox_exec').invoke({ command: 'ls' });
        await byName('sandbox_run_code').invoke({ language: 'python', code: 'print(42)' });
        await cleanup();

        expect(fake.ops()).toEqual(['ensureInstance', 'exec', 'runCode', 'destroy']);
        const [ref, spec] = fake.calls[0].args as [Record<string, unknown>, Record<string, unknown>];
        expect(spec).toMatchObject({ templateKey: 'py', persist: false, blockNetwork: true });
        expect(ref.conversationId).toBeUndefined();
        expect((fake.calls[1].args[2] as { timeoutSec: number }).timeoutSec).toBe(120);
    });

    it('resolves relative paths under /workspace', async () => {
        const { byName } = await build({ enabled: true });
        await byName('sandbox_write_file').invoke({ path: 'src/app.py', content: 'x' });
        await byName('sandbox_read_file').invoke({ path: '/etc/hosts' });
        expect(fake.calls[1].args[2]).toBe('/workspace/src/app.py');
        expect(fake.calls[2].args[2]).toBe('/etc/hosts');
    });
});

describe('secrets', () => {
    it('are passed to each command as env — not on the instance — and masked in the output', async () => {
        const sandbox = sealAgentSandboxConfig({ enabled: true, env: { MODE: 'ci' }, secrets: { API_TOKEN: 's3cr3t-value' } }, undefined)!;
        expect(JSON.stringify(sandbox)).not.toContain('s3cr3t-value');

        const { byName } = await build(sandbox);
        const out = await byName('sandbox_exec').invoke({ command: 'echo $API_TOKEN' }) as { stdout: string };

        const spec = fake.calls[0].args[1] as { env?: Record<string, string> };
        expect(spec.env).toEqual({ MODE: 'ci' });
        expect((fake.calls[1].args[2] as { env: Record<string, string> }).env).toEqual({ API_TOKEN: 's3cr3t-value' });
        expect(out.stdout).not.toContain('s3cr3t-value');
        expect(out.stdout).toContain('••••••');
    });
});

describe('persistent sandbox', () => {
    it('keeps one machine per conversation: stopped between turns, reused on the next', async () => {
        conversations.set('conv-1', { _id: 'conv-1', metadata: { runtimeContext: { a: 1 } } });
        const conversation = { _id: 'conv-1', metadata: { runtimeContext: { a: 1 } } };

        const first = await build({ enabled: true, mode: 'persist' }, { conversation });
        await first.byName('sandbox_exec').invoke({ command: 'pip install pandas' });
        await first.cleanup();

        const stored = conversations.get('conv-1')!.metadata as Record<string, any>;
        expect(stored.sandbox.instanceId).toBe('sbx-1');
        // Other metadata survives the write.
        expect(stored.runtimeContext).toEqual({ a: 1 });

        const second = await build({ enabled: true, mode: 'persist' }, { conversation });
        await second.byName('sandbox_exec').invoke({ command: 'python -c "import pandas"' });
        await second.cleanup();

        expect(fake.ops()).toEqual(['ensureInstance', 'exec', 'stop', 'ensureInstance', 'exec', 'stop']);
        expect(fake.calls[3].args[1]).toMatchObject({ persist: true, instanceId: 'sbx-1' });
        expect((fake.calls[0].args[0] as { conversationId: string }).conversationId).toBe('conv-1');
    });

    it('replaces a sandbox unused for longer than the retention window', async () => {
        const old = new Date(Date.now() - 5 * 3_600_000).toISOString();
        conversations.set('conv-2', {
            _id: 'conv-2',
            metadata: { sandbox: { instanceId: 'sbx-old', createdAt: old, lastUsedAt: old } },
        });
        const { byName } = await build({ enabled: true, mode: 'persist', retentionHours: 2 }, { conversation: { _id: 'conv-2' } });
        await byName('sandbox_list_files').invoke({});
        expect(fake.ops().slice(0, 2)).toEqual(['destroy', 'ensureInstance']);
        expect(fake.calls[0].args[1]).toBe('sbx-old');
        expect((fake.calls[1].args[1] as { instanceId?: string }).instanceId).toBeUndefined();
    });

    it('without a conversation, persist falls back to a throwaway sandbox', async () => {
        const { byName, cleanup } = await build({ enabled: true, mode: 'persist' });
        await byName('sandbox_exec').invoke({ command: 'ls' });
        await cleanup();
        expect(fake.calls[0].args[1]).toMatchObject({ persist: false });
        expect(fake.ops()).toContain('destroy');
    });

    it('deleting the conversation deletes its sandbox', async () => {
        await destroyConversationSandbox({
            tenantDbName: 'tenant_acme',
            tenantId: 't1',
            conversation: { _id: 'conv-3', agentKey: 'builder', projectId: 'p1', metadata: { sandbox: { instanceId: 'sbx-9' } } },
        });
        expect(fake.calls).toEqual([{ op: 'destroy', args: [expect.objectContaining({ conversationId: 'conv-3' }), 'sbx-9'] }]);
    });
});
