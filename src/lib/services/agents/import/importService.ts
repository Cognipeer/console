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
    /** Cognipeer manifests: dependencies the project does not have. */
    missing?: Array<{ type: string; key: string; usedBy: string }>;
    warnings: Array<{ code: string; message: string }>;
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
        const skillKeys = new Set(skills.map((s) => s.key));
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
            skills: (manifest.spec.skills ?? []).map((key) => ({
                ref: key,
                label: key,
                kind: 'cognipeer' as const,
                ...(skillKeys.has(key) ? { existing: { key, title: skills.find((s) => s.key === key)!.title } } : {}),
            })),
            missing: preview.missing,
            warnings: preview.missing.map((dep) => ({
                code: 'missing_dependency',
                message: `${dep.type} "${dep.key}" (used by ${dep.usedBy}) does not exist in this project.`,
            })),
        };
    }

    // claude-managed-agent
    let plan: ClaudeAgentPlan;
    try {
        plan = planClaudeManagedAgent(doc);
    } catch (error) {
        throw new AgentImportError((error as Error).message);
    }
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

export interface ApplyAgentDocumentImportInput {
    content: string;
    format?: string;
    key?: string;
    name?: string;
    modelKey?: string;
    mcp?: Record<string, McpImportChoice>;
    skills?: Record<string, SkillImportChoice>;
    /** Cognipeer manifests only: overwrite an existing agent with the same key. */
    overwrite?: boolean;
}

export interface AgentImportApplyResult {
    agent: IAgent;
    action: 'created' | 'updated';
    created: { mcpServers: Array<{ key: string; name: string }>; skills: Array<{ key: string; title: string }> };
    warnings: Array<{ code: string; message: string }>;
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

    if (format.id === 'cognipeer') {
        const manifest = doc.data as unknown as AgentManifest;
        const spec = input.modelKey ? { ...manifest.spec, modelKey: input.modelKey } : manifest.spec;
        const result = await applyAgentManifest(ctx.tenantDbName, ctx.tenantId, ctx.projectId, ctx.userId, { ...manifest, spec }, {
            mode: input.overwrite ? 'upsert' : 'create',
            key: input.key,
            name: input.name,
        });
        return {
            agent: result.agent,
            action: result.action,
            created: { mcpServers: [], skills: [] },
            warnings: result.missing.map((dep) => ({ code: 'missing_dependency', message: `${dep.type} "${dep.key}" does not exist in this project.` })),
        };
    }

    let plan: ClaudeAgentPlan;
    try {
        plan = planClaudeManagedAgent(doc);
    } catch (error) {
        throw new AgentImportError((error as Error).message);
    }
    if (!input.modelKey) throw new AgentImportError('Choose a model for the agent.');

    const key = input.key?.trim() || slugify(plan.name);
    if (await agentKeyExists(ctx.tenantDbName, ctx.projectId, key)) {
        throw new AgentImportError(`An agent with key "${key}" already exists in this project. Choose another key.`, 409);
    }

    const createdServers: IMcpServer[] = [];
    const createdSkills: IAgentSkill[] = [];
    const rollback = async () => {
        // Best effort, one by one: a failure here must never mask the error
        // that triggered the rollback.
        for (const server of createdServers) {
            try {
                await deleteMcpServer(ctx.tenantDbName, String(server._id));
            } catch (error) {
                logger.warn('Import rollback could not delete an MCP server', { key: server.key, error: (error as Error).message });
            }
        }
        if (createdSkills.length > 0) {
            try {
                const db = await getDatabase();
                await db.switchToTenant(ctx.tenantDbName);
                for (const skill of createdSkills) {
                    try {
                        await db.deleteSkill(String(skill._id));
                    } catch (error) {
                        logger.warn('Import rollback could not delete a skill', { key: skill.key, error: (error as Error).message });
                    }
                }
            } catch {
                /* the original error is what matters */
            }
        }
    };

    try {
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
                createdServers.push(resolved);
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
            const created = await createSkill(ctx.tenantDbName, ctx.tenantId, ctx.projectId, ctx.userId, {
                title: choice.title.trim(),
                header: choice.header.trim(),
                body: choice.body ?? '',
            });
            createdSkills.push(created);
            skillKeys.push(created.key);
        }

        const sandboxAvailability = plan.builtins.sandbox.length > 0 ? await resolveSandboxAvailability(ctx.tenantId) : null;
        const warnings = [...plan.unsupported];
        if (plan.builtins.webSearch) toolBindings.push({ source: 'system', sourceKey: 'web_search', toolNames: ['web_search'] });
        if (plan.builtins.webFetch) toolBindings.push({ source: 'system', sourceKey: 'browser_use', toolNames: ['browser_use'] });

        const config: IAgentConfig = {
            modelKey: input.modelKey,
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
            created: {
                mcpServers: createdServers.map((s) => ({ key: s.key, name: s.name })),
                skills: createdSkills.map((s) => ({ key: s.key, title: s.title })),
            },
            warnings: [...warnings, ...validation.warnings.map((w) => ({ code: 'config_warning', message: `${w.field}: ${w.message}` }))],
        };
    } catch (error) {
        await rollback();
        if (error instanceof AgentManifestError) throw new AgentImportError(error.message, 400, { issues: error.issues });
        throw error;
    }
}
