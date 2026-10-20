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
/** Config rows behind `sandbox.envRefs / secretRefs / groupRefs` (values are stored plain here, see the configService mock). */
const configRows = vi.hoisted(() => ({
    items: [] as Array<{ _id: string; key: string; value: string; isSecret: boolean; groupId: string; projectId: string; version: number }>,
    groups: [] as Array<{ _id: string; key: string; projectId: string }>,
    audit: [] as Array<Record<string, unknown>>,
}));
vi.mock('@/lib/services/config/configService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/services/config/configService')>();
    return { ...actual, openConfigItemValue: (item: { value: string }) => item.value };
});
vi.mock('@/lib/database', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/database')>();
    const getDatabase = vi.fn(async () => ({
            switchToTenant: vi.fn(),
            findConfigItemById: vi.fn(async (id: string) => configRows.items.find((i) => i._id === id) ?? null),
            findConfigGroupById: vi.fn(async (id: string) => configRows.groups.find((g) => g._id === id) ?? null),
            listConfigItems: vi.fn(async (f: { groupId?: string }) => configRows.items.filter((i) => !f.groupId || i.groupId === f.groupId)),
            createConfigAuditLog: vi.fn(async (entry: Record<string, unknown>) => { configRows.audit.push(entry); return entry; }),
            findAgentConversationById: vi.fn(async (id: string) => conversations.get(id) ?? null),
            updateAgentConversation: vi.fn(async (id: string, data: Record<string, unknown>) => {
                conversations.set(id, { ...(conversations.get(id) ?? {}), ...data });
                return conversations.get(id);
            }),
        }));
    return {
        ...actual,
        getDatabase,
        // The real one would open its own (unmocked) connection.
        runWithTenantScope: async (_name: string, fn: (db: Awaited<ReturnType<typeof getDatabase>>) => unknown) => fn(await getDatabase()),
    };
});

const downloaded = vi.hoisted(() => ({ files: new Map<string, Uint8Array>() }));
vi.mock('@/lib/services/files', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/services/files')>();
    return { ...actual, downloadFile: vi.fn(async (_db: string, _t: string, _p: string, _bucket: string, key: string) => ({ data: downloaded.files.get(key) })) };
});

const savedOutputs = vi.hoisted(() => [] as Array<{ fileName: string; data: Buffer }>);
vi.mock('@/lib/services/agents/sessionFiles', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/services/agents/sessionFiles')>();
    return {
        ...actual,
        saveAgentOutputFile: vi.fn(async (input: { fileName: string; data: Buffer }) => {
            savedOutputs.push({ fileName: input.fileName, data: input.data });
            return { fileId: `f_${input.fileName}`, name: input.fileName, mimeType: 'text/plain', size: input.data.length, origin: 'agent_output' };
        }),
    };
});

import { agentSandboxRunner, type AgentSandboxRunner } from '@/enterprise/registry';
import { runWithTurnSignal } from '@/lib/core/turnSignal';
import { buildAgentSandboxTools, destroyConversationSandbox } from '@/lib/services/agents/agentSandboxTools';
import { AGENT_SANDBOX_SECRET_MASK, sealAgentSandboxConfig } from '@/lib/services/agents/agentSandboxSecrets';
import { buildReadTool } from '@/lib/services/agents/readTool';
import { toolOutputToText, type ToolOutput } from '@/lib/services/tools/toolOutput';
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

/** The `read` tool over a run's sandbox, as the agent is given it. */
function readOver(reader: Awaited<ReturnType<typeof build>>['reader']) {
    return buildReadTool({
        createToolFn: createTool,
        zod: z,
        guard: { protect: (_spec, execute) => execute as never },
        sandbox: reader,
        modelTakesImages: false,
    }) as unknown as { invoke: (args: Record<string, unknown>) => Promise<ToolOutput> };
}

let fake: ReturnType<typeof fakeRunner>;
beforeEach(() => {
    licensed.value = true;
    conversations.clear();
    configRows.items = [];
    configRows.groups = [];
    configRows.audit = [];
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

    it('binds four tools by default (reading is the `read` tool, fed by `reader`), and only the enabled groups otherwise', async () => {
        const all = await build({ enabled: true });
        expect(all.tools.map((t: { name: string }) => t.name)).toEqual([
            'sandbox_exec', 'sandbox_run_code', 'sandbox_write_file', 'sandbox_list_files',
        ]);
        expect(all.definitions.map((d) => d.name)).not.toContain('sandbox_read_file');
        expect(all.reader).toMatchObject({ runner: fake.runner });
        const noFiles = await build({ enabled: true, tools: { exec: false, files: false } });
        expect(noFiles.tools.map((t: { name: string }) => t.name)).toEqual(['sandbox_run_code']);
        expect(noFiles.reader).toBeUndefined();
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

    it('resolves relative paths under /workspace (the reader the `read` tool uses resolves them the same way)', async () => {
        const { byName, reader } = await build({ enabled: true });
        await byName('sandbox_write_file').invoke({ path: 'src/app.py', content: 'x' });
        expect(fake.calls[1].args[2]).toBe('/workspace/src/app.py');
        expect(reader!.resolvePath('src/app.py')).toBe('/workspace/src/app.py');
        expect(reader!.resolvePath('./a.txt')).toBe('/workspace/a.txt');
        expect(reader!.resolvePath('/etc/hosts')).toBe('/etc/hosts');
        // The reader provisions the same machine on first use.
        expect(await reader!.getInstance()).toBe('sbx-1');
        expect(fake.ops()).toEqual(['ensureInstance', 'writeFile']);
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

describe('secrets — seed files, outputs and an unreadable store', () => {
    const SECRET = 's3cr3t-value';
    const seedFile = {
        id: 'seed-1', name: 'template.txt', path: '/workspace/templates/template.txt', size: 5,
        fileRef: { bucketKey: 'assets', objectKey: 'agent-assets/builder/template.txt' },
    };

    it('writes seed files without the agent secrets in the command environment', async () => {
        downloaded.files.set('agent-assets/builder/template.txt', new Uint8Array([1, 2, 3, 4, 5]));
        const sandbox = sealAgentSandboxConfig({ enabled: true, secrets: { API_TOKEN: SECRET }, seedFiles: [seedFile] }, undefined)!;
        const { byName } = await build(sandbox);
        await byName('sandbox_exec').invoke({ command: 'echo $API_TOKEN' });

        const execs = fake.calls.filter((c) => c.op === 'exec');
        expect(execs.length).toBeGreaterThan(1);
        const [command, ...seedWrites] = [execs[execs.length - 1]!, ...execs.slice(0, -1)];
        expect((command!.args[2] as { env: Record<string, string> }).env).toEqual({ API_TOKEN: SECRET });
        for (const write of seedWrites) {
            expect((write.args[2] as { env?: unknown }).env).toBeUndefined();
            expect(JSON.stringify(write.args)).not.toContain(SECRET);
        }
    });

    it('scrubs secret values from text files in /outputs and leaves binary files as they are', async () => {
        savedOutputs.length = 0;
        const sandbox = sealAgentSandboxConfig({ enabled: true, secrets: { API_TOKEN: SECRET } }, undefined)!;
        conversations.set('conv-1', { _id: 'conv-1', agentKey: 'builder', projectId: 'p1', metadata: {} });
        const binary = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(SECRET)]);
        const files: Record<string, Buffer> = {
            '/outputs/report.txt': Buffer.from(`token: ${SECRET}\nend`),
            '/outputs/blob.bin': binary,
        };
        fake.runner.exec = async (...args) => {
            fake.calls.push({ op: 'exec', args });
            const command = (args[2] as { command: string }).command;
            return command.startsWith('find ')
                ? { exitCode: 0, stdout: Object.entries(files).map(([path, data]) => `10|${data.length}|${path}`).join('\n'), stderr: '' }
                : { exitCode: 0, stdout: 'ok', stderr: '' };
        };
        fake.runner.readFileBytes = async (_ref, _id, path) => files[path]!;

        const { byName, collectOutputs } = await build(sandbox, {
            conversation: { _id: 'conv-1', metadata: {} },
            outputs: { agentConfig: undefined, actorId: 'user-1' },
        });
        await byName('sandbox_exec').invoke({ command: 'true' });
        const { attachments } = await collectOutputs();

        expect(attachments).toHaveLength(2);
        const text = savedOutputs.find((f) => f.fileName === 'report.txt')!;
        expect(text.data.toString('utf8')).toBe(`token: ••••••\nend`);
        expect(savedOutputs.find((f) => f.fileName === 'blob.bin')!.data.equals(binary)).toBe(true);
    });

    it('says the secrets are unavailable when the stored ones cannot be decrypted', async () => {
        const { byName, tools } = await build({ enabled: true, secretsSealed: 'not-a-valid-ciphertext' });
        expect((tools.find((t: { name: string }) => t.name === 'sandbox_exec') as { description: string }).description).toMatch(/unavailable/);
        const out = await byName('sandbox_exec').invoke({ command: 'echo hi' }) as { notice?: string; stdout: string };
        expect(out.notice).toMatch(/secrets .* unavailable/);
        expect(out.notice).toMatch(/encryption key/);
        expect((fake.calls[1]!.args[2] as { env: Record<string, string> }).env).toEqual({});
    });
});

describe('values the sandbox launch carries', () => {
    // What the machine was started with (its template's typed env, secret Config items): the agent never passes these,
    // so the model could only meet them in what a command, a file or an error shows.
    const LAUNCH = 'launch-secret-7f3a';
    const OTHER = 'template-db-pass-91';
    const MASK = AGENT_SANDBOX_SECRET_MASK;
    const answering = (stdout: string, stderr = '') => async (...args: Parameters<AgentSandboxRunner['exec']>) => {
        fake.calls.push({ op: 'exec', args });
        return { exitCode: 0, stdout, stderr };
    };

    beforeEach(() => {
        fake.runner.launchSecretValues = async (...args) => {
            fake.calls.push({ op: 'launchSecretValues', args });
            return [LAUNCH, OTHER];
        };
    });

    it('asks the runner once per run, for the machine it just ensured, before the first command', async () => {
        const { byName } = await build({ enabled: true });
        await byName('sandbox_exec').invoke({ command: 'true' });
        await byName('sandbox_exec').invoke({ command: 'true' });
        await byName('sandbox_list_files').invoke({});

        expect(fake.ops()).toEqual(['ensureInstance', 'launchSecretValues', 'exec', 'exec', 'listFiles']);
        const [ref, instanceId] = fake.calls[1].args as [Record<string, unknown>, string];
        expect(instanceId).toBe('sbx-1');
        // The same reference every other runner call carries: the tenant database and the agent.
        expect(ref).toEqual(fake.calls[0].args[0]);
        expect(ref).toMatchObject({ tenantDbName: 'tenant_acme', agentKey: 'builder' });
    });

    it('asks again for the machine of the next run', async () => {
        conversations.set('conv-1', { _id: 'conv-1', agentKey: 'builder', projectId: 'p1', metadata: {} });
        for (let run = 0; run < 2; run++) {
            const { byName, cleanup } = await build({ enabled: true }, { conversation: { _id: 'conv-1' } });
            await byName('sandbox_exec').invoke({ command: 'true' });
            await cleanup();
        }
        expect(fake.ops()).toEqual(['ensureInstance', 'launchSecretValues', 'exec', 'ensureInstance', 'launchSecretValues', 'exec']);
        expect(fake.calls[4].args[1]).toBe('sbx-1');
    });

    it('masks them in the stdout and stderr of a command and of run_code', async () => {
        fake.runner.exec = answering(`env: TOKEN=${LAUNCH}`, `db password ${OTHER} rejected`);
        fake.runner.runCode = async (...args) => {
            fake.calls.push({ op: 'runCode', args });
            return { exitCode: 0, stdout: `${LAUNCH}${OTHER}`, stderr: LAUNCH };
        };
        const { byName } = await build({ enabled: true });

        const exec = await byName('sandbox_exec').invoke({ command: 'env' }) as { stdout: string; stderr: string };
        expect(exec.stdout).toBe(`env: TOKEN=${MASK}`);
        expect(exec.stderr).toBe(`db password ${MASK} rejected`);
        const code = await byName('sandbox_run_code').invoke({ language: 'python', code: 'print(1)' }) as { stdout: string; stderr: string };
        expect(code).toMatchObject({ stdout: `${MASK}${MASK}`, stderr: MASK });
    });

    it('masks them together with the agent\'s own secrets', async () => {
        fake.runner.exec = answering(`a=s3cr3t-value b=${LAUNCH}`);
        const sandbox = sealAgentSandboxConfig({ enabled: true, secrets: { API_TOKEN: 's3cr3t-value' } }, undefined)!;
        const { byName } = await build(sandbox);
        expect((await byName('sandbox_exec').invoke({ command: 'env' }) as { stdout: string }).stdout).toBe(`a=${MASK} b=${MASK}`);
    });

    it('masks a value before the output is cut, so that a cut cannot leave half of it showing', async () => {
        // 16,000 characters are kept; the front of the value would be cut off and its back left readable.
        const padding = 'x'.repeat(15_990);
        fake.runner.exec = answering(`${LAUNCH}${padding}`, `${padding}${OTHER}`);
        const { byName } = await build({ enabled: true });
        const out = await byName('sandbox_exec').invoke({ command: 'env' }) as { stdout: string; stderr: string };
        expect(out.stdout).toBe(`${MASK}${padding}`);
        expect(out.stdout).not.toContain(LAUNCH.slice(8));
        expect(out.stderr).toBe(`${padding}${MASK}`);
    });

    it('masks them in a file the model reads, and before a line is cut', async () => {
        // A line is cut at 2,000 characters: 2,008 before masking, so the cut would land inside the value; 1,996 after.
        const body = `PASSWORD=${OTHER}\n${'y'.repeat(1_990)}${LAUNCH}\n`;
        const bytes = Buffer.byteLength(body);
        fake.runner.exec = answering(`FILE ${bytes} ${bytes} ${bytes} ${Buffer.from(body).subarray(0, 32).toString('hex')}`);
        fake.runner.readFile = async (...args) => {
            fake.calls.push({ op: 'readFile', args });
            return body;
        };
        const { reader } = await build({ enabled: true });
        const content = toolOutputToText(await readOver(reader).invoke({ path: 'config.env' }));
        expect(content).toContain(`PASSWORD=${MASK}`);
        expect(content).toContain(`${'y'.repeat(1_990)}${MASK}`);
        expect(content).not.toContain(OTHER);
        expect(content).not.toContain(LAUNCH.slice(0, 8));
    });

    it('masks them in the names and paths of a listing and leaves the rest of an entry alone', async () => {
        fake.runner.listFiles = async (...args) => {
            fake.calls.push({ op: 'listFiles', args });
            return [
                { name: `backup-${LAUNCH}.tar`, path: `/workspace/backup-${LAUNCH}.tar`, type: 'file', size: 10 },
                { name: 'src', path: '/workspace/src', type: 'directory', size: 0 },
            ];
        };
        const { byName } = await build({ enabled: true });
        expect(await byName('sandbox_list_files').invoke({})).toEqual([
            { name: `backup-${MASK}.tar`, path: `/workspace/backup-${MASK}.tar`, type: 'file', size: 10 },
            { name: 'src', path: '/workspace/src', type: 'directory', size: 0 },
        ]);
    });

    it('masks them in the text files collected from /outputs', async () => {
        savedOutputs.length = 0;
        conversations.set('conv-1', { _id: 'conv-1', agentKey: 'builder', projectId: 'p1', metadata: {} });
        const files: Record<string, Buffer> = { '/outputs/report.txt': Buffer.from(`key: ${LAUNCH}\nend`) };
        fake.runner.exec = async (...args) => {
            fake.calls.push({ op: 'exec', args });
            const command = (args[2] as { command: string }).command;
            return command.startsWith('find ')
                ? { exitCode: 0, stdout: Object.entries(files).map(([path, data]) => `10|${data.length}|${path}`).join('\n'), stderr: '' }
                : { exitCode: 0, stdout: 'ok', stderr: '' };
        };
        fake.runner.readFileBytes = async (_ref, _id, path) => files[path]!;
        const { byName, collectOutputs } = await build({ enabled: true }, {
            conversation: { _id: 'conv-1', metadata: {} },
            outputs: { agentConfig: undefined, actorId: 'user-1' },
        });
        await byName('sandbox_exec').invoke({ command: 'true' });
        await collectOutputs();
        expect(savedOutputs.find((f) => f.fileName === 'report.txt')!.data.toString('utf8')).toBe(`key: ${MASK}\nend`);
    });

    it('masks them in the error a tool call ends with, and keeps what kind of error it was', async () => {
        class ExecError extends Error {
            constructor(message: string) {
                super(message);
                this.name = 'ExecError';
            }
        }
        fake.runner.exec = async () => { throw new ExecError(`connect to db failed: password=${OTHER}`); };
        const { byName } = await build({ enabled: true });
        const failure = await byName('sandbox_exec').invoke({ command: 'x' }).catch((error: Error) => error) as Error;
        expect(failure).toBeInstanceOf(Error);
        expect(failure.message).toBe(`connect to db failed: password=${MASK}`);
        expect(failure.name).toBe('ExecError');
        // The stack goes to the trace: it holds the message, so it must not hold the value either.
        expect(failure.stack ?? '').not.toContain(OTHER);
    });

    it('lets an error that carries nothing to mask go on as the same object', async () => {
        const original = new Error('The sandbox is not running (exec)');
        fake.runner.exec = async () => { throw original; };
        const { byName } = await build({ enabled: true });
        await expect(byName('sandbox_exec').invoke({ command: 'x' })).rejects.toBe(original);
    });

    it.each([
        ['sandbox_run_code', { language: 'python', code: 'print(1)' }, 'runCode'],
        ['sandbox_write_file', { path: 'a.txt', content: 'x' }, 'writeFile'],
        ['sandbox_list_files', {}, 'listFiles'],
        ['sandbox_preview_link', { port: 3000 }, 'previewLink'],
    ] as const)('masks them in the error of %s', async (tool, args, method) => {
        (fake.runner as unknown as Record<string, unknown>)[method] = async () => { throw new Error(`failed with ${LAUNCH}`); };
        const { byName } = await build({ enabled: true, preview: { enabled: true } });
        const failure = await byName(tool).invoke({ ...args }).catch((error: Error) => error) as Error;
        expect(failure.message).toBe(`failed with ${MASK}`);
    });

    it('masks them in the error of read, and keeps what kind of error it was', async () => {
        class ExecError extends Error {
            constructor(message: string) {
                super(message);
                this.name = 'ExecError';
            }
        }
        fake.runner.exec = async () => { throw new ExecError(`failed with ${LAUNCH}`); };
        const { reader } = await build({ enabled: true });
        const failure = await readOver(reader).invoke({ path: 'a.txt' }).catch((error: Error) => error) as Error;
        expect(failure.message).toBe(`failed with ${MASK}`);
        expect(failure.name).toBe('ExecError');
    });

    it('masks the agent\'s own secrets in the error of a machine that would not start', async () => {
        // The launch values are not known yet at this point: only the agent's own are.
        fake.runner.ensureInstance = async () => { throw new Error('The sandbox failed to start: image pull denied for s3cr3t-value'); };
        const sandbox = sealAgentSandboxConfig({ enabled: true, secrets: { API_TOKEN: 's3cr3t-value' } }, undefined)!;
        const { byName } = await build(sandbox);
        await expect(byName('sandbox_exec').invoke({ command: 'ls' })).rejects.toThrow(`The sandbox failed to start: image pull denied for ${MASK}`);
    });

    it('applies the same length rule as for the agent\'s own secrets: short and empty values are left alone', async () => {
        fake.runner.launchSecretValues = async () => ['abc', '', LAUNCH];
        fake.runner.exec = answering(`abc ${LAUNCH} abc`);
        const { byName } = await build({ enabled: true });
        expect((await byName('sandbox_exec').invoke({ command: 'env' }) as { stdout: string }).stdout).toBe(`abc ${MASK} abc`);
    });

    it('goes on without them when the runner cannot tell, and still masks the agent\'s own secrets', async () => {
        fake.runner.launchSecretValues = async () => { throw new Error('instance store unavailable'); };
        fake.runner.exec = answering(`a=s3cr3t-value b=${LAUNCH}`);
        const sandbox = sealAgentSandboxConfig({ enabled: true, secrets: { API_TOKEN: 's3cr3t-value' } }, undefined)!;
        const { byName } = await build(sandbox);
        const out = await byName('sandbox_exec').invoke({ command: 'env' }) as { stdout: string };
        expect(out.stdout).toBe(`a=${MASK} b=${LAUNCH}`);
    });

    it('behaves as before with a runner that cannot name them (an older module)', async () => {
        delete fake.runner.launchSecretValues;
        fake.runner.exec = answering(`a=s3cr3t-value b=${LAUNCH}`);
        const sandbox = sealAgentSandboxConfig({ enabled: true, secrets: { API_TOKEN: 's3cr3t-value' } }, undefined)!;
        const { byName } = await build(sandbox);
        const out = await byName('sandbox_exec').invoke({ command: 'env' }) as { stdout: string };
        expect(out.stdout).toBe(`a=${MASK} b=${LAUNCH}`);
        expect(fake.ops()).toEqual(['ensureInstance', 'exec']);
    });
});

describe('values taken from Config', () => {
    const row = (id: string, key: string, value: string, isSecret: boolean, groupId = 'g1') =>
        ({ _id: id, key, value, isSecret, groupId, projectId: 'p1', version: 2 });
    beforeEach(() => {
        configRows.groups = [{ _id: 'g1', key: 'shared', projectId: 'p1' }];
        configRows.items = [row('i1', 'region', 'eu-west', false), row('i2', 'api-key', 'cfg-secret-value', true)];
    });

    it('sets plain values on the machine, passes secrets per command, masks them and names them to the model', async () => {
        const { byName, tools } = await build({
            enabled: true,
            env: { MODE: 'ci' },
            envRefs: { REGION: { configId: 'i1', key: 'region' } },
            groupRefs: [{ groupId: 'g1', key: 'shared' }],
        });
        const out = await byName('sandbox_exec').invoke({ command: 'echo $API_KEY' }) as { stdout: string; notice?: string };

        expect((fake.calls[0].args[1] as { env?: Record<string, string> }).env).toEqual({ REGION: 'eu-west', MODE: 'ci' });
        const commandEnv = (fake.calls[1].args[2] as { env: Record<string, string> }).env;
        expect(commandEnv).toEqual({ API_KEY: 'cfg-secret-value' });
        expect(JSON.stringify(fake.calls[0].args[1])).not.toContain('cfg-secret-value');
        expect(out.notice).toBeUndefined();
        const description = (tools.find((t: { name: string }) => t.name === 'sandbox_exec') as { description: string }).description;
        expect(description).toContain('API_KEY');
        expect(description).not.toContain('cfg-secret-value');
        expect(configRows.audit).toEqual([expect.objectContaining({ configKey: 'api-key', performedBy: 'agent:builder' })]);
    });

    it('never puts a secret on the machine, even when an envRefs item has become secret', async () => {
        const { byName } = await build({ enabled: true, envRefs: { REGION: { configId: 'i2', key: 'api-key' } } });
        await byName('sandbox_exec').invoke({ command: 'true' });
        expect(fake.calls[0].args[1]).not.toHaveProperty('env');
        expect((fake.calls[1].args[2] as { env: Record<string, string> }).env).toEqual({ REGION: 'cfg-secret-value' });
    });

    it('runs without a variable that is gone, warns once and tells the model with the results', async () => {
        const { byName, warnings } = await build({
            enabled: true,
            envRefs: { REGION: { configId: 'i1', key: 'region' }, GONE: { configId: 'deleted', key: 'removed' } },
        });
        const first = await byName('sandbox_exec').invoke({ command: 'true' }) as { notice?: string };
        const second = await byName('sandbox_exec').invoke({ command: 'true' }) as { notice?: string };
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/GONE/);
        expect(first.notice).toMatch(/configured from Config are unavailable: [\s\S]*GONE[\s\S]*run without them/);
        expect(second.notice).toBe(first.notice);
        expect((fake.calls[0].args[1] as { env?: Record<string, string> }).env).toEqual({ REGION: 'eu-west' });
    });

    it('starts the sandbox without a Config value over the env limits, and says so (limit problem)', async () => {
        configRows.items.push(row('i9', 'huge', 'x'.repeat(32 * 1024 + 1), false));
        const { byName, warnings } = await build({
            enabled: true,
            envRefs: { REGION: { configId: 'i1', key: 'region' }, HUGE: { configId: 'i9', key: 'huge' } },
        });
        const out = await byName('sandbox_exec').invoke({ command: 'true' }) as { notice?: string };
        expect((fake.calls[0].args[1] as { env?: Record<string, string> }).env).toEqual({ REGION: 'eu-west' });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/HUGE/);
        expect(out.notice).toMatch(/configured from Config are unavailable: [\s\S]*HUGE[\s\S]*run without them/);
    });

    it('says nothing to the model about a name collision between bound groups (a warning only)', async () => {
        configRows.groups.push({ _id: 'g2', key: 'second', projectId: 'p1' });
        configRows.items.push(row('i3', 'region', 'other', false, 'g2'));
        const { byName, warnings } = await build({
            enabled: true,
            groupRefs: [{ groupId: 'g1', key: 'shared' }, { groupId: 'g2', key: 'second' }],
        });
        const out = await byName('sandbox_exec').invoke({ command: 'true' }) as { notice?: string };
        expect(warnings).toHaveLength(1);
        expect(out.notice).toBeUndefined();
    });
});

describe('session sandbox', () => {
    it('is the default: one machine per conversation, left running between turns and reused by the next', async () => {
        conversations.set('conv-1', { _id: 'conv-1', agentKey: 'builder', projectId: 'p1', metadata: { runtimeContext: { a: 1 } } });
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
        conversations.set('conv-1', { _id: 'conv-1', agentKey: 'builder', projectId: 'p1', metadata: {} });
        const { byName } = await build({ enabled: true }, { conversation: { _id: 'conv-1' } });
        await byName('sandbox_exec').invoke({ command: 'ls' });
        // No cleanup: the process died mid-run. The next turn must still find it.
        expect((conversations.get('conv-1')!.metadata as Record<string, any>).sandbox.instanceId).toBe('sbx-1');
    });

    it('the persist mode of earlier versions is read as session', async () => {
        conversations.set('conv-1', { _id: 'conv-1', agentKey: 'builder', projectId: 'p1', metadata: {} });
        const { byName, cleanup } = await build({ enabled: true, mode: 'persist' }, { conversation: { _id: 'conv-1' } });
        await byName('sandbox_exec').invoke({ command: 'ls' });
        await cleanup();
        expect(fake.ops()).toEqual(['ensureInstance', 'exec']);
    });

    it('starts a fresh machine when the recorded one was closed by the idle reaper', async () => {
        conversations.set('conv-1', {
            _id: 'conv-1', agentKey: 'builder', projectId: 'p1',
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
            _id: 'conv-2', agentKey: 'builder', projectId: 'p1',
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
            _id: 'conv-4', agentKey: 'builder', projectId: 'p1',
            metadata: { sandbox: { instanceId: 'sbx-py', templateKey: 'py', lifecycle: 'session', createdAt: 'x', lastUsedAt: 'x' } },
        });
        const { byName } = await build({ enabled: true, templateKey: 'node' }, { conversation: { _id: 'conv-4' } });
        await byName('sandbox_list_files').invoke({});
        expect(fake.ops().slice(0, 2)).toEqual(['destroy', 'ensureInstance']);
        expect(fake.calls[0].args[1]).toBe('sbx-py');
    });

    it('only reads and writes the record of the agent\'s own session: a conversation of another agent or project is left alone', async () => {
        conversations.set('conv-5', { _id: 'conv-5', agentKey: 'someone-else', projectId: 'p1', metadata: { sandbox: { instanceId: 'sbx-theirs', lifecycle: 'session', createdAt: 'x', lastUsedAt: 'x' } } });
        conversations.set('conv-6', { _id: 'conv-6', agentKey: 'builder', projectId: 'p-other', metadata: {} });
        for (const id of ['conv-5', 'conv-6']) {
            const built = await build({ enabled: true }, { conversation: { _id: id } });
            await built.byName('sandbox_list_files').invoke({});
            await built.cleanup();
        }
        // never adopted the other agent's machine, and wrote no record into either row
        expect(fake.calls.some((c) => c.op === 'ensureInstance' && (c.args[1] as { instanceId?: string }).instanceId === 'sbx-theirs')).toBe(false);
        expect((conversations.get('conv-5')!.metadata as Record<string, any>).sandbox.instanceId).toBe('sbx-theirs');
        expect((conversations.get('conv-6')!.metadata as Record<string, any>).sandbox).toBeUndefined();
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
        conversations.set('conv-5', { _id: 'conv-5', agentKey: 'builder', projectId: 'p1', metadata: { keep: true } });
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
        conversations.set('conv-p', { _id: 'conv-p', agentKey: 'builder', projectId: 'p1', metadata: {} });
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

describe('the turn\'s Stop reaches a running command', () => {
    it('sandbox_exec and sandbox_run_code get the turn signal; outside a turn they get none', async () => {
        const { byName } = await build({ enabled: true });
        const controller = new AbortController();
        await runWithTurnSignal(controller.signal, async () => {
            await byName('sandbox_exec').invoke({ command: 'sleep 60' });
            await byName('sandbox_run_code').invoke({ language: 'python', code: 'print(1)' });
        });
        await byName('sandbox_exec').invoke({ command: 'ls' });
        const execs = fake.calls.filter((c) => c.op === 'exec' || c.op === 'runCode').map((c) => c.args[2] as { signal?: AbortSignal });
        expect(execs[0].signal).toBe(controller.signal);
        expect(execs[1].signal).toBe(controller.signal);
        expect('signal' in execs[2]).toBe(false);
    });
});
