import type { IMcpServer, IMcpTool, IMcpToolAnnotations } from '@/lib/database';
import { normalizeMcpInstructions } from './discovery';
import { defaultAnnotationsForSource, describeMcpTools, type McpToolDescriptor } from './toolAnnotations';
import { resolveSourceType } from './serverView';

// ── Tool enable/disable ───────────────────────────────────────────────────
// Disabled tool names ride in metadata.disabledTools (same pattern as
// runtimeHeaders — no schema migration in either DB tree). Absent/empty
// list means every discovered tool is enabled.

export function getDisabledToolNames(server: Pick<IMcpServer, 'metadata'>): string[] {
  const raw = (server.metadata as Record<string, unknown> | undefined)?.disabledTools;
  return Array.isArray(raw) ? raw.filter((n): n is string => typeof n === 'string') : [];
}

export function isMcpToolEnabled(server: IMcpServer, toolName: string): boolean {
  return !getDisabledToolNames(server).includes(toolName);
}

/** Tools visible to callers (tools/list, client APIs, agents), overrides applied. */
export function listEnabledMcpTools(server: IMcpServer): IMcpTool[] {
  const disabled = new Set(getDisabledToolNames(server));
  const enabled = disabled.size === 0
    ? (server.tools ?? [])
    : (server.tools ?? []).filter((tool) => !disabled.has(tool.name));
  return applyToolOverrides(server, enabled);
}

/** Merge a disabled-name list into a metadata blob (empty list removes the key). */
export function metadataWithDisabledTools(
  metadata: Record<string, unknown> | undefined,
  disabledTools: string[],
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  if (disabledTools.length) next.disabledTools = disabledTools;
  else delete next.disabledTools;
  return next;
}

// ── Tool annotation overrides ─────────────────────────────────────────────
// Operator-set hints ride in metadata.toolAnnotations so they survive tool
// rediscovery (which replaces `tools` wholesale).

export function getToolAnnotationOverrides(
  server: Pick<IMcpServer, 'metadata'>,
): Record<string, IMcpToolAnnotations> {
  const raw = (server.metadata as Record<string, unknown> | undefined)?.toolAnnotations;
  if (!raw || typeof raw !== 'object') return {};
  return raw as Record<string, IMcpToolAnnotations>;
}

const ANNOTATION_FLAGS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

/** Keep only recognised keys; an entry with nothing set is dropped. */
export function sanitizeAnnotationOverride(value: unknown): IMcpToolAnnotations | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const next: IMcpToolAnnotations = {};
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title) next.title = title;
  for (const flag of ANNOTATION_FLAGS) {
    if (typeof input[flag] === 'boolean') next[flag] = input[flag] as boolean;
  }
  return Object.keys(next).length ? next : null;
}

export function metadataWithToolAnnotations(
  metadata: Record<string, unknown> | undefined,
  overrides: Record<string, IMcpToolAnnotations>,
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  if (Object.keys(overrides).length) next.toolAnnotations = overrides;
  else delete next.toolAnnotations;
  return next;
}

// ── Tool description overrides ────────────────────────────────────────────
// Same metadata-backed pattern: the operator's wording wins over whatever the
// spec/upstream advertises, and survives tool rediscovery.

export function getToolDescriptionOverrides(
  server: Pick<IMcpServer, 'metadata'>,
): Record<string, string> {
  const raw = (server.metadata as Record<string, unknown> | undefined)?.toolDescriptions;
  if (!raw || typeof raw !== 'object') return {};
  return raw as Record<string, string>;
}

export function metadataWithToolDescriptions(
  metadata: Record<string, unknown> | undefined,
  overrides: Record<string, string>,
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  if (Object.keys(overrides).length) next.toolDescriptions = overrides;
  else delete next.toolDescriptions;
  return next;
}

// ── Tool name overrides ───────────────────────────────────────────────────
// Same metadata-backed pattern as descriptions/annotations: keyed by the
// *real* (discovered) tool name, so a rename survives tool rediscovery
// without needing an identity of its own. The real name stays the source of
// truth everywhere internally (disabledTools, annotations, descriptions,
// execution) — only the outward-facing `name` in tools/list changes.

export function getToolNameOverrides(
  server: Pick<IMcpServer, 'metadata'>,
): Record<string, string> {
  const raw = (server.metadata as Record<string, unknown> | undefined)?.toolNames;
  if (!raw || typeof raw !== 'object') return {};
  return raw as Record<string, string>;
}

/** MCP/OpenAI-compatible identifier charset, generous length cap. */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export function sanitizeToolNameOverride(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !TOOL_NAME_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export function metadataWithToolNames(
  metadata: Record<string, unknown> | undefined,
  overrides: Record<string, string>,
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  if (Object.keys(overrides).length) next.toolNames = overrides;
  else delete next.toolNames;
  return next;
}

/**
 * Reverse-map whatever name a caller used back to the real, stored tool
 * name. Callers that never saw the override (legacy agent bindings, a
 * client that cached an old tools/list) still pass the real name through
 * unchanged, since it only matches an override's *target*.
 */
export function resolveMcpToolName(server: Pick<IMcpServer, 'metadata'>, calledName: string): string {
  const overrides = getToolNameOverrides(server);
  for (const [realName, exposedName] of Object.entries(overrides)) {
    if (exposedName === calledName) return realName;
  }
  return calledName;
}

// ── Server instructions ───────────────────────────────────────────────────
// The MCP `instructions` an initialize result carries — how the server's tools
// fit together, which a client may add to the model's system prompt. Same
// metadata-backed pattern: the operator's text (metadata.instructions) wins
// over what the source supplied at discovery (metadata.discoveredInstructions:
// an upstream's initialize result, an internal provider's text, a composite's
// members), which every rediscovery replaces.

export function getMcpInstructionsOverride(server: Pick<IMcpServer, 'metadata'>): string | undefined {
  return normalizeMcpInstructions((server.metadata as Record<string, unknown> | undefined)?.instructions);
}

export function getDiscoveredMcpInstructions(server: Pick<IMcpServer, 'metadata'>): string | undefined {
  return normalizeMcpInstructions(
    (server.metadata as Record<string, unknown> | undefined)?.discoveredInstructions,
  );
}

/** The `instructions` this server's `initialize` result carries, if any. */
export function resolveMcpInstructions(server: Pick<IMcpServer, 'metadata'>): string | undefined {
  return getMcpInstructionsOverride(server) ?? getDiscoveredMcpInstructions(server);
}

/** Set one instructions key in a metadata blob; `null` (or blank text) removes it. */
export function metadataWithInstructions(
  metadata: Record<string, unknown> | undefined,
  key: 'instructions' | 'discoveredInstructions',
  value: string | null,
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  const text = normalizeMcpInstructions(value);
  if (text) next[key] = text;
  else delete next[key];
  return next;
}

/** Overlay the operator's name/description/annotation overrides on discovered tools. */
function applyToolOverrides(server: Pick<IMcpServer, 'metadata'>, tools: IMcpTool[]): IMcpTool[] {
  const annotationOverrides = getToolAnnotationOverrides(server);
  const descriptionOverrides = getToolDescriptionOverrides(server);
  const nameOverrides = getToolNameOverrides(server);
  if (!Object.keys(annotationOverrides).length
    && !Object.keys(descriptionOverrides).length
    && !Object.keys(nameOverrides).length) {
    return tools;
  }
  return tools.map((tool) => {
    const annotations = annotationOverrides[tool.name];
    const description = descriptionOverrides[tool.name];
    const name = nameOverrides[tool.name];
    if (!annotations && !description && !name) return tool;
    return {
      ...tool,
      ...(name ? { name } : {}),
      ...(annotations?.title ? { title: annotations.title } : {}),
      ...(description ? { description } : {}),
      ...(annotations ? { annotations: { ...(tool.annotations ?? {}), ...annotations } } : {}),
    };
  });
}

/** Enabled tools as spec-complete `tools/list` entries, overrides applied. */
export function listMcpToolDescriptors(server: IMcpServer): McpToolDescriptor[] {
  return describeMcpTools(
    listEnabledMcpTools(server),
    defaultAnnotationsForSource(resolveSourceType(server)),
  );
}
