/**
 * Claude Managed Agents → console agent.
 *
 * Source format (platform.claude.com/docs/en/managed-agents/agent-setup):
 * `name`, `model` (string or `{ id }`), `system`, `description`, `tools`
 * (`agent_toolset_<date>`, `mcp_toolset`, `custom`), `mcp_servers`
 * (`{ type: 'url', name, url }`), `skills` (`{ type: 'anthropic'|'custom',
 * skill_id, version }`), `multiagent`, `metadata`. The CLI file is Markdown
 * with this as YAML front-matter and the system prompt as the body.
 *
 * This module is pure: it turns the document into a plan. Resolving the
 * plan against the project (which model, which existing MCP server/skill)
 * and writing it is `importService.ts`'s job.
 */

import type { ParsedAgentDocument } from './document';

/** The built-in toolset's tools that need a machine to run on → the console Sandbox. */
export const CLAUDE_SANDBOX_TOOLS = ['bash', 'read', 'write', 'edit', 'glob', 'grep'] as const;
export const CLAUDE_BUILTIN_TOOLS = [...CLAUDE_SANDBOX_TOOLS, 'web_search', 'web_fetch'] as const;

export interface ClaudeMcpPlan {
    /** `mcp_servers[].name` — how the document refers to it. */
    ref: string;
    url: string;
    /**
     * Tool filter from the matching `mcp_toolset`: `mode: 'all-except'` keeps
     * every discovered tool but `names`; `'only'` keeps just `names`.
     */
    toolFilter: { mode: 'all-except' | 'only'; names: string[] };
    /** A server listed without an `mcp_toolset` referencing it contributes no tools. */
    referenced: boolean;
}

export interface ClaudeSkillPlan {
    ref: string;
    kind: 'anthropic' | 'custom';
    skillId: string;
    version?: string;
}

export interface ClaudeAgentPlan {
    name: string;
    description?: string;
    /** The Claude model id the document asks for (e.g. `claude-opus-5-5`). */
    model?: string;
    systemPrompt?: string;
    builtins: { sandbox: string[]; webSearch: boolean; webFetch: boolean };
    mcpServers: ClaudeMcpPlan[];
    skills: ClaudeSkillPlan[];
    metadata?: Record<string, unknown>;
    /** Parts of the document the console has no equivalent for. */
    unsupported: Array<{ code: string; message: string }>;
    /** Provenance: the Claude agent id/version when the document is an API response. */
    source?: { id?: string; version?: number };
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/**
 * 0–100 confidence that `doc` is a Claude Managed Agent definition. Strong
 * markers are the versioned built-in toolset and `mcp_toolset`; a `claude-*`
 * model or the `agent_…` id of an API response are corroborating.
 */
export function detectClaudeManagedAgent(doc: ParsedAgentDocument): number {
    const data = doc.data;
    if (data.apiVersion !== undefined && data.kind !== undefined) return 0;
    const tools = asArray(data.tools).map(asRecord).filter(Boolean) as Array<Record<string, unknown>>;
    let score = 0;
    if (tools.some((t) => typeof t.type === 'string' && /^agent_toolset_\d+$/.test(t.type))) score = Math.max(score, 95);
    if (tools.some((t) => t.type === 'mcp_toolset')) score = Math.max(score, 90);
    if (data.type === 'agent' && typeof data.id === 'string' && data.id.startsWith('agent_')) score = Math.max(score, 90);
    const skills = asArray(data.skills).map(asRecord);
    if (skills.some((s) => s && (s.type === 'anthropic' || s.type === 'custom') && typeof s.skill_id === 'string')) {
        score = Math.max(score, 80);
    }
    const servers = asArray(data.mcp_servers).map(asRecord);
    if (servers.some((s) => s && s.type === 'url' && typeof s.url === 'string')) score = Math.max(score, 70);
    const model = typeof data.model === 'string' ? data.model : str(asRecord(data.model)?.id);
    if (model && /^claude[-_]/i.test(model) && typeof data.name === 'string') score = Math.max(score, 60);
    if (data.multiagent !== undefined && typeof data.name === 'string') score = Math.max(score, 60);
    return score;
}

/** `default_config.enabled` + per-tool `configs[]` → which names are on. */
function toolFilterFrom(toolset: Record<string, unknown>): { mode: 'all-except' | 'only'; names: string[] } {
    const defaultEnabled = asRecord(toolset.default_config)?.enabled !== false;
    const configs = asArray(toolset.configs).map(asRecord).filter(Boolean) as Array<Record<string, unknown>>;
    if (defaultEnabled) {
        return {
            mode: 'all-except',
            names: configs.filter((c) => c.enabled === false).map((c) => str(c.name)).filter((n): n is string => Boolean(n)),
        };
    }
    return {
        mode: 'only',
        names: configs.filter((c) => c.enabled === true).map((c) => str(c.name)).filter((n): n is string => Boolean(n)),
    };
}

export function planClaudeManagedAgent(doc: ParsedAgentDocument): ClaudeAgentPlan {
    const data = doc.data;
    const unsupported: ClaudeAgentPlan['unsupported'] = [];
    const name = str(data.name);
    if (!name) throw new Error('A Claude agent definition needs a name.');

    const model = typeof data.model === 'string' ? str(data.model) : str(asRecord(data.model)?.id);
    const systemPrompt = str(data.system) ?? doc.body;

    const builtins = { sandbox: [] as string[], webSearch: false, webFetch: false };
    const toolsetsByServer = new Map<string, Record<string, unknown>>();
    for (const raw of asArray(data.tools)) {
        const tool = asRecord(raw);
        if (!tool) continue;
        const type = str(tool.type) ?? '';
        if (/^agent_toolset_/.test(type)) {
            const filter = toolFilterFrom(tool);
            const enabled = CLAUDE_BUILTIN_TOOLS.filter((t) =>
                (filter.mode === 'all-except' ? !filter.names.includes(t) : filter.names.includes(t)));
            builtins.sandbox = enabled.filter((t) => (CLAUDE_SANDBOX_TOOLS as readonly string[]).includes(t));
            builtins.webSearch = enabled.includes('web_search');
            builtins.webFetch = enabled.includes('web_fetch');
        } else if (type === 'mcp_toolset') {
            const serverName = str(tool.mcp_server_name);
            if (serverName) toolsetsByServer.set(serverName, tool);
        } else if (type === 'custom') {
            unsupported.push({
                code: 'custom_tool',
                message: `Custom tool "${str(tool.name) ?? '?'}" is executed by the Claude client that calls the agent; the console has no implementation for it. Add it as a Tool or MCP server and bind it.`,
            });
        } else if (type) {
            unsupported.push({ code: 'unknown_tool', message: `Tool type "${type}" is not recognised and was skipped.` });
        }
    }

    const mcpServers: ClaudeMcpPlan[] = [];
    const seen = new Set<string>();
    for (const raw of asArray(data.mcp_servers)) {
        const server = asRecord(raw);
        const ref = str(server?.name);
        const url = str(server?.url);
        if (!server || !ref || !url) continue;
        if (server.type !== undefined && server.type !== 'url') {
            unsupported.push({ code: 'mcp_type', message: `MCP server "${ref}" has type "${String(server.type)}"; only "url" servers can be imported.` });
            continue;
        }
        if (seen.has(ref)) continue;
        seen.add(ref);
        const toolset = toolsetsByServer.get(ref);
        mcpServers.push({
            ref,
            url,
            toolFilter: toolset ? toolFilterFrom(toolset) : { mode: 'only', names: [] },
            referenced: Boolean(toolset),
        });
    }
    for (const serverName of toolsetsByServer.keys()) {
        if (!seen.has(serverName)) {
            unsupported.push({ code: 'mcp_missing', message: `mcp_toolset references "${serverName}", which is not in mcp_servers.` });
        }
    }

    const skills: ClaudeSkillPlan[] = [];
    for (const raw of asArray(data.skills)) {
        const skill = asRecord(raw);
        const skillId = str(skill?.skill_id);
        if (!skill || !skillId) continue;
        const kind = skill.type === 'anthropic' ? 'anthropic' : 'custom';
        skills.push({
            ref: `${kind}:${skillId}`,
            kind,
            skillId,
            ...(str(skill.version) ? { version: str(skill.version) } : {}),
        });
    }

    if (data.multiagent !== undefined) {
        unsupported.push({
            code: 'multiagent',
            message: 'The multiagent block was not imported. Add the delegate agents under Build → Delegation.',
        });
    }

    const metadata = asRecord(data.metadata);
    return {
        name,
        ...(str(data.description) ? { description: str(data.description) } : {}),
        ...(model ? { model } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        builtins,
        mcpServers,
        skills,
        ...(metadata ? { metadata } : {}),
        unsupported,
        ...(typeof data.id === 'string' || typeof data.version === 'number'
            ? { source: { ...(typeof data.id === 'string' ? { id: data.id } : {}), ...(typeof data.version === 'number' ? { version: data.version } : {}) } }
            : {}),
    };
}

/** Keeps discovered tool names that pass a toolset filter. */
export function applyToolFilter(discovered: string[], filter: ClaudeMcpPlan['toolFilter']): string[] {
    return filter.mode === 'all-except'
        ? discovered.filter((name) => !filter.names.includes(name))
        : discovered.filter((name) => filter.names.includes(name));
}
