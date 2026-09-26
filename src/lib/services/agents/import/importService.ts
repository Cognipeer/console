/**
 * Import an agent from a definition document — the "New → Import" flow.
 *
 * Formats are adapters: each one `detect`s its own documents (0–100) and
 * turns them into something this service can preview and write. Today:
 *   - `cognipeer`             — the console's own manifest (export/import).
 *   - `claude-managed-agent`  — Claude Managed Agents (JSON body, YAML, or
 *                               the CLI's Markdown-with-front-matter file).
 * A document no adapter recognises comes back with `format: null`; the UI
 * then asks which format it is, and the caller passes it explicitly.
 *
 * A Claude definition carries its MCP servers inline and references skills
 * by id, so importing one may create library records too (MCP servers,
 * placeholder skills). Those are created FIRST; if any fails (unreachable
 * server, wrong credentials) everything created so far is removed again and
 * no agent is written — never half an import.
 */

import { createLogger } from '@/lib/core/logger';
import { getDatabase, type IAgent, type IAgentConfig, type IAgentToolBinding, type IMcpServer, type IAgentSkill } from '@/lib/database';
import { createMcpServer, deleteMcpServer, listMcpServers } from '@/lib/services/mcp/mcpService';
import { createSkill, listSkills } from '@/lib/services/agents/skillService';
import { createPrompt, deletePrompt } from '@/lib/services/prompts/promptService';
import { createTool, deleteTool } from '@/lib/services/tools/toolService';
import { listWebSearchProviders } from '@/lib/services/webSearch/webSearchService';
import {
    AGENT_MANIFEST_API_VERSION,
    AgentManifestError,
    applyAgentManifest,
    previewAgentImport,
    validateAgentManifest,
    type AgentManifest,
} from '../agentManifest';
import { validateAgentConfig } from '../agentConfigValidation';
import {
    remapSpecResourceKeys,
    type ManifestAuthShape,
    type ManifestResourceType,
    type ManifestResources,
} from '../manifestResources';
import { resolveSandboxAvailability } from '../agentSandboxTools';
import { parseAgentDocument, type ParsedAgentDocument } from './document';
import {
    applyToolFilter,
    detectClaudeManagedAgent,
    planClaudeManagedAgent,
    type ClaudeAgentPlan,
} from './claudeManagedAgent';

const logger = createLogger('agent-import');

export type AgentImportFormatId = 'cognipeer' | 'claude-managed-agent';

export const AGENT_IMPORT_FORMATS: Array<{ id: AgentImportFormatId; label: string; detect: (doc: ParsedAgentDocument) => number }> = [
    {
        id: 'cognipeer',
        label: 'Cognipeer agent manifest',
        detect: (doc) => (doc.data.apiVersion === AGENT_MANIFEST_API_VERSION && doc.data.kind === 'Agent' ? 100
            : typeof doc.data.apiVersion === 'string' && String(doc.data.apiVersion).startsWith('cognipeer') ? 70 : 0),
    },
    { id: 'claude-managed-agent', label: 'Claude Managed Agent', detect: detectClaudeManagedAgent },
];

/** Below this, a format is a candidate but not a decision — the UI asks. */
const DETECT_THRESHOLD = 50;

export class AgentImportError extends Error {
    constructor(message: string, readonly status = 400, readonly details?: unknown) {
        super(message);
        this.name = 'AgentImportError';
    }
}

export interface ImportContext {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    userId: string;
}

// ── Preview ─────────────────────────────────────────────────────────────

export interface AgentImportPreview {
    format: {
        id: AgentImportFormatId | null;
        label?: string;
        detected: boolean;
        candidates: Array<{ id: AgentImportFormatId; label: string; confidence: number }>;
    };
    envelope: ParsedAgentDocument['envelope'];
    agent?: { name: string; key: string; description?: string; exists: boolean };
    model?: {
        requested?: string;
        suggestedKey?: string;
        options: Array<{ key: string; name: string; modelId: string }>;
    };
    mcpServers: Array<{
        ref: string;
        url: string;
        referenced: boolean;
        toolFilter: ClaudeAgentPlan['mcpServers'][number]['toolFilter'];
        existing?: { key: string; name: string };
    }>;
    skills: Array<{
        ref: string;
        label: string;
        kind: 'anthropic' | 'custom' | 'cognipeer';
        existing?: { key: string; title: string };
    }>;
    skillOptions: Array<{ key: string; title: string }>;
    capabilities: {
        sandbox: { requested: string[]; available: boolean; reason?: string };
        webSearch: { requested: boolean; available: boolean };
        webFetch: { requested: boolean };
    };
    /**
     * Cognipeer manifests exported with `include=…`: the embedded definitions.
     * Each is reused when the project has one with the same key (or, for a
     * remote MCP server, the same URL), created otherwise — or skipped.
     */
    resources: EmbeddedResourceRow[];
    /** Cognipeer manifests: dependencies the project does not have (and the manifest does not embed). */
    missing?: Array<{ type: string; key: string; usedBy: string }>;
    warnings: Array<{ code: string; message: string }>;
}

export interface EmbeddedResourceRow {
    type: ManifestResourceType;
    key: string;
    name: string;
    /** One line: URL, package, source type… */
    detail?: string;
    existing?: { key: string; name: string };
    /** Credential the importer has to supply when creating (secrets are never exported). */
    auth?: ManifestAuthShape;
    /** stdio MCP: env var names whose values have to be supplied. */
    envKeys?: string[];
}

/** `resources` choice id — `type:key`, e.g. `mcpServers:github`. */
export const resourceRef = (type: ManifestResourceType, key: string) => `${type}:${key}`;

const DEPENDENCY_RESOURCE_TYPE: Record<string, ManifestResourceType | undefined> = {
    skill: 'skills',
    prompt: 'prompts',
    mcp: 'mcpServers',
    tool: 'tools',
};

async function embeddedResourceRows(ctx: ImportContext, resources: ManifestResources | undefined): Promise<EmbeddedResourceRow[]> {
    if (!resources) return [];
    const db = await getDatabase();
    await db.switchToTenant(ctx.tenantDbName);
    const rows: EmbeddedResourceRow[] = [];
    for (const skill of resources.skills ?? []) {
        const found = await db.findSkillByKey(skill.key, ctx.projectId);
        rows.push({ type: 'skills', key: skill.key, name: skill.title, detail: skill.header, ...(found ? { existing: { key: found.key, name: found.title } } : {}) });
    }
    for (const prompt of resources.prompts ?? []) {
        const found = await db.findPromptByKey(prompt.key, ctx.projectId);
        rows.push({ type: 'prompts', key: prompt.key, name: prompt.name, ...(prompt.description ? { detail: prompt.description } : {}), ...(found ? { existing: { key: found.key, name: found.name } } : {}) });
    }
    if (resources.mcpServers?.length) {
        const servers = await listMcpServers(ctx.tenantDbName, { projectId: ctx.projectId });
        for (const server of resources.mcpServers) {
            const found = servers.find((s: IMcpServer) => s.key === server.key)
                ?? (server.remoteConfig ? servers.find((s: IMcpServer) => s.remoteConfig?.url === server.remoteConfig!.url && s.status !== 'disabled') : undefined);
            rows.push({
                type: 'mcpServers',
                key: server.key,
                name: server.name,
                detail: server.remoteConfig?.url ?? (server.stdioConfig ? `${server.stdioConfig.runtime} ${server.stdioConfig.packageName}` : server.upstreamBaseUrl ?? server.sourceType),
                ...(found ? { existing: { key: found.key, name: found.name } } : {}),
                ...(server.auth.type !== 'none' ? { auth: server.auth } : {}),
                ...(server.stdioConfig?.envKeys?.length ? { envKeys: server.stdioConfig.envKeys } : {}),
            });
        }
    }
    for (const tool of resources.tools ?? []) {
        const found = await db.findToolByKey(tool.key, ctx.projectId);
        rows.push({
            type: 'tools',
            key: tool.key,
            name: tool.name,
            detail: tool.mcpEndpoint ?? tool.upstreamBaseUrl ?? tool.type,
            ...(found ? { existing: { key: found.key, name: found.name } } : {}),
            ...(tool.auth.type !== 'none' ? { auth: tool.auth } : {}),
        });
    }
    return rows;
}

function slugify(value: string): string {
    return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'imported-agent';
}

/** `claude-opus-5-5` ↔ `anthropic.claude-opus-5-5-v1:0` ↔ `claude-opus-5.5` — compare on letters+digits. */
function normalizeModelId(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function detectFormat(doc: ParsedAgentDocument, explicit?: string) {
    const candidates = AGENT_IMPORT_FORMATS
        .map((f) => ({ id: f.id, label: f.label, confidence: f.detect(doc) }))
        .filter((c) => c.confidence > 0)
        .sort((a, b) => b.confidence - a.confidence);
    if (explicit && explicit !== 'auto') {
        const chosen = AGENT_IMPORT_FORMATS.find((f) => f.id === explicit);
        if (!chosen) throw new AgentImportError(`Unknown import format "${explicit}"`);
        return { id: chosen.id, label: chosen.label, detected: false, candidates };
    }
    const best = candidates[0];
    if (best && best.confidence >= DETECT_THRESHOLD) return { id: best.id, label: best.label, detected: true, candidates };
    return { id: null, detected: false, candidates };
}

async function projectModels(tenantDbName: string, projectId: string) {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    const models = await db.listModels({ projectId, category: 'llm' });
    return models.map((m) => ({ key: m.key, name: m.name, modelId: m.modelId }));
}

function suggestModel(requested: string | undefined, options: Array<{ key: string; modelId: string }>): string | undefined {
    if (!requested) return undefined;
    const wanted = normalizeModelId(requested);
    const exact = options.find((o) => o.key === requested || normalizeModelId(o.modelId) === wanted);
    if (exact) return exact.key;
    return options.find((o) => normalizeModelId(o.modelId).includes(wanted) || wanted.includes(normalizeModelId(o.modelId)))?.key;
}

async function agentKeyExists(tenantDbName: string, projectId: string, key: string): Promise<boolean> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return Boolean(await db.findAgentByKey(key, projectId));
}

export async function previewAgentDocumentImport(
    ctx: ImportContext,
    content: string,
    formatHint?: string,
): Promise<AgentImportPreview> {
    const doc = parseAgentDocument(content);
    const format = detectFormat(doc, formatHint);
    const base: AgentImportPreview = {
        format,
        envelope: doc.envelope,
        mcpServers: [],
        skills: [],
        skillOptions: [],
        resources: [],
        capabilities: {
            sandbox: { requested: [], available: false },
            webSearch: { requested: false, available: false },
            webFetch: { requested: false },
        },
        warnings: [],
    };
    if (!format.id) return base;

    const [models, skills] = await Promise.all([
        projectModels(ctx.tenantDbName, ctx.projectId),
        listSkills(ctx.tenantDbName, ctx.projectId, { status: 'active' }),
    ]);
    base.skillOptions = skills.map((s) => ({ key: s.key, title: s.title }));

    if (format.id === 'cognipeer') {
        const manifest = doc.data as unknown as AgentManifest;
        const issues = validateAgentManifest(manifest);
        if (issues.length > 0) throw new AgentImportError('Manifest failed validation', 400, { issues });
        const preview = await previewAgentImport(ctx.tenantDbName, ctx.projectId, manifest);
        const resources = await embeddedResourceRows(ctx, manifest.resources);
        const embedded = new Set(resources.map((r) => resourceRef(r.type, r.key)));
        // A dependency the manifest embeds is not "missing": the import creates it.
        const missing = preview.missing.filter((dep) => {
            const type = DEPENDENCY_RESOURCE_TYPE[dep.type];
            return !(type && embedded.has(resourceRef(type, dep.key)));
        });
        return {
            ...base,
            agent: {
                name: manifest.metadata.name,
                key: manifest.metadata.key,
                ...(manifest.metadata.description ? { description: manifest.metadata.description } : {}),
                exists: preview.exists,
            },
            model: {
                requested: manifest.spec.modelKey,
                suggestedKey: models.some((m) => m.key === manifest.spec.modelKey) ? manifest.spec.modelKey : undefined,
                options: models,
            },
            resources,
            missing,
            warnings: missing.map((dep) => ({
                code: 'missing_dependency',
                message: `${dep.type} "${dep.key}" (used by ${dep.usedBy}) does not exist in this project.`,
            })),
        };
    }

    // claude-managed-agent
    const plan = planClaudeManagedAgent(doc);
    const key = slugify(plan.name);
    const [servers, sandbox, webSearch] = await Promise.all([
        listMcpServers(ctx.tenantDbName, { projectId: ctx.projectId }),
        plan.builtins.sandbox.length > 0 ? resolveSandboxAvailability(ctx.tenantId) : Promise.resolve(null),
        plan.builtins.webSearch ? listWebSearchProviders(ctx.tenantDbName, ctx.tenantId, ctx.projectId).catch(() => []) : Promise.resolve([]),
    ]);
    const warnings = [...plan.unsupported];
    const sandboxAvailable = Boolean(sandbox?.available);
    if (plan.builtins.sandbox.length > 0 && !sandboxAvailable) {
        warnings.push({
            code: 'sandbox_unavailable',
            message: `The agent uses ${plan.builtins.sandbox.join(', ')}, which need the Sandbox (Enterprise). It will be imported without them.`,
        });
    }
    const webSearchAvailable = (webSearch as Array<{ status?: string }>).some((p) => p.status === 'active');
    if (plan.builtins.webSearch && !webSearchAvailable) {
        warnings.push({ code: 'websearch_unavailable', message: 'web_search is bound, but this project has no active Web Search provider yet — add one before running the agent.' });
    }
    if (plan.builtins.webFetch) {
        warnings.push({ code: 'web_fetch', message: 'web_fetch is mapped to Browser Use, the closest console equivalent.' });
    }
    for (const skill of plan.skills) {
        if (skill.kind === 'anthropic') {
            warnings.push({ code: 'anthropic_skill', message: `"${skill.skillId}" is an Anthropic pre-built skill; its content is not in the file. Map it to a console skill or skip it.` });
        }
    }
    const modelSuggestion = suggestModel(plan.model, models);
    if (plan.model && !modelSuggestion) {
        warnings.push({ code: 'model_unmatched', message: `No model in this project matches "${plan.model}". Pick one before importing.` });
    }

    return {
        ...base,
        agent: {
            name: plan.name,
            key,
            ...(plan.description ? { description: plan.description } : {}),
            exists: await agentKeyExists(ctx.tenantDbName, ctx.projectId, key),
        },
        model: { requested: plan.model, suggestedKey: modelSuggestion, options: models },
        mcpServers: plan.mcpServers.map((server) => {
            const existing = servers.find((s: IMcpServer) => s.remoteConfig?.url === server.url && s.status !== 'disabled');
            return {
                ref: server.ref,
                url: server.url,
                referenced: server.referenced,
                toolFilter: server.toolFilter,
                ...(existing ? { existing: { key: existing.key, name: existing.name } } : {}),
            };
        }),
        skills: plan.skills.map((skill) => {
            const match = skills.find((s: IAgentSkill) => s.key === skill.skillId || s.title.toLowerCase() === skill.skillId.toLowerCase());
            return {
                ref: skill.ref,
                label: `${skill.skillId}${skill.version ? ` @ ${skill.version}` : ''}`,
                kind: skill.kind,
                ...(match ? { existing: { key: match.key, title: match.title } } : {}),
            };
        }),
        capabilities: {
            sandbox: {
                requested: plan.builtins.sandbox,
                available: sandboxAvailable,
                ...(sandbox && !sandbox.available ? { reason: sandbox.reason } : {}),
            },
            webSearch: { requested: plan.builtins.webSearch, available: webSearchAvailable },
            webFetch: { requested: plan.builtins.webFetch },
        },
        warnings,
    };
}

// ── Apply ───────────────────────────────────────────────────────────────

export type McpImportChoice =
    | { action: 'reuse'; key: string }
    | {
        action: 'create';
        name?: string;
        transport?: 'streamable-http' | 'sse';
        auth?: { type: 'none' | 'token' | 'header'; token?: string; headerName?: string; headerValue?: string };
    }
    | { action: 'skip' };

export type SkillImportChoice =
    | { action: 'map'; key: string }
    | { action: 'create'; title: string; header: string; body: string }
    | { action: 'skip' };

export type ResourceImportChoice =
    | { action: 'reuse'; key?: string }
    | {
        action: 'create';
        auth?: { token?: string; headerName?: string; headerValue?: string; username?: string; password?: string };
        /** stdio MCP env values, by the names the manifest lists. */
        env?: Record<string, string>;
    }
    | { action: 'skip' };

export interface ApplyAgentDocumentImportInput {
    content: string;
    format?: string;
    key?: string;
    name?: string;
    modelKey?: string;
    mcp?: Record<string, McpImportChoice>;
    skills?: Record<string, SkillImportChoice>;
    /** Cognipeer manifests: what to do with each embedded definition, by `type:key`. */
    resources?: Record<string, ResourceImportChoice>;
    /** Cognipeer manifests only: overwrite an existing agent with the same key. */
    overwrite?: boolean;
}

export interface AgentImportApplyResult {
    agent: IAgent;
    action: 'created' | 'updated';
    created: {
        mcpServers: Array<{ key: string; name: string }>;
        skills: Array<{ key: string; title: string }>;
        prompts?: Array<{ key: string; name: string }>;
        tools?: Array<{ key: string; name: string }>;
    };
    warnings: Array<{ code: string; message: string }>;
}

/** Library records an import created, so a failure can remove them again. */
interface CreatedRecords {
    mcpServers: Array<{ key: string; name: string; id: string }>;
    skills: Array<{ key: string; title: string; id: string }>;
    prompts: Array<{ key: string; name: string; id: string }>;
    tools: Array<{ key: string; name: string; id: string }>;
}

const withoutIds = <T extends { id: string }>(list: T[]) => list.map(({ id: _id, ...rest }) => { void _id; return rest; });

type RollbackKind = 'MCP server' | 'tool' | 'prompt' | 'skill' | 'skills';
/** Logs a rollback delete that failed; `key` is absent when the skills DB switch itself failed. */
type RollbackReporter = (kind: RollbackKind, key: string | undefined, error: string) => void;

const reportManifestRollbackFailure: RollbackReporter = (kind, key, error) =>
    logger.warn(`Import rollback could not delete ${key === undefined ? kind : `${kind} ${key}`}`, { error });

// The Claude path keeps its own log events, and stays silent when the skills DB switch fails.
const reportClaudeRollbackFailure: RollbackReporter = (kind, key, error) => {
    if (kind === 'skills') return;
    logger.warn(kind === 'MCP server' ? 'Import rollback could not delete an MCP server' : 'Import rollback could not delete a skill', { key, error });
};

/**
 * Runs the writing part of an import; if it throws, deletes whatever
 * `created` has collected so far and rethrows (manifest errors as a 400).
 * Best effort, one by one: a failure here must never mask the error that
 * triggered the rollback.
 */
async function withImportRollback<T>(
    ctx: ImportContext,
    created: CreatedRecords,
    report: RollbackReporter,
    run: () => Promise<T>,
): Promise<T> {
    try {
        return await run();
    } catch (error) {
        const attempt = async (kind: RollbackKind, key: string | undefined, fn: () => Promise<unknown>) => {
            try {
                await fn();
            } catch (rollbackError) {
                report(kind, key, (rollbackError as Error).message);
            }
        };
        for (const server of created.mcpServers) await attempt('MCP server', server.key, () => deleteMcpServer(ctx.tenantDbName, server.id));
        for (const tool of created.tools) await attempt('tool', tool.key, () => deleteTool(ctx.tenantDbName, tool.id));
        for (const prompt of created.prompts) await attempt('prompt', prompt.key, () => deletePrompt(ctx.tenantDbName, ctx.projectId, prompt.id));
        if (created.skills.length > 0) {
            await attempt('skills', undefined, async () => {
                const db = await getDatabase();
                await db.switchToTenant(ctx.tenantDbName);
                for (const skill of created.skills) await attempt('skill', skill.key, () => db.deleteSkill(skill.id));
            });
        }
        if (error instanceof AgentManifestError) throw new AgentImportError(error.message, 400, { issues: error.issues });
        throw error;
    }
}

export async function applyAgentDocumentImport(
    ctx: ImportContext,
    input: ApplyAgentDocumentImportInput,
): Promise<AgentImportApplyResult> {
    const doc = parseAgentDocument(input.content);
    const format = detectFormat(doc, input.format);
    if (!format.id) {
        throw new AgentImportError('Could not tell which format this document is — choose one and import again.', 422, {
            candidates: format.candidates,
        });
    }

    if (format.id === 'cognipeer') return applyManifestDocument(ctx, doc.data as unknown as AgentManifest, input);

    const plan = planClaudeManagedAgent(doc);
    const modelKey = input.modelKey;
    if (!modelKey) throw new AgentImportError('Choose a model for the agent.');

    const key = input.key?.trim() || slugify(plan.name);
    if (await agentKeyExists(ctx.tenantDbName, ctx.projectId, key)) {
        throw new AgentImportError(`An agent with key "${key}" already exists in this project. Choose another key.`, 409);
    }

    const created: CreatedRecords = { mcpServers: [], skills: [], prompts: [], tools: [] };
    return withImportRollback(ctx, created, reportClaudeRollbackFailure, async () => {
        const toolBindings: IAgentToolBinding[] = [];
        const existingServers = await listMcpServers(ctx.tenantDbName, { projectId: ctx.projectId });

        for (const server of plan.mcpServers) {
            const choice: McpImportChoice = input.mcp?.[server.ref] ?? { action: 'create' };
            if (choice.action === 'skip') continue;
            let resolved: IMcpServer | undefined;
            if (choice.action === 'reuse') {
                resolved = existingServers.find((s) => s.key === choice.key);
                if (!resolved) throw new AgentImportError(`MCP server "${choice.key}" (for "${server.ref}") was not found.`);
            } else {
                try {
                    resolved = await createMcpServer(ctx.tenantDbName, ctx.tenantId, ctx.userId, ctx.projectId, {
                        name: choice.name?.trim() || server.ref,
                        description: `Imported with Claude agent "${plan.name}"`,
                        sourceType: 'remote',
                        remoteConfig: { url: server.url, transport: choice.transport ?? 'streamable-http' },
                        upstreamAuth: {
                            type: choice.auth?.type ?? 'none',
                            ...(choice.auth?.token ? { token: choice.auth.token } : {}),
                            ...(choice.auth?.headerName ? { headerName: choice.auth.headerName } : {}),
                            ...(choice.auth?.headerValue ? { headerValue: choice.auth.headerValue } : {}),
                        },
                    });
                } catch (error) {
                    throw new AgentImportError(
                        `MCP server "${server.ref}" (${server.url}) could not be connected: ${(error as Error).message}`,
                        422,
                        { mcpServer: server.ref },
                    );
                }
                created.mcpServers.push({ key: resolved.key, name: resolved.name, id: String(resolved._id) });
            }
            if (!server.referenced) continue;
            const toolNames = applyToolFilter((resolved.tools ?? []).map((t) => t.name), server.toolFilter);
            if (toolNames.length > 0) toolBindings.push({ source: 'mcp', sourceKey: resolved.key, toolNames });
        }

        const skillKeys: string[] = [];
        for (const skill of plan.skills) {
            const choice: SkillImportChoice = input.skills?.[skill.ref] ?? { action: 'skip' };
            if (choice.action === 'skip') continue;
            if (choice.action === 'map') {
                skillKeys.push(choice.key);
                continue;
            }
            if (!choice.title?.trim() || !choice.header?.trim()) {
                throw new AgentImportError(`Skill "${skill.skillId}" needs a title and a one-line description.`);
            }
            const record = await createSkill(ctx.tenantDbName, ctx.tenantId, ctx.projectId, ctx.userId, {
                title: choice.title.trim(),
                header: choice.header.trim(),
                body: choice.body ?? '',
            });
            created.skills.push({ key: record.key, title: record.title, id: String(record._id) });
            skillKeys.push(record.key);
        }

        const sandboxAvailability = plan.builtins.sandbox.length > 0 ? await resolveSandboxAvailability(ctx.tenantId) : null;
        const warnings = [...plan.unsupported];
        if (plan.builtins.webSearch) toolBindings.push({ source: 'system', sourceKey: 'web_search', toolNames: ['web_search'] });
        if (plan.builtins.webFetch) toolBindings.push({ source: 'system', sourceKey: 'browser_use', toolNames: ['browser_use'] });

        const config: IAgentConfig = {
            modelKey,
            ...(plan.systemPrompt ? { systemPrompt: plan.systemPrompt } : {}),
            ...(toolBindings.length > 0 ? { toolBindings } : {}),
            ...(skillKeys.length > 0 ? { skills: [...new Set(skillKeys)] } : {}),
            ...(sandboxAvailability?.available
                ? { sandbox: { enabled: true, mode: 'ephemeral' as const } }
                : {}),
        };
        if (plan.builtins.sandbox.length > 0 && !sandboxAvailability?.available) {
            warnings.push({ code: 'sandbox_unavailable', message: 'Imported without the Sandbox — it needs the Enterprise sandbox module.' });
        }

        const validation = await validateAgentConfig({
            tenantDbName: ctx.tenantDbName,
            tenantId: ctx.tenantId,
            projectId: ctx.projectId,
            config,
            agentKey: key,
        });
        if (validation.errors.length > 0) {
            throw new AgentImportError('The imported configuration is not valid', 400, { issues: validation.errors });
        }

        const manifest: AgentManifest = {
            apiVersion: AGENT_MANIFEST_API_VERSION,
            kind: 'Agent',
            metadata: {
                key,
                name: input.name?.trim() || plan.name,
                ...(plan.description ? { description: plan.description } : {}),
                exportedAt: new Date().toISOString(),
            },
            spec: config,
            dependencies: [],
        } as AgentManifest;
        const result = await applyAgentManifest(ctx.tenantDbName, ctx.tenantId, ctx.projectId, ctx.userId, manifest, { mode: 'create' });

        // Provenance: where this agent came from, for whoever opens it next.
        const db = await getDatabase();
        await db.switchToTenant(ctx.tenantDbName);
        await db.updateAgent(String(result.agent._id), {
            metadata: {
                ...(result.agent.metadata ?? {}),
                imported: {
                    format: 'claude-managed-agent',
                    at: new Date().toISOString(),
                    ...(plan.source ?? {}),
                    ...(plan.model ? { requestedModel: plan.model } : {}),
                    ...(plan.metadata ? { metadata: plan.metadata } : {}),
                },
            },
        }).catch(() => undefined);

        return {
            agent: result.agent,
            action: 'created',
            created: { mcpServers: withoutIds(created.mcpServers), skills: withoutIds(created.skills) },
            warnings: [...warnings, ...validation.warnings.map((w) => ({ code: 'config_warning', message: `${w.field}: ${w.message}` }))],
        };
    });
}

// ── Cognipeer manifest (with optional embedded definitions) ─────────────

function mergeAuth(shape: ManifestAuthShape, secret: Extract<ResourceImportChoice, { action: 'create' }>['auth']) {
    return {
        type: shape.type,
        ...(shape.type === 'token' && secret?.token ? { token: secret.token } : {}),
        ...(shape.type === 'header' ? { headerName: secret?.headerName || shape.headerName, ...(secret?.headerValue ? { headerValue: secret.headerValue } : {}) } : {}),
        ...(shape.type === 'basic' ? { username: secret?.username || shape.username, ...(secret?.password ? { password: secret.password } : {}) } : {}),
    };
}

function authIsComplete(auth: ReturnType<typeof mergeAuth>): boolean {
    if (auth.type === 'token') return Boolean(auth.token);
    if (auth.type === 'header') return Boolean(auth.headerName && auth.headerValue);
    if (auth.type === 'basic') return Boolean(auth.username && auth.password);
    return true;
}

async function applyManifestDocument(
    ctx: ImportContext,
    manifest: AgentManifest,
    input: ApplyAgentDocumentImportInput,
): Promise<AgentImportApplyResult> {
    const issues = validateAgentManifest(manifest);
    if (issues.length > 0) throw new AgentImportError('Manifest failed validation', 400, { issues });
    const key = input.key?.trim() || manifest.metadata.key;
    // Refuse before creating anything: a key clash must not leave library records behind.
    if (!input.overwrite && await agentKeyExists(ctx.tenantDbName, ctx.projectId, key)) {
        throw new AgentImportError(`An agent with key "${key}" already exists in this project. Choose another key.`, 409);
    }

    const resources = manifest.resources ?? {};
    const rows = await embeddedResourceRows(ctx, resources);
    /** What to do with an embedded definition — by default reuse what the project has, create otherwise. A reuse comes back with the key it resolves to. */
    const choiceFor = (type: ManifestResourceType, resourceKey: string) => {
        const existing = rows.find((r) => r.type === type && r.key === resourceKey)?.existing?.key;
        const choice: ResourceImportChoice = input.resources?.[resourceRef(type, resourceKey)] ?? (existing ? { action: 'reuse' } : { action: 'create' });
        if (choice.action !== 'reuse') return choice;
        const target = choice.key || existing;
        if (!target) throw new AgentImportError(`Nothing to reuse for ${type} "${resourceKey}" — create it or skip it.`);
        return { action: 'reuse' as const, key: target };
    };

    const remap: Partial<Record<ManifestResourceType, Record<string, string>>> = {};
    const setKey = (type: ManifestResourceType, from: string, to: string) => { (remap[type] ??= {})[from] = to; };
    const created: CreatedRecords = { mcpServers: [], skills: [], prompts: [], tools: [] };
    const warnings: Array<{ code: string; message: string }> = [];

    return withImportRollback(ctx, created, reportManifestRollbackFailure, async () => {
        for (const skill of resources.skills ?? []) {
            const choice = choiceFor('skills', skill.key);
            if (choice.action === 'skip') continue;
            if (choice.action === 'reuse') { setKey('skills', skill.key, choice.key); continue; }
            const record = await createSkill(ctx.tenantDbName, ctx.tenantId, ctx.projectId, ctx.userId, {
                key: skill.key, title: skill.title, header: skill.header, body: skill.body ?? '',
                ...(skill.minModelTier ? { minModelTier: skill.minModelTier } : {}),
            });
            created.skills.push({ key: record.key, title: record.title, id: String(record._id) });
            setKey('skills', skill.key, record.key);
        }

        for (const prompt of resources.prompts ?? []) {
            const choice = choiceFor('prompts', prompt.key);
            if (choice.action === 'skip') continue;
            if (choice.action === 'reuse') { setKey('prompts', prompt.key, choice.key); continue; }
            const record = await createPrompt(ctx.tenantDbName, ctx.tenantId, ctx.projectId, ctx.userId, {
                key: prompt.key, name: prompt.name, template: prompt.template,
                ...(prompt.description ? { description: prompt.description } : {}),
                ...(prompt.metadata ? { metadata: prompt.metadata } : {}),
                versionComment: `Imported with agent "${manifest.metadata.name}"`,
            });
            created.prompts.push({ key: record.key, name: record.name, id: record.id });
            setKey('prompts', prompt.key, record.key);
        }

        for (const tool of resources.tools ?? []) {
            const choice = choiceFor('tools', tool.key);
            if (choice.action === 'skip') continue;
            if (choice.action === 'reuse') { setKey('tools', tool.key, choice.key); continue; }
            const auth = mergeAuth(tool.auth, choice.auth);
            if (!authIsComplete(auth)) {
                warnings.push({ code: 'credentials_missing', message: `Tool "${tool.name}" was created without its ${auth.type} credential — add it under Tools before running the agent.` });
            }
            let record;
            try {
                record = await createTool(ctx.tenantDbName, ctx.tenantId, ctx.userId, ctx.projectId, {
                    name: tool.name, type: tool.type,
                    ...(tool.description ? { description: tool.description } : {}),
                    ...(tool.openApiSpec ? { openApiSpec: tool.openApiSpec } : {}),
                    ...(tool.upstreamBaseUrl ? { upstreamBaseUrl: tool.upstreamBaseUrl } : {}),
                    ...(tool.mcpEndpoint ? { mcpEndpoint: tool.mcpEndpoint, mcpTransport: tool.mcpTransport ?? 'streamable-http' } : {}),
                    upstreamAuth: auth,
                });
            } catch (error) {
                throw new AgentImportError(`Tool "${tool.name}" could not be created: ${(error as Error).message}`, 422, { resource: resourceRef('tools', tool.key) });
            }
            created.tools.push({ key: record.key, name: record.name, id: String(record._id) });
            setKey('tools', tool.key, record.key);
        }

        for (const server of resources.mcpServers ?? []) {
            const choice = choiceFor('mcpServers', server.key);
            if (choice.action === 'skip') continue;
            if (choice.action === 'reuse') { setKey('mcpServers', server.key, choice.key); continue; }
            const auth = mergeAuth(server.auth, choice.auth);
            if (!authIsComplete(auth) && server.sourceType !== 'remote') {
                warnings.push({ code: 'credentials_missing', message: `MCP server "${server.name}" was created without its ${auth.type} credential — add it under MCP before running the agent.` });
            }
            const stdioConfig = server.stdioConfig
                ? {
                    runtime: server.stdioConfig.runtime,
                    packageName: server.stdioConfig.packageName,
                    ...(server.stdioConfig.args ? { args: server.stdioConfig.args } : {}),
                    ...(server.stdioConfig.envKeys?.length
                        ? { env: Object.fromEntries(server.stdioConfig.envKeys.map((name) => [name, choice.env?.[name] ?? ''])) }
                        : {}),
                    executionMode: server.stdioConfig.executionMode,
                    ...(server.stdioConfig.sandbox ? { sandbox: server.stdioConfig.sandbox } : {}),
                }
                : undefined;
            let record: IMcpServer;
            try {
                record = await createMcpServer(ctx.tenantDbName, ctx.tenantId, ctx.userId, ctx.projectId, {
                    name: server.name,
                    key: server.key,
                    ...(server.description ? { description: server.description } : {}),
                    sourceType: server.sourceType,
                    ...(server.openApiSpec ? { openApiSpec: server.openApiSpec } : {}),
                    ...(server.upstreamBaseUrl ? { upstreamBaseUrl: server.upstreamBaseUrl } : {}),
                    ...(server.remoteConfig ? { remoteConfig: server.remoteConfig } : {}),
                    ...(stdioConfig ? { stdioConfig } : {}),
                    upstreamAuth: auth,
                });
            } catch (error) {
                throw new AgentImportError(
                    `MCP server "${server.name}" could not be created: ${(error as Error).message}`,
                    422,
                    { resource: resourceRef('mcpServers', server.key) },
                );
            }
            created.mcpServers.push({ key: record.key, name: record.name, id: String(record._id) });
            setKey('mcpServers', server.key, record.key);
        }

        const remapped = remapSpecResourceKeys(manifest.spec, remap);
        const spec = input.modelKey ? { ...remapped, modelKey: input.modelKey } : remapped;
        const result = await applyAgentManifest(ctx.tenantDbName, ctx.tenantId, ctx.projectId, ctx.userId, { ...manifest, resources: undefined, spec }, {
            mode: input.overwrite ? 'upsert' : 'create',
            key,
            name: input.name,
        });
        return {
            agent: result.agent,
            action: result.action,
            created: {
                mcpServers: withoutIds(created.mcpServers),
                skills: withoutIds(created.skills),
                prompts: withoutIds(created.prompts),
                tools: withoutIds(created.tools),
            },
            warnings: [
                ...warnings,
                ...result.missing.map((dep) => ({ code: 'missing_dependency', message: `${dep.type} "${dep.key}" does not exist in this project.` })),
            ],
        };
    });
}
