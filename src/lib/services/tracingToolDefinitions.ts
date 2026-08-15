/**
 * Tool-definition capture — the `tool_definitions` trace section (canonical
 * contract lives HERE; the section-kind overview in otlpMapper.ts points at
 * this file).
 *
 * Section shape:
 *   {
 *     kind: 'tool_definitions',
 *     label: 'Tool Definitions',
 *     tools: Array<{
 *       name: string;
 *       description?: string;
 *       parameters?: Record<string, unknown>;   // JSON-schema object
 *       truncated?: true;                       // `parameters` dropped by the size cap
 *     }>,
 *     truncated?: true;                          // any entry was truncated
 *   }
 *
 * The section is carried on the MODEL-CALL event it applies to (type
 * 'ai_call'), NEVER per-session: the tool menu offered to the model CAN
 * CHANGE BETWEEN TURNS, so each model call records the menu it actually saw.
 * `IAgentTracingEvent.sections` is schemaless (Array<Record<string,
 * unknown>>), so no schema migration is involved.
 *
 * Producers:
 *   - native JSON/stream ingestion — first-class `toolDefinitions` field on an
 *     incoming event (client-tracing.ts), normalized here;
 *   - OTLP ingestion — synthesized from OpenLLMetry/Traceloop
 *     `llm.request.functions.{i}.*` and `gen_ai.request.functions.{i}.*`
 *     indexed attributes (otlpMapper.ts);
 *   - the console's own agent runtime — bound-tool menu injected per ai_call
 *     event (agentService.ts createInternalTracingSink).
 *
 * Consumers: the tracing detail UI (generic section rendering + a labeled
 * name list) and the traffic-snapshot mapper (snapshotService.ts
 * mapTracingSession), which prefers these RECORDED menus over the menu it
 * infers from observed calls.
 */

export interface TraceToolDefinition {
  name: string;
  description?: string;
  /** JSON-schema object describing the tool's input. */
  parameters?: Record<string, unknown>;
  /** Set when `parameters` was dropped by the per-section size cap. */
  truncated?: true;
}

export interface ToolDefinitionsSection extends Record<string, unknown> {
  kind: 'tool_definitions';
  label: string;
  tools: TraceToolDefinition[];
  /** Set when at least one entry lost its `parameters` to the size cap. */
  truncated?: true;
}

export const TOOL_DEFINITIONS_SECTION_KIND = 'tool_definitions';

/**
 * Serialized-size budget for one section. Sections are otherwise stored raw
 * (only the global request-body cap applies at ingest), but tool schemas can
 * be enormous — beyond this budget entries keep name + description and drop
 * `parameters` with a `truncated: true` marker.
 */
export const TOOL_DEFINITIONS_SECTION_MAX_BYTES = 64 * 1024;
/** Defensive cap on the number of tools one section may carry. */
export const TOOL_DEFINITIONS_MAX_TOOLS = 128;
const MAX_NAME_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 4_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Accept a JSON-schema object directly or as a JSON string (OTLP attrs). */
function toParameters(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (record) return record;
  if (typeof value === 'string' && value.length > 0) {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined; // malformed — ignored silently by contract
    }
  }
  return undefined;
}

/**
 * Normalize a caller-supplied tool list into the section's `tools` shape.
 * Tolerant by contract — malformed entries are skipped silently. Accepts
 * bare `{name, description?, parameters?}` entries, the OpenAI envelope
 * `{type: 'function', function: {...}}`, and `inputSchema`/`input_schema`
 * aliases for `parameters` (which may itself be a JSON string).
 * Returns undefined when nothing usable remains.
 */
export function normalizeToolDefinitions(value: unknown): TraceToolDefinition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools: TraceToolDefinition[] = [];
  for (const entry of value) {
    if (tools.length >= TOOL_DEFINITIONS_MAX_TOOLS) break;
    const record = asRecord(entry);
    if (!record) continue;
    const fn = asRecord(record.function) ?? record;
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) continue;
    const description = typeof fn.description === 'string' && fn.description.length > 0
      ? fn.description.slice(0, MAX_DESCRIPTION_CHARS)
      : undefined;
    const parameters = toParameters(fn.parameters ?? fn.inputSchema ?? fn.input_schema);
    tools.push({
      name: name.slice(0, MAX_NAME_CHARS),
      ...(description !== undefined ? { description } : {}),
      ...(parameters !== undefined ? { parameters } : {}),
      // Keep the marker when re-normalizing an already-capped section.
      ...(record.truncated === true || fn.truncated === true ? { truncated: true as const } : {}),
    });
  }
  return tools.length > 0 ? tools : undefined;
}

/**
 * Build a normalized, size-capped `tool_definitions` section from any
 * caller-supplied tool list. Returns undefined when the input is malformed
 * or empty (callers ignore that silently by contract).
 */
export function buildToolDefinitionsSection(value: unknown): ToolDefinitionsSection | undefined {
  const tools = normalizeToolDefinitions(value);
  if (!tools) return undefined;

  // Size cap: names + descriptions (individually capped above) always stay;
  // once the running serialized size would blow the budget, entries drop
  // `parameters` and carry `truncated: true`.
  let bytes = 0;
  let sectionTruncated = false;
  const capped = tools.map((tool) => {
    if (tool.truncated) sectionTruncated = true;
    const size = Buffer.byteLength(JSON.stringify(tool), 'utf8');
    if (bytes + size <= TOOL_DEFINITIONS_SECTION_MAX_BYTES || tool.parameters === undefined) {
      bytes += size;
      return tool;
    }
    sectionTruncated = true;
    const reduced: TraceToolDefinition = {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      truncated: true,
    };
    bytes += Buffer.byteLength(JSON.stringify(reduced), 'utf8');
    return reduced;
  });

  return {
    kind: 'tool_definitions',
    label: 'Tool Definitions',
    tools: capped,
    ...(sectionTruncated ? { truncated: true as const } : {}),
  };
}

/**
 * Apply the tool_definitions cap/shape to any such sections inside a
 * caller-supplied sections array (senders may encode the section themselves
 * instead of using the first-class `toolDefinitions` field). Malformed
 * tool_definitions sections are dropped silently; every other section passes
 * through untouched.
 */
export function normalizeSectionListToolDefinitions(
  sections: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (!sections.some((section) => section?.kind === TOOL_DEFINITIONS_SECTION_KIND)) {
    return sections;
  }
  const out: Array<Record<string, unknown>> = [];
  for (const section of sections) {
    if (section?.kind !== TOOL_DEFINITIONS_SECTION_KIND) {
      out.push(section);
      continue;
    }
    const rebuilt = buildToolDefinitionsSection(section.tools);
    // Preserve the sender's own truncation marker: an SDK that already
    // trimmed its menu (e.g. >128 tools) sends truncated:true with a list
    // that fits our caps — rebuilding must not erase that signal.
    if (rebuilt) out.push(section.truncated === true ? { ...rebuilt, truncated: true } : rebuilt);
  }
  return out;
}
