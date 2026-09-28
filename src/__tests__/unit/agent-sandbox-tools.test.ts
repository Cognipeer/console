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
    /** Machines the sandbox module's idle reaper has already closed. */
    const closed = new Set<string>();
    const runner: AgentSandboxRunner = {
        listTemplates: async () => [{ key: 'multi-base', name: 'Multi base' }],
        ensureInstance: async (...args) => {
            calls.push({ op: 'ensureInstance', args });
            const reuse = args[1].instanceId;
            return reuse && !closed.has(reuse) ? { instanceId: reuse, created: false } : { instanceId: `sbx-${++seq}`, created: true };
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
        previewLink: async (...args) => {
            calls.push({ op: 'previewLink', args });
            const input = args[2];
            return input.public
                ? { url: `https://console.test/api/sandbox/preview/tok-${input.port}/`, public: true, expiresAt: '2026-09-25T00:00:00.000Z', listening: input.port !== 9999 }
                : { url: `https://console.test/api/sandbox/instances/${args[1]}/preview/${input.port}/`, public: false, listening: true };
        },
        stop: async (...args) => { calls.push({ op: 'stop', args }); },
        destroy: async (...args) => { calls.push({ op: 'destroy', args }); },
    };
    return { runner, calls, closed, ops: () => calls.map((c) => c.op) };
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

describe('session sandbox', () => {
    it('is the default: one machine per conversation, left running between turns and reused by the next', async () => {
        conversations.set('conv-1', { _id: 'conv-1', metadata: { runtimeContext: { a: 1 } } });
        const conversation = { _id: 'conv-1', metadata: { runtimeContext: { a: 1 } } };

        const first = await build({ enabled: true }, { conversation });
        await first.byName('sandbox_exec').invoke({ command: 'pip install pandas' });
        await first.cleanup();

        const stored = conversations.get('conv-1')!.metadata as Record<string, any>;
        expect(stored.sandbox).toMatchObject({ instanceId: 'sbx-1', lifecycle: 'session' });
        // Other metadata survives the write.
        expect(stored.runtimeContext).toEqual({ a: 1 });

        const second = await build({ enabled: true }, { conversation });
        await second.byName('sandbox_exec').invoke({ command: 'python -c "import pandas"' });
        await second.cleanup();

        // Never stopped, never deleted: the sandbox module closes it once idle.
        expect(fake.ops()).toEqual(['ensureInstance', 'exec', 'ensureInstance', 'exec']);
        // Not a persistent machine — a stop of one is a full close, and the idle reaper applies.
        expect(fake.calls[0].args[1]).toMatchObject({ persist: false });
        expect(fake.calls[2].args[1]).toMatchObject({ persist: false, instanceId: 'sbx-1' });
        expect((fake.calls[0].args[0] as { conversationId: string }).conversationId).toBe('conv-1');
    });

    it('records the machine as soon as it exists, not only when the run ends', async () => {
        conversations.set('conv-1', { _id: 'conv-1', metadata: {} });
        const { byName } = await build({ enabled: true }, { conversation: { _id: 'conv-1' } });
        await byName('sandbox_exec').invoke({ command: 'ls' });
        // No cleanup: the process died mid-run. The next turn must still find it.
        expect((conversations.get('conv-1')!.metadata as Record<string, any>).sandbox.instanceId).toBe('sbx-1');
    });

    it('the persist mode of earlier versions is read as session', async () => {
        conversations.set('conv-1', { _id: 'conv-1', metadata: {} });
        const { byName, cleanup } = await build({ enabled: true, mode: 'persist' }, { conversation: { _id: 'conv-1' } });
        await byName('sandbox_exec').invoke({ command: 'ls' });
        await cleanup();
        expect(fake.ops()).toEqual(['ensureInstance', 'exec']);
    });

    it('starts a fresh machine when the recorded one was closed by the idle reaper', async () => {
        conversations.set('conv-1', {
            _id: 'conv-1',
            metadata: { sandbox: { instanceId: 'sbx-gone', lifecycle: 'session', createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: '2026-09-01T00:00:00.000Z' } },
        });
        fake.closed.add('sbx-gone');
        const { byName, cleanup } = await build({ enabled: true }, { conversation: { _id: 'conv-1' } });
        await byName('sandbox_exec').invoke({ command: 'ls' });
        await cleanup();

        expect(fake.calls[0].args[1]).toMatchObject({ instanceId: 'sbx-gone' });
        // The record now points at the new machine, with a new birth date.
        const record = (conversations.get('conv-1')!.metadata as Record<string, any>).sandbox;
        expect(record.instanceId).toBe('sbx-1');
        expect(record.createdAt).not.toBe('2026-09-01T00:00:00.000Z');
    });

    it('replaces a machine made under the old persist mode instead of adopting it', async () => {
        conversations.set('conv-2', {
            _id: 'conv-2',
            metadata: { sandbox: { instanceId: 'sbx-old', createdAt: '2026-09-24T00:00:00.000Z', lastUsedAt: '2026-09-24T00:00:00.000Z' } },
        });
        const { byName } = await build({ enabled: true }, { conversation: { _id: 'conv-2' } });
        await byName('sandbox_list_files').invoke({});
        // A persistent machine is exempt from the idle reaper — adopting it would leave it running forever.
        expect(fake.ops().slice(0, 2)).toEqual(['destroy', 'ensureInstance']);
        expect(fake.calls[0].args[1]).toBe('sbx-old');
        expect((fake.calls[1].args[1] as { instanceId?: string }).instanceId).toBeUndefined();
    });

    it('replaces the machine when the agent now wants another template', async () => {
        conversations.set('conv-4', {
            _id: 'conv-4',
            metadata: { sandbox: { instanceId: 'sbx-py', templateKey: 'py', lifecycle: 'session', createdAt: 'x', lastUsedAt: 'x' } },
        });
        const { byName } = await build({ enabled: true, templateKey: 'node' }, { conversation: { _id: 'conv-4' } });
        await byName('sandbox_list_files').invoke({});
        expect(fake.ops().slice(0, 2)).toEqual(['destroy', 'ensureInstance']);
        expect(fake.calls[0].args[1]).toBe('sbx-py');
    });

    it('without a conversation, it lasts one message', async () => {
        const { byName, cleanup } = await build({ enabled: true });
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

describe('per-message sandbox on a conversation', () => {
    it('is deleted when the reply is done, and nothing is recorded on the conversation', async () => {
        conversations.set('conv-5', { _id: 'conv-5', metadata: { keep: true } });
        const { byName, cleanup } = await build({ enabled: true, mode: 'ephemeral' }, { conversation: { _id: 'conv-5' } });
        await byName('sandbox_exec').invoke({ command: 'ls' });
        await cleanup();

        expect(fake.ops()).toEqual(['ensureInstance', 'exec', 'destroy']);
        expect((fake.calls[0].args[0] as { conversationId?: string }).conversationId).toBeUndefined();
        expect(conversations.get('conv-5')!.metadata).toEqual({ keep: true });
    });
});

describe('preview', () => {
    it('no preview tool unless preview is enabled', async () => {
        expect((await build({ enabled: true })).tools.map((t: { name: string }) => t.name)).not.toContain('sandbox_preview_link');
        expect((await build({ enabled: true, preview: { enabled: true } })).tools.map((t: { name: string }) => t.name)).toContain('sandbox_preview_link');
    });

    it('provisions the machine with the preview flags and an idle stop', async () => {
        const { byName } = await build({ enabled: true, preview: { enabled: true, public: true, keepAliveMinutes: 45 } });
        await byName('sandbox_exec').invoke({ command: 'ls' });
        expect(fake.calls[0].args[1]).toMatchObject({ preview: { enabled: true, public: true }, idleStopSeconds: 2700 });
    });

    it('issues a public link with the configured lifetime and keeps an ephemeral machine alive after the reply', async () => {
        const { byName, cleanup } = await build({ enabled: true, preview: { enabled: true, public: true, linkTtlHours: 2 } });
        const link = await byName('sandbox_preview_link').invoke({ port: 8000 }) as Record<string, unknown>;
        await cleanup();
        expect(link).toMatchObject({ public: true, url: 'https://console.test/api/sandbox/preview/tok-8000/' });
        expect(fake.calls.find((c) => c.op === 'previewLink')!.args[2]).toEqual({ port: 8000, public: true, ttlSeconds: 7200 });
        // Not destroyed: the link would die with it. The reaper stops it once idle.
        expect(fake.ops()).not.toContain('destroy');
    });

    it('a session machine with a live preview is kept and recorded, and stops itself once idle', async () => {
        conversations.set('conv-p', { _id: 'conv-p', metadata: {} });
        const { byName, cleanup } = await build({ enabled: true, mode: 'session', preview: { enabled: true } }, { conversation: { _id: 'conv-p' } });
        await byName('sandbox_preview_link').invoke({ port: 3000 });
        await cleanup();
        expect(fake.ops()).not.toContain('destroy');
        expect(fake.calls[0].args[1]).toMatchObject({ idleStopSeconds: 1800 });
        expect((conversations.get('conv-p')!.metadata as Record<string, any>).sandbox.instanceId).toBe('sbx-1');
    });

    it('without a link the usual cleanup applies', async () => {
        const { byName, cleanup } = await build({ enabled: true, preview: { enabled: true } });
        await byName('sandbox_exec').invoke({ command: 'ls' });
        await cleanup();
        expect(fake.ops()).toContain('destroy');
    });

    it('warns the agent when nothing listens on the port yet', async () => {
        const { byName } = await build({ enabled: true, preview: { enabled: true, public: true } });
        const link = await byName('sandbox_preview_link').invoke({ port: 9999 }) as Record<string, unknown>;
        expect(String(link.warning)).toMatch(/Nothing answered on port 9999/);
    });
});
