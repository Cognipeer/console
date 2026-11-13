/**
 * The workspace's guardrails as the MCP guardrail pickers list them: the
 * guardrail on a server's tool calls and the one that checks its tool
 * definitions. A server selects a guardrail; the guardrail's own mode applies.
 */

export type McpGuardrailOptionMode = 'enforce' | 'monitor' | 'disabled';

export interface McpGuardrailOption {
  key: string;
  name: string;
  mode: McpGuardrailOptionMode;
  /** A tool hook (`tool.pre` / `tool.post`) is on: the guardrail checks tool calls. */
  toolBound: boolean;
  /** `input.pre` or `tool.post` is on: the guardrail can check tool definitions. */
  definitionBound: boolean;
}

const MODE_LABELS: Record<McpGuardrailOptionMode, string> = {
  enforce: 'enforce',
  monitor: 'monitor',
  disabled: 'disabled',
};

/** What each mode does to an MCP tool call, for the picker's hint. */
export const MCP_GUARDRAIL_MODE_HINTS: Record<McpGuardrailOptionMode, string> = {
  enforce: 'Enforce: a blocking finding stops the call.',
  monitor: 'Monitor: findings are recorded and the call still runs.',
  disabled: 'Disabled: the guardrail checks nothing until it is turned on.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function modeOf(raw: Record<string, unknown>): McpGuardrailOptionMode {
  if (raw.enabled === false || raw.mode === 'disabled') return 'disabled';
  return raw.mode === 'monitor' ? 'monitor' : 'enforce';
}

/** The `guardrails` of a `/api/guardrails` response, as picker options. */
export function readMcpGuardrailOptions(data: unknown): McpGuardrailOption[] {
  const list = isRecord(data) && Array.isArray(data.guardrails) ? data.guardrails : [];
  const options: McpGuardrailOption[] = [];
  for (const item of list) {
    if (!isRecord(item) || typeof item.key !== 'string' || !item.key) continue;
    const authored = isRecord(item.hooks) && isRecord(item.hooks.bindings);
    const bindings = authored ? (item.hooks as { bindings: Record<string, unknown> }).bindings : {};
    const on = (hook: string) => isRecord(bindings[hook]) && (bindings[hook] as { enabled?: unknown }).enabled === true;
    options.push({
      key: item.key,
      name: typeof item.name === 'string' && item.name ? item.name : item.key,
      mode: modeOf(item),
      toolBound: on('tool.pre') || on('tool.post'),
      // A guardrail saved before hooks existed runs its checks on input (and/or output) only.
      definitionBound: authored ? on('input.pre') || on('tool.post') : item.target !== 'output',
    });
  }
  return options;
}

/**
 * The tenant's default tool guardrail (`DEFAULT_TOOL_GUARDRAIL_KEY` in
 * guardrail/hooks/engine.ts). A server binding saved without a key runs it; it
 * is created on first use, so it may not be listed yet.
 */
export const DEFAULT_TOOL_GUARDRAIL_KEY = 'tool-safety-default';

/** A guardrail template meant for MCP servers, from the guardrail module's catalog. */
export interface McpGuardrailTemplate {
  key: string;
  name: string;
  description: string;
  recommended: boolean;
}

/** The templates of a `/api/guardrails/templates` response meant for MCP servers, recommended first. */
export function readMcpGuardrailTemplates(data: unknown): McpGuardrailTemplate[] {
  const list = isRecord(data) && Array.isArray(data.templates) ? data.templates : [];
  const templates: McpGuardrailTemplate[] = [];
  for (const item of list) {
    if (!isRecord(item) || typeof item.key !== 'string' || !item.key) continue;
    if (!Array.isArray(item.attachTo) || !item.attachTo.includes('mcp')) continue;
    templates.push({
      key: item.key,
      name: typeof item.name === 'string' && item.name ? item.name : item.key,
      description: typeof item.description === 'string' ? item.description : '',
      recommended: item.recommended === true,
    });
  }
  return templates.sort((a, b) => Number(b.recommended) - Number(a.recommended));
}

/** The guardrail a template apply (`POST /api/guardrails/templates/:key/apply`) created, as a picker option. */
export function readAppliedMcpGuardrail(data: unknown): McpGuardrailOption | undefined {
  return isRecord(data) ? readMcpGuardrailOptions({ guardrails: [data.guardrail] })[0] : undefined;
}

/** Picker entries; a selected key that is not listed (deleted, or another project's) stays visible. */
export function mcpGuardrailSelectData(
  options: McpGuardrailOption[],
  selectedKey?: string | null,
): Array<{ value: string; label: string }> {
  const data = options.map((option) => ({ value: option.key, label: `${option.name} · ${MODE_LABELS[option.mode]}` }));
  if (selectedKey && !options.some((option) => option.key === selectedKey)) {
    data.unshift({
      value: selectedKey,
      label: selectedKey === DEFAULT_TOOL_GUARDRAIL_KEY ? 'Default tool guardrail' : `${selectedKey} · not found`,
    });
  }
  return data;
}
