/**
 * OTLP ingestion of third-party GenAI semantic conventions.
 *
 * Agent frameworks that are not instrumented by the Cognipeer SDK arrive here
 * through OpenInference (Arize/Phoenix), the current OTel GenAI convention
 * (also OpenLLMetry >= 0.55) or the legacy indexed OpenLLMetry form — and a
 * customer usually cannot choose which. These tests pin the mapping for each,
 * because a missed attribute silently shows up as an empty trace rather than
 * as an error.
 */

import { describe, expect, it } from 'vitest';
import { mapOtlpToInternalModels, type OtlpKeyValue } from '@/lib/services/otlpMapper';

function str(key: string, value: string): OtlpKeyValue {
  return { key, value: { stringValue: value } };
}

function int(key: string, value: number): OtlpKeyValue {
  return { key, value: { intValue: String(value) } };
}

/** One root span plus one child carrying the attributes under test. */
function request(childAttrs: OtlpKeyValue[], resourceAttrs: OtlpKeyValue[] = []) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [str('service.name', 'third-party-agent'), ...resourceAttrs] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'trace-semconv',
                spanId: 'root-span',
                name: 'agent_session',
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000002000000000',
              },
              {
                traceId: 'trace-semconv',
                spanId: 'child-span',
                parentSpanId: 'root-span',
                name: 'ChatOpenAI',
                startTimeUnixNano: '1700000000100000000',
                endTimeUnixNano: '1700000000900000000',
                attributes: childAttrs,
              },
            ],
          },
        ],
      },
    ],
  };
}

function mapChild(childAttrs: OtlpKeyValue[], resourceAttrs: OtlpKeyValue[] = []) {
  const result = mapOtlpToInternalModels(request(childAttrs, resourceAttrs), 'tenant-1', 'project-1');
  expect(result.events).toHaveLength(1);
  return { event: result.events[0], session: result.sessions[0] };
}

function sectionsOfKind(sections: Array<Record<string, unknown>> | undefined, kind: string) {
  return (sections ?? []).filter((section) => section.kind === kind);
}

describe('OpenInference (Arize/Phoenix) spans', () => {
  const llmSpan: OtlpKeyValue[] = [
    str('openinference.span.kind', 'LLM'),
    str('llm.model_name', 'gpt-4.1-mini'),
    int('llm.token_count.prompt', 1200),
    int('llm.token_count.completion', 90),
    int('llm.token_count.total', 1290),
    int('llm.token_count.prompt_details.cache_read', 1024),
    str('llm.input_messages.0.message.role', 'system'),
    str('llm.input_messages.0.message.content', 'You are helpful.'),
    str('llm.input_messages.1.message.role', 'user'),
    str('llm.input_messages.1.message.content', 'Book a flight to Rome'),
    str('llm.output_messages.0.message.role', 'assistant'),
    str('llm.output_messages.0.message.content', 'Searching…'),
    str('llm.output_messages.0.message.tool_calls.0.tool_call.function.name', 'search_flights'),
    str('llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments', '{"city":"Rome"}'),
    str(
      'llm.tools.0.tool.json_schema',
      '{"type":"function","function":{"name":"search_flights","description":"Search flights","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}',
    ),
    str('session.id', 'conv-42'),
  ];

  it('maps span kind, model and the full token breakdown', () => {
    const { event } = mapChild(llmSpan);

    expect(event.type).toBe('ai_call');
    expect(event.model).toBe('gpt-4.1-mini');
    expect(event.inputTokens).toBe(1200);
    expect(event.outputTokens).toBe(90);
    expect(event.totalTokens).toBe(1290);
    expect(event.cachedInputTokens).toBe(1024);
  });

  it('renders indexed messages and their nested tool calls as sections', () => {
    const { event } = mapChild(llmSpan);

    expect(sectionsOfKind(event.sections, 'message').map((section) => section.content)).toEqual([
      'You are helpful.',
      'Book a flight to Rome',
      'Searching…',
    ]);
    expect(sectionsOfKind(event.sections, 'tool_call')).toEqual([
      expect.objectContaining({ tool: 'search_flights', content: '{"city":"Rome"}' }),
    ]);
  });

  it('recovers the tool menu from llm.tools.{i}.tool.json_schema', () => {
    const { event } = mapChild(llmSpan);
    const [definitions] = sectionsOfKind(event.sections, 'tool_definitions');

    expect(definitions.tools).toEqual([
      {
        name: 'search_flights',
        description: 'Search flights',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);
  });

  it('uses session.id as the thread id', () => {
    const { session } = mapChild(llmSpan);
    expect(session.threadId).toBe('conv-42');
  });

  it('maps a TOOL span to tool_call with its input and output', () => {
    const { event } = mapChild([
      str('openinference.span.kind', 'TOOL'),
      str('tool.name', 'search_flights'),
      str('input.value', '{"city":"Rome"}'),
      str('output.value', '[{"flight":"AZ123"}]'),
    ]);

    expect(event.type).toBe('tool_call');
    expect(event.toolName).toBe('search_flights');
    expect(sectionsOfKind(event.sections, 'tool_call')[0]).toMatchObject({
      content: '{"city":"Rome"}',
    });
    expect(sectionsOfKind(event.sections, 'tool_result')[0]).toMatchObject({
      content: '[{"flight":"AZ123"}]',
    });
  });

  it('maps RETRIEVER and EMBEDDING kinds', () => {
    expect(mapChild([str('openinference.span.kind', 'RETRIEVER')]).event.type).toBe('retrieval');
    expect(mapChild([str('openinference.span.kind', 'EMBEDDING')]).event.type).toBe('embedding');
  });
});

describe('OTel GenAI / OpenLLMetry >= 0.55 spans', () => {
  const genAiSpan: OtlpKeyValue[] = [
    str('gen_ai.operation.name', 'chat'),
    str('gen_ai.request.model', 'claude-sonnet-5'),
    str('gen_ai.response.model', 'claude-sonnet-5-20260101'),
    int('gen_ai.usage.input_tokens', 800),
    int('gen_ai.usage.output_tokens', 120),
    int('gen_ai.usage.cache_read.input_tokens', 640),
    str('gen_ai.system_instructions', '[{"type":"text","content":"You are a travel agent."}]'),
    str(
      'gen_ai.input.messages',
      '[{"role":"user","parts":[{"type":"text","content":"Book a flight"}]}]',
    ),
    str(
      'gen_ai.output.messages',
      '[{"role":"assistant","parts":[{"type":"text","content":"On it"},{"type":"tool_call","name":"search_flights","arguments":{"city":"Rome"}}]}]',
    ),
    str(
      'gen_ai.tool.definitions',
      '[{"name":"search_flights","description":"Search flights","parameters":{"type":"object"}}]',
    ),
    str('gen_ai.conversation.id', 'conv-77'),
  ];

  it('prefers the response model and reads the standard token keys', () => {
    const { event } = mapChild(genAiSpan);

    expect(event.type).toBe('ai_call');
    expect(event.model).toBe('claude-sonnet-5-20260101');
    expect(event.inputTokens).toBe(800);
    expect(event.outputTokens).toBe(120);
    expect(event.cachedInputTokens).toBe(640);
  });

  it('keeps the system prompt, which lives outside gen_ai.input.messages', () => {
    const { event } = mapChild(genAiSpan);
    const messages = sectionsOfKind(event.sections, 'message');

    expect(messages[0]).toMatchObject({ role: 'system', content: 'You are a travel agent.' });
    expect(messages.map((section) => section.content)).toEqual([
      'You are a travel agent.',
      'Book a flight',
      'On it',
    ]);
  });

  it('extracts tool calls from message parts and the tool menu from the JSON array', () => {
    const { event } = mapChild(genAiSpan);

    expect(sectionsOfKind(event.sections, 'tool_call')[0]).toMatchObject({
      tool: 'search_flights',
      content: '{"city":"Rome"}',
    });
    expect(sectionsOfKind(event.sections, 'tool_definitions')[0].tools).toEqual([
      { name: 'search_flights', description: 'Search flights', parameters: { type: 'object' } },
    ]);
  });

  it('uses gen_ai.conversation.id as the thread id', () => {
    expect(mapChild(genAiSpan).session.threadId).toBe('conv-77');
  });

  it('maps execute_tool operations and their results', () => {
    const { event } = mapChild([
      str('gen_ai.operation.name', 'execute_tool'),
      str('gen_ai.tool.name', 'search_flights'),
      str('gen_ai.tool.call.result', '[{"flight":"AZ123"}]'),
    ]);

    expect(event.type).toBe('tool_call');
    expect(event.toolName).toBe('search_flights');
    expect(sectionsOfKind(event.sections, 'tool_result')[0]).toMatchObject({
      content: '[{"flight":"AZ123"}]',
    });
  });
});

describe('convention edge cases', () => {
  it('survives an attribute truncated mid-JSON without losing the span', () => {
    // OTel caps attribute value length, so a long conversation arrives cut off.
    const { event } = mapChild([
      str('gen_ai.operation.name', 'chat'),
      str('gen_ai.request.model', 'gpt-4.1'),
      int('gen_ai.usage.input_tokens', 42),
      str('gen_ai.input.messages', '[{"role":"user","parts":[{"type":"text","content":"tru'),
    ]);

    expect(event.type).toBe('ai_call');
    expect(event.inputTokens).toBe(42);
  });

  it('does not render the __REDACTED__ sentinel as message content', () => {
    const { event } = mapChild([
      str('openinference.span.kind', 'LLM'),
      str('llm.model_name', 'gpt-4.1'),
      str('llm.input_messages.0.message.role', 'user'),
      str('llm.input_messages.0.message.content', '__REDACTED__'),
    ]);

    expect(sectionsOfKind(event.sections, 'message')).toHaveLength(0);
  });

  it('merges both conventions when one app runs two instrumentors', () => {
    const { event } = mapChild([
      str('openinference.span.kind', 'LLM'),
      str('llm.model_name', 'gpt-4.1'),
      str('llm.input_messages.0.message.role', 'user'),
      str('llm.input_messages.0.message.content', 'from openinference'),
      str(
        'gen_ai.input.messages',
        '[{"role":"user","parts":[{"type":"text","content":"from genai"}]}]',
      ),
    ]);

    expect(sectionsOfKind(event.sections, 'message').map((section) => section.content)).toEqual([
      'from openinference',
      'from genai',
    ]);
  });

  it('still honours cognipeer.* attributes over third-party ones', () => {
    const { event } = mapChild([
      str('cognipeer.event.type', 'summarization'),
      str('cognipeer.model', 'internal-model'),
      str('llm.model_name', 'gpt-4.1'),
      int('cognipeer.tokens.input', 10),
      int('llm.token_count.prompt', 999),
    ]);

    expect(event.type).toBe('summarization');
    expect(event.model).toBe('internal-model');
    expect(event.inputTokens).toBe(10);
  });

  it('leaves token fields absent rather than zero when nothing reported them', () => {
    const { event } = mapChild([str('openinference.span.kind', 'CHAIN')]);

    expect(event.inputTokens).toBeUndefined();
    expect(event.outputTokens).toBeUndefined();
    expect(event.cachedInputTokens).toBeUndefined();
  });
});
