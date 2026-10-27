/**
 * Prompt caching of a Model Hub model: the support table and the switch (promptCaching.ts), the provider option
 * the native client and the evaluation invoker send, the settings validation, a client's own cache markers on
 * the way in (openaiAdapter) and OpenAI's prompt-cache fields on the way through (gatewayRequest, responsesWire).
 */
import { describe, expect, it } from 'vitest';
import {
  PROMPT_CACHING_OPENAI_DRIVERS,
  promptCachingProviderOption,
  promptCachingSupport,
  resolvePromptCaching,
  validatePromptCaching,
} from '@/lib/services/models/promptCaching';
import { OPENAI_SCHEMA_DRIVERS } from '@/lib/services/models/reasoning';
import { withPromptCaching } from '@/lib/providers/contracts/nativeClients';
import { buildPassthroughBody } from '@/lib/services/models/gatewayRequest';
import { responsesRequestToChat } from '@/lib/services/models/responsesWire';
import { openAiMessagesToNative } from '@/lib/services/models/openaiAdapter';
import { normalizeModelSettings } from '@/lib/services/models/modelSettings';

describe('promptCachingSupport', () => {
  it('anthropic: explicit Claude caching, on by default, tools cached', () => {
    expect(promptCachingSupport('anthropic', 'claude-sonnet-4-5')).toEqual({ support: 'explicit', family: 'claude', cachesTools: true, defaultEnabled: true });
  });

  it.each([
    'anthropic.claude-sonnet-4-5-20250929-v1:0',
    'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'eu.anthropic.claude-haiku-4-5-v1:0',
    'global.anthropic.claude-opus-4-5-v1:0',
  ])('bedrock Claude %s: explicit, on by default', (id) => {
    expect(promptCachingSupport('bedrock', id)).toMatchObject({ support: 'explicit', family: 'claude', cachesTools: true, defaultEnabled: true });
  });

  it('bedrock Nova: explicit, tools never cached, off by default', () => {
    expect(promptCachingSupport('bedrock', 'amazon.nova-pro-v1:0')).toEqual({ support: 'explicit', family: 'nova', cachesTools: false, defaultEnabled: false });
    expect(promptCachingSupport('bedrock', 'us.amazon.nova-lite-v1:0').family).toBe('nova');
  });

  it.each([
    'meta.llama3-1-70b-instruct-v1:0',
    'us.meta.llama3-3-70b-instruct-v1:0',
    'mistral.mistral-large-2407-v1:0',
    'cohere.command-r-plus-v1:0',
    'amazon.titan-text-premier-v1:0',
    'deepseek.r1-v1:0',
    'openai.gpt-oss-120b-1:0',
  ])('bedrock %s: none', (id) => {
    expect(promptCachingSupport('bedrock', id).support).toBe('none');
  });

  it.each([
    'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-v1:0',
    'arn:aws:bedrock:us-east-1:123:inference-profile/us.amazon.nova-pro-v1:0',
    'arn:aws:bedrock:us-east-1:123:inference-profile/us.meta.llama3-1-8b-instruct-v1:0',
    'ARN:aws:bedrock:us-east-1:123:foundation-model/anthropic.claude-3-haiku',
  ])('bedrock ARN %s: the SDK reads no family from an arn:, so explicit, tools cached, off by default', (id) => {
    expect(promptCachingSupport('bedrock', id)).toEqual({ support: 'explicit', cachesTools: true, defaultEnabled: false });
  });

  it('bedrock id the table does not know (opaque ARN): the SDK would still send checkpoints, so explicit but off by default', () => {
    const info = promptCachingSupport('bedrock', 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123');
    expect(info).toEqual({ support: 'explicit', cachesTools: true, defaultEnabled: false });
    expect(promptCachingSupport('bedrock', 'some.future-model-v1:0').defaultEnabled).toBe(false);
  });

  it('vertex: Claude ids are explicit, everything else (Gemini) is automatic', () => {
    expect(promptCachingSupport('vertex', 'claude-sonnet-4-5@20250929')).toMatchObject({ support: 'explicit', family: 'claude', defaultEnabled: true });
    expect(promptCachingSupport('vertex', 'publishers/anthropic/models/claude-haiku-4-5').family).toBe('claude');
    expect(promptCachingSupport('vertex', 'gemini-2.5-pro').support).toBe('automatic');
  });

  it('OpenAI-schema drivers are automatic; any other driver has none', () => {
    for (const driver of ['openai', 'azure', 'openai-compatible', 'together']) {
      expect(promptCachingSupport(driver, 'gpt-5').support).toBe('automatic');
    }
    expect(promptCachingSupport('cohere', 'x').support).toBe('none');
    expect(promptCachingSupport('dynamic', 'x').support).toBe('none');
    expect(promptCachingSupport(undefined, undefined).support).toBe('none');
  });

  it('the OpenAI driver set stays the one the reasoning rules use', () => {
    expect([...PROMPT_CACHING_OPENAI_DRIVERS].sort()).toEqual([...OPENAI_SCHEMA_DRIVERS].sort());
  });
});

describe('resolvePromptCaching', () => {
  it('follows the default while the record does not set the switch', () => {
    expect(resolvePromptCaching('anthropic', 'claude-sonnet-4-5')).toMatchObject({ enabled: true, strategy: 'auto' });
    expect(resolvePromptCaching('bedrock', 'amazon.nova-pro-v1:0')).toMatchObject({ enabled: false, strategy: 'auto' });
  });

  it('the record wins over the default, both ways', () => {
    expect(resolvePromptCaching('anthropic', 'claude-sonnet-4-5', { enabled: false }).enabled).toBe(false);
    expect(resolvePromptCaching('bedrock', 'amazon.nova-pro-v1:0', { enabled: true, strategy: 'static' })).toMatchObject({ enabled: true, strategy: 'static' });
  });

  it('is never on without explicit caching', () => {
    expect(resolvePromptCaching('openai', 'gpt-5', { enabled: true }).enabled).toBe(false);
    expect(resolvePromptCaching('vertex', 'gemini-2.5-pro', { enabled: true }).enabled).toBe(false);
    expect(resolvePromptCaching('bedrock', 'meta.llama3-1-70b-instruct-v1:0', { enabled: true }).enabled).toBe(false);
  });

  it('an unknown strategy is "auto"', () => {
    expect(resolvePromptCaching('anthropic', 'claude-sonnet-4-5', { strategy: 'weird' as never }).strategy).toBe('auto');
  });
});

describe('promptCachingProviderOption / withPromptCaching', () => {
  it('sends prompt_caching { enabled, strategy } and never a ttl', () => {
    expect(promptCachingProviderOption('anthropic', 'claude-sonnet-4-5', {})).toEqual({ enabled: true, strategy: 'auto' });
    expect(promptCachingProviderOption('anthropic', 'claude-sonnet-4-5', { promptCaching: { strategy: 'static' } })).toEqual({ enabled: true, strategy: 'static' });
    expect(promptCachingProviderOption('bedrock', 'amazon.nova-pro-v1:0', { promptCaching: { enabled: true } })).not.toHaveProperty('ttl');
  });

  it('sends nothing when the switch is off or the provider has no explicit caching', () => {
    expect(promptCachingProviderOption('anthropic', 'claude-sonnet-4-5', { promptCaching: { enabled: false } })).toBeUndefined();
    expect(promptCachingProviderOption('bedrock', 'amazon.nova-pro-v1:0', {})).toBeUndefined();
    expect(promptCachingProviderOption('openai', 'gpt-5', { promptCaching: { enabled: true } })).toBeUndefined();
    expect(promptCachingProviderOption('bedrock', 'meta.llama3-1-70b-instruct-v1:0', { promptCaching: { enabled: true } })).toBeUndefined();
  });

  it('the provider config gets the option; a changed switch changes the next config (nothing is pooled)', () => {
    const base = { provider: 'anthropic', apiKey: 'k' } as never;
    expect(withPromptCaching(base, 'anthropic', 'claude-sonnet-4-5', {})).toMatchObject({ prompt_caching: { enabled: true, strategy: 'auto' } });
    expect(withPromptCaching(base, 'anthropic', 'claude-sonnet-4-5', { promptCaching: { strategy: 'static' } })).toMatchObject({ prompt_caching: { strategy: 'static' } });
    const off = withPromptCaching(base, 'anthropic', 'claude-sonnet-4-5', { promptCaching: { enabled: false } });
    expect(off).not.toHaveProperty('prompt_caching');
    expect(withPromptCaching({ provider: 'openai' } as never, 'openai', 'gpt-5', {})).not.toHaveProperty('prompt_caching');
  });

  it('a malformed stored value falls back to the default', () => {
    expect(promptCachingProviderOption('anthropic', 'claude-sonnet-4-5', { promptCaching: 'yes' })).toEqual({ enabled: true, strategy: 'auto' });
  });
});

describe('validatePromptCaching', () => {
  it('accepts nothing, null, and the two known fields', () => {
    expect(validatePromptCaching(undefined)).toBeUndefined();
    expect(validatePromptCaching({})).toBeUndefined();
    expect(validatePromptCaching({ promptCaching: null })).toBeUndefined();
    expect(validatePromptCaching({ promptCaching: {} })).toBeUndefined();
    expect(validatePromptCaching({ promptCaching: { enabled: false, strategy: 'static' } })).toBeUndefined();
  });

  it.each([
    [{ promptCaching: true }, /must be an object/],
    [{ promptCaching: [] }, /must be an object/],
    [{ promptCaching: { enabled: 'yes' } }, /enabled must be true or false/],
    [{ promptCaching: { strategy: 'all' } }, /strategy must be "auto" or "static"/],
    [{ promptCaching: { ttl: '1h' } }, /ttl is not supported/],
    [{ promptCaching: { mode: 'x' } }, /not a known field/],
  ])('rejects %j', (settings, message) => {
    expect(validatePromptCaching(settings)).toMatch(message);
  });

  it('a stringified object in the settings blob is healed on write', () => {
    expect(normalizeModelSettings({ promptCaching: '{"enabled":true}' })).toEqual({ promptCaching: { enabled: true } });
  });
});

describe('OpenAI prompt-cache request fields', () => {
  const body = {
    messages: [],
    prompt_cache_key: 'tenant-42',
    prompt_cache_retention: '24h',
    prompt_cache_options: { ttl: '12h', mode: 'x' },
  };

  it.each(['openai', 'azure'])('are sent unchanged to %s without the extra-parameters switch', (driver) => {
    const out = buildPassthroughBody({}, body, new Set(), driver)!;
    expect(out).toMatchObject({ prompt_cache_key: 'tenant-42', prompt_cache_retention: '24h', prompt_cache_options: { ttl: '12h', mode: 'x' } });
  });

  it.each(['openai-compatible', 'together'])('are NOT sent to %s without the extra-parameters switch', (driver) => {
    expect(JSON.stringify(buildPassthroughBody({}, body, new Set(), driver) ?? {})).not.toContain('prompt_cache');
  });

  it.each(['openai-compatible', 'together'])('are sent to %s when the extra-parameters switch is on (minus unsupported ones)', (driver) => {
    const out = buildPassthroughBody({ allowUnknownPassthrough: true }, body, new Set(['prompt_cache_options']), driver)!;
    expect(out).toMatchObject({ prompt_cache_key: 'tenant-42', prompt_cache_retention: '24h' });
    expect(out).not.toHaveProperty('prompt_cache_options');
  });

  it.each(['anthropic', 'bedrock', 'vertex'])('never reach %s, not even with the extra-parameters switch on', (driver) => {
    const out = buildPassthroughBody({ allowUnknownPassthrough: true }, body, new Set(), driver);
    expect(out ?? {}).not.toHaveProperty('prompt_cache_key');
    expect(out ?? {}).not.toHaveProperty('prompt_cache_retention');
    expect(JSON.stringify(out ?? {})).not.toContain('prompt_cache');
    expect(JSON.stringify(out ?? {})).not.toContain('"ttl"');
  });

  it('a field the model lists as unsupported is not sent', () => {
    const out = buildPassthroughBody({}, body, new Set(['prompt_cache_options']), 'openai')!;
    expect(out).not.toHaveProperty('prompt_cache_options');
    expect(out.prompt_cache_key).toBe('tenant-42');
  });

  it('a Responses request carries them into the chat body', () => {
    const chat = responsesRequestToChat({ model: 'm', input: 'hi', prompt_cache_key: 'k', prompt_cache_options: { ttl: '30m' } });
    expect(chat).toMatchObject({ prompt_cache_key: 'k', prompt_cache_options: { ttl: '30m' } });
    expect(chat).not.toHaveProperty('prompt_cache_retention');
  });
});

describe('a client cache marker on the way in', () => {
  it('stays on a user text part as cacheControl (cache_control and cacheControl spellings, ttl kept)', () => {
    const [message] = openAiMessagesToNative([{
      role: 'user',
      content: [
        { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'b', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: 'c', cacheControl: { type: 'ephemeral', ttl: '5m' } },
        { type: 'text', text: 'd' },
        { type: 'text', text: 'e', cache_control: { type: 'persistent' } },
      ],
    }]);
    expect(message.content).toEqual([
      { type: 'text', text: 'a', cacheControl: { type: 'ephemeral' } },
      { type: 'text', text: 'b', cacheControl: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'c', cacheControl: { type: 'ephemeral', ttl: '5m' } },
      { type: 'text', text: 'd' },
      { type: 'text', text: 'e' },
    ]);
  });

  it('a marked system message keeps its parts; an unmarked one is flattened as before', () => {
    const [marked, plain] = openAiMessagesToNative([
      { role: 'system', content: [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'more' }] },
      { role: 'developer', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
    ]);
    expect(marked).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'rules', cacheControl: { type: 'ephemeral' } }, { type: 'text', text: 'more' }],
    });
    expect(plain).toEqual({ role: 'system', content: 'one\ntwo' });
  });

  it('a marked tool result keeps its parts; an unmarked one is flattened', () => {
    const [marked, plain] = openAiMessagesToNative([
      { role: 'tool', tool_call_id: 't1', content: [{ type: 'text', text: 'result', cache_control: { type: 'ephemeral' } }] },
      { role: 'tool', tool_call_id: 't2', content: [{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }] },
    ]);
    expect(marked).toMatchObject({ role: 'tool', toolCallId: 't1', content: [{ type: 'text', text: 'result', cacheControl: { type: 'ephemeral' } }] });
    expect(plain).toMatchObject({ role: 'tool', content: 'x\ny' });
  });

  it('a plain string message is untouched', () => {
    expect(openAiMessagesToNative([{ role: 'user', content: 'hi' }])).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
