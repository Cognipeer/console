/**
 * Definitions a manifest can carry alongside the agent — opt-in, per type.
 *
 * A plain manifest references its prompt, skills, MCP servers and tools by
 * key, which is right when the target project already has them. For moving
 * an agent into a project that does not, the export can embed the
 * definitions themselves (`?include=skills,prompts,mcp,tools` or `all`);
 * the importer then reuses what already exists or creates what is missing.
 *
 * Credentials never travel. An embedded MCP server / tool keeps only the
 * SHAPE of its auth (type, header name, username) and a stdio server only its
 * env var NAMES, so the importer knows what to ask for. Internal and
 * composite MCP servers are bound to this project's own resources and are
 * not embedded — they stay plain references.
 */

import { getDatabase, type IAgentConfig, type IAgentToolBinding, type IMcpServer, type ITool } from '@/lib/database';

export const MANIFEST_RESOURCE_TYPES = ['skills', 'prompts', 'mcpServers', 'tools'] as const;
export type ManifestResourceType = typeof MANIFEST_RESOURCE_TYPES[number];

/** Auth without the secret: enough to ask the importer for the right credential. */
export interface ManifestAuthShape {
    type: 'none' | 'token' | 'header' | 'basic';
    headerName?: string;
    username?: string;
}

export interface ManifestSkillResource {
    key: string;
    title: string;
    header: string;
    body: string;
    minModelTier?: 'small' | 'large';
}

export interface ManifestPromptResource {
    key: string;
    name: string;
    description?: string;
    template: string;
    metadata?: Record<string, unknown>;
}

export interface ManifestMcpResource {
    key: string;
    name: string;
    description?: string;
    sourceType: 'openapi' | 'remote' | 'stdio';
    openApiSpec?: string;
    upstreamBaseUrl?: string;
    remoteConfig?: { url: string; transport: 'streamable-http' | 'sse' };
    stdioConfig?: {
        runtime: 'npx' | 'uvx';
        packageName: string;
        args?: string[];
        /** Names only — every value is blank and filled in on import. */
        envKeys?: string[];
        executionMode: 'subprocess' | 'sandbox';
        sandbox?: { templateKey?: string; resources?: { cpuCores?: number; memoryMb?: number } };
    };
    auth: ManifestAuthShape;
}

export interface ManifestToolResource {
    key: string;
    name: string;
    description?: string;
    type: 'openapi' | 'mcp';
    openApiSpec?: string;
    upstreamBaseUrl?: string;
    mcpEndpoint?: string;
    mcpTransport?: 'sse' | 'streamable-http';
    auth: ManifestAuthShape;
}

export interface ManifestResources {
    skills?: ManifestSkillResource[];
    prompts?: ManifestPromptResource[];
    mcpServers?: ManifestMcpResource[];
    tools?: ManifestToolResource[];
}

const INCLUDE_ALIASES: Record<string, ManifestResourceType> = {
    skill: 'skills',
    skills: 'skills',
    prompt: 'prompts',
    prompts: 'prompts',
    mcp: 'mcpServers',
    mcps: 'mcpServers',
    mcpservers: 'mcpServers',
    tool: 'tools',
    tools: 'tools',
};

/** `"all"`, `"skills,mcp"` or an array → the set of types to embed. Unknown names are an error. */
export function parseResourceInclude(value: unknown): Set<ManifestResourceType> {
    const raw = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',') : [];
    const out = new Set<ManifestResourceType>();
    for (const part of raw.map((p) => p.trim().toLowerCase()).filter(Boolean)) {
        if (part === 'all') {
            MANIFEST_RESOURCE_TYPES.forEach((t) => out.add(t));
            continue;
        }
        if (part === 'none') continue;
        const type = INCLUDE_ALIASES[part];
        if (!type) throw new Error(`Unknown include "${part}". Use ${MANIFEST_RESOURCE_TYPES.join(', ')} or all.`);
        out.add(type);
    }
    return out;
}

/** Every key the spec references, per resource type (spec + inline sub-agents). */
export function referencedResourceKeys(spec: IAgentConfig): Record<ManifestResourceType, string[]> {
    const mcp = new Set<string>();
    const tools = new Set<string>();
    const visit = (bindings: IAgentToolBinding[] | undefined) => {
        for (const binding of bindings ?? []) {
            if (binding.source === 'mcp') mcp.add(binding.sourceKey);
            else if (binding.source === 'tool') tools.add(binding.sourceKey);
        }
    };
    visit(spec.toolBindings);
    for (const subagent of spec.subagents ?? []) {
        if (subagent.kind !== 'ref') visit(subagent.toolBindings);
    }
    return {
        skills: [...new Set(spec.skills ?? [])],
        prompts: spec.promptKey ? [spec.promptKey] : [],
        mcpServers: [...mcp],
        tools: [...tools],
    };
}

function authShape(auth: { type?: string; headerName?: string; username?: string } | undefined): ManifestAuthShape {
    const type = (['token', 'header', 'basic'].includes(String(auth?.type)) ? auth!.type : 'none') as ManifestAuthShape['type'];
    return {
        type,
        ...(type === 'header' && auth?.headerName ? { headerName: auth.headerName } : {}),
        ...(type === 'basic' && auth?.username ? { username: auth.username } : {}),
    };
}

function mcpResource(server: IMcpServer): ManifestMcpResource | { skip: string } {
    const sourceType = server.sourceType ?? 'openapi';
    if (sourceType === 'internal' || sourceType === 'composite') {
        return { skip: `${sourceType} MCP servers are bound to this project's own resources and cannot be embedded` };
    }
    const base = {
        key: server.key,
        name: server.name,
        ...(server.description ? { description: server.description } : {}),
        auth: authShape(server.upstreamAuth),
    };
    if (sourceType === 'remote' && server.remoteConfig) {
        return { ...base, sourceType, remoteConfig: { url: server.remoteConfig.url, transport: server.remoteConfig.transport } };
    }
    if (sourceType === 'stdio' && server.stdioConfig) {
        const stdio = server.stdioConfig;
        return {
            ...base,
            sourceType,
            stdioConfig: {
                runtime: stdio.runtime,
                packageName: stdio.packageName,
                ...(stdio.args?.length ? { args: [...stdio.args] } : {}),
                ...(stdio.env && Object.keys(stdio.env).length ? { envKeys: Object.keys(stdio.env) } : {}),
                executionMode: stdio.executionMode,
                ...(stdio.executionMode === 'sandbox' && stdio.sandbox
                    ? { sandbox: { templateKey: stdio.sandbox.templateKey, resources: stdio.sandbox.resources } }
                    : {}),
            },
        };
    }
    if (sourceType === 'openapi' && server.openApiSpec) {
        return {
            ...base,
            sourceType,
            openApiSpec: server.openApiSpec,
            ...(server.upstreamBaseUrl ? { upstreamBaseUrl: server.upstreamBaseUrl } : {}),
        };
    }
    return { skip: 'its source definition is incomplete' };
}

function toolResource(tool: ITool): ManifestToolResource {
    return {
        key: tool.key,
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        type: tool.type,
        ...(tool.openApiSpec ? { openApiSpec: tool.openApiSpec } : {}),
        ...(tool.upstreamBaseUrl ? { upstreamBaseUrl: tool.upstreamBaseUrl } : {}),
        ...(tool.mcpEndpoint ? { mcpEndpoint: tool.mcpEndpoint } : {}),
        ...(tool.mcpTransport ? { mcpTransport: tool.mcpTransport } : {}),
        auth: authShape(tool.upstreamAuth),
    };
}

export interface CollectedResources {
    resources: ManifestResources;
    /** Referenced but not embedded: not found, or not portable. */
    skipped: Array<{ type: ManifestResourceType; key: string; reason: string }>;
}

/** Loads the definitions of every referenced resource of the requested types. */
export async function collectManifestResources(
    tenantDbName: string,
    projectId: string,
    spec: IAgentConfig,
    include: Set<ManifestResourceType>,
): Promise<CollectedResources> {
    const resources: ManifestResources = {};
    const skipped: CollectedResources['skipped'] = [];
    if (include.size === 0) return { resources, skipped };

    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    const refs = referencedResourceKeys(spec);
    const missing = (type: ManifestResourceType, key: string) => skipped.push({ type, key, reason: 'not found in this project' });

    if (include.has('skills')) {
        for (const key of refs.skills) {
            const skill = await db.findSkillByKey(key, projectId);
            if (!skill) { missing('skills', key); continue; }
            (resources.skills ??= []).push({
                key: skill.key,
                title: skill.title,
                header: skill.header,
                body: skill.body,
                ...(skill.minModelTier ? { minModelTier: skill.minModelTier } : {}),
            });
        }
    }
    if (include.has('prompts')) {
        for (const key of refs.prompts) {
            const prompt = await db.findPromptByKey(key, projectId);
            if (!prompt) { missing('prompts', key); continue; }
            (resources.prompts ??= []).push({
                key: prompt.key,
                name: prompt.name,
                ...(prompt.description ? { description: prompt.description } : {}),
                template: prompt.template,
                ...(prompt.metadata && Object.keys(prompt.metadata).length ? { metadata: prompt.metadata } : {}),
            });
        }
    }
    if (include.has('mcpServers')) {
        for (const key of refs.mcpServers) {
            const server = await db.findMcpServerByKey(key, projectId);
            if (!server) { missing('mcpServers', key); continue; }
            const resource = mcpResource(server);
            if ('skip' in resource) skipped.push({ type: 'mcpServers', key, reason: resource.skip });
            else (resources.mcpServers ??= []).push(resource);
        }
    }
    if (include.has('tools')) {
        for (const key of refs.tools) {
            const tool = await db.findToolByKey(key, projectId);
            if (!tool) { missing('tools', key); continue; }
            (resources.tools ??= []).push(toolResource(tool));
        }
    }
    return { resources, skipped };
}

/** Rewrites resource keys in a spec (after an import created copies under new keys). */
export function remapSpecResourceKeys(
    spec: IAgentConfig,
    remap: Partial<Record<ManifestResourceType, Record<string, string>>>,
): IAgentConfig {
    const next: IAgentConfig = JSON.parse(JSON.stringify(spec));
    const map = (type: ManifestResourceType, key: string) => remap[type]?.[key] ?? key;
    const rebind = (bindings: IAgentToolBinding[] | undefined) => bindings?.map((binding) => (
        binding.source === 'mcp' ? { ...binding, sourceKey: map('mcpServers', binding.sourceKey) }
            : binding.source === 'tool' ? { ...binding, sourceKey: map('tools', binding.sourceKey) }
                : binding
    ));
    if (next.promptKey) next.promptKey = map('prompts', next.promptKey);
    if (next.skills) next.skills = [...new Set(next.skills.map((key) => map('skills', key)))];
    if (next.toolBindings) next.toolBindings = rebind(next.toolBindings);
    if (next.subagents) {
        next.subagents = next.subagents.map((subagent) => (
            subagent.kind === 'ref' || !subagent.toolBindings ? subagent : { ...subagent, toolBindings: rebind(subagent.toolBindings) }
        ));
    }
    return next;
}
