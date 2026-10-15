/**
 * What the agent in this session can actually call.
 *
 * Derived from the stored config rather than from the run, so the inspector
 * answers "why did it not use X" as well as "what did it use" — a tool that
 * was never bound and a tool that was bound but never chosen look identical
 * in a transcript, and they are opposite problems.
 *
 * Deliberately conservative: it lists only surfaces whose tool names are known
 * from the config. Control-plane tools the SDK injects for delegation, skills
 * and planning are counted, not enumerated, because their exact names come
 * from the SDK's own policy resolution and guessing them here would be the
 * kind of plausible-looking lie this panel exists to prevent.
 */

/**
 * Where a tool came from. `runtime` is the honest label for a name the run
 * called but the config does not declare — an SDK control-plane tool, or a
 * binding that changed after the turn ran.
 */
export type ToolOrigin = 'tool' | 'mcp' | 'system' | 'knowledge' | 'memory' | 'sandbox' | 'runtime';

export interface ConfiguredTool {
    name: string;
    origin: ToolOrigin;
    /** The binding this came from — a tool record key, an MCP server key. */
    sourceKey?: string;
}

export interface AgentToolConfig {
    toolBindings?: Array<{ source?: string; sourceKey?: string; toolNames?: string[] }>;
    knowledgeEngineKey?: string;
    knowledgeBindings?: Array<{ key: string; enabled?: boolean }>;
    knowledgeToolMode?: 'combined' | 'separate';
    subagents?: unknown[];
    skills?: unknown[];
    memory?: { enabled?: boolean; memoryStoreKey?: string; mounts?: { storeKey: string; access?: string }[]; tools?: 'off' | 'read' | 'readwrite' };
    sandbox?: {
        enabled?: boolean;
        templateKey?: string;
        tools?: { exec?: boolean; code?: boolean; files?: boolean };
        preview?: { enabled?: boolean };
    };
}

/** Bound whenever a knowledge engine is attached — see `agentService.ts`. */
import { knowledgeKeySlug, normalizeKnowledgeBindings } from '@/lib/services/agents/agentKnowledgeBindings';

const KNOWLEDGE_TOOLS = [
    'knowledge_search',
    'knowledge_read_document',
    'knowledge_read_document_lines',
];

export function collectConfiguredTools(config: AgentToolConfig | undefined): ConfiguredTool[] {
    if (!config) return [];
    const tools: ConfiguredTool[] = [];

    for (const binding of config.toolBindings ?? []) {
        const origin: ToolOrigin = binding.source === 'mcp' || binding.source === 'system' ? binding.source : 'tool';
        // An empty `toolNames` binds nothing: both resolution loops in
        // `agentService.ts` iterate the list literally, so an empty one
        // contributes no tool at all rather than "everything".
        for (const name of binding.toolNames ?? []) {
            tools.push({ name, origin, sourceKey: binding.sourceKey });
        }
    }

    const kbs = normalizeKnowledgeBindings(config);
    if (kbs.length > 1 && config.knowledgeToolMode === 'separate') {
        for (const kb of kbs) {
            for (const name of KNOWLEDGE_TOOLS) {
                tools.push({ name: `${name}_${knowledgeKeySlug(kb.key)}`, origin: 'knowledge', sourceKey: kb.key });
            }
        }
    } else if (kbs.length > 0) {
        for (const name of KNOWLEDGE_TOOLS) {
            tools.push({ name, origin: 'knowledge', sourceKey: kbs.map((k) => k.key).join(', ') });
        }
    }

    // Console-side memory tools — see `agentMemoryTools.ts`. Bound whenever
    // memory is on with a store, unless the operator turned them off.
    const memoryMode = config.memory?.tools ?? 'readwrite';
    if (config.memory?.enabled && (config.memory.memoryStoreKey || config.memory.mounts?.length) && memoryMode !== 'off') {
        const names = memoryMode === 'readwrite'
            ? ['memory_search', 'memory_write', 'memory_forget']
            : ['memory_search'];
        for (const name of names) {
            tools.push({ name, origin: 'memory', sourceKey: config.memory.mounts?.[0]?.storeKey ?? config.memory.memoryStoreKey });
        }
    }

    // Sandbox tools — see `agentSandboxTools.ts`. Bound when sandbox access is
    // on (and licensed, which only the run can tell; a refused run says so).
    if (config.sandbox?.enabled) {
        const groups = { exec: true, code: true, files: true, ...(config.sandbox.tools ?? {}) };
        const names = [
            ...(groups.exec ? ['sandbox_exec'] : []),
            ...(groups.code ? ['sandbox_run_code'] : []),
            ...(groups.files ? ['sandbox_read_file', 'sandbox_write_file', 'sandbox_list_files'] : []),
            ...(config.sandbox.preview?.enabled ? ['sandbox_preview_link'] : []),
        ];
        for (const name of names) {
            tools.push({ name, origin: 'sandbox', sourceKey: config.sandbox.templateKey ?? 'default template' });
        }
    }

    return tools;
}

/** Surfaces that add tools whose names the SDK decides, not the config. */
export function countUnnamedToolSurfaces(config: AgentToolConfig | undefined): {
    subagents: number;
    skills: number;
} {
    return {
        subagents: config?.subagents?.length ?? 0,
        skills: config?.skills?.length ?? 0,
    };
}
