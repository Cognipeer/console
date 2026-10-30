/**
 * The internal MCP sandbox providers: `sandbox` (new sandboxes from a template,
 * explicit `sandboxId`s owned by the server that made them) and
 * `sandbox-instance` (one persistent sandbox of the project).
 *
 * The runner is the enterprise seam; here it is a recording fake. The license
 * check is mocked per test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const licensed = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/license/tenantLicense', () => ({
  isTenantEnterpriseLicensed: vi.fn(async () => licensed.value),
}));

import { agentSandboxRunner, type AgentSandboxInstanceInfo, type AgentSandboxRunner } from '@/enterprise/registry';
import { McpToolInputError } from '@/lib/services/mcp/errors';
import { getInternalMcpProvider } from '@/lib/services/mcp/internal/registry';
import { isTokenOnlyServer, tokenOnlyProviderOf } from '@/lib/services/mcp/mcpService';
import { sandboxInstanceProvider, sandboxProvider } from '@/lib/services/mcp/internal/sandboxProvider';

const CTX = { tenantDbName: 'tenant_acme', tenantId: 't1', projectId: 'p1' };
const CALL = { ...CTX, serverKey: 'srv-a' };
const LAUNCH_SECRET = 'launch-secret-value-123';

function fakeRunner() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const instances = new Map<string, AgentSandboxInstanceInfo>([
    ['own-1', { id: 'own-1', name: 'mcp-srv-a', state: 'running', persist: false, createdBy: 'mcp:srv-a' }],
    ['other-1', { id: 'other-1', name: 'mcp-srv-b', state: 'running', persist: false, createdBy: 'mcp:srv-b' }],
    ['agent-1', { id: 'agent-1', name: 'agent-x', state: 'running', persist: false, createdBy: 'agent' }],
    ['gone-1', { id: 'gone-1', name: 'mcp-srv-a', state: 'failed', persist: false, createdBy: 'mcp:srv-a' }],
    ['shared', { id: 'shared', name: 'Shared box', state: 'stopped', persist: true, templateKey: 'multi-base', createdBy: 'user-1' }],
    ['scratch', { id: 'scratch', name: 'Scratch', state: 'running', persist: false, createdBy: 'user-1' }],
  ]);
  const runner: AgentSandboxRunner = {
    listTemplates: async () => [{ key: 'multi-base', name: 'Multi base', description: 'Ubuntu' }],
    listInstances: async (...args) => {
      calls.push({ op: 'listInstances', args });
      return [...instances.values()].filter((i) => args[3]?.persist === undefined || i.persist === args[3].persist);
    },
    describeInstance: async (_ref, id) => instances.get(id) ?? null,
    ensureInstance: async (...args) => {
      calls.push({ op: 'ensureInstance', args });
      return args[1].instanceId ? { instanceId: args[1].instanceId, created: false } : { instanceId: 'new-1', created: true };
    },
    launchSecretValues: async () => [LAUNCH_SECRET],
    exec: async (...args) => {
      calls.push({ op: 'exec', args });
      return { exitCode: 0, stdout: `secret=${LAUNCH_SECRET}\nok`, stderr: '' };
    },
    runCode: async (...args) => { calls.push({ op: 'runCode', args }); return { exitCode: 0, stdout: '42', stderr: '' }; },
    readFile: async (...args) => { calls.push({ op: 'readFile', args }); return 'x'.repeat(250_000); },
    writeFile: async (...args) => { calls.push({ op: 'writeFile', args }); },
    listFiles: async (...args) => {
      calls.push({ op: 'listFiles', args });
      return [{ name: `${LAUNCH_SECRET}.txt`, path: `/workspace/${LAUNCH_SECRET}.txt`, type: 'file', size: 3 }];
    },
    previewLink: async () => { throw new Error('not used'); },
    stop: async (...args) => { calls.push({ op: 'stop', args }); },
    destroy: async (...args) => { calls.push({ op: 'destroy', args }); },
  };
  return { runner, calls, ops: () => calls.map((c) => c.op) };
}

let fake: ReturnType<typeof fakeRunner>;
beforeEach(() => {
  licensed.value = true;
  fake = fakeRunner();
  agentSandboxRunner.current = fake.runner;
});
afterEach(() => {
  agentSandboxRunner.current = null;
});

describe('both providers', () => {
  it('are registered and token-only', () => {
    expect(getInternalMcpProvider('sandbox')).toBe(sandboxProvider);
    expect(getInternalMcpProvider('sandbox-instance')).toBe(sandboxInstanceProvider);
    expect(sandboxProvider.tokenOnly).toBe(true);
    expect(sandboxInstanceProvider.tokenOnly).toBe(true);
  });

  it('make their servers token-only, like a browser, and nothing else', () => {
    const on = (provider: string) => ({ sourceType: 'internal' as const, metadata: { internal: { provider, instanceKey: 'x' } } });
    expect(isTokenOnlyServer(on('sandbox'))).toBe(true);
    expect(isTokenOnlyServer(on('sandbox-instance'))).toBe(true);
    expect(isTokenOnlyServer(on('browser'))).toBe(true);
    expect(isTokenOnlyServer(on('knowledge-base'))).toBe(false);
    expect(isTokenOnlyServer({ sourceType: 'remote', metadata: { internal: { provider: 'sandbox' } } })).toBe(false);
    expect(tokenOnlyProviderOf(on('sandbox-instance'))?.label).toBe('Persistent sandbox');
  });

  it('are available only with the sandbox module and an Enterprise license', async () => {
    expect(await sandboxProvider.isAvailable!({ tenantId: 't1' })).toBe(true);
    licensed.value = false;
    expect(await sandboxProvider.isAvailable!({ tenantId: 't1' })).toBe(false);
    await expect(sandboxProvider.execute(CALL, 'multi-base', {}, 'sandbox_create', {})).rejects.toThrow(/Enterprise license/);
    licensed.value = true;
    agentSandboxRunner.current = null;
    expect(await sandboxInstanceProvider.isAvailable!({ tenantId: 't1' })).toBe(false);
    expect(await sandboxInstanceProvider.listInstances(CTX)).toEqual([]);
    await expect(sandboxInstanceProvider.validateInstance(CTX, 'shared', {})).rejects.toThrow(/no sandbox module/);
  });

  it('must be called through an MCP server', async () => {
    await expect(sandboxProvider.execute(CTX, 'multi-base', {}, 'sandbox_create', {})).rejects.toThrow(/through an MCP server/);
    await expect(sandboxInstanceProvider.execute(CTX, 'shared', {}, 'sandbox_exec', { command: 'ls' })).rejects.toThrow(/through an MCP server/);
  });
});

describe('Sandbox (new sandboxes from a template)', () => {
  it('lists the templates and validates the chosen one', async () => {
    expect(await sandboxProvider.listInstances(CTX)).toEqual([{ key: 'multi-base', label: 'Multi base', description: 'Ubuntu' }]);
    await expect(sandboxProvider.validateInstance(CTX, 'multi-base', {})).resolves.toBeUndefined();
    await expect(sandboxProvider.validateInstance(CTX, 'nope', {})).rejects.toThrow(/template "nope" not found/);
  });

  it('builds the create/work/delete tools, each work tool taking a sandboxId', async () => {
    const built = await sandboxProvider.buildTools(CTX, 'multi-base', {});
    expect(built.tools.map((t) => t.name)).toEqual([
      'sandbox_create', 'sandbox_exec', 'sandbox_run_code', 'sandbox_read_file', 'sandbox_write_file', 'sandbox_list_files', 'sandbox_delete',
    ]);
    for (const tool of built.tools.filter((t) => t.name !== 'sandbox_create')) {
      expect((tool.inputSchema as { required: string[] }).required).toContain('sandboxId');
    }
    expect(built.suggestedName).toBe('Multi base sandbox');
    expect(built.instructions).toMatch(/sandbox_create/);
  });

  it('creates a non-persistent sandbox from the template, acted on by the server', async () => {
    const result = await sandboxProvider.execute(CALL, 'multi-base', {}, 'sandbox_create', {});
    expect(result).toMatchObject({ ok: true, sandboxId: 'new-1' });
    const [ref, spec] = fake.calls[0].args as [Record<string, unknown>, Record<string, unknown>];
    expect(ref).toMatchObject({ tenantDbName: 'tenant_acme', projectId: 'p1', actor: 'mcp:srv-a' });
    expect(spec).toMatchObject({ templateKey: 'multi-base', persist: false, name: 'mcp-srv-a' });
  });

  it('runs a command in a sandbox the server made and masks what the launch carries', async () => {
    const result = await sandboxProvider.execute(CALL, 'multi-base', {}, 'sandbox_exec', { sandboxId: 'own-1', command: 'env', timeoutSec: 9999 });
    expect(result).toEqual({ exitCode: 0, stdout: 'secret=••••••\nok', stderr: '' });
    expect(fake.calls[0]).toMatchObject({ op: 'exec', args: [expect.anything(), 'own-1', { command: 'env', cwd: '/workspace', timeoutSec: 600 }] });
  });

  it('treats a sandbox made anywhere else exactly like an unknown id', async () => {
    for (const sandboxId of ['other-1', 'agent-1', 'shared', 'missing']) {
      const error = await sandboxProvider.execute(CALL, 'multi-base', {}, 'sandbox_exec', { sandboxId, command: 'ls' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpToolInputError);
      expect((error as Error).message).toBe(`Sandbox "${sandboxId}" not found`);
    }
    expect(fake.ops()).not.toContain('exec');
  });

  it('asks for a sandboxId, and says when the sandbox has ended', async () => {
    await expect(sandboxProvider.execute(CALL, 'multi-base', {}, 'sandbox_exec', { command: 'ls' }))
      .rejects.toThrow(/"sandboxId" is required/);
    await expect(sandboxProvider.execute(CALL, 'multi-base', {}, 'sandbox_exec', { sandboxId: 'gone-1', command: 'ls' }))
      .rejects.toThrow(/has ended \(failed\)/);
  });

  it('deletes only its own sandboxes', async () => {
    expect(await sandboxProvider.execute(CALL, 'multi-base', {}, 'sandbox_delete', { sandboxId: 'own-1' }))
      .toEqual({ ok: true, sandboxId: 'own-1', deleted: true });
    await expect(sandboxProvider.execute(CALL, 'multi-base', {}, 'sandbox_delete', { sandboxId: 'other-1' })).rejects.toThrow(/not found/);
    expect(fake.calls.filter((c) => c.op === 'destroy').map((c) => c.args[1])).toEqual(['own-1']);
  });
});

describe('Persistent sandbox (one machine)', () => {
  it('lists only the project\'s persistent sandboxes', async () => {
    expect(await sandboxInstanceProvider.listInstances(CTX)).toEqual([
      { key: 'shared', label: 'Shared box', description: 'stopped · multi-base' },
    ]);
    expect(fake.calls[0].args.slice(2)).toEqual(['p1', { persist: true }]);
  });

  it('accepts only a persistent sandbox of the project', async () => {
    await expect(sandboxInstanceProvider.validateInstance(CTX, 'shared', {})).resolves.toBeUndefined();
    await expect(sandboxInstanceProvider.validateInstance(CTX, 'scratch', {})).rejects.toThrow(/not persistent/);
    await expect(sandboxInstanceProvider.validateInstance(CTX, 'missing', {})).rejects.toThrow(/not found in this project/);
  });

  it('builds the work tools without a sandboxId', async () => {
    const built = await sandboxInstanceProvider.buildTools(CTX, 'shared', {});
    expect(built.tools.map((t) => t.name)).toEqual(['sandbox_exec', 'sandbox_run_code', 'sandbox_read_file', 'sandbox_write_file', 'sandbox_list_files']);
    expect(JSON.stringify(built.tools)).not.toContain('sandboxId');
    expect(built.suggestedName).toBe('Shared box (sandbox)');
  });

  it('attaches (starting it when stopped) before every call, and never creates, stops or deletes it', async () => {
    await sandboxInstanceProvider.execute(CALL, 'shared', {}, 'sandbox_run_code', { language: 'python', code: 'print(42)' });
    await sandboxInstanceProvider.execute(CALL, 'shared', {}, 'sandbox_write_file', { path: 'a.txt', content: 'hi' });
    expect(fake.ops()).toEqual(['ensureInstance', 'runCode', 'ensureInstance', 'writeFile']);
    expect(fake.calls[0].args[1]).toEqual({ attach: true, instanceId: 'shared', persist: true });
    expect(fake.calls[3].args.slice(1)).toEqual(['shared', '/workspace/a.txt', 'hi']);
  });

  it('refuses a sandbox that stopped being persistent', async () => {
    await expect(sandboxInstanceProvider.execute(CALL, 'scratch', {}, 'sandbox_exec', { command: 'ls' })).rejects.toThrow(/not persistent/);
    expect(fake.ops()).toEqual([]);
  });

  it('cuts a long file and masks launch values in listings', async () => {
    const read = await sandboxInstanceProvider.execute(CALL, 'shared', {}, 'sandbox_read_file', { path: '/etc/big' }) as Record<string, unknown>;
    expect(read).toMatchObject({ path: '/etc/big', truncated: true, totalChars: 250_000 });
    expect((read.content as string).length).toBe(200_000);
    const listed = await sandboxInstanceProvider.execute(CALL, 'shared', {}, 'sandbox_list_files', {});
    expect(listed).toEqual([{ name: '••••••.txt', path: '/workspace/••••••.txt', type: 'file', size: 3 }]);
  });

  it('reports bad arguments as input errors', async () => {
    await expect(sandboxInstanceProvider.execute(CALL, 'shared', {}, 'sandbox_run_code', { language: 'cobol', code: 'x' }))
      .rejects.toBeInstanceOf(McpToolInputError);
    await expect(sandboxInstanceProvider.execute(CALL, 'shared', {}, 'sandbox_exec', {})).rejects.toThrow(/"command" is required/);
    await expect(sandboxInstanceProvider.execute(CALL, 'shared', {}, 'sandbox_nope', {})).rejects.toBeInstanceOf(McpToolInputError);
  });
});
