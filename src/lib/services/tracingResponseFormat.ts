/**
 * Structured-output capture — the `response_format` trace section (canonical
 * contract lives HERE; the section-kind overview in otlpMapper.ts points at
 * this file, and tracingToolDefinitions.ts is its sibling).
 *
 * Section shape:
 *   {
 *     kind: 'response_format',
 *     label: 'Response Format',
 *     type: 'json_schema' | 'json_object' | 'text' | …,  // wire response_format.type
 *     strategy?: 'native' | 'tool_based',
 *     schemaName?: string;                    // json_schema.name
 *     strict?: boolean;                       // json_schema.strict
 *     schema?: Record<string, unknown>;       // the JSON Schema as sent
 *     truncated?: true;                       // `schema` dropped by the size cap
 *   }
 *
 * WHY this is a first-class section rather than free metadata: the messages
 * alone cannot explain a malformed or prose-instead-of-JSON reply. Whether the
 * provider was asked for a schema, and which one, is what actually decides the
 * shape of the answer — and it is the half of the request contract that a
 * REPLAY has to reproduce. An evaluation suite or prompt-optimizer run that
 * omits it measures a looser system than production runs under, so the captured
 * contract flows: trace → traffic snapshot → dataset item → suite / optimizer.
 *
 * Like `tool_definitions`, it is carried on the MODEL-CALL event it applies to
 * (type 'ai_call'), NEVER per-session: an agent may enforce a schema on its
 * final turn only, so each model call records the contract it actually sent.
 * `IAgentTracingEvent.sections` is schemaless, so no schema migration applies.
 *
 * Producers:
 *   - native JSON/stream ingestion — first-class `responseFormat` field on an
 *     incoming event (client-tracing.ts), normalized here;
 *   - OTLP ingestion — synthesized from OpenInference `llm.invocation_parameters`
 *     and OTel GenAI `gen_ai.request.structured_output_schema` (otlpMapper.ts);
 *   - the agent-sdk, which emits the section directly from the response_format
 *     it passed to the provider (utils/tracing.ts buildResponseFormatSection).
 *
 * Consumers: the tracing detail UI, and the traffic-snapshot mapper
 * (snapshotService.ts), which copies the recorded contract onto dataset items.
 */

export type ResponseFormatStrategy = 'native' | 'tool_based';

export interface ResponseFormatSection extends Record<string, unknown> {
  kind: 'response_format';
  label: string;
  type: string;
  strategy?: ResponseFormatStrategy;
  schemaName?: string;
  strict?: boolean;
  schema?: Record<string, unknown>;
  /** Set when `schema` was dropped by the per-section size cap. */
  truncated?: true;
}

export const RESPONSE_FORMAT_SECTION_KIND = 'response_format';

/**
 * Serialized-size budget for one section. A JSON Schema can be enormous, so
 * beyond this budget the section keeps the contract's IDENTITY (type, schema
 * name, strict) and drops the schema body with a `truncated: true` marker —
 * knowing a strict `invoice_v2` schema was enforced is most of the diagnostic
 * value even without the schema text.
 */
export const RESPONSE_FORMAT_SECTION_MAX_BYTES = 64 * 1024;
const MAX_NAME_CHARS = 200;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Accept a JSON-schema object directly or as a JSON string (OTLP attrs). */
function toSchema(value: unknown): Record<string, unknown> | undefined {
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

function toStrategy(value: unknown): ResponseFormatStrategy | undefined {
  return value === 'native' || value === 'tool_based' ? value : undefined;
}

/**
 * Build a normalized, size-capped `response_format` section from any
 * caller-supplied contract. Returns undefined when the input is malformed or
 * carries nothing usable (callers ignore that silently by contract).
 *
 * Tolerant about the envelope: accepts the agent-sdk's invoke-options wrapper
 * (`{ response_format: {…} }`), a bare `response_format` object, the camelCase
 * `responseFormat`/`jsonSchema` spellings, and an already-built section.
 */
export function buildResponseFormatSection(value: unknown): ResponseFormatSection | undefined {
  const outer = asRecord(value);
  if (!outer) return undefined;
  const raw = asRecord(outer.response_format) ?? asRecord(outer.responseFormat) ?? outer;

  const type = typeof raw.type === 'string' && raw.type.trim().length > 0 ? raw.type.trim() : undefined;
  const jsonSchema = asRecord(raw.json_schema) ?? asRecord(raw.jsonSchema);
  // A bare `{ schema: … }` with no type still describes a JSON contract.
  const source = jsonSchema ?? raw;
  const schema = toSchema(source.schema);
  if (!type && !schema) return undefined;

  // `schemaName` is the section's own spelling of `json_schema.name`, so an
  // already-built section (re-normalized on re-ingest) must round-trip it.
  const name = [source.name, raw.schemaName, outer.schemaName]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  const strategy = toStrategy(raw.strategy ?? outer.strategy);

  const section: ResponseFormatSection = {
    kind: RESPONSE_FORMAT_SECTION_KIND,
    label: 'Response Format',
    type: type ?? (schema ? 'json_schema' : 'unknown'),
    ...(strategy ? { strategy } : {}),
    ...(name !== undefined ? { schemaName: name.slice(0, MAX_NAME_CHARS) } : {}),
    ...(typeof source.strict === 'boolean' ? { strict: source.strict } : {}),
    ...(schema !== undefined ? { schema } : {}),
    // Keep the marker when re-normalizing an already-capped section.
    ...(raw.truncated === true || outer.truncated === true ? { truncated: true as const } : {}),
  };

  if (section.schema && Buffer.byteLength(JSON.stringify(section), 'utf8') > RESPONSE_FORMAT_SECTION_MAX_BYTES) {
    delete section.schema;
    section.truncated = true;
  }

  return section;
}

/**
 * Apply the response_format cap/shape to any such sections inside a
 * caller-supplied sections array (senders may encode the section themselves
 * instead of using the first-class `responseFormat` field). Malformed
 * response_format sections are dropped silently; every other section passes
 * through untouched.
 */
export function normalizeSectionListResponseFormat(
  sections: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (!sections.some((section) => section?.kind === RESPONSE_FORMAT_SECTION_KIND)) {
    return sections;
  }
  const out: Array<Record<string, unknown>> = [];
  for (const section of sections) {
    if (section?.kind !== RESPONSE_FORMAT_SECTION_KIND) {
      out.push(section);
      continue;
    }
    const rebuilt = buildResponseFormatSection(section);
    // Preserve the sender's own truncation marker: an SDK that already dropped
    // an oversized schema sends truncated:true with a body that fits our cap —
    // rebuilding must not erase that signal.
    if (rebuilt) out.push(section.truncated === true ? { ...rebuilt, truncated: true as const } : rebuilt);
  }
  return out;
}

/**
 * The contract in the form a REPLAY needs: exactly the object to put on the
 * wire as `response_format`. Returns undefined when the section was truncated
 * past usefulness (a `json_schema` type with no schema would be rejected by
 * the provider) — the caller then runs without a contract rather than with a
 * broken one.
 */
export function sectionToWireResponseFormat(
  section: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!section || section.kind !== RESPONSE_FORMAT_SECTION_KIND) return undefined;
  const type = typeof section.type === 'string' ? section.type : undefined;
  if (!type || type === 'unknown' || type === 'text') return undefined;
  if (type !== 'json_schema') return { type };
  const schema = asRecord(section.schema);
  if (!schema) return undefined;
  return {
    type: 'json_schema',
    json_schema: {
      name: typeof section.schemaName === 'string' && section.schemaName ? section.schemaName : 'response',
      ...(typeof section.strict === 'boolean' ? { strict: section.strict } : {}),
      schema,
    },
  };
}
