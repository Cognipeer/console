/**
 * The `response_format` trace section: the structured-output contract enforced
 * on ONE model call. Contract + caps live in tracingResponseFormat.ts.
 *
 * These cover the two things that make the section useful end to end: it
 * normalizes whatever envelope a sender used, and it converts back into the
 * exact object a replay puts on the wire.
 */

import { describe, it, expect } from 'vitest';
import {
  buildResponseFormatSection,
  normalizeSectionListResponseFormat,
  sectionToWireResponseFormat,
} from '@/lib/services/tracingResponseFormat';
import { mapOtlpToInternalModels, type OtlpKeyValue } from '@/lib/services/otlpMapper';

const SCHEMA = {
  type: 'object',
  properties: { total: { type: 'number' } },
  required: ['total'],
  additionalProperties: false,
};

describe('buildResponseFormatSection', () => {
  it('normalizes the agent-sdk invoke envelope', () => {
    const section = buildResponseFormatSection({
      response_format: { type: 'json_schema', json_schema: { name: 'invoice', strict: true, schema: SCHEMA } },
    });
    expect(section).toEqual({
      kind: 'response_format',
      label: 'Response Format',
      type: 'json_schema',
      schemaName: 'invoice',
      strict: true,
      schema: SCHEMA,
    });
  });

  it('accepts a bare response_format body and the camelCase spellings', () => {
    expect(buildResponseFormatSection({ type: 'json_object' })?.type).toBe('json_object');
    expect(
      buildResponseFormatSection({ responseFormat: { type: 'json_schema', jsonSchema: { name: 'x', schema: SCHEMA } } })
        ?.schemaName,
    ).toBe('x');
  });

  it('parses a JSON-string schema (the OTLP attribute form)', () => {
    const section = buildResponseFormatSection({
      type: 'json_schema',
      json_schema: { name: 'otlp', schema: JSON.stringify(SCHEMA) },
    });
    expect(section?.schema).toEqual(SCHEMA);
  });

  it('keeps the strategy when the sender recorded one', () => {
    expect(buildResponseFormatSection({ type: 'json_object', strategy: 'tool_based' })?.strategy).toBe('tool_based');
    expect(buildResponseFormatSection({ type: 'json_object', strategy: 'nonsense' })?.strategy).toBeUndefined();
  });

  it('drops an oversized schema but keeps the contract identity', () => {
    const section = buildResponseFormatSection({
      type: 'json_schema',
      json_schema: { name: 'huge', strict: true, schema: { type: 'object', description: 'x'.repeat(70 * 1024) } },
    });
    expect(section?.schema).toBeUndefined();
    expect(section?.truncated).toBe(true);
    expect(section?.schemaName).toBe('huge');
  });

  it('returns undefined when there is nothing usable', () => {
    expect(buildResponseFormatSection(undefined)).toBeUndefined();
    expect(buildResponseFormatSection({})).toBeUndefined();
    expect(buildResponseFormatSection([])).toBeUndefined();
    expect(buildResponseFormatSection({ response_format: {} })).toBeUndefined();
  });
});

describe('normalizeSectionListResponseFormat', () => {
  it('leaves lists without a response_format section untouched (same reference)', () => {
    const sections = [{ kind: 'message', role: 'user', content: 'hi' }];
    expect(normalizeSectionListResponseFormat(sections)).toBe(sections);
  });

  it('rebuilds a sender-encoded section and drops a malformed one', () => {
    const out = normalizeSectionListResponseFormat([
      { kind: 'message', role: 'user', content: 'hi' },
      { kind: 'response_format', label: 'whatever', type: 'json_schema', schemaName: 'x', schema: SCHEMA },
      { kind: 'response_format', label: 'broken' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ label: 'Response Format', schemaName: 'x' });
  });

  it("preserves a sender's own truncation marker", () => {
    const out = normalizeSectionListResponseFormat([
      { kind: 'response_format', label: 'Response Format', type: 'json_schema', schemaName: 'x', truncated: true },
    ]);
    expect(out[0].truncated).toBe(true);
  });
});

describe('sectionToWireResponseFormat', () => {
  it('round-trips a json_schema contract back onto the wire', () => {
    const section = buildResponseFormatSection({
      response_format: { type: 'json_schema', json_schema: { name: 'invoice', strict: true, schema: SCHEMA } },
    });
    expect(sectionToWireResponseFormat(section)).toEqual({
      type: 'json_schema',
      json_schema: { name: 'invoice', strict: true, schema: SCHEMA },
    });
  });

  it('passes json_object through as the bare mode', () => {
    expect(sectionToWireResponseFormat(buildResponseFormatSection({ type: 'json_object' })))
      .toEqual({ type: 'json_object' });
  });

  it('refuses a json_schema whose schema was truncated away', () => {
    // A schema-less json_schema block is rejected by every provider: replaying
    // with NO contract is a smaller lie than replaying with a broken one.
    const section = buildResponseFormatSection({
      type: 'json_schema',
      json_schema: { name: 'huge', schema: { type: 'object', description: 'x'.repeat(70 * 1024) } },
    });
    expect(sectionToWireResponseFormat(section)).toBeUndefined();
  });

  it('ignores non-response_format sections and plain text mode', () => {
    expect(sectionToWireResponseFormat({ kind: 'message', content: 'hi' })).toBeUndefined();
    expect(sectionToWireResponseFormat(buildResponseFormatSection({ type: 'text' }))).toBeUndefined();
    expect(sectionToWireResponseFormat(undefined)).toBeUndefined();
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

function responseFormatSections(childAttrs: OtlpKeyValue[]) {
  const { events } = mapOtlpToInternalModels(otlpRequest(childAttrs), 'tenant-1', 'project-1');
  expect(events).toHaveLength(1);
  return (events[0].sections ?? []).filter((section) => section.kind === 'response_format');
}

describe('mapOtlpToInternalModels response_format synthesis', () => {
  it('reads the contract out of OpenInference invocation parameters', () => {
    const sections = responseFormatSections([
      str('llm.invocation_parameters', JSON.stringify({
        temperature: 0,
        response_format: { type: 'json_schema', json_schema: { name: 'invoice', strict: true, schema: SCHEMA } },
      })),
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ type: 'json_schema', schemaName: 'invoice', strict: true, schema: SCHEMA });
  });

  it('reads a directly attached response_format body', () => {
    const sections = responseFormatSections([
      str('llm.request.response_format', JSON.stringify({ type: 'json_object' })),
    ]);
    expect(sections[0]).toMatchObject({ type: 'json_object' });
  });

  it('reassembles the GenAI split form (output type + schema)', () => {
    const sections = responseFormatSections([
      str('gen_ai.output.type', 'json'),
      str('gen_ai.request.structured_output_schema', JSON.stringify(SCHEMA)),
      str('gen_ai.request.structured_output_name', 'invoice'),
    ]);
    expect(sections[0]).toMatchObject({ type: 'json_schema', schemaName: 'invoice', schema: SCHEMA });
  });

  it('treats JSON mode without a schema as a contract of its own', () => {
    expect(responseFormatSections([str('gen_ai.output.type', 'json')])[0])
      .toMatchObject({ type: 'json_object' });
  });

  it('stays silent when the span says nothing about the contract', () => {
    // Absent and `text` are different facts from "unconstrained call", and a
    // section on every event would be pure noise.
    expect(responseFormatSections([])).toHaveLength(0);
    expect(responseFormatSections([str('gen_ai.output.type', 'text')])).toHaveLength(0);
    expect(responseFormatSections([str('llm.invocation_parameters', '{broken')])).toHaveLength(0);
  });

  it('composes with the tool menu on the same event', () => {
    const { events } = mapOtlpToInternalModels(
      otlpRequest([
        str('llm.request.functions.0.name', 'search_flights'),
        str('llm.request.response_format', JSON.stringify({ type: 'json_object' })),
      ]),
      'tenant-1',
    );
    const kinds = (events[0].sections ?? []).map((section) => section.kind);
    expect(kinds).toContain('tool_definitions');
    expect(kinds).toContain('response_format');
  });
});
