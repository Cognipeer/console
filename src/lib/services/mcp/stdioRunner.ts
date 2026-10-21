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
 * - packageName is validated against a strict npm/PyPI identifier grammar and
 *   the package spec is always passed after a literal `--`, so it can never
 *   be reinterpreted as an npx/uvx flag (e.g. npx's own `-c`/`--call`)
 * - per-call timeout and stdout buffer cap
 * - global concurrency cap so a burst cannot fork-bomb the gateway, and a
 *   per-tenant share of it so one tenant cannot hold every slot
 * - can be disabled entirely with MCP_STDIO_ENABLED=false
 */

import { spawn } from 'node:child_process';
import { getConfig } from '@/lib/core/config';
import { currentTurnSignal } from '@/lib/core/turnSignal';
import { createLogger } from '@/lib/core/logger';
import type { IMcpStdioConfig, IMcpTool } from '@/lib/database';
import { maskSecretValues } from '@/lib/services/logRedaction';
import {
  MAX_TOOL_LIST_PAGES,
  readInitializeInstructions,
  readToolCallResult,
  readToolListPage,
  type McpDiscovery,
} from './discovery';
import { openStdioEnv } from './secretVault';

const logger = createLogger('mcp-stdio-runner');

const JSONRPC_VERSION = '2.0';
const MCP_PROTOCOL_VERSION = '2025-03-26';

const DEFAULT_TIMEOUT_MS = Number(process.env.MCP_STDIO_TIMEOUT_MS ?? 90_000);
const MAX_STDOUT_BYTES = Number(process.env.MCP_STDIO_MAX_OUTPUT_BYTES ?? 8 * 1024 * 1024);

/** Which tenant a run is for, so the pool can be shared fairly. */
export interface StdioRunOptions {
  tenantId?: string;
}

let activeProcesses = 0;
const activeByTenant = new Map<string, number>();

/**
 * Take a slot of the pool (and of the tenant's share of it). Returns the
 * function that gives it back; throws when either limit is reached, with a
 * message that says which.
 */
function acquireSlot(tenantId: string | undefined): () => void {
  // MCP_STDIO_MAX_CONCURRENT and MCP_STDIO_MAX_CONCURRENT_PER_TENANT.
  const { maxConcurrent, maxConcurrentPerTenant } = getConfig().mcp.stdio;
  if (activeProcesses >= maxConcurrent) {
    throw new Error('Too many concurrent stdio MCP executions; try again shortly');
  }
  const held = tenantId ? (activeByTenant.get(tenantId) ?? 0) : 0;
  if (tenantId && maxConcurrentPerTenant > 0 && held >= maxConcurrentPerTenant) {
    throw new Error(
      `This workspace has reached its limit of ${maxConcurrentPerTenant} concurrent stdio MCP executions; try again shortly`,
    );
  }

  activeProcesses += 1;
  if (tenantId) activeByTenant.set(tenantId, held + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeProcesses = Math.max(0, activeProcesses - 1);
    if (tenantId) {
      const left = (activeByTenant.get(tenantId) ?? 1) - 1;
      if (left > 0) activeByTenant.set(tenantId, left);
      else activeByTenant.delete(tenantId);
    }
  };
}

/**
 * The gateway process environment carries platform-wide secrets (JWT signing
 * key, provider credential encryption key, database connection strings,
 * SMTP/CRM/system-model credentials, etc. — see `src/lib/core/config.ts`).
 * Tenant-configured stdio MCP servers run tenant-selected npx/uvx packages,
 * so they must NOT inherit that environment wholesale (CWE-526).
 *
 * Instead the child only gets:
 *  - a small, explicit allowlist of platform/runtime plumbing vars needed for
 *    npx/uvx (and the interpreters they shell out to) to locate binaries,
 *    caches, and — for on-prem deployments behind a corporate proxy or a
 *    private package mirror — the standard proxy/mirror vars those tools
 *    read directly from the environment;
 *  - the tenant-supplied stdio env map for this MCP server (`config.env` /
 *    `config.envSealed`), layered on top so it can still override any of the
 *    above.
 * Nothing else from `process.env` reaches the child.
 */
const SAFE_ENV_VAR_NAMES = new Set([
  // Binary resolution / OS plumbing needed for npx and uvx to run at all.
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'windir',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramData',
  'APPDATA',
  'LOCALAPPDATA',
  'COMSPEC',
  'PATHEXT',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SHELL',
  // Corporate-proxy egress. npm/npx, uvx and the interpreters they invoke
  // read these directly from the environment (independent of the
  // NPM_CONFIG_*/UV_* prefixes below) — required for on-prem deployments
  // that egress through a proxy. None of these carry secrets.
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  // Private PyPI mirror configuration read directly by pip/uv on on-prem
  // deployments. None of these carry secrets (index URLs, not credentials).
  'PIP_INDEX_URL',
  'PIP_EXTRA_INDEX_URL',
  'PIP_TRUSTED_HOST',
]);

const SAFE_ENV_VAR_PREFIXES = ['NPM_CONFIG_', 'UV_'];

function isSafeEnvVarName(name: string): boolean {
  if (SAFE_ENV_VAR_NAMES.has(name)) return true;
  return SAFE_ENV_VAR_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Build the child process environment: an explicit allowlist copied from the
 * gateway's own environment, plus the tenant-supplied stdio env for this MCP
 * server. The full `process.env` is never spread into the child.
 */
function buildChildEnv(tenantEnv: Record<string, string>): NodeJS.ProcessEnv {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && isSafeEnvVarName(key)) {
      safe[key] = value;
    }
  }
  return {
    // NODE_ENV is not a secret and is unconditionally required by the
    // NodeJS.ProcessEnv type (see next/types/global.d.ts); it does not
    // widen exposure beyond the allowlist above.
    NODE_ENV: process.env.NODE_ENV,
    ...safe,
    ...tenantEnv,
    // MCP servers must not inherit interactive npm prompts.
    npm_config_yes: 'true',
    NO_COLOR: '1',
  };
}

export function isStdioRunnerEnabled(): boolean {
  return (process.env.MCP_STDIO_ENABLED ?? 'true').toLowerCase() !== 'false';
}

interface JsonRpcResponse {
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

// A package spec is the npm/PyPI package identifier `buildCommand` hands to
// npx/uvx, optionally followed by a version/extras suffix (e.g.
// "@scope/name@1.2.3", "black==23.1.0"). It must never be able to look like a
// CLI flag: npx and uvx both scan their argv for recognized flags (npx's own
// `-c`/`--call` runs an arbitrary shell string; a bare-looking token can be
// misread as an option), so a leading '-' is rejected outright, and only a
// tight, known-safe character set is allowed — no whitespace, quotes, `$`,
// backticks, `;`, `|`, `&`, parens, etc.
const SAFE_PACKAGE_SPEC_RE = /^[A-Za-z0-9@][A-Za-z0-9@/_.~+!=<>,[\]-]{0,213}$/;

function assertSafePackageSpec(packageName: string, runtime: 'npx' | 'uvx'): string {
  const spec = packageName.trim();
  if (!SAFE_PACKAGE_SPEC_RE.test(spec)) {
    throw new Error(
      `Refusing to launch ${runtime}: stdio packageName "${packageName}" is not a valid `
      + 'npm/PyPI package identifier (leading "-" or unsafe characters are not allowed)',
    );
  }
  return spec;
}

function buildCommand(config: IMcpStdioConfig): { command: string; args: string[] } {
  const extraArgs = (config.args ?? []).map((a) => String(a));
  if (config.runtime === 'npx') {
    const packageSpec = assertSafePackageSpec(config.packageName, 'npx');
    // -y: run without an install prompt; the npm cache keeps this fast.
    // `--` marks the end of npx's own flags: everything after it is always
    // treated as the package spec + its args, never re-parsed as an npx
    // option (e.g. a malicious packageName can no longer masquerade as
    // npx's `-c`/`--call` and hijack the invocation).
    return { command: 'npx', args: ['-y', '--', packageSpec, ...extraArgs] };
  }
  if (config.runtime === 'uvx') {
    const packageSpec = assertSafePackageSpec(config.packageName, 'uvx');
    return { command: 'uvx', args: ['--', packageSpec, ...extraArgs] };
  }
  throw new Error(`Unsupported stdio runtime: ${String(config.runtime)}`);
}

interface StdioRequest {
  method: string;
  params?: Record<string, unknown>;
  notification?: boolean;
}

/**
 * Spawn the configured MCP server, run `requests` sequentially over stdio and
 * resolve with the matching responses. The process is always terminated.
 *
 * `followUp` sees the response to the last request sent and may return one
 * more request to send in the same process (a `tools/list` page cursor);
 * its responses are appended in order.
 */
async function runStdioSession(
  config: IMcpStdioConfig,
  requests: StdioRequest[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  options: StdioRunOptions = {},
  followUp?: (response: JsonRpcResponse) => StdioRequest | null,
): Promise<JsonRpcResponse[]> {
  if (!isStdioRunnerEnabled()) {
    throw new Error('Stdio MCP execution is disabled on this deployment (MCP_STDIO_ENABLED=false)');
  }

  const { command, args } = buildCommand(config);
  const tenantEnv = openStdioEnv(config);
  const env = buildChildEnv(tenantEnv);
  // What the process writes to stderr ends up in the error a caller sees:
  // values it was given are masked before the tail is cut.
  const stderrSecrets = Object.values(tenantEnv);
  const stderrExcerpt = (tail: string) => maskSecretValues(tail, stderrSecrets).slice(-400);

  const releaseSlot = acquireSlot(options.tenantId);
  const child = (() => {
    try {
      return spawn(command, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // No shell: the package name and args are passed verbatim, never parsed.
        shell: false,
      });
    } catch (error) {
      releaseSlot();
      throw error;
    }
  })();

  const responses = new Map<number, JsonRpcResponse>();
  const expectedIds: number[] = [];
  let stdoutBuffer = '';
  let stderrTail = '';
  let stdoutBytes = 0;
  let settled = false;

  // A stopped agent turn ends the process instead of waiting for its answer.
  const turnSignal = currentTurnSignal();

  return await new Promise<JsonRpcResponse[]>((resolve, reject) => {
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      turnSignal?.removeEventListener('abort', onTurnAbort);
      releaseSlot();
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
        + (stderrTail ? ` — stderr: ${stderrExcerpt(stderrTail)}` : ''),
      ));
    }, timeoutMs);

    function onTurnAbort() {
      finish(new Error('The MCP call was cancelled'));
    }
    if (turnSignal?.aborted) onTurnAbort();
    else turnSignal?.addEventListener('abort', onTurnAbort, { once: true });

    child.on('error', (err) => {
      finish(new Error(`Failed to launch ${command}: ${err.message}`));
    });

    // A server that exits mid-write must surface as "exited before
    // responding", not as an uncaught EPIPE on stdin.
    child.stdin.on('error', () => { /* handled by the exit listener */ });

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
          // Some servers echo numeric ids back as strings — normalize.
          const id = typeof message.id === 'string' && /^\d+$/.test(message.id)
            ? Number(message.id)
            : message.id;
          if (typeof id === 'number' && (message.result !== undefined || message.error !== undefined)) {
            responses.set(id, message);
          }
        } catch {
          // Some servers log human text to stdout; ignore non-JSON lines.
        }
        // Pump first: a follow-up request it queues keeps the session open.
        pump();
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
          + (stderrTail ? ` — stderr: ${stderrExcerpt(stderrTail)}` : ''),
        ));
      }
    });

    // Send frames respecting the MCP lifecycle: after each request, wait for
    // its response before sending the next frame. Strict servers reject (or
    // drop) requests that arrive before `initialize` has completed.
    let nextId = 1;
    const frames: Array<{ payload: string; id?: number }> = [];
    const enqueue = (req: StdioRequest) => {
      if (req.notification) {
        frames.push({
          payload: JSON.stringify({ jsonrpc: JSONRPC_VERSION, method: req.method, ...(req.params ? { params: req.params } : {}) }),
        });
      } else {
        const id = nextId++;
        expectedIds.push(id);
        frames.push({
          payload: JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, method: req.method, ...(req.params ? { params: req.params } : {}) }),
          id,
        });
      }
    };
    for (const req of requests) enqueue(req);

    let cursor = 0;
    let awaitingId: number | null = null;
    function pump(): void {
      if (settled) return;
      if (awaitingId !== null && !responses.has(awaitingId)) return;
      if (awaitingId !== null && cursor >= frames.length && followUp) {
        const next = followUp(responses.get(awaitingId)!);
        if (next) enqueue(next);
      }
      awaitingId = null;
      while (cursor < frames.length) {
        const frame = frames[cursor];
        cursor += 1;
        try {
          child.stdin.write(`${frame.payload}\n`);
        } catch { /* exit handler reports the failure */ }
        if (frame.id !== undefined) {
          awaitingId = frame.id;
          return;
        }
      }
    }
    pump();
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

/**
 * Discover a stdio server by spawning it once: its `instructions` (from the
 * initialize result) and every `tools/list` page, followed in the same process.
 */
export async function stdioDiscover(
  config: IMcpStdioConfig,
  options: StdioRunOptions = {},
): Promise<McpDiscovery> {
  const seenCursors = new Set<string>();
  const [initRes, ...listResponses] = await runStdioSession(config, [
    INITIALIZE_REQUEST,
    INITIALIZED_NOTIFICATION,
    { method: 'tools/list', params: {} },
  ], DEFAULT_TIMEOUT_MS, options, (response) => {
    const { nextCursor } = readToolListPage(response.result);
    if (nextCursor === undefined || seenCursors.has(nextCursor) || seenCursors.size + 1 >= MAX_TOOL_LIST_PAGES) {
      return null;
    }
    seenCursors.add(nextCursor);
    return { method: 'tools/list', params: { cursor: nextCursor } };
  });

  if (initRes.error) {
    throw new Error(`MCP initialize failed: ${initRes.error.message ?? 'unknown error'}`);
  }
  const listError = listResponses.find((res) => res.error)?.error;
  if (listError) {
    throw new Error(`tools/list failed: ${listError.message ?? 'unknown error'}`);
  }

  const tools = listResponses.flatMap((res) => readToolListPage(res.result).tools);

  logger.info('Discovered stdio MCP tools', {
    package: config.packageName,
    runtime: config.runtime,
    toolCount: tools.length,
    pages: listResponses.length,
  });

  return { tools, instructions: readInitializeInstructions(initRes.result) };
}

/** Discover tools by spawning the stdio server once. */
export async function stdioListTools(
  config: IMcpStdioConfig,
  options: StdioRunOptions = {},
): Promise<IMcpTool[]> {
  return (await stdioDiscover(config, options)).tools;
}

/** Execute one tool call by spawning the stdio server once. */
export async function stdioCallTool(
  config: IMcpStdioConfig,
  toolName: string,
  args: Record<string, unknown>,
  options: StdioRunOptions = {},
): Promise<unknown> {
  const [initRes, callRes] = await runStdioSession(config, [
    INITIALIZE_REQUEST,
    INITIALIZED_NOTIFICATION,
    { method: 'tools/call', params: { name: toolName, arguments: args } },
  ], DEFAULT_TIMEOUT_MS, options);

  if (initRes.error) {
    throw new Error(`MCP initialize failed: ${initRes.error.message ?? 'unknown error'}`);
  }
  if (callRes.error) {
    throw new Error(`MCP tool error: ${callRes.error.message ?? 'unknown error'}`);
  }

  return readToolCallResult(callRes.result);
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
