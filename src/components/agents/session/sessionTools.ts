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
    subagents?: unknown[];
    skills?: unknown[];
    memory?: { enabled?: boolean; memoryStoreKey?: string; tools?: 'off' | 'read' | 'readwrite' };
    sandbox?: { enabled?: boolean; templateKey?: string; tools?: { exec?: boolean; code?: boolean; files?: boolean } };
}

/** Bound whenever a knowledge engine is attached — see `agentService.ts`. */
const KNOWLEDGE_TOOLS = [
    'knowledge_search',
    'knowledge_read_document',
    'knowledge_read_document_lines',
];

export function collectConfiguredTools(config: AgentToolConfig | undefined): ConfiguredTool[] {
    if (!config) return [];
    const tools: ConfiguredTool[] = [];

    for (const binding of config.toolBindings ?? []) {
        const origin: ToolOrigin = binding.source === 'mcp'
            ? 'mcp'
            : binding.source === 'system'
                ? 'system'
                : 'tool';
        // An empty `toolNames` binds nothing: both resolution loops in
        // `agentService.ts` iterate the list literally, so an empty one
        // contributes no tool at all rather than "everything".
        for (const name of binding.toolNames ?? []) {
            tools.push({ name, origin, sourceKey: binding.sourceKey });
        }
    }

    if (config.knowledgeEngineKey) {
        for (const name of KNOWLEDGE_TOOLS) {
            tools.push({ name, origin: 'knowledge', sourceKey: config.knowledgeEngineKey });
        }
    }

    // Console-side memory tools — see `agentMemoryTools.ts`. Bound whenever
    // memory is on with a store, unless the operator turned them off.
    const memoryMode = config.memory?.tools ?? 'readwrite';
    if (config.memory?.enabled && config.memory.memoryStoreKey && memoryMode !== 'off') {
        const names = memoryMode === 'readwrite'
            ? ['memory_search', 'memory_write', 'memory_forget']
            : ['memory_search'];
        for (const name of names) {
            tools.push({ name, origin: 'memory', sourceKey: config.memory.memoryStoreKey });
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
