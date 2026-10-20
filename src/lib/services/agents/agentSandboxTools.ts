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
 * and scrubbed from every output before the model sees it. So are the values
 * the sandbox's own launch carries (its template's secrets, secret Config
 * items): the agent never passes those, so only output could show them.
 *
 * Enterprise only: the sandbox module ships in the enterprise overlay
 * (`agentSandboxRunner` seam) AND the tenant needs an active Enterprise
 * license, checked here, per run. A config that asks for a sandbox it cannot
 * have runs without the tools and says why (a run warning), rather than fail.
 */

import { createLogger } from '@/lib/core/logger';
import { currentTurnSignal } from '@/lib/core/turnSignal';
import {
    agentSandboxRunner,
    type AgentSandboxExecResult,
    type AgentSandboxRef,
    type AgentSandboxRunner,
} from '@/enterprise/registry';
import { getDatabase, type IAgentConfig, type IAgentConversation, type IAgentMessageAttachment, type IAgentSandboxConfig } from '@/lib/database';
import { isTenantEnterpriseLicensed } from '@/lib/license/tenantLicense';
import type { TraceToolDefinition } from '@/lib/services/tracingToolDefinitions';
import { resolveSandboxMode } from './agentSandboxMode';
import { downloadFile } from '@/lib/services/files';
import { applySeedFiles, buildSeedPromptNote, isOwnedObjectKey, type SeedApplyResult } from './agentSandboxSeedFiles';
import {
    SANDBOX_OUTPUTS_DIR,
    collectSandboxOutputs,
    parseStatListing,
    readBytesViaExec,
    shQuote,
} from './agentSandboxOutputs';
import { resolveAttachmentsConfig } from './sessionFilesConfig';
import { resolveUploadMimeType, saveAgentOutputFile } from './sessionFiles';
import { readAgentSandboxSecrets, scrubSecretValues } from './agentSandboxSecrets';
import { resolveAgentSandboxConfigVars } from './agentSandboxConfigVars';
import { blockingConfigRefProblems, describeConfigRefProblems } from '@/lib/services/config/configRefs';

const logger = createLogger('agent-sandbox');

const DEFAULT_LINK_TTL_HOURS = 24;
const MAX_LINK_TTL_HOURS = 168;
const DEFAULT_KEEP_ALIVE_MINUTES = 30;

const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 600;
/** Per stream: a build log can be megabytes, and the end is what explains a failure. */
const MAX_STREAM_CHARS = 16_000;
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

/** Told to the model (and so the transcript) when the stored secrets cannot be decrypted. */
const SECRETS_UNAVAILABLE_NOTICE = 'The sandbox secrets configured for this agent are unavailable (the encryption key has changed), so commands run without them. Tell the user to re-enter them in the agent settings.';

/** Told to the model with the command results when variables configured from Config could not be read. */
function configVarsUnavailableNotice(detail: string): string {
    return `These sandbox variables configured from Config are unavailable: ${detail} Commands run without them.`;
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
    /** Where `/outputs/` files are saved as session files; without it nothing is collected. */
    outputs?: { agentConfig: IAgentConfig | undefined; actorId: string; tokenId?: string };
}

export interface AgentSandboxTools {
    /**
     * End of turn: saves the files the agent wrote to `/outputs/` (new or changed since the last turn) as session
     * files and returns them as attachments. Never throws: a failure is logged and the turn goes on.
     */
    collectOutputs: () => Promise<{ attachments: IAgentMessageAttachment[]; warnings: string[] }>;
    tools: AnyTool[];
    definitions: TraceToolDefinition[];
    /** Deletes the sandbox this run used (ephemeral); a session sandbox is left up and only recorded. */
    cleanup: () => Promise<void>;
    /** Preloaded-files block for the system prompt (empty when the agent has none). */
    promptNote: string;
    /**
     * What the `read` tool (`readTool.ts`) needs to read a file of this sandbox. Present when the files group is
     * enabled; reading is `read`, not a sandbox tool of its own, so it also serves the session's files and images.
     */
    reader?: SandboxReader;
}

export interface SandboxReader {
    runner: AgentSandboxRunner;
    ref: AgentSandboxRef;
    getInstance(): Promise<string>;
    resolvePath(path: string): string;
    scrub(text: string): string;
}

const NO_TOOLS: AgentSandboxTools = {
    tools: [], definitions: [], promptNote: '', cleanup: async () => undefined, collectOutputs: async () => ({ attachments: [], warnings: [] }),
};

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
    const { secrets: typedSecrets, unreadable: secretsUnreadable } = readAgentSandboxSecrets(config);
    // Config-sourced variables, read once per run: values from Config join the typed ones (secrets per command,
    // the rest on the machine). A reference that cannot be read is left out; the run goes on and says so.
    const configVars = await resolveAgentSandboxConfigVars({
        sandbox: config,
        tenantDbName: input.tenantDbName,
        tenantId: input.tenantId,
        projectId: input.projectId,
        agentKey: input.agentKey,
        secrets: typedSecrets,
    });
    const secrets = configVars.secrets;
    const machineEnv = configVars.machineEnv;
    const configProblems = configVars.problems;
    if (configProblems.length > 0) input.onWarning(describeConfigRefProblems(configProblems));
    const unavailableConfig = blockingConfigRefProblems(configProblems);
    const configNotice = unavailableConfig.length > 0
        ? configVarsUnavailableNotice(describeConfigRefProblems(unavailableConfig))
        : undefined;
    /** Launch values of the sandbox (see `readLaunchSecrets`); known once the machine exists. */
    let launchSecrets: readonly string[] = [];
    const scrub = (text: string) => scrubSecretValues(text, secrets, launchSecrets);
    /** An error the model (and the trace) reads must not carry a secret value in its text either. */
    const scrubbedError = (error: unknown): unknown => {
        const text = error instanceof Error ? error.message : String(error);
        const clean = scrub(text);
        if (clean === text) return error;
        const masked = new Error(clean);
        if (error instanceof Error) masked.name = error.name;
        return masked;
    };
    /** Runs a tool body so that what it throws is masked like what it returns. */
    const guarded = <A, R>(body: (args: A) => Promise<R>) => async (args: A): Promise<R> => {
        try {
            return await body(args);
        } catch (error) {
            throw scrubbedError(error);
        }
    };
    /** Said with every command result: variables that cannot be read mean commands run without them. */
    const secretsNotice = [secretsUnreadable ? SECRETS_UNAVAILABLE_NOTICE : undefined, configNotice].filter(Boolean).join(' ') || undefined;
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
    let seedResult: SeedApplyResult | undefined;
    /** Told to the model once, with the first command result, when a seed file failed. */
    let seedNotice: string | undefined;

    /**
     * Writes the conversation's sandbox record. `metadata` is replaced
     * wholesale by the database layer, so the write starts from a fresh read —
     * the transcript write for this turn may have landed after the
     * conversation was loaded, and merging into a stale copy would drop it.
     */
    /**
     * The session's own row, read fresh. The sandbox record lives on the conversation, so the row is only used when
     * it is THIS agent's session in THIS project - the same scope every session route checks
     * (api/plugins/agent-session-access.ts) - never merely whatever the id names.
     */
    const readOwnConversation = async (db: Awaited<ReturnType<typeof getDatabase>>): Promise<IAgentConversation | null> => {
        if (!sessionConversationId) return null;
        const found = await db.findAgentConversationById(sessionConversationId);
        return found && found.agentKey === input.agentKey && found.projectId === input.projectId ? found : null;
    };

    const saveRecord = async (instanceId: string): Promise<void> => {
        if (!sessionConversationId) return;
        const db = await getDatabase();
        await db.switchToTenant(input.tenantDbName);
        const latest = await readOwnConversation(db);
        if (!latest) return;
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

    /**
     * What the machine's launch carries and the agent never passes (the secret Config items it takes):
     * the model could only meet those in output. Asked once per run, right after the machine exists. A runner that
     * cannot tell (an older module) or fails leaves the agent's own secrets as the whole set; it never stops a run.
     */
    const readLaunchSecrets = async (instanceId: string): Promise<string[]> => {
        try {
            return (await runner.launchSecretValues?.(ref, instanceId)) ?? [];
        } catch (error) {
            logger.warn('Could not read the sandbox launch values to mask in output', {
                agentKey: input.agentKey,
                instanceId,
                error: error instanceof Error ? error.message : String(error),
            });
            return [];
        }
    };

    const provision = async (): Promise<string> => {
        let previous: ConversationSandboxRecord | undefined;
        if (sessionConversationId) {
            const db = await getDatabase();
            await db.switchToTenant(input.tenantDbName);
            const fresh = await readOwnConversation(db);
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
            ...(Object.keys(machineEnv).length > 0 ? { env: machineEnv } : {}),
            ...(previous?.instanceId ? { instanceId: previous.instanceId } : {}),
            preview: { enabled: Boolean(preview), public: preview?.public ?? false },
            // A previewing machine is stopped by the sandbox module's reaper
            // once idle, not by this run — see `cleanup`.
            idleStopSeconds: preview ? preview.keepAliveSeconds : null,
        });
        launchSecrets = await readLaunchSecrets(instanceId);
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
        await seedInstance(instanceId);
        return instanceId;
    };

    /** Writes the operator's seed files (missing or changed ones only); never throws. */
    const seedInstance = async (instanceId: string): Promise<void> => {
        const files = config.seedFiles ?? [];
        if (files.length === 0) return;
        try {
            seedResult = await applySeedFiles({
                files,
                agentKey: input.agentKey,
                // Seed writes only move bytes: they run without the agent's secrets in their environment.
                runner: { exec: (cmd) => runner.exec(ref, instanceId, cmd) },
                readBytes: async (file) => {
                    const { bucketKey, objectKey } = file.fileRef;
                    if (!isOwnedObjectKey(objectKey, input.agentKey)) throw new Error('not an agent asset');
                    const result = await downloadFile(input.tenantDbName, input.tenantId, input.projectId, bucketKey, objectKey);
                    return Buffer.from(result.data as Uint8Array);
                },
                ...(currentTurnSignal() ? { signal: currentTurnSignal() } : {}),
                onWarn: (message, meta) => logger.warn(message, { agentKey: input.agentKey, instanceId, ...meta }),
            });
        } catch (error) {
            logger.warn('Sandbox seeding failed', { agentKey: input.agentKey, error: error instanceof Error ? error.message : String(error) });
            return;
        }
        if (seedResult.failed.length > 0) {
            seedNotice = `Some preloaded files could not be written: ${seedResult.failed.map((f) => `${f.path} (${f.reason})`).join('; ')}.`;
        }
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

    const shapeExec = (result: AgentSandboxExecResult) => {
        const notice = [seedNotice, secretsNotice].filter(Boolean).join(' ') || undefined;
        seedNotice = undefined;
        return {
            exitCode: result.exitCode,
            // Masked before cut: a value the cut would split is not left half visible.
            stdout: tail(scrub(result.stdout ?? ''), MAX_STREAM_CHARS),
            stderr: tail(scrub(result.stderr ?? ''), MAX_STREAM_CHARS),
            ...(notice ? { notice: scrub(notice) } : {}),
        };
    };

    const lifetime = session
        ? 'Files and installed packages stay across turns of this conversation while you keep using the sandbox. After a long idle period it is shut down and the next use starts a fresh, empty one.'
        : 'The sandbox is discarded when this reply is finished.';
    const secretNote = [
        secretsUnreadable ? ` ${SECRETS_UNAVAILABLE_NOTICE}` : '',
        configNotice ? ` ${configNotice}` : '',
        Object.keys(secrets).length > 0
            ? ` Environment variables available to commands: ${Object.keys(secrets).join(', ')} (secret — never print them).`
            : '',
    ].join('');

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
            func: guarded(async (args: { command: string; cwd?: string }) => {
                const instanceId = await getInstance();
                return shapeExec(await runner.exec(ref, instanceId, {
                    command: args.command,
                    cwd: args.cwd || WORKDIR,
                    env: secrets,
                    timeoutSec,
                    ...turnSignalField(),
                }));
            }),
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
            func: guarded(async (args: { language: 'python' | 'javascript' | 'typescript' | 'bash'; code: string }) => {
                const instanceId = await getInstance();
                return shapeExec(await runner.runCode(ref, instanceId, {
                    language: args.language,
                    code: args.code,
                    env: secrets,
                    timeoutSec,
                    ...turnSignalField(),
                }));
            }),
        }));
    }
    if (toolsEnabled.files) {
        add(input.createToolFn({
            name: 'sandbox_write_file',
            description: `Write a text file in your sandbox, creating parent folders. Relative paths are under ${WORKDIR}. Overwrites an existing file.`,
            schema: z.object({ path: z.string().min(1), content: z.string() }),
            func: guarded(async (args: { path: string; content: string }) => {
                const instanceId = await getInstance();
                const path = resolvePath(args.path);
                await runner.writeFile(ref, instanceId, path, args.content);
                return { ok: true, path, bytes: Buffer.byteLength(args.content, 'utf8') };
            }),
        }));
        add(input.createToolFn({
            name: 'sandbox_list_files',
            description: `List a folder in your sandbox. Default ${WORKDIR}.`,
            schema: z.object({ path: z.string().optional() }),
            func: guarded(async (args: { path?: string }) => {
                const instanceId = await getInstance();
                const entries = await runner.listFiles(ref, instanceId, resolvePath(args.path || WORKDIR));
                return entries.map((entry) => ({ ...entry, name: scrub(entry.name), path: scrub(entry.path) }));
            }),
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
            func: guarded(async (args: { port: number }) => {
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
            }),
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

    const collectOutputs: AgentSandboxTools['collectOutputs'] = async () => {
        const empty = { attachments: [] as IAgentMessageAttachment[], warnings: [] as string[] };
        const outputs = input.outputs;
        if (!outputs || !instance || !conversationId || !input.conversation) return empty;
        try {
            const instanceId = await instance;
            const conversation = { _id: conversationId, agentKey: input.agentKey };
            const maxFileBytes = Math.floor(resolveAttachmentsConfig(outputs.agentConfig?.attachments).maxFileSizeMb * 1024 * 1024);
            const sh = (command: string) => runner.exec(ref, instanceId, { command, timeoutSec: 60 });
            const stored = (input.conversation.metadata?.sandboxOutputs ?? {}) as Record<string, string>;
            const result = await collectSandboxOutputs({
                seen: session ? stored : {},
                maxFileBytes,
                list: async () => {
                    const res = await sh(`find ${shQuote(SANDBOX_OUTPUTS_DIR)} -type f -exec stat -c '%Y|%s|%n' {} +`);
                    if (res.exitCode === 0) return parseStatListing(res.stdout);
                    const listed = await runner.listFiles(ref, instanceId, SANDBOX_OUTPUTS_DIR).catch(() => []);
                    return listed.filter((e) => e.type === 'file').map((e) => ({ path: e.path, size: e.size ?? 0 }));
                },
                readBytes: async (entry) => runner.readFileBytes
                    ? runner.readFileBytes(ref, instanceId, entry.path)
                    : readBytesViaExec(sh, entry.path, entry.size),
                scrub,
                store: (file) => saveAgentOutputFile({
                    scope: { tenantDbName: input.tenantDbName, tenantId: input.tenantId, projectId: input.projectId },
                    conversation,
                    agentConfig: outputs.agentConfig,
                    fileName: file.name,
                    contentType: resolveUploadMimeType(undefined, file.name),
                    data: file.data,
                    actorId: outputs.actorId,
                    ...(outputs.tokenId ? { tokenId: outputs.tokenId } : {}),
                }),
            });
            if (session && result.attachments.length > 0) {
                // `metadata` is replaced wholesale: start from a fresh read (see `saveRecord`).
                const db = await getDatabase();
                await db.switchToTenant(input.tenantDbName);
                const latest = await readOwnConversation(db);
                if (latest) {
                    await db.updateAgentConversation(conversationId, {
                        metadata: { ...(latest.metadata ?? {}), sandboxOutputs: result.seen },
                    });
                }
            }
            if (result.warnings.length > 0) logger.warn('Sandbox outputs collected with warnings', { agentKey: input.agentKey, warnings: result.warnings });
            return { attachments: result.attachments, warnings: result.warnings };
        } catch (error) {
            logger.warn('Could not collect sandbox outputs', { agentKey: input.agentKey, error: error instanceof Error ? error.message : String(error) });
            return empty;
        }
    };

    return {
        tools,
        definitions,
        cleanup,
        collectOutputs,
        promptNote: tools.length > 0 ? buildSeedPromptNote(config.seedFiles) : '',
        ...(toolsEnabled.files ? { reader: { runner, ref, getInstance, resolvePath, scrub } } : {}),
    };
}

/** The running turn's abort signal as an optional field: a Stop ends a command that is in flight. */
function turnSignalField(): { signal?: AbortSignal } {
    const signal = currentTurnSignal();
    return signal ? { signal } : {};
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
