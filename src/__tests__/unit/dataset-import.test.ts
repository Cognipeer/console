/**
 * Unit tests — External Eval-Import service.
 *
 * Format detection across the five supported export shapes, per-format
 * parsing (tools / tool_calls mapping, Anthropic tool_use, Langfuse string
 * input, embedded-chat deep walk, trailing-assistant → reference), size/item
 * caps with skip counting, contentSha256 stability, and the mandatory
 * anonymization gate on dataset creation. DB access mocked with SYNC
 * vi.mock factories (async factories silently fail to intercept).
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/services/evaluation/service', () => ({ createDataset: vi.fn() }));

import { getDatabase } from '@/lib/database';
import { createDataset } from '@/lib/services/evaluation/service';
import {
  ImportTooLargeError,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ITEMS,
  computeContentSha256,
  createImportedDataset,
  detectImportFormat,
  parseImportItems,
} from '@/lib/services/datasetImport/datasetImport';
import type { AnonymizeOptions } from '@/lib/services/pii/anonymize';

const CTX = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'project-1', userId: 'user-1' };
const ANON: AnonymizeOptions = { categories: ['email'], strategy: 'pseudonym', salt: 'unit-salt' };

// ── Fixtures ───────────────────────────────────────────────────────────────

const chatLine = JSON.stringify({
  model: 'gpt-4o',
  messages: [
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'Say hi' },
    { role: 'assistant', content: 'Hi!' },
  ],
});

const chatToolCallLine = JSON.stringify({
  messages: [
    { role: 'user', content: 'weather in Paris' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: '1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
      ],
    },
  ],
  tools: [
    { type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } } },
  ],
});

const pairLine = JSON.stringify({
  request: { model: 'gpt-4o', messages: [{ role: 'user', content: 'what is 2+2' }] },
  response: { choices: [{ message: { role: 'assistant', content: '4' } }] },
});

const bedrockLine = JSON.stringify({
  modelId: 'anthropic.claude-3-sonnet',
  input: {
    inputBodyJson: {
      system: 'You answer briefly.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'capital of France?' }] }],
      tools: [{ name: 'lookup', description: 'Look things up', input_schema: { type: 'object' } }],
    },
  },
  output: {
    outputBodyJson: {
      content: [
        { type: 'text', text: 'Paris.' },
        { type: 'tool_use', id: 't1', name: 'lookup', input: { q: 'France' } },
      ],
    },
  },
});

const langfuseArray = JSON.stringify([
  { id: 'g1', type: 'GENERATION', model: 'gpt-4o-mini', input: 'What is up?', output: 'Nothing much.' },
]);

const embeddedLine = JSON.stringify({
  log: {
    req: { body: { model: 'gpt-4', messages: [{ role: 'user', content: 'ping' }] } },
    resp: { body: { choices: [{ message: { content: 'pong' } }] } },
  },
});

// ── Detection ──────────────────────────────────────────────────────────────

describe('detectImportFormat', () => {
  it('recognizes openai-chat-jsonl', () => {
    expect(detectImportFormat(`${chatLine}\n${chatToolCallLine}`)).toBe('openai-chat-jsonl');
  });

  it('recognizes openai-pair-jsonl (request/response and input/output aliases)', () => {
    expect(detectImportFormat(pairLine)).toBe('openai-pair-jsonl');
    const aliased = JSON.stringify({
      input: { messages: [{ role: 'user', content: 'q' }] },
      output: { choices: [{ message: { content: 'a' } }] },
    });
    expect(detectImportFormat(aliased)).toBe('openai-pair-jsonl');
  });

  it('recognizes bedrock-invocation-jsonl', () => {
    expect(detectImportFormat(bedrockLine)).toBe('bedrock-invocation-jsonl');
  });

  it('recognizes langfuse-generations (JSON array and JSONL)', () => {
    expect(detectImportFormat(langfuseArray)).toBe('langfuse-generations');
    const jsonl = JSON.stringify({ model: 'gpt-4o', input: 'q', output: 'a' });
    expect(detectImportFormat(jsonl)).toBe('langfuse-generations');
  });

  it('falls back to embedded-chat-json for wrapped gateway records', () => {
    expect(detectImportFormat(embeddedLine)).toBe('embedded-chat-json');
  });

  it('detects a pretty-printed single embedded object', () => {
    const pretty = JSON.stringify(JSON.parse(embeddedLine), null, 2);
    expect(detectImportFormat(pretty)).toBe('embedded-chat-json');
  });

  it('mixed formats are ambiguous → undefined', () => {
    expect(detectImportFormat(`${chatLine}\n${bedrockLine}`)).toBeUndefined();
  });

  it('unrecognizable content → undefined', () => {
    expect(detectImportFormat('just some text\nnot json')).toBeUndefined();
    expect(detectImportFormat('{"foo": 1}')).toBeUndefined();
  });
});

// ── openai-chat-jsonl ──────────────────────────────────────────────────────

describe('parseImportItems: openai-chat-jsonl', () => {
  it('moves the trailing assistant message to expected.reference', () => {
    const { items, skipped } = parseImportItems(chatLine, 'openai-chat-jsonl');
    expect(skipped).toEqual({});
    expect(items).toHaveLength(1);
    expect(items[0].input).toEqual([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'Say hi' },
    ]);
    expect(items[0].expected?.reference).toBe('Hi!');
    expect(items[0].sourceModel).toBe('gpt-4o');
  });

  it('maps tools and trailing assistant tool_calls (argsMatch subset)', () => {
    const { items } = parseImportItems(chatToolCallLine, 'openai-chat-jsonl');
    expect(items).toHaveLength(1);
    expect(items[0].input).toEqual([{ role: 'user', content: 'weather in Paris' }]);
    expect(items[0].tools).toEqual([
      { name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } },
    ]);
    expect(items[0].expected?.reference).toBeUndefined();
    expect(items[0].expected?.toolCalls).toEqual([
      { name: 'get_weather', argsMatch: 'subset', args: { city: 'Paris' } },
    ]);
  });

  it('counts unparseable / missingMessages / emptyInput skips', () => {
    const content = [
      'not json at all',
      '{"foo": 1}',
      '{"messages": [{"role": "assistant", "content": "answer only"}]}',
      chatLine,
    ].join('\n');
    const { items, skipped } = parseImportItems(content, 'openai-chat-jsonl');
    expect(items).toHaveLength(1);
    expect(skipped).toEqual({ unparseable: 1, missingMessages: 1, emptyInput: 1 });
  });
});

// ── openai-pair-jsonl ──────────────────────────────────────────────────────

describe('parseImportItems: openai-pair-jsonl', () => {
  it('maps request messages → input and response choice → expected', () => {
    const { items } = parseImportItems(pairLine, 'openai-pair-jsonl');
    expect(items).toHaveLength(1);
    expect(items[0].input).toEqual([{ role: 'user', content: 'what is 2+2' }]);
    expect(items[0].expected?.reference).toBe('4');
    expect(items[0].sourceModel).toBe('gpt-4o');
  });

  it('accepts body/completion aliases and response tool_calls', () => {
    const line = JSON.stringify({
      body: { messages: [{ role: 'user', content: 'book it' }] },
      completion: {
        choices: [{
          message: {
            content: null,
            tool_calls: [{ type: 'function', function: { name: 'book', arguments: '{"id":7}' } }],
          },
        }],
      },
    });
    const { items } = parseImportItems(line, 'openai-pair-jsonl');
    expect(items).toHaveLength(1);
    expect(items[0].expected?.toolCalls).toEqual([{ name: 'book', argsMatch: 'subset', args: { id: 7 } }]);
  });

  it('counts records without a request half as missingMessages', () => {
    const { items, skipped } = parseImportItems('{"response": {"choices": []}}', 'openai-pair-jsonl');
    expect(items).toHaveLength(0);
    expect(skipped).toEqual({ missingMessages: 1 });
  });
});

// ── bedrock-invocation-jsonl ───────────────────────────────────────────────

describe('parseImportItems: bedrock-invocation-jsonl', () => {
  it('maps Anthropic bodies: system + blocks, tools, output tool_use', () => {
    const { items } = parseImportItems(bedrockLine, 'bedrock-invocation-jsonl');
    expect(items).toHaveLength(1);
    expect(items[0].input).toEqual([
      { role: 'system', content: 'You answer briefly.' },
      { role: 'user', content: 'capital of France?' },
    ]);
    expect(items[0].tools).toEqual([
      { name: 'lookup', description: 'Look things up', parameters: { type: 'object' } },
    ]);
    expect(items[0].expected?.reference).toBe('Paris.');
    expect(items[0].expected?.toolCalls).toEqual([{ name: 'lookup', argsMatch: 'subset', args: { q: 'France' } }]);
    expect(items[0].sourceModel).toBe('anthropic.claude-3-sonnet');
  });

  it('accepts stringified inputBodyJson/outputBodyJson', () => {
    const line = JSON.stringify({
      modelId: 'anthropic.claude-3-haiku',
      input: { inputBodyJson: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }) },
      output: { outputBodyJson: JSON.stringify({ content: [{ type: 'text', text: 'hey' }] }) },
    });
    const { items } = parseImportItems(line, 'bedrock-invocation-jsonl');
    expect(items).toHaveLength(1);
    expect(items[0].input).toEqual([{ role: 'user', content: 'hello' }]);
    expect(items[0].expected?.reference).toBe('hey');
  });
});

// ── langfuse-generations ───────────────────────────────────────────────────

describe('parseImportItems: langfuse-generations', () => {
  it('maps a JSON array with string input/output', () => {
    const { items } = parseImportItems(langfuseArray, 'langfuse-generations');
    expect(items).toHaveLength(1);
    expect(items[0].input).toEqual([{ role: 'user', content: 'What is up?' }]);
    expect(items[0].expected?.reference).toBe('Nothing much.');
    expect(items[0].sourceModel).toBe('gpt-4o-mini');
  });

  it('maps messages[] input and assistant-record output (JSONL)', () => {
    const line = JSON.stringify({
      type: 'GENERATION',
      model: 'gpt-4o',
      input: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
      output: { role: 'assistant', content: 'a' },
    });
    const { items } = parseImportItems(line, 'langfuse-generations');
    expect(items).toHaveLength(1);
    expect(items[0].input).toEqual([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]);
    expect(items[0].expected?.reference).toBe('a');
  });
});

// ── embedded-chat-json ─────────────────────────────────────────────────────

describe('parseImportItems: embedded-chat-json', () => {
  it('deep-walks to the first messages[] and choices[] objects', () => {
    const { items } = parseImportItems(embeddedLine, 'embedded-chat-json');
    expect(items).toHaveLength(1);
    expect(items[0].input).toEqual([{ role: 'user', content: 'ping' }]);
    expect(items[0].expected?.reference).toBe('pong');
    expect(items[0].sourceModel).toBe('gpt-4');
  });

  it('walks JSON-looking strings (APIM-style stringified bodies)', () => {
    const line = JSON.stringify({
      wrapper: { payload: JSON.stringify({ messages: [{ role: 'user', content: 'inner' }] }) },
    });
    const { items } = parseImportItems(line, 'embedded-chat-json');
    expect(items).toHaveLength(1);
    expect(items[0].input).toEqual([{ role: 'user', content: 'inner' }]);
  });

  it('parses a pretty-printed single object', () => {
    const pretty = JSON.stringify(JSON.parse(embeddedLine), null, 2);
    const { items, skipped } = parseImportItems(pretty, 'embedded-chat-json');
    expect(skipped).toEqual({});
    expect(items).toHaveLength(1);
    expect(items[0].expected?.reference).toBe('pong');
  });
});

// ── Caps ───────────────────────────────────────────────────────────────────

describe('caps', () => {
  it('rejects content above MAX_IMPORT_BYTES with a typed error', () => {
    const huge = 'a'.repeat(MAX_IMPORT_BYTES + 1);
    expect(() => parseImportItems(huge, 'openai-chat-jsonl')).toThrow(ImportTooLargeError);
    expect(() => detectImportFormat(huge)).toThrow(ImportTooLargeError);
  });

  it('stops at MAX_IMPORT_ITEMS and counts the remainder as overLimit', () => {
    const line = '{"messages":[{"role":"user","content":"q"},{"role":"assistant","content":"a"}]}';
    const content = Array.from({ length: MAX_IMPORT_ITEMS + 3 }, () => line).join('\n');
    const { items, skipped } = parseImportItems(content, 'openai-chat-jsonl');
    expect(items).toHaveLength(MAX_IMPORT_ITEMS);
    expect(skipped).toEqual({ overLimit: 3 });
  });
});

// ── contentSha256 ──────────────────────────────────────────────────────────

describe('computeContentSha256', () => {
  it('is stable and matches the known sha256 of the content', () => {
    expect(computeContentSha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(computeContentSha256(chatLine)).toBe(computeContentSha256(chatLine));
    expect(computeContentSha256(chatLine)).not.toBe(computeContentSha256(pairLine));
  });
});

// ── createImportedDataset ──────────────────────────────────────────────────

describe('createImportedDataset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (createDataset as Mock).mockResolvedValue({ id: 'ds-1', key: 'import-1', name: 'My import' });
  });

  it('refuses to run without anonymization options', async () => {
    await expect(
      createImportedDataset(CTX, {
        name: 'x',
        content: chatLine,
        format: 'openai-chat-jsonl',
        anonymize: undefined as unknown as AnonymizeOptions,
      }),
    ).rejects.toThrow(/anonymize/);
    expect(createDataset).not.toHaveBeenCalled();
  });

  it('refuses anonymization options without a salt (snapshot gate parity)', async () => {
    await expect(
      createImportedDataset(CTX, {
        name: 'x',
        content: chatLine,
        format: 'openai-chat-jsonl',
        anonymize: { categories: ['email'], strategy: 'pseudonym', salt: '' },
      }),
    ).rejects.toThrow(/salt/);
  });

  it('anonymizes every persisted string, persists source imported, never leaks the salt', async () => {
    const content = JSON.stringify({
      messages: [
        { role: 'user', content: 'mail me at john.doe@example.com' },
        { role: 'assistant', content: 'sent to john.doe@example.com' },
      ],
    });
    const result = await createImportedDataset(CTX, {
      name: 'Imported logs',
      content,
      format: 'openai-chat-jsonl',
      sourceLabel: 'prod gateway',
      anonymize: ANON,
    });

    expect(result).toMatchObject({ datasetId: 'ds-1', created: 1, skipped: {} });
    expect(result.piiFindings).toBe(2);

    expect(createDataset).toHaveBeenCalledTimes(1);
    const [tenantDbName, tenantId, userId, input] = (createDataset as Mock).mock.calls[0];
    expect(tenantDbName).toBe(CTX.tenantDbName);
    expect(tenantId).toBe(CTX.tenantId);
    expect(userId).toBe(CTX.userId);
    expect(input.source).toBe('imported');
    expect(input.projectId).toBe(CTX.projectId);
    expect(input.items).toHaveLength(1);
    expect(input.items[0].id).toBe('imp-1');
    expect(input.items[0].tags).toContain('imported');
    expect(input.items[0].tags).toContain('format:openai-chat-jsonl');

    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain('john.doe@example.com');
    expect(serialized).not.toContain('unit-salt');

    expect(input.metadata).toMatchObject({
      importFormat: 'openai-chat-jsonl',
      sourceLabel: 'prod gateway',
      contentSha256: computeContentSha256(content),
      counts: { parsed: 1, created: 1, skipped: {} },
      anonymization: { strategy: 'pseudonym', categories: ['email'], customPatternCount: 0 },
      piiFindings: 2,
    });

    // Evaluation-only rule: the import path performs no direct DB access —
    // in particular no usage_daily / cost writes.
    expect(getDatabase).not.toHaveBeenCalled();
  });
});
