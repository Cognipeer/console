/**
 * Sandbox access for an agent: the tools, and the sandbox behind them.
 *
 * Built from `config.sandbox` for every run. Nothing is provisioned until the
 * model actually calls a sandbox tool — an agent that could use a sandbox but
 * answers from memory costs no machine.
 *
 *  - `session` (default): one sandbox per conversation, recorded on the
 *    conversation (`metadata.sandbox`) as soon as it exists. It is left
 *    running when a run ends and reused by the next turn; the sandbox module
 *    closes it (a full delete) after its own idle timeout, and every command
 *    counts as activity. The conversation's record then points at nothing and
 *    the next message gets a fresh sandbox. Without a conversation (a
 *    stateless playground call) there is nothing to keep it against, so the
 *    run is per-message.
 *  - `ephemeral`: a fresh sandbox for the run, deleted when the run ends.
 *
 * Secrets are decrypted per run and passed to each command as environment
 * variables — never set on the instance, so they are not stored on its row —
 * and scrubbed from every output before the model sees it.
 *
 * Enterprise only: the sandbox module ships in the enterprise overlay
 * (`agentSandboxRunner` seam) AND the tenant needs an active Enterprise
 * license, checked here, per run. A config that asks for a sandbox it cannot
 * have runs without the tools and says why (a run warning), rather than fail.
 */

import { createLogger } from '@/lib/core/logger';
import {
    agentSandboxRunner,
    type AgentSandboxExecResult,
    type AgentSandboxRef,
    type AgentSandboxRunner,
} from '@/enterprise/registry';
import { getDatabase, type IAgentConversation, type IAgentSandboxConfig } from '@/lib/database';
import { isTenantEnterpriseLicensed } from '@/lib/license/tenantLicense';
import type { TraceToolDefinition } from '@/lib/services/tracingToolDefinitions';
import { resolveSandboxMode } from './agentSandboxMode';
import { openAgentSandboxSecrets, scrubSecretValues } from './agentSandboxSecrets';

const logger = createLogger('agent-sandbox');

const DEFAULT_LINK_TTL_HOURS = 24;
const MAX_LINK_TTL_HOURS = 168;
const DEFAULT_KEEP_ALIVE_MINUTES = 30;

const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 600;
/** Per stream: a build log can be megabytes, and the end is what explains a failure. */
const MAX_STREAM_CHARS = 16_000;
const MAX_FILE_CHARS = 100_000;
const WORKDIR = '/workspace';

/** What a session sandbox leaves on its conversation. */
export interface ConversationSandboxRecord {
    instanceId: string;
    templateKey?: string;
    /**
     * Set on every record this version writes. A record without it belongs to
     * a sandbox made when `persist` meant "stop between turns" — a machine the
     * idle reaper never closes — so it is replaced rather than adopted.
     */
    lifecycle?: 'session';
    createdAt: string;
    lastUsedAt: string;
}

export type SandboxAvailability =
    | { available: true; runner: AgentSandboxRunner }
    | { available: false; reason: 'edition' | 'license' };

/** Whether this deployment and tenant can give agents a sandbox at all. */
export async function resolveSandboxAvailability(tenantId: string): Promise<SandboxAvailability> {
    // Optional chaining on the REF too: an overlay registry from before seam 4
    // replaces this file without exporting `agentSandboxRunner` at all, and
    // that mismatch must read as "no sandbox module", not crash every agent.
    const runner = agentSandboxRunner?.current;
    if (!runner) return { available: false, reason: 'edition' };
    if (!(await isTenantEnterpriseLicensed(tenantId))) return { available: false, reason: 'license' };
    return { available: true, runner };
}

function sandboxUnavailableMessage(reason: 'edition' | 'license'): string {
    return reason === 'license'
        ? 'Sandbox access requires an Enterprise license; the agent ran without its sandbox tools.'
        : 'Sandbox access is configured, but this edition has no sandbox module; the agent ran without its sandbox tools.';
}

function clampTimeout(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_SEC;
    return Math.min(MAX_TIMEOUT_SEC, Math.round(value));
}

/** Keeps the END of a long stream — that is where errors are. */
function tail(text: string, limit: number): string {
    if (text.length <= limit) return text;
    return `… [${(text.length - limit).toLocaleString()} earlier characters omitted]\n${text.slice(-limit)}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = any;

export interface BuildAgentSandboxToolsInput {
    sandbox: IAgentSandboxConfig | undefined;
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    agentKey: string;
    /** The Session / API conversation — required for `session`. */
    conversation?: Pick<IAgentConversation, '_id' | 'metadata'> | null;
    createToolFn: typeof import('@cognipeer/agent-sdk').createTool;
    zod: typeof import('zod').z;
    /** Wraps a built tool with the agent's tool guardrails. */
    protect: (policyName: string, tool: AnyTool) => AnyTool;
    onWarning: (message: string) => void;
}

export interface AgentSandboxTools {
    tools: AnyTool[];
    definitions: TraceToolDefinition[];
    /** Deletes the sandbox this run used (ephemeral); a session sandbox is left up and only recorded. */
    cleanup: () => Promise<void>;
}

const NO_TOOLS: AgentSandboxTools = { tools: [], definitions: [], cleanup: async () => undefined };

export async function buildAgentSandboxTools(input: BuildAgentSandboxToolsInput): Promise<AgentSandboxTools> {
    const config = input.sandbox;
    if (!config?.enabled) return NO_TOOLS;

    const availability = await resolveSandboxAvailability(input.tenantId);
    if (!availability.available) {
        input.onWarning(sandboxUnavailableMessage(availability.reason));
        return NO_TOOLS;
    }
    const { runner } = availability;

    const conversationId = input.conversation?._id ? String(input.conversation._id) : undefined;
    const mode = resolveSandboxMode(config.mode);
    const sessionConversationId = mode === 'session' ? conversationId : undefined;
    const session = Boolean(sessionConversationId);
    if (mode === 'session' && !conversationId) {
        logger.debug('Session sandbox requested without a conversation; running per-message', { agentKey: input.agentKey });
    }
    const ref: AgentSandboxRef = {
        tenantDbName: input.tenantDbName,
        tenantId: input.tenantId,
        projectId: input.projectId,
        agentKey: input.agentKey,
        ...(sessionConversationId ? { conversationId: sessionConversationId } : {}),
    };
    const timeoutSec = clampTimeout(config.commandTimeoutSec);
    const secrets = openAgentSandboxSecrets(config);
    const scrub = (text: string) => scrubSecretValues(text, secrets);
    const preview = config.preview?.enabled
        ? {
            public: config.preview.public === true,
            ttlSeconds: Math.round(Math.min(MAX_LINK_TTL_HOURS, Math.max(1, config.preview.linkTtlHours ?? DEFAULT_LINK_TTL_HOURS)) * 3600),
            keepAliveSeconds: Math.round(Math.max(1, config.preview.keepAliveMinutes ?? DEFAULT_KEEP_ALIVE_MINUTES) * 60),
        }
        : null;
    /** Set once the agent hands out a link: the machine must outlive the reply. */
    let previewIssued = false;

    // ── The instance, provisioned on first use ───────────────────────────
    let instance: Promise<string> | null = null;
    let createdAt: string | undefined;

    /**
     * Writes the conversation's sandbox record. `metadata` is replaced
     * wholesale by the database layer, so the write starts from a fresh read —
     * the transcript write for this turn may have landed after the
     * conversation was loaded, and merging into a stale copy would drop it.
     */
    const saveRecord = async (instanceId: string): Promise<void> => {
        if (!sessionConversationId) return;
        const db = await getDatabase();
        await db.switchToTenant(input.tenantDbName);
        const latest = await db.findAgentConversationById(sessionConversationId);
        const now = new Date().toISOString();
        const record: ConversationSandboxRecord = {
            instanceId,
            ...(config.templateKey ? { templateKey: config.templateKey } : {}),
            lifecycle: 'session',
            createdAt: createdAt ?? now,
            lastUsedAt: now,
        };
        await db.updateAgentConversation(sessionConversationId, {
            metadata: { ...(latest?.metadata ?? {}), sandbox: record },
        });
    };

    const provision = async (): Promise<string> => {
        let previous: ConversationSandboxRecord | undefined;
        if (sessionConversationId) {
            const db = await getDatabase();
            await db.switchToTenant(input.tenantDbName);
            const fresh = await db.findAgentConversationById(sessionConversationId);
            previous = fresh?.metadata?.sandbox as ConversationSandboxRecord | undefined;
            if (previous && (previous.lifecycle !== 'session'
                || (config.templateKey && previous.templateKey && previous.templateKey !== config.templateKey))) {
                // Made under the old `persist` (a machine the idle reaper never
                // closes), or the agent now wants a different template: start over.
                await runner.destroy(ref, previous.instanceId).catch((error: unknown) => {
                    logger.warn('Could not delete a replaced conversation sandbox', { error: String(error) });
                });
                previous = undefined;
            }
        }
        const { instanceId, created } = await runner.ensureInstance(ref, {
            templateKey: config.templateKey,
            // Never a persistent machine: a stop is then a full close, and the
            // sandbox module's idle reaper applies — that is what ends a session.
            persist: false,
            ...(config.resources ? { resources: config.resources } : {}),
            ...(config.blockNetwork ? { blockNetwork: true } : {}),
            ...(config.env && Object.keys(config.env).length > 0 ? { env: config.env } : {}),
            ...(previous?.instanceId ? { instanceId: previous.instanceId } : {}),
            preview: { enabled: Boolean(preview), public: preview?.public ?? false },
            // A previewing machine is stopped by the sandbox module's reaper
            // once idle, not by this run — see `cleanup`.
            idleStopSeconds: preview ? preview.keepAliveSeconds : null,
        });
        createdAt = created || !previous ? new Date().toISOString() : previous.createdAt;
        logger.info('Agent sandbox ready', {
            agentKey: input.agentKey,
            instanceId,
            created,
            session,
            // A record pointed at a machine that has since been closed.
            replaced: Boolean(created && previous),
        });
        // Recorded now, not when the run ends: a run that never gets to clean
        // up (a restart, a crash) must not orphan the machine it just made.
        await saveRecord(instanceId).catch((error: unknown) => {
            logger.warn('Could not record the conversation sandbox', { instanceId, error: error instanceof Error ? error.message : String(error) });
        });
        return instanceId;
    };

    const getInstance = (): Promise<string> => {
        if (!instance) {
            instance = provision().catch((error: unknown) => {
                instance = null; // let the next call retry
                throw error;
            });
        }
        return instance;
    };

    const shapeExec = (result: AgentSandboxExecResult) => ({
        exitCode: result.exitCode,
        stdout: scrub(tail(result.stdout ?? '', MAX_STREAM_CHARS)),
        stderr: scrub(tail(result.stderr ?? '', MAX_STREAM_CHARS)),
    });

    const lifetime = session
        ? 'Files and installed packages stay across turns of this conversation while you keep using the sandbox. After a long idle period it is shut down and the next use starts a fresh, empty one.'
        : 'The sandbox is discarded when this reply is finished.';
    const secretNote = Object.keys(secrets).length > 0
        ? ` Environment variables available to commands: ${Object.keys(secrets).join(', ')} (secret — never print them).`
        : '';

    const z = input.zod;
    const toolsEnabled = { exec: true, code: true, files: true, ...(config.tools ?? {}) };
    const tools: AnyTool[] = [];
    const definitions: TraceToolDefinition[] = [];
    const add = (tool: AnyTool) => {
        tools.push(input.protect(`agent.sandbox.${tool.name}`, tool));
        definitions.push({ name: tool.name, description: tool.description });
    };

    if (toolsEnabled.exec) {
        add(input.createToolFn({
            name: 'sandbox_exec',
            description: `Run a shell command in your Linux sandbox (working directory ${WORKDIR}). Returns exitCode, stdout and stderr. Times out after ${timeoutSec}s. ${lifetime}${secretNote}`,
            schema: z.object({
                command: z.string().min(1).describe('The shell command to run, e.g. "ls -la" or "pip install pandas && python main.py".'),
                cwd: z.string().optional().describe(`Working directory. Default ${WORKDIR}.`),
            }),
            func: async (args: { command: string; cwd?: string }) => {
                const instanceId = await getInstance();
                return shapeExec(await runner.exec(ref, instanceId, {
                    command: args.command,
                    cwd: args.cwd || WORKDIR,
                    env: secrets,
                    timeoutSec,
                }));
            },
        }));
    }
    if (toolsEnabled.code) {
        add(input.createToolFn({
            name: 'sandbox_run_code',
            description: `Run a snippet of code in your sandbox and return its output (exitCode, stdout, stderr). Times out after ${timeoutSec}s. ${lifetime}`,
            schema: z.object({
                language: z.enum(['python', 'javascript', 'typescript', 'bash']),
                code: z.string().min(1),
            }),
            func: async (args: { language: 'python' | 'javascript' | 'typescript' | 'bash'; code: string }) => {
                const instanceId = await getInstance();
                return shapeExec(await runner.runCode(ref, instanceId, {
                    language: args.language,
                    code: args.code,
                    env: secrets,
                    timeoutSec,
                }));
            },
        }));
    }
    if (toolsEnabled.files) {
        add(input.createToolFn({
            name: 'sandbox_read_file',
            description: `Read a text file from your sandbox. Relative paths are under ${WORKDIR}.`,
            schema: z.object({ path: z.string().min(1) }),
            func: async (args: { path: string }) => {
                const instanceId = await getInstance();
                const content = await runner.readFile(ref, instanceId, resolvePath(args.path));
                const clipped = content.length > MAX_FILE_CHARS
                    ? `${content.slice(0, MAX_FILE_CHARS)}\n… [truncated: ${content.length.toLocaleString()} characters in total]`
                    : content;
                return scrub(clipped);
            },
        }));
        add(input.createToolFn({
            name: 'sandbox_write_file',
            description: `Write a text file in your sandbox, creating parent folders. Relative paths are under ${WORKDIR}. Overwrites an existing file.`,
            schema: z.object({ path: z.string().min(1), content: z.string() }),
            func: async (args: { path: string; content: string }) => {
                const instanceId = await getInstance();
                const path = resolvePath(args.path);
                await runner.writeFile(ref, instanceId, path, args.content);
                return { ok: true, path, bytes: Buffer.byteLength(args.content, 'utf8') };
            },
        }));
        add(input.createToolFn({
            name: 'sandbox_list_files',
            description: `List a folder in your sandbox. Default ${WORKDIR}.`,
            schema: z.object({ path: z.string().optional() }),
            func: async (args: { path?: string }) => {
                const instanceId = await getInstance();
                return runner.listFiles(ref, instanceId, resolvePath(args.path || WORKDIR));
            },
        }));
    }

    if (preview) {
        add(input.createToolFn({
            name: 'sandbox_preview_link',
            description: `Get a link to something your sandbox serves on a port — a web app, an HTML report, a dashboard — to give to the user. Start the server first, in the background and bound to 0.0.0.0 (e.g. sandbox_exec "nohup python3 -m http.server 8000 --bind 0.0.0.0 > /tmp/server.log 2>&1 &"), then call this with the port. ${preview.public
                ? `The link is public: anyone who has it can open it for ${Math.round(preview.ttlSeconds / 3600)}h.`
                : 'The link opens only for signed-in console users.'} The sandbox keeps running after your reply while the preview is in use, and stops after ${Math.round(preview.keepAliveSeconds / 60)} idle minutes.`,
            schema: z.object({
                port: z.number().int().min(1).max(65535).describe('The port the server listens on inside the sandbox.'),
            }),
            func: async (args: { port: number }) => {
                const instanceId = await getInstance();
                const link = await runner.previewLink(ref, instanceId, {
                    port: args.port,
                    public: preview.public,
                    ttlSeconds: preview.ttlSeconds,
                });
                previewIssued = true;
                return {
                    ...link,
                    ...(link.listening ? {} : {
                        warning: `Nothing answered on port ${args.port} yet — start the server (bound to 0.0.0.0) before sharing the link.`,
                    }),
                };
            },
        }));
    }

    const cleanup = async () => {
        if (!instance) return;
        let instanceId: string;
        try {
            instanceId = await instance;
        } catch {
            return; // never provisioned
        }
        try {
            if (previewIssued) {
                // The link must keep working after the reply: leave the
                // machine running. The sandbox module stops it once the
                // preview has been idle for `keepAliveMinutes`
                // (idleStopSeconds on the instance).
                logger.info('Agent sandbox left running for its preview', { agentKey: input.agentKey, instanceId });
            } else if (!session) {
                await runner.destroy(ref, instanceId);
            }
            // A session sandbox is left up on purpose: the next turn reuses it,
            // and the sandbox module closes it once it has sat idle.
            if (session) await saveRecord(instanceId);
        } catch (error) {
            logger.warn('Agent sandbox cleanup failed', {
                agentKey: input.agentKey,
                instanceId,
                session,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    };

    return { tools, definitions, cleanup };
}

function resolvePath(path: string): string {
    const trimmed = path.trim();
    if (trimmed.startsWith('/')) return trimmed;
    return `${WORKDIR}/${trimmed.replace(/^\.\//, '')}`;
}

/**
 * Deletes the session sandbox recorded on a conversation. Called when the
 * conversation itself is deleted — the machine must not outlive the thread
 * that owned it. Best-effort, and a no-op without the enterprise module.
 */
export async function destroyConversationSandbox(input: {
    tenantDbName: string;
    tenantId: string;
    conversation: Pick<IAgentConversation, '_id' | 'agentKey' | 'projectId' | 'metadata'>;
}): Promise<void> {
    const record = input.conversation.metadata?.sandbox as ConversationSandboxRecord | undefined;
    const runner = agentSandboxRunner?.current;
    if (!record?.instanceId || !runner) return;
    try {
        await runner.destroy({
            tenantDbName: input.tenantDbName,
            tenantId: input.tenantId,
            projectId: input.conversation.projectId,
            agentKey: input.conversation.agentKey,
            conversationId: String(input.conversation._id),
        }, record.instanceId);
    } catch (error) {
        logger.warn('Could not delete the sandbox of a deleted conversation', {
            conversationId: String(input.conversation._id),
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
