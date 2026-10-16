/**
 * Stdio (npx/uvx) MCP servers run as subprocesses of the gateway, a pool of
 * MCP_STDIO_MAX_CONCURRENT slots shared by every tenant. One tenant may hold
 * only its share of it (MCP_STDIO_MAX_CONCURRENT_PER_TENANT), and what a
 * subprocess writes to stderr reaches a caller only with the values it was
 * given masked.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMcpStdioConfig } from '@/lib/database';

const spawnMock = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => spawnMock);

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  kill = vi.fn(() => {
    this.exitCode = 0;
    return true;
  });
  /** The process dies without having answered. */
  die(code = 1) {
    this.exitCode = code;
    this.emit('exit', code);
  }
}

let children: FakeChild[];

const CONFIG: IMcpStdioConfig = {
  runtime: 'npx',
  packageName: '@acme/mcp-server',
  executionMode: 'subprocess',
  env: { ACME_TOKEN: 'sk-live-0123456789abcdef' },
};

/** A fresh runner (its slot counts start at zero) reading the given settings. */
async function loadRunner(settings: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('MCP_STDIO_ENABLED', 'true');
  const config = await import('@/lib/core/config');
  config.setConfigSource({ name: 'test', get: (key) => settings[key] });
  return import('@/lib/services/mcp/stdioRunner');
}

/**
 * Start a call that stays in flight until its process dies. `outcome` settles
 * with the call's result, or reports `pending` when nothing settled within a
 * moment — a call that was let through and is running.
 */
function startCall(runner: Awaited<ReturnType<typeof loadRunner>>, tenantId: string | undefined) {
  const before = children.length;
  const promise = runner.stdioCallTool(CONFIG, 'tool', {}, { tenantId });
  const settled = promise.then(
    () => ({ ok: true as const }),
    (error: Error) => ({ ok: false as const, message: error.message }),
  );
  const outcome: Promise<{ ok: boolean | 'pending'; message?: string }> = Promise.race([
    settled,
    new Promise<{ ok: 'pending' }>((resolve) => setTimeout(() => resolve({ ok: 'pending' }), 1000)),
  ]);
  return { outcome, child: () => children[before] };
}

beforeEach(() => {
  children = [];
  spawnMock.spawn.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('a tenant\'s share of the stdio pool', () => {
  it('defaults to half of the pool', async () => {
    const runner = await loadRunner();
    const calls = Array.from({ length: 4 }, () => startCall(runner, 'tenant-a'));
    expect(children).toHaveLength(4);

    const fifth = startCall(runner, 'tenant-a');
    expect(await fifth.outcome).toEqual({
      ok: false,
      message: 'This workspace has reached its limit of 4 concurrent stdio MCP executions; try again shortly',
    });
    expect(children).toHaveLength(4);

    calls.forEach((call) => call.child().die());
    await Promise.all(calls.map((call) => call.outcome));
  });

  it('leaves the rest of the pool to other tenants', async () => {
    const runner = await loadRunner();
    const a = Array.from({ length: 4 }, () => startCall(runner, 'tenant-a'));
    const b = Array.from({ length: 4 }, () => startCall(runner, 'tenant-b'));
    expect(children).toHaveLength(8);

    // The pool is now full for everyone, with its own message.
    const ninth = startCall(runner, 'tenant-c');
    expect(await ninth.outcome).toEqual({
      ok: false,
      message: 'Too many concurrent stdio MCP executions; try again shortly',
    });

    [...a, ...b].forEach((call) => call.child().die());
    await Promise.all([...a, ...b].map((call) => call.outcome));
  });

  it('gives a slot back when a call ends, however it ends', async () => {
    const runner = await loadRunner({ MCP_STDIO_MAX_CONCURRENT: '4', MCP_STDIO_MAX_CONCURRENT_PER_TENANT: '1' });
    const first = startCall(runner, 'tenant-a');
    expect((await startCall(runner, 'tenant-a').outcome).ok).toBe(false);

    first.child().die();
    await first.outcome;

    const second = startCall(runner, 'tenant-a');
    expect(children).toHaveLength(2);
    second.child().emit('error', new Error('spawn npx ENOENT'));
    expect((await second.outcome).ok).toBe(false);

    const third = startCall(runner, 'tenant-a');
    expect(children).toHaveLength(3);
    third.child().die();
    await third.outcome;
  });

  it('gives a slot back when the process cannot be started at all', async () => {
    const runner = await loadRunner({ MCP_STDIO_MAX_CONCURRENT: '2', MCP_STDIO_MAX_CONCURRENT_PER_TENANT: '1' });
    spawnMock.spawn.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
    expect(await startCall(runner, 'tenant-a').outcome).toEqual({ ok: false, message: 'spawn failed' });
    const next = startCall(runner, 'tenant-a');
    expect(children).toHaveLength(1);
    next.child().die();
    await next.outcome;
  });

  it('counts a discovery run like a call', async () => {
    const runner = await loadRunner({ MCP_STDIO_MAX_CONCURRENT: '4', MCP_STDIO_MAX_CONCURRENT_PER_TENANT: '1' });
    const listing = runner.stdioListTools(CONFIG, { tenantId: 'tenant-a' }).catch((error: Error) => error);
    expect((await startCall(runner, 'tenant-a').outcome).ok).toBe(false);
    children[0].die();
    await listing;
  });

  it.each([
    [{ MCP_STDIO_MAX_CONCURRENT: '1' }, 1],
    [{ MCP_STDIO_MAX_CONCURRENT: '3' }, 1],
    [{ MCP_STDIO_MAX_CONCURRENT: '8' }, 4],
    [{ MCP_STDIO_MAX_CONCURRENT: '10' }, 5],
    [{ MCP_STDIO_MAX_CONCURRENT: '8', MCP_STDIO_MAX_CONCURRENT_PER_TENANT: '6' }, 6],
    [{ MCP_STDIO_MAX_CONCURRENT: '8', MCP_STDIO_MAX_CONCURRENT_PER_TENANT: 'abc' }, 4],
    [{ MCP_STDIO_MAX_CONCURRENT: '8', MCP_STDIO_MAX_CONCURRENT_PER_TENANT: '-2' }, 4],
    [{ MCP_STDIO_MAX_CONCURRENT: 'abc' }, 4],
  ])('works out the share for %j as %d', async (env, share) => {
    const runner = await loadRunner(env);
    const calls = Array.from({ length: share }, () => startCall(runner, 'tenant-a'));
    expect(children).toHaveLength(share);
    const over = await startCall(runner, 'tenant-a').outcome;
    expect(over.ok).toBe(false);
    expect(children.length).toBeLessThanOrEqual(share);
    calls.forEach((call) => call.child().die());
    await Promise.all(calls.map((call) => call.outcome));
  });

  it('leaves only the pool limit when the share is 0', async () => {
    const runner = await loadRunner({ MCP_STDIO_MAX_CONCURRENT: '3', MCP_STDIO_MAX_CONCURRENT_PER_TENANT: '0' });
    const calls = Array.from({ length: 3 }, () => startCall(runner, 'tenant-a'));
    expect(children).toHaveLength(3);
    expect(await startCall(runner, 'tenant-a').outcome).toEqual({
      ok: false,
      message: 'Too many concurrent stdio MCP executions; try again shortly',
    });
    calls.forEach((call) => call.child().die());
    await Promise.all(calls.map((call) => call.outcome));
  });

  it('applies only the pool limit to a run that names no tenant', async () => {
    const runner = await loadRunner({ MCP_STDIO_MAX_CONCURRENT: '4', MCP_STDIO_MAX_CONCURRENT_PER_TENANT: '1' });
    const calls = Array.from({ length: 4 }, () => startCall(runner, undefined));
    expect(children).toHaveLength(4);
    calls.forEach((call) => call.child().die());
    await Promise.all(calls.map((call) => call.outcome));
  });
});

describe('what a stdio process says on stderr', () => {
  it('reaches the caller with the values the process was given masked, also across the cut', async () => {
    const runner = await loadRunner();
    const secret = CONFIG.env!.ACME_TOKEN;
    const call = startCall(runner, 'tenant-a');
    // 414 characters: cutting the last 400 of the raw text would keep the tail of the secret.
    call.child().stderr.write(`${secret}${'y'.repeat(390)}`);
    await new Promise((resolve) => setImmediate(resolve));
    call.child().die(1);

    const outcome = await call.outcome;
    expect(outcome.ok).toBe(false);
    const message = (outcome as { message: string }).message;
    expect(message).toContain('exited (code 1) before responding');
    expect(message).not.toContain(secret.slice(-10));
    expect(message).toContain('[REDACTED]');
  });

  it('is cut to the last 400 characters', async () => {
    const runner = await loadRunner();
    const call = startCall(runner, 'tenant-a');
    call.child().stderr.write(`${'a'.repeat(1000)}END`);
    await new Promise((resolve) => setImmediate(resolve));
    call.child().die(2);
    const message = (await call.outcome as { message: string }).message;
    const stderr = message.split('stderr: ')[1];
    expect(stderr).toHaveLength(400);
    expect(stderr.endsWith('END')).toBe(true);
  });

  it('is unchanged when the process was given nothing secret', async () => {
    const runner = await loadRunner();
    const call = runner.stdioCallTool({ ...CONFIG, env: undefined }, 'tool', {}, { tenantId: 'tenant-a' })
      .catch((error: Error) => error.message);
    const child = children[0];
    child.stderr.write('npm ERR! 404 Not Found');
    await new Promise((resolve) => setImmediate(resolve));
    child.die(1);
    expect(await call).toBe('Stdio MCP server exited (code 1) before responding — stderr: npm ERR! 404 Not Found');
  });
});
