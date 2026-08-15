/**
 * Unit tests — `tool_definitions` trace-section capture.
 *
 * Covers the shared normalizer/cap (tracingToolDefinitions.ts) and the OTLP
 * synthesis of the section from the wire conventions we support:
 * OpenLLMetry/Traceloop `llm.request.functions.{i}.*`, the
 * `gen_ai.request.functions.{i}.*` mirror, and the single JSON-array
 * attribute variant (`gen_ai.request.tools` / `llm.request.tools`).
 */

import { describe, expect, it } from 'vitest';

import {
  buildToolDefinitionsSection,
  normalizeSectionListToolDefinitions,
  normalizeToolDefinitions,
  TOOL_DEFINITIONS_SECTION_MAX_BYTES,
} from '@/lib/services/tracingToolDefinitions';
import { mapOtlpToInternalModels, type OtlpKeyValue } from '@/lib/services/otlpMapper';

// ── Normalizer ─────────────────────────────────────────────────────────────

describe('normalizeToolDefinitions', () => {
  it('accepts bare entries and skips malformed ones silently', () => {
    const tools = normalizeToolDefinitions([
      { name: 'search', description: 'Search things', parameters: { type: 'object' } },
      { description: 'no name — dropped' },
      'not-an-object',
      null,
      { name: '   ' }, // blank name — dropped
      { name: 'plain' },
    ]);
    expect(tools).toEqual([
      { name: 'search', description: 'Search things', parameters: { type: 'object' } },
      { name: 'plain' },
    ]);
  });

  it('accepts the OpenAI function envelope', () => {
    const tools = normalizeToolDefinitions([
      {
        type: 'function',
        function: {
          name: 'book_flight',
          description: 'Book a flight',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ]);
    expect(tools).toEqual([
      {
        name: 'book_flight',
        description: 'Book a flight',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);
  });

  it('parses JSON-string parameters and accepts inputSchema aliases', () => {
    const tools = normalizeToolDefinitions([
      { name: 'a', parameters: '{"type":"object","properties":{"q":{"type":"string"}}}' },
      { name: 'b', inputSchema: { type: 'object' } },
      { name: 'c', parameters: '{broken json' }, // malformed schema — entry kept, schema ignored
    ]);
    expect(tools).toEqual([
      { name: 'a', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'b', parameters: { type: 'object' } },
      { name: 'c' },
    ]);
  });

  it('returns undefined for non-arrays and empty results', () => {
    expect(normalizeToolDefinitions(undefined)).toBeUndefined();
    expect(normalizeToolDefinitions('nope')).toBeUndefined();
    expect(normalizeToolDefinitions([{ description: 'nameless' }])).toBeUndefined();
    expect(normalizeToolDefinitions([])).toBeUndefined();
  });
});

// ── Section build + size cap ───────────────────────────────────────────────

describe('buildToolDefinitionsSection', () => {
  it('builds the section shape for well-formed input', () => {
    const section = buildToolDefinitionsSection([{ name: 'search', parameters: { type: 'object' } }]);
    expect(section).toEqual({
      kind: 'tool_definitions',
      label: 'Tool Definitions',
      tools: [{ name: 'search', parameters: { type: 'object' } }],
    });
  });

  it('returns undefined for malformed input (ignored silently by callers)', () => {
    expect(buildToolDefinitionsSection({ name: 'not-an-array' })).toBeUndefined();
    expect(buildToolDefinitionsSection(undefined)).toBeUndefined();
  });

  it('drops parameters beyond the byte budget with truncated markers', () => {
    const giant = 'x'.repeat(TOOL_DEFINITIONS_SECTION_MAX_BYTES);
    const section = buildToolDefinitionsSection([
      { name: 'small', description: 'fits', parameters: { type: 'object' } },
      { name: 'huge', description: 'schema too big', parameters: { type: 'object', blob: giant } },
      { name: 'later', parameters: { type: 'object' } },
    ]);
    expect(section).toBeDefined();
    if (!section) return;
    // First tool fits untouched.
    expect(section.tools[0]).toEqual({ name: 'small', description: 'fits', parameters: { type: 'object' } });
    // The oversized tool keeps name + description, loses parameters.
    expect(section.tools[1]).toEqual({ name: 'huge', description: 'schema too big', truncated: true });
    expect(section.truncated).toBe(true);
    // The section stays storable: far below the raw input size.
    const bytes = Buffer.byteLength(JSON.stringify(section), 'utf8');
    expect(bytes).toBeLessThan(TOOL_DEFINITIONS_SECTION_MAX_BYTES * 2);
  });
});

describe('normalizeSectionListToolDefinitions', () => {
  it('rebuilds tool_definitions sections, drops malformed ones, passes others through', () => {
    const message = { kind: 'message', role: 'user', content: 'hi' };
    const out = normalizeSectionListToolDefinitions([
      message,
      { kind: 'tool_definitions', tools: [{ name: 'a', parameters: '{"type":"object"}' }] },
      { kind: 'tool_definitions', tools: 'malformed' },
    ]);
    expect(out).toEqual([
      message,
      {
        kind: 'tool_definitions',
        label: 'Tool Definitions',
        tools: [{ name: 'a', parameters: { type: 'object' } }],
      },
    ]);
  });

  it('returns the input array unchanged when no tool_definitions are present', () => {
    const sections = [{ kind: 'message', role: 'user', content: 'hi' }];
    expect(normalizeSectionListToolDefinitions(sections)).toBe(sections);
  });
});

// ── OTLP synthesis ─────────────────────────────────────────────────────────

function str(key: string, value: string): OtlpKeyValue {
  return { key, value: { stringValue: value } };
}

function otlpRequest(childAttrs: OtlpKeyValue[]) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [str('service.name', 'test-agent')] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'trace-1',
                spanId: 'root-span',
                name: 'agent_session',
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
              },
              {
                traceId: 'trace-1',
                spanId: 'child-span',
                parentSpanId: 'root-span',
                name: 'chat gpt-4o',
                startTimeUnixNano: '1700000000100000000',
                endTimeUnixNano: '1700000000600000000',
                attributes: [
                  str('gen_ai.prompt.0.role', 'user'),
                  str('gen_ai.prompt.0.content', 'hello'),
                  ...childAttrs,
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function toolDefinitionSections(childAttrs: OtlpKeyValue[]) {
  const { events } = mapOtlpToInternalModels(otlpRequest(childAttrs), 'tenant-1', 'project-1');
  expect(events).toHaveLength(1);
  return (events[0].sections ?? []).filter((section) => section.kind === 'tool_definitions');
}

describe('mapOtlpToInternalModels tool_definitions synthesis', () => {
  it('synthesizes the section from llm.request.functions.{i}.* (Traceloop style)', () => {
    const sections = toolDefinitionSections([
      str('llm.request.functions.0.name', 'search_flights'),
      str('llm.request.functions.0.description', 'Search flights'),
      str('llm.request.functions.0.parameters', '{"type":"object","properties":{"city":{"type":"string"}}}'),
      str('llm.request.functions.1.name', 'book_flight'),
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0].tools).toEqual([
      {
        name: 'search_flights',
        description: 'Search flights',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
      { name: 'book_flight' },
    ]);
    // Attached to the same synthesized event as the span's model call.
    const { events } = mapOtlpToInternalModels(
      otlpRequest([str('llm.request.functions.0.name', 'search_flights')]),
      'tenant-1',
    );
    expect(events[0].type).toBe('ai_call');
    expect((events[0].sections ?? []).some((section) => section.kind === 'message')).toBe(true);
  });

  it('synthesizes from the gen_ai.request.functions.{i}.* mirror', () => {
    const sections = toolDefinitionSections([
      str('gen_ai.request.functions.0.name', 'lookup'),
      str('gen_ai.request.functions.0.parameters', '{"type":"object"}'),
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0].tools).toEqual([{ name: 'lookup', parameters: { type: 'object' } }]);
  });

  it('synthesizes from a single gen_ai.request.tools JSON array (OpenAI envelopes)', () => {
    const sections = toolDefinitionSections([
      str(
        'gen_ai.request.tools',
        JSON.stringify([
          { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } },
        ]),
      ),
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0].tools).toEqual([{ name: 'get_weather', parameters: { type: 'object' } }]);
  });

  it('ignores unparseable JSON and spans without tool attributes', () => {
    expect(toolDefinitionSections([str('gen_ai.request.tools', '{broken')])).toHaveLength(0);
    expect(toolDefinitionSections([])).toHaveLength(0);
  });
});
