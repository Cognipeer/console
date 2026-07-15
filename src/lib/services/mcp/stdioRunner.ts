/**
 * Stdio MCP runner — launches npx / uvx MCP server packages as short-lived
 * subprocesses and speaks the MCP stdio transport (newline-delimited JSON-RPC)
 * with them.
 *
 * Execution model is STATELESS per call: every listTools/callTool spawns a
 * fresh process, runs the initialize handshake, performs the request, and
 * tears the process down. Package installs are served from the npm/uv cache,
 * so after the first spawn subsequent launches are fast and offline-safe.
 *
 * Safety rails:
 * - runtime allowlist (npx / uvx only), no shell interpolation (execFile-style
 *   spawn with an args array)
 * - per-call timeout and stdout buffer cap
 * - global concurrency cap so a burst cannot fork-bomb the gateway
 * - can be disabled entirely with MCP_STDIO_ENABLED=false
 */

import { spawn } from 'node:child_process';
import { createLogger } from '@/lib/core/logger';
import type { IMcpStdioConfig, IMcpTool } from '@/lib/database';
import { openStdioEnv } from './secretVault';

const logger = createLogger('mcp-stdio-runner');

const JSONRPC_VERSION = '2.0';
const MCP_PROTOCOL_VERSION = '2025-03-26';

const DEFAULT_TIMEOUT_MS = Number(process.env.MCP_STDIO_TIMEOUT_MS ?? 90_000);
const MAX_STDOUT_BYTES = Number(process.env.MCP_STDIO_MAX_OUTPUT_BYTES ?? 8 * 1024 * 1024);
const MAX_CONCURRENT = Number(process.env.MCP_STDIO_MAX_CONCURRENT ?? 8);

let activeProcesses = 0;

export function isStdioRunnerEnabled(): boolean {
  return (process.env.MCP_STDIO_ENABLED ?? 'true').toLowerCase() !== 'false';
}

interface JsonRpcResponse {
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

function buildCommand(config: IMcpStdioConfig): { command: string; args: string[] } {
  const extraArgs = (config.args ?? []).map((a) => String(a));
  if (config.runtime === 'npx') {
    // -y: run without an install prompt; the npm cache keeps this fast.
    return { command: 'npx', args: ['-y', config.packageName, ...extraArgs] };
  }
  if (config.runtime === 'uvx') {
    return { command: 'uvx', args: [config.packageName, ...extraArgs] };
  }
  throw new Error(`Unsupported stdio runtime: ${String(config.runtime)}`);
}

/**
 * Spawn the configured MCP server, run `requests` sequentially over stdio and
 * resolve with the matching responses. The process is always terminated.
 */
async function runStdioSession(
  config: IMcpStdioConfig,
  requests: Array<{ method: string; params?: Record<string, unknown>; notification?: boolean }>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<JsonRpcResponse[]> {
  if (!isStdioRunnerEnabled()) {
    throw new Error('Stdio MCP execution is disabled on this deployment (MCP_STDIO_ENABLED=false)');
  }
  if (activeProcesses >= MAX_CONCURRENT) {
    throw new Error('Too many concurrent stdio MCP executions; try again shortly');
  }

  const { command, args } = buildCommand(config);
  const env = {
    ...process.env,
    ...openStdioEnv(config),
    // MCP servers must not inherit interactive npm prompts.
    npm_config_yes: 'true',
    NO_COLOR: '1',
  };

  activeProcesses += 1;
  const child = spawn(command, args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // No shell: the package name and args are passed verbatim, never parsed.
    shell: false,
  });

  const responses = new Map<number, JsonRpcResponse>();
  const expectedIds: number[] = [];
  let stdoutBuffer = '';
  let stderrTail = '';
  let stdoutBytes = 0;
  let settled = false;

  return await new Promise<JsonRpcResponse[]>((resolve, reject) => {
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeProcesses = Math.max(0, activeProcesses - 1);
      try {
        child.kill('SIGTERM');
        // Escalate if the process ignores SIGTERM.
        setTimeout(() => {
          try {
            if (child.exitCode === null) child.kill('SIGKILL');
          } catch { /* already gone */ }
        }, 2_000).unref();
      } catch { /* already gone */ }

      if (error) {
        reject(error);
        return;
      }
      resolve(expectedIds.map((id) => responses.get(id) ?? { id, error: { message: 'No response received' } }));
    };

    const timer = setTimeout(() => {
      finish(new Error(
        `Stdio MCP server timed out after ${timeoutMs}ms`
        + (stderrTail ? ` — stderr: ${stderrTail.slice(-400)}` : ''),
      ));
    }, timeoutMs);

    child.on('error', (err) => {
      finish(new Error(`Failed to launch ${command}: ${err.message}`));
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4_000);
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        finish(new Error('Stdio MCP server exceeded the output size limit'));
        return;
      }
      stdoutBuffer += chunk.toString('utf8');

      let newlineIdx = stdoutBuffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = stdoutBuffer.slice(0, newlineIdx).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        newlineIdx = stdoutBuffer.indexOf('\n');
        if (!line) continue;
        try {
          const message = JSON.parse(line) as JsonRpcResponse;
          if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
            responses.set(message.id, message);
          }
        } catch {
          // Some servers log human text to stdout; ignore non-JSON lines.
        }
        if (expectedIds.every((id) => responses.has(id))) {
          finish();
          return;
        }
      }
    });

    child.on('exit', (code) => {
      if (expectedIds.every((id) => responses.has(id))) {
        finish();
      } else {
        finish(new Error(
          `Stdio MCP server exited (code ${code ?? 'null'}) before responding`
          + (stderrTail ? ` — stderr: ${stderrTail.slice(-400)}` : ''),
        ));
      }
    });

    // Write the whole conversation up front; stdio servers process in order.
    let nextId = 1;
    const frames: string[] = [];
    for (const req of requests) {
      if (req.notification) {
        frames.push(JSON.stringify({ jsonrpc: JSONRPC_VERSION, method: req.method, ...(req.params ? { params: req.params } : {}) }));
      } else {
        const id = nextId++;
        expectedIds.push(id);
        frames.push(JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, method: req.method, ...(req.params ? { params: req.params } : {}) }));
      }
    }
    child.stdin.write(`${frames.join('\n')}\n`);
  });
}

const INITIALIZE_REQUEST = {
  method: 'initialize',
  params: {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'cognipeer-mcp-gateway', version: '1.0.0' },
  },
};
const INITIALIZED_NOTIFICATION = { method: 'notifications/initialized', notification: true };

/** Discover tools by spawning the stdio server once. */
export async function stdioListTools(config: IMcpStdioConfig): Promise<IMcpTool[]> {
  const [initRes, listRes] = await runStdioSession(config, [
    INITIALIZE_REQUEST,
    INITIALIZED_NOTIFICATION,
    { method: 'tools/list', params: {} },
  ]);

  if (initRes.error) {
    throw new Error(`MCP initialize failed: ${initRes.error.message ?? 'unknown error'}`);
  }
  if (listRes.error) {
    throw new Error(`tools/list failed: ${listRes.error.message ?? 'unknown error'}`);
  }

  const tools = (listRes.result as {
    tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  })?.tools ?? [];

  logger.info('Discovered stdio MCP tools', {
    package: config.packageName,
    runtime: config.runtime,
    toolCount: tools.length,
  });

  return tools.map((t) => ({
    name: t.name,
    description: t.description || t.name,
    inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
  }));
}

/** Execute one tool call by spawning the stdio server once. */
export async function stdioCallTool(
  config: IMcpStdioConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const [initRes, callRes] = await runStdioSession(config, [
    INITIALIZE_REQUEST,
    INITIALIZED_NOTIFICATION,
    { method: 'tools/call', params: { name: toolName, arguments: args } },
  ]);

  if (initRes.error) {
    throw new Error(`MCP initialize failed: ${initRes.error.message ?? 'unknown error'}`);
  }
  if (callRes.error) {
    throw new Error(`MCP tool error: ${callRes.error.message ?? 'unknown error'}`);
  }

  const result = callRes.result as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    structuredContent?: unknown;
  } | undefined;

  if (result?.isError) {
    const text = (result.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    throw new Error(text || 'MCP tool call failed');
  }

  if (result?.structuredContent !== undefined) return result.structuredContent;

  const content = result?.content;
  if (Array.isArray(content)) {
    const textParts = content.filter((c) => c.type === 'text');
    if (textParts.length === 1) {
      const text = textParts[0].text ?? '';
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return textParts.map((c) => c.text).join('\n');
  }
  return result;
}

/** Quick availability probe for the create-screen preflight. */
export async function stdioRuntimeAvailable(runtime: 'npx' | 'uvx'): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(runtime, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'], shell: false });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      resolve(false);
    }, 5_000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}
