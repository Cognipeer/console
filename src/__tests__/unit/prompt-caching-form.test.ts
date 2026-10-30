/**
 * Unit tests — the "Prompt caching" section of the model form
 *
 * One state per provider kind (Claude on, switched off, Nova default off, automatic, none), the empty-price warning,
 * "Fill from catalog" only while the catalog has cache prices, what gets stored (only a change from the default), and
 * en / tr parity. (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import PromptCachingSection from '@/components/models/modelFormSections/PromptCachingSection';
import { cachePricesFromMatch, normalizePromptCaching } from '@/components/models/promptCachingForm';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

(globalThis as { React?: typeof React }).React = React;

const priced = { currency: 'USD', cached: 0.3 as number | '', cacheWrite: 3.75 as number | '' };
const blank = { currency: 'USD', cached: '' as number | '', cacheWrite: '' as number | '' };

function render(props: Partial<React.ComponentProps<typeof PromptCachingSection>> & { driver?: string; modelId?: string }) {
  return renderToStaticMarkup(
    h(MantineProvider, null, h(PromptCachingSection, { number: 6, onChange: () => undefined, pricing: priced, ...props })),
  );
}

describe('PromptCachingSection states', () => {
  it('Claude on the anthropic driver: switch on, conversation strategy, caption, billing, markers note', () => {
    const html = render({ driver: 'anthropic', modelId: 'claude-sonnet-4-5' });
    expect(html).toContain('Cache prompts');
    expect(html).toContain('On by default for Claude models.');
    expect(html).toMatch(/type="checkbox"[^>]*checked/);
    expect(html).toContain('Conversation (recommended)');
    // Mantine's closed Select only renders the selected option, so check the static option via its selected state.
    expect(render({ driver: 'anthropic', modelId: 'claude-sonnet-4-5', value: { strategy: 'static' } })).toContain(
      'Tools and system prompt only',
    );
    expect(html).toContain('Edit in Pricing');
    expect(html).toContain('cache_control');
    expect(html).toContain('markers keep them.');
    expect(html).not.toContain('prompt-caching-price-warning');
  });

  it('is off when the record switches it off: select disabled, off caption, markers still kept', () => {
    const html = render({ driver: 'anthropic', modelId: 'claude-sonnet-4-5', value: { enabled: false } });
    expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
    expect(html).toContain('Off: requests go out without cache markers.');
    expect(html).toContain('markers still keep them.');
    expect(html).toContain('disabled=""');
    expect(render({ driver: 'anthropic', modelId: 'claude-sonnet-4-5' })).not.toContain('disabled=""');
  });

  it('Bedrock Nova is off by default and says so; the second option is "System prompt only"', () => {
    const html = render({ driver: 'bedrock', modelId: 'amazon.nova-pro-v1:0' });
    expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
    expect(html).toContain('Nova caches the system prompt and messages. Tool definitions are not cached on this family.');
    const on = render({ driver: 'bedrock', modelId: 'amazon.nova-pro-v1:0', value: { enabled: true, strategy: 'static' } });
    expect(on).toMatch(/type="checkbox"[^>]*checked/);
    expect(on).toContain('Off by default for Nova models.');
    expect(on).toContain('System prompt only');
    expect(on).not.toContain('On by default for Claude models.');
  });

  it('Bedrock Claude and Vertex Claude get the switch, on', () => {
    for (const [driver, modelId] of [['bedrock', 'us.anthropic.claude-sonnet-4-5-v1:0'], ['vertex', 'claude-sonnet-4-5']]) {
      expect(render({ driver, modelId }), driver).toMatch(/type="checkbox"[^>]*checked/);
    }
  });

  it('automatic providers: no switch, a note', () => {
    for (const [driver, modelId] of [['openai', 'gpt-5'], ['azure', 'gpt-5'], ['openai-compatible', 'x'], ['vertex', 'gemini-2.5-pro']]) {
      const html = render({ driver, modelId });
      expect(html, driver).toContain('This provider caches long prompts by itself. There is nothing to set here.');
      expect(html, driver).toContain('cache-read price set in Pricing');
      expect(html, driver).not.toContain('type="checkbox"');
    }
  });

  it('no caching: the switch is shown disabled with the reason', () => {
    const bedrock = render({ driver: 'bedrock', modelId: 'meta.llama3-70b-instruct-v1:0' });
    expect(bedrock).toContain('Bedrock has no prompt caching for this model family, so no cache markers are sent.');
    expect(bedrock).toMatch(/<input[^>]*type="checkbox"[^>]*disabled/);
    expect(bedrock).not.toContain('Conversation (recommended)');
    expect(render({ driver: 'something-else', modelId: 'x' })).toContain('has no prompt caching for this model, so no cache markers are sent.');
  });
});

describe('empty cache prices and the catalog fill', () => {
  const claude = { driver: 'anthropic', modelId: 'claude-sonnet-4-5', pricing: blank };

  it('warns while caching is on and a cache price is empty; says the Claude write price is assumed', () => {
    const html = render(claude);
    expect(html).toContain('Cache prices are empty, so cached tokens bill at the input price and the savings do not show in cost reports.');
    expect(html).toContain('1.25 x the input price');
    expect(render({ ...claude, pricing: { currency: 'USD', cached: 0.3, cacheWrite: '' } })).toContain('prompt-caching-price-warning');
  });

  it('does not warn when both are set, or when caching is off', () => {
    expect(render({ ...claude, pricing: priced })).not.toContain('prompt-caching-price-warning');
    expect(render({ ...claude, value: { enabled: false } })).not.toContain('prompt-caching-price-warning');
  });

  it('does not claim the 1.25x assumption for Nova', () => {
    const html = render({ driver: 'bedrock', modelId: 'amazon.nova-pro-v1:0', value: { enabled: true }, pricing: blank });
    expect(html).toContain('prompt-caching-price-warning');
    expect(html).not.toContain('1.25 x');
  });

  it('shows "Fill from catalog" only when the catalog has cache prices to fill', () => {
    const catalogPrices = { cachedTokenPer1M: 0.3, cacheWriteTokenPer1M: 3.75 };
    const fill = () => undefined;
    expect(render({ ...claude, catalogPrices, onFillCatalog: fill })).toContain('prompt-caching-fill-catalog');
    expect(render({ ...claude, catalogPrices, onFillCatalog: fill })).toContain('or set them in Pricing.');
    expect(render({ ...claude, catalogPrices: null, onFillCatalog: fill })).not.toContain('prompt-caching-fill-catalog');
    expect(render({ ...claude, onFillCatalog: fill })).not.toContain('prompt-caching-fill-catalog');
    // Nothing left to fill: the fields already hold the prices the catalog could give.
    expect(render({ ...claude, pricing: priced, catalogPrices, onFillCatalog: fill })).not.toContain('prompt-caching-fill-catalog');
  });

  it('reads a catalog match: no cache prices means nothing to fill', () => {
    expect(cachePricesFromMatch({ inputTokenPer1M: 3, cachedTokenPer1M: 0.3, cacheWriteTokenPer1M: 3.75 })).toEqual({ cachedTokenPer1M: 0.3, cacheWriteTokenPer1M: 3.75 });
    expect(cachePricesFromMatch({ inputTokenPer1M: 3, cachedTokenPer1M: 0 })).toBeNull();
    expect(cachePricesFromMatch(undefined)).toBeNull();
  });
});

describe('normalizePromptCaching (what is stored)', () => {
  it('stores nothing for the default, so untouched records stay clean', () => {
    expect(normalizePromptCaching(undefined, 'anthropic', 'claude-sonnet-4-5')).toBeUndefined();
    expect(normalizePromptCaching({ enabled: true, strategy: 'auto' }, 'anthropic', 'claude-sonnet-4-5')).toBeUndefined();
    expect(normalizePromptCaching({ enabled: false }, 'bedrock', 'amazon.nova-pro-v1:0')).toBeUndefined();
  });

  it('stores a change from the default', () => {
    expect(normalizePromptCaching({ enabled: false }, 'anthropic', 'claude-sonnet-4-5')).toEqual({ enabled: false });
    expect(normalizePromptCaching({ enabled: true, strategy: 'static' }, 'bedrock', 'amazon.nova-pro-v1:0')).toEqual({ enabled: true, strategy: 'static' });
    expect(normalizePromptCaching({ strategy: 'static' }, 'anthropic', 'claude-sonnet-4-5')).toEqual({ strategy: 'static' });
  });

  it('drops the value for a provider with no switch (and for junk)', () => {
    expect(normalizePromptCaching({ enabled: false }, 'openai', 'gpt-5')).toBeUndefined();
    expect(normalizePromptCaching({ enabled: true }, 'bedrock', 'meta.llama3-70b-instruct-v1:0')).toBeUndefined();
    expect(normalizePromptCaching('x', 'anthropic', 'claude-sonnet-4-5')).toBeUndefined();
  });
});

describe('messages', () => {
  const keys = (value: unknown, prefix = ''): string[] =>
    value && typeof value === 'object'
      ? Object.entries(value).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
      : [prefix.slice(0, -1)];

  it('en and tr carry the same keys, and tr is translated', () => {
    expect(keys(tr.modelPromptCaching).sort()).toEqual(keys(en.modelPromptCaching).sort());
    expect(tr.modelPromptCaching.switch).not.toBe(en.modelPromptCaching.switch);
    expect(en.modelPromptCaching.caption.nova).toBe('Off by default for Nova models.');
  });
});
