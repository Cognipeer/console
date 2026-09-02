import { describe, it, expect } from 'vitest';
import { describeRequestContract } from '@/lib/services/models/inferenceService';

describe('describeRequestContract', () => {
  it('records a strict json_schema response format with its schema name', () => {
    const c = describeRequestContract({
      response_format: { type: 'json_schema', json_schema: { name: 'MainAgentResponse', strict: true, schema: {} } },
    });
    expect(c.responseFormat).toEqual({
      type: 'json_schema', schemaName: 'MainAgentResponse', strict: true, schema: {},
    });
  });

  it('keeps the schema itself — a replay needs it, a summary is not enough', () => {
    const schema = { type: 'object', properties: { total: { type: 'number' } }, required: ['total'] };
    const c = describeRequestContract({
      response_format: { type: 'json_schema', json_schema: { name: 'invoice', strict: true, schema } },
    });
    expect(c.responseFormat?.schema).toEqual(schema);
    expect(c.responseFormat?.schemaTruncated).toBeUndefined();
  });

  it('drops an oversized schema rather than blowing the whole log payload', () => {
    // The 20k whole-payload cap replaces providerRequest with a preview, so an
    // unbounded schema would take the messages down with it.
    const schema = { type: 'object', description: 'x'.repeat(9 * 1024) };
    const c = describeRequestContract({
      response_format: { type: 'json_schema', json_schema: { name: 'huge', strict: true, schema } },
    });
    expect(c.responseFormat?.schema).toBeUndefined();
    expect(c.responseFormat?.schemaTruncated).toBe(true);
    // The contract's identity survives — that is most of the diagnostic value.
    expect(c.responseFormat?.schemaName).toBe('huge');
    expect(c.responseFormat?.strict).toBe(true);
  });

  it('records a plain json_object response format', () => {
    expect(describeRequestContract({ response_format: { type: 'json_object' } }).responseFormat)
      .toEqual({ type: 'json_object' });
  });

  it('accepts the camelCase spelling too', () => {
    expect(describeRequestContract({ responseFormat: { type: 'json_object' } }).responseFormat?.type)
      .toBe('json_object');
  });

  it('records the tool menu as names + count, plus the full schemas when they fit budget', () => {
    const tools = [
      { type: 'function', function: { name: 'create_todo', parameters: { type: 'object', properties: { a: {} } } } },
      { type: 'function', function: { name: 'search_topics', parameters: {} } },
    ];
    const c = describeRequestContract({ tools });
    expect(c.tools?.count).toBe(2);
    expect(c.tools?.names).toEqual(['create_todo', 'search_topics']);
    // A replay (evaluation suite, prompt optimizer, traffic snapshot) needs
    // the schemas themselves, not just which names were offered.
    expect(c.tools?.schemas).toEqual(tools);
    expect(c.tools?.schemasTruncated).toBeUndefined();
  });

  it('drops oversized tool schemas rather than blowing the whole log payload, keeping names + count', () => {
    // Same reasoning as the response-schema truncation test: the 20k
    // whole-payload cap replaces providerRequest with a preview, so an
    // unbounded tool menu would take the messages down with it.
    const tools = Array.from({ length: 20 }, (_, i) => ({
      type: 'function',
      function: { name: `tool_${i}`, parameters: { type: 'object', description: 'x'.repeat(1024) } },
    }));
    const c = describeRequestContract({ tools });
    expect(c.tools?.count).toBe(20);
    expect(c.tools?.names).toHaveLength(20);
    expect(c.tools?.schemas).toBeUndefined();
    expect(c.tools?.schemasTruncated).toBe(true);
  });

  it('survives a malformed tool entry without dropping the rest', () => {
    const tools = [{ function: { name: 'ok' } }, null, { nonsense: true }];
    const c = describeRequestContract({ tools });
    expect(c.tools?.count).toBe(3);
    expect(c.tools?.names).toEqual(['ok']);
    expect(c.tools?.schemas).toEqual(tools);
  });

  it('records tool_choice, max_tokens and sampling settings', () => {
    const c = describeRequestContract({ tool_choice: 'auto', max_tokens: 512, temperature: 0.2, top_p: 0.9 });
    expect(c.toolChoice).toBe('auto');
    expect(c.maxTokens).toBe(512);
    expect(c.temperature).toBe(0.2);
    expect(c.topP).toBe(0.9);
  });

  it('reads max_completion_tokens as the output ceiling as well', () => {
    expect(describeRequestContract({ max_completion_tokens: 256 }).maxTokens).toBe(256);
  });

  it('omits absent fields instead of writing nulls', () => {
    // A request with no structured-output contract must be distinguishable
    // from one whose contract simply was not recorded.
    expect(describeRequestContract({ messages: [] })).toEqual({});
  });

  it('handles an undefined body', () => {
    expect(describeRequestContract(undefined)).toEqual({});
  });
});
