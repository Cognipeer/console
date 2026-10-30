/**
 * Internal MCP providers: Sandbox and Persistent sandbox.
 *
 * Both serve the enterprise sandbox module as MCP tools — run a command, run
 * code, read / write / list files — through the same `agentSandboxRunner` seam
 * an agent's sandbox tools use, so the two surfaces behave alike.
 *
 *  - `sandbox` (instance = a template): the caller starts its own sandboxes
 *    from the server's template with `sandbox_create` and passes the returned
 *    `sandboxId` to every other tool. SANDBOXES ARE EXPLICIT for the reason
 *    browser sessions are (see `browserProvider.ts`): a tool call carries no
 *    transport session and may reach another node. A sandbox is usable only
 *    through the MCP server that created it (its `createdBy` is
 *    `mcp:<serverKey>`); one the caller forgets to delete is closed by the
 *    sandbox module's idle timeout like any non-persistent sandbox.
 *  - `sandbox-instance` (instance = a persistent sandbox of the project): the
 *    tools work in that one machine — started when it is stopped, and never
 *    created, stopped or deleted here.
 *
 * A server on either provider runs code, so it is TOKEN-ONLY: never public,
 * and neither is a composite that includes it. Enterprise only, like an
 * agent's sandbox: the module must be present and the tenant licensed,
 * checked on every call. What the sandbox's launch carries (its secret Config
 * items) is masked in every result, as it is for an agent.
 */

import { McpToolInputError } from '../errors';
import { scrubSecretValues } from '@/lib/services/agents/agentSandboxSecrets';
import type { AgentSandboxExecResult, AgentSandboxRef, AgentSandboxRunner } from '@/enterprise/registry';
import type { SandboxAvailability } from '@/lib/services/agents/sandboxAvailability';
import type { IMcpTool } from '@/lib/database';
import type { InternalMcpInstanceOption, InternalMcpProvider, InternalMcpProviderContext } from './types';

/**
 * Loaded on first use, not at module scope: the enterprise registry imports
 * the API plugins (and through them this file), so a static import would put
 * `@/enterprise/registry` in its own import phase — the cycle that file warns
 * about.
 */
async function resolveSandboxAvailability(tenantId: string): Promise<SandboxAvailability> {
  const { resolveSandboxAvailability: resolve } = await import('@/lib/services/agents/sandboxAvailability');
  return resolve(tenantId);
}

const WORKDIR = '/workspace';
const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 600;
/** Per stream: the end of a long log is what explains a failure. */
const MAX_STREAM_CHARS = 16_000;
/** A file read returns at most this much text. */
const MAX_FILE_CHARS = 200_000;
/** Longest piece of a caller-supplied id an error repeats back. */
const ECHOED_ID_MAX_CHARS = 100;
/** States a created sandbox cannot come back from. */
const ENDED_STATES = new Set(['failed', 'deleted']);

const TOOL_CREATE = 'sandbox_create';
const TOOL_DELETE = 'sandbox_delete';
const TOOL_EXEC = 'sandbox_exec';
const TOOL_RUN_CODE = 'sandbox_run_code';
const TOOL_READ_FILE = 'sandbox_read_file';
const TOOL_WRITE_FILE = 'sandbox_write_file';
const TOOL_LIST_FILES = 'sandbox_list_files';

const LANGUAGES = ['python', 'javascript', 'typescript', 'bash'] as const;
type Language = typeof LANGUAGES[number];

// ── Tool list ─────────────────────────────────────────────────────────────

const SANDBOX_ID_PROPERTY = { type: 'string', description: 'The sandboxId returned by sandbox_create.' };
const TIMEOUT_PROPERTY = {
  type: 'integer',
  minimum: 1,
  maximum: MAX_TIMEOUT_SEC,
  description: `Seconds before the command is stopped. Default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}.`,
};

function annotations(title: string, readOnly: boolean, destructive = !readOnly) {
  return { title, readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: readOnly, openWorldHint: true };
}

/** The work tools; `withSandboxId` adds the `sandboxId` argument the Sandbox provider's tools take. */
function workTools(withSandboxId: boolean): IMcpTool[] {
  const schema = (properties: Record<string, unknown>, required: string[]) => ({
    type: 'object',
    properties: withSandboxId ? { sandboxId: SANDBOX_ID_PROPERTY, ...properties } : properties,
    required: withSandboxId ? ['sandboxId', ...required] : required,
  });
  return [
    {
      name: TOOL_EXEC,
      description: `Run a shell command in the sandbox (working directory ${WORKDIR}). Returns exitCode, stdout and stderr; long output keeps its end.`,
      inputSchema: schema({
        command: { type: 'string', description: 'The shell command, e.g. "ls -la" or "pip install pandas && python main.py".' },
        cwd: { type: 'string', description: `Working directory. Default ${WORKDIR}.` },
        timeoutSec: TIMEOUT_PROPERTY,
      }, ['command']),
      annotations: annotations('Run a command', false),
    },
    {
      name: TOOL_RUN_CODE,
      description: 'Run a snippet of code in the sandbox and return its output (exitCode, stdout, stderr).',
      inputSchema: schema({
        language: { type: 'string', enum: [...LANGUAGES] },
        code: { type: 'string' },
        timeoutSec: TIMEOUT_PROPERTY,
      }, ['language', 'code']),
      annotations: annotations('Run code', false),
    },
    {
      name: TOOL_READ_FILE,
      description: `Read a text file from the sandbox. Relative paths are under ${WORKDIR}. Returns at most ${MAX_FILE_CHARS.toLocaleString('en-US')} characters.`,
      inputSchema: schema({ path: { type: 'string' } }, ['path']),
      annotations: annotations('Read a file', true),
    },
    {
      name: TOOL_WRITE_FILE,
      description: `Write a text file in the sandbox, creating parent folders. Relative paths are under ${WORKDIR}. Overwrites an existing file.`,
      inputSchema: schema({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
      annotations: annotations('Write a file', false),
    },
    {
      name: TOOL_LIST_FILES,
      description: `List a folder in the sandbox. Default ${WORKDIR}.`,
      inputSchema: schema({ path: { type: 'string' } }, []),
      annotations: annotations('List files', true),
    },
  ];
}

const SANDBOX_TOOLS: IMcpTool[] = [
  {
    name: TOOL_CREATE,
    description:
      'Start a new sandbox from this server\'s template and return its `sandboxId`. Pass that id to every other '
      + 'sandbox_* tool, and call sandbox_delete when the work is done — an idle sandbox is deleted automatically.',
    inputSchema: { type: 'object', properties: {} },
    annotations: annotations('Start a sandbox', false, false),
  },
  ...workTools(true),
  {
    name: TOOL_DELETE,
    description: 'Delete a sandbox this server started, with everything in it.',
    inputSchema: { type: 'object', properties: { sandboxId: SANDBOX_ID_PROPERTY }, required: ['sandboxId'] },
    annotations: { ...annotations('Delete a sandbox', false), idempotentHint: true },
  },
];

const INSTANCE_TOOLS: IMcpTool[] = workTools(false);

// ── Shared plumbing ───────────────────────────────────────────────────────

async function requireRunner(ctx: InternalMcpProviderContext): Promise<AgentSandboxRunner> {
  const availability = await resolveSandboxAvailability(ctx.tenantId);
  if (availability.available) return availability.runner;
  throw new Error(availability.reason === 'license'
    ? 'Sandbox tools require an Enterprise license'
    : 'This edition has no sandbox module');
}

function requireServerKey(ctx: InternalMcpProviderContext): string {
  if (!ctx.serverKey) throw new Error('Sandbox tools must be called through an MCP server');
  return ctx.serverKey;
}

function actorOf(serverKey: string): string {
  return `mcp:${serverKey}`;
}

/** The runner's view of a call: the server's project, acted on by the server. */
function refOf(ctx: InternalMcpProviderContext, serverKey?: string): AgentSandboxRef {
  if (!ctx.projectId) throw new Error('Sandbox tools need the MCP server\'s project');
  return {
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    agentKey: serverKey ? `mcp-${serverKey}` : 'mcp',
    ...(serverKey ? { actor: actorOf(serverKey) } : {}),
  };
}

function stringArg(args: Record<string, unknown>, name: string, options: { required?: boolean } = {}): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === '') {
    if (options.required) throw new McpToolInputError(`"${name}" is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new McpToolInputError(`"${name}" must be a string`);
  return value;
}

function timeoutArg(args: Record<string, unknown>): number {
  const value = args.timeoutSec;
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_SEC;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new McpToolInputError('"timeoutSec" must be a positive number');
  }
  return Math.min(MAX_TIMEOUT_SEC, Math.round(value));
}

function resolvePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith('/')) return trimmed;
  return `${WORKDIR}/${trimmed.replace(/^\.\//, '')}`;
}

/** Keeps the END of a long stream — that is where errors are. */
function tail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `… [${(text.length - limit).toLocaleString('en-US')} earlier characters omitted]\n${text.slice(-limit)}`;
}

/**
 * Runs one work tool in `instanceId`. Everything returned — and the message of anything thrown — is masked for
 * the values the sandbox's launch carries.
 */
async function runWorkTool(
  runner: AgentSandboxRunner,
  ref: AgentSandboxRef,
  instanceId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const launchSecrets = await runner.launchSecretValues?.(ref, instanceId).catch(() => []) ?? [];
  const scrub = (text: string) => scrubSecretValues(text, {}, launchSecrets);
  const shapeExec = (result: AgentSandboxExecResult) => ({
    exitCode: result.exitCode,
    // Masked before cut: a value the cut would split is not left half visible.
    stdout: tail(scrub(result.stdout ?? ''), MAX_STREAM_CHARS),
    stderr: tail(scrub(result.stderr ?? ''), MAX_STREAM_CHARS),
  });
  try {
    switch (toolName) {
      case TOOL_EXEC:
        return shapeExec(await runner.exec(ref, instanceId, {
          command: stringArg(args, 'command', { required: true })!,
          cwd: stringArg(args, 'cwd') ?? WORKDIR,
          timeoutSec: timeoutArg(args),
        }));
      case TOOL_RUN_CODE: {
        const language = stringArg(args, 'language', { required: true }) as Language;
        if (!LANGUAGES.includes(language)) {
          throw new McpToolInputError(`"language" must be one of: ${LANGUAGES.join(', ')}`);
        }
        return shapeExec(await runner.runCode(ref, instanceId, {
          language,
          code: stringArg(args, 'code', { required: true })!,
          timeoutSec: timeoutArg(args),
        }));
      }
      case TOOL_READ_FILE: {
        const path = resolvePath(stringArg(args, 'path', { required: true })!);
        const content = scrub(await runner.readFile(ref, instanceId, path));
        return content.length > MAX_FILE_CHARS
          ? { path, content: content.slice(0, MAX_FILE_CHARS), truncated: true, totalChars: content.length }
          : { path, content };
      }
      case TOOL_WRITE_FILE: {
        const path = resolvePath(stringArg(args, 'path', { required: true })!);
        const content = typeof args.content === 'string' ? args.content : undefined;
        if (content === undefined) throw new McpToolInputError('"content" must be a string');
        await runner.writeFile(ref, instanceId, path, content);
        return { ok: true, path, bytes: Buffer.byteLength(content, 'utf8') };
      }
      case TOOL_LIST_FILES: {
        const entries = await runner.listFiles(ref, instanceId, resolvePath(stringArg(args, 'path') ?? WORKDIR));
        return entries.map((entry) => ({ ...entry, name: scrub(entry.name), path: scrub(entry.path) }));
      }
      default:
        throw new McpToolInputError(`Unknown sandbox tool "${toolName}"`);
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const clean = scrub(text);
    if (clean === text) throw error;
    const masked = error instanceof McpToolInputError ? new McpToolInputError(clean) : new Error(clean);
    throw masked;
  }
}

// ── Sandbox (new sandboxes from a template) ───────────────────────────────

/** The `sandboxId` argument, if it names a sandbox THIS server started; else the same "not found" for any other. */
async function requireOwnSandbox(
  runner: AgentSandboxRunner,
  ref: AgentSandboxRef,
  serverKey: string,
  raw: unknown,
): Promise<string> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new McpToolInputError(`"sandboxId" is required — start one with ${TOOL_CREATE}`);
  }
  const id = raw.trim();
  const echoed = id.slice(0, ECHOED_ID_MAX_CHARS);
  if (!runner.describeInstance) throw new Error('This sandbox module cannot look up a sandbox');
  const found = await runner.describeInstance(ref, id);
  // One made anywhere else — the dashboard, an agent, another MCP server — reads exactly like an unknown id.
  if (!found || found.createdBy !== actorOf(serverKey)) {
    throw new McpToolInputError(`Sandbox "${echoed}" not found`);
  }
  if (ENDED_STATES.has(found.state)) {
    throw new McpToolInputError(`Sandbox "${echoed}" has ended (${found.state}) — start a new one with ${TOOL_CREATE}`);
  }
  return id;
}

async function templateByKey(runner: AgentSandboxRunner, ctx: InternalMcpProviderContext, key: string) {
  const templates = await runner.listTemplates(ctx.tenantDbName, ctx.tenantId);
  return templates.find((template) => template.key === key);
}

async function isSandboxAvailable(ctx: Pick<InternalMcpProviderContext, 'tenantId'>): Promise<boolean> {
  return (await resolveSandboxAvailability(ctx.tenantId)).available;
}

export const sandboxProvider: InternalMcpProvider = {
  id: 'sandbox',
  label: 'Sandbox',
  description:
    'Start isolated sandboxes from a template and run commands and code, and read and write files, in them.',
  configFields: [],
  tokenOnly: true,
  isAvailable: isSandboxAvailable,

  async listInstances(ctx): Promise<InternalMcpInstanceOption[]> {
    const availability = await resolveSandboxAvailability(ctx.tenantId);
    if (!availability.available) return [];
    const templates = await availability.runner.listTemplates(ctx.tenantDbName, ctx.tenantId);
    return templates.map((template) => ({
      key: template.key,
      label: template.name,
      ...(template.description ? { description: template.description } : {}),
    }));
  },

  async validateInstance(ctx, instanceKey) {
    const runner = await requireRunner(ctx);
    if (!runner.describeInstance) throw new Error('This sandbox module cannot serve sandboxes over MCP');
    if (!(await templateByKey(runner, ctx, instanceKey))) {
      throw new Error(`Sandbox template "${instanceKey}" not found`);
    }
  },

  async buildTools(ctx, instanceKey) {
    const availability = await resolveSandboxAvailability(ctx.tenantId);
    const template = availability.available ? await templateByKey(availability.runner, ctx, instanceKey).catch(() => undefined) : undefined;
    const name = template?.name ?? instanceKey;
    return {
      tools: SANDBOX_TOOLS,
      suggestedName: `${name} sandbox`,
      suggestedDescription: `Isolated "${name}" sandboxes to run commands and code in.`,
      instructions:
        `Every tool works in a sandbox you start: call "${TOOL_CREATE}" first and pass the sandboxId it returns `
        + `to each sandbox_* tool, then call ${TOOL_DELETE} when the work is done (an idle sandbox is deleted on its `
        + `own). Files and installed packages stay in a sandbox until it is deleted. The working directory is ${WORKDIR}.`,
    };
  },

  async execute(ctx, instanceKey, _config, toolName, args) {
    const serverKey = requireServerKey(ctx);
    const runner = await requireRunner(ctx);
    const ref = refOf(ctx, serverKey);

    if (toolName === TOOL_CREATE) {
      const { instanceId } = await runner.ensureInstance(ref, {
        templateKey: instanceKey,
        // Never persistent: the sandbox module's idle timeout closes what a caller leaves behind.
        persist: false,
        name: `mcp-${serverKey}`.slice(0, 48),
        preview: { enabled: false, public: false },
        idleStopSeconds: null,
      });
      return {
        ok: true,
        sandboxId: instanceId,
        hint: `Pass sandboxId to the other sandbox_* tools; call ${TOOL_DELETE} when done.`,
      };
    }

    const { sandboxId, ...toolArgs } = args;
    const instanceId = await requireOwnSandbox(runner, ref, serverKey, sandboxId);
    if (toolName === TOOL_DELETE) {
      await runner.destroy(ref, instanceId);
      return { ok: true, sandboxId: instanceId, deleted: true };
    }
    return runWorkTool(runner, ref, instanceId, toolName, toolArgs);
  },
};

// ── Persistent sandbox (one existing machine) ─────────────────────────────

/** The server's persistent sandbox, in its project and still persistent; else an error naming why. */
async function requirePersistentSandbox(runner: AgentSandboxRunner, ref: AgentSandboxRef, instanceKey: string) {
  if (!runner.describeInstance) throw new Error('This sandbox module cannot serve a sandbox over MCP');
  const found = await runner.describeInstance(ref, instanceKey);
  if (!found) throw new Error(`Sandbox "${instanceKey}" not found in this project`);
  if (!found.persist) {
    throw new Error(`Sandbox "${found.name}" is not persistent — publish a persistent sandbox, or use the Sandbox service to start new ones`);
  }
  return found;
}

export const sandboxInstanceProvider: InternalMcpProvider = {
  id: 'sandbox-instance',
  label: 'Persistent sandbox',
  description:
    'Run commands and code, and read and write files, in one of this project\'s persistent sandboxes.',
  configFields: [],
  tokenOnly: true,
  isAvailable: isSandboxAvailable,

  async listInstances(ctx): Promise<InternalMcpInstanceOption[]> {
    const availability = await resolveSandboxAvailability(ctx.tenantId);
    if (!availability.available || !availability.runner.listInstances || !ctx.projectId) return [];
    const instances = await availability.runner.listInstances(ctx.tenantDbName, ctx.tenantId, ctx.projectId, { persist: true });
    return instances.map((instance) => ({
      key: instance.id,
      label: instance.name,
      description: [instance.state, instance.templateKey].filter(Boolean).join(' · '),
    }));
  },

  async validateInstance(ctx, instanceKey) {
    const runner = await requireRunner(ctx);
    await requirePersistentSandbox(runner, refOf(ctx), instanceKey);
  },

  async buildTools(ctx, instanceKey) {
    const availability = await resolveSandboxAvailability(ctx.tenantId);
    const found = availability.available && availability.runner.describeInstance && ctx.projectId
      ? await availability.runner.describeInstance(refOf(ctx), instanceKey).catch(() => null)
      : null;
    const name = found?.name ?? instanceKey;
    return {
      tools: INSTANCE_TOOLS,
      suggestedName: `${name} (sandbox)`,
      suggestedDescription: `Commands, code and files in the persistent sandbox "${name}".`,
      instructions:
        `Every tool works in the same persistent sandbox "${name}": files and installed packages stay between `
        + `calls and callers, so anything written there can be seen by every other user of the sandbox. `
        + `The working directory is ${WORKDIR}.`,
    };
  },

  async execute(ctx, instanceKey, _config, toolName, args) {
    const serverKey = requireServerKey(ctx);
    const runner = await requireRunner(ctx);
    const ref = refOf(ctx, serverKey);
    await requirePersistentSandbox(runner, ref, instanceKey);
    // Started when it is stopped; otherwise left exactly as it is.
    await runner.ensureInstance(ref, { attach: true, instanceId: instanceKey, persist: true });
    return runWorkTool(runner, ref, instanceKey, toolName, args);
  },
};
