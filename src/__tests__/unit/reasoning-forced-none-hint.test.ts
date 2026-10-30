// @vitest-environment jsdom
/**
 * The reasoning pickers say when tools switch a model's reasoning off.
 *
 * GPT-5.1+ and gpt-6 answer any reasoning effort but `none` next to function tools on Chat Completions with a 400, so
 * the gateway sends `none` for a call that carries tools, whatever effort is set. The Responses API takes both
 * together and keeps the reasoning. The Model Hub's Reasoning section and the agent's reasoning dropdown tell the
 * operator so, only where it is true (rule `chatTools.reasoning: 'force-none'`, Upstream API = Chat Completions,
 * automatic detection on). No default changes.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MantineProvider } from '@mantine/core';
import AgentReasoningPicker from '@/components/agents/studio/AgentReasoningPicker';
import { ReasoningSection } from '@/components/models/modelFormSections';
import { EMPTY_REASONING_FORM } from '@/components/models/reasoningForm';
import { I18nProvider } from '@/lib/i18n';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';
import { reasoningForcedNoneOnChat } from '@/lib/providers/unsupportedParams';

(globalThis as { React?: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // Mantine reads these from the browser.
  window.matchMedia = window.matchMedia || ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = vi.fn();
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;
function cleanup() {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
}
afterEach(cleanup);

/** Mounts one element at a time: whatever an earlier call of the same test mounted is removed first. */
function mount(element: React.ReactElement, locale: 'en' | 'tr' = 'en') {
  cleanup();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(h(MantineProvider, null, h(I18nProvider, { locale, children: element }))));
  return container;
}

const noop = () => undefined;

describe('reasoningForcedNoneOnChat', () => {
  it.each([
    ['azure', 'gpt-6-luna'],
    ['azure', 'gpt-5.2'],
    ['openai', 'gpt-5.1'],
    ['openai', 'gpt-5.6-luna'],
    ['openai-compatible', 'gpt-6-luna'],
    ['together', 'gpt-6-luna'],
  ])('is true for %s / %s on Chat Completions', (driver, modelId) => {
    expect(reasoningForcedNoneOnChat(driver, modelId, {})).toBe(true);
    expect(reasoningForcedNoneOnChat(driver, modelId, { upstreamApi: 'chat' })).toBe(true);
    // Settings that say nothing about it are Chat Completions too.
    expect(reasoningForcedNoneOnChat(driver, modelId, undefined)).toBe(true);
  });

  it.each([
    ['openai', 'gpt-5'],
    ['openai', 'gpt-5-mini'],
    ['openai', 'gpt-5-chat-latest'],
    ['openai', 'o3'],
    ['openai', 'gpt-4o'],
    ['azure', 'my-prod-deployment'],
    ['openai-compatible', 'gpt-oss-120b'],
    ['openai-compatible', 'qwen3-32b'],
  ])('is false for %s / %s: its rule takes an effort next to tools', (driver, modelId) => {
    expect(reasoningForcedNoneOnChat(driver, modelId, {})).toBe(false);
  });

  it('is false on the Responses upstream API, which keeps reasoning with tools', () => {
    for (const settings of [{ upstreamApi: 'responses' }, { upstreamApi: 'Responses' }]) {
      expect(reasoningForcedNoneOnChat('azure', 'gpt-6-luna', settings)).toBe(false);
      expect(reasoningForcedNoneOnChat('openai', 'gpt-5.2', settings)).toBe(false);
    }
  });

  it('is false when the model has automatic detection switched off, as the gateway then sends what is set', () => {
    expect(reasoningForcedNoneOnChat('azure', 'gpt-6-luna', { autoDropUnsupportedParams: false })).toBe(false);
    expect(reasoningForcedNoneOnChat('azure', 'gpt-6-luna', { autoDropUnsupportedParams: true })).toBe(true);
  });

  it('is false for the drivers with their own reasoning envelope, an unknown model and no driver at all', () => {
    expect(reasoningForcedNoneOnChat('anthropic', 'claude-sonnet-5-5', {})).toBe(false);
    expect(reasoningForcedNoneOnChat('bedrock', 'global.openai.gpt-5.6-terra', {})).toBe(false);
    expect(reasoningForcedNoneOnChat('vertex', 'gemini-2.5-pro', {})).toBe(false);
    expect(reasoningForcedNoneOnChat('azure', undefined, {})).toBe(false);
    expect(reasoningForcedNoneOnChat(undefined, 'gpt-6-luna', {})).toBe(false);
    expect(reasoningForcedNoneOnChat(null, 'gpt-6-luna', {})).toBe(false);
  });
});

describe('the Model Hub Reasoning section', () => {
  const section = (props: Record<string, unknown>, locale: 'en' | 'tr' = 'en') =>
    mount(h(ReasoningSection, { number: 4, value: EMPTY_REASONING_FORM, onChange: noop, ...props } as never), locale);
  const hint = (c: HTMLElement) => c.querySelector('[data-testid="reasoning-forced-none"]');

  it('says that tools run the model without reasoning on Chat Completions', () => {
    const c = section({ driver: 'azure', modelId: 'gpt-6-luna', settings: {} });
    expect(hint(c)?.textContent).toBe(en.modelReasoning.hint.forcedNoneOnChat);
  });

  it('says it in Turkish for a Turkish console', () => {
    const c = section({ driver: 'azure', modelId: 'gpt-6-luna', settings: {} }, 'tr');
    expect(hint(c)?.textContent).toBe(tr.modelReasoning.hint.forcedNoneOnChat);
  });

  it('keeps quiet once the Upstream API is Responses', () => {
    expect(hint(section({ driver: 'azure', modelId: 'gpt-6-luna', settings: { upstreamApi: 'responses' } }))).toBeNull();
  });

  it('keeps quiet for a model whose rule takes an effort next to tools, and for Claude', () => {
    expect(hint(section({ driver: 'openai', modelId: 'o3', settings: {} }))).toBeNull();
    expect(hint(section({ driver: 'anthropic', modelId: 'claude-sonnet-5-5', settings: {} }))).toBeNull();
  });

  it('keeps quiet while the model\'s driver has no reasoning control', () => {
    expect(hint(section({ driver: undefined, modelId: 'gpt-6-luna', settings: {} }))).toBeNull();
  });
});

describe('the agent reasoning dropdown', () => {
  const picker = (model: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    mount(h(AgentReasoningPicker, {
      model: { key: 'k', name: 'K', ...model },
      driverByProviderKey: { azureProv: 'azure', openaiProv: 'openai', claudeProv: 'anthropic' },
      value: {},
      onChange: noop,
      testId: 'picker',
      ...extra,
    } as never));
  const hint = (c: HTMLElement) => c.querySelector('[data-testid="picker-forced-none-hint"]');

  it('says that tools run the model without reasoning on Chat Completions', () => {
    const c = picker({ providerKey: 'azureProv', modelId: 'gpt-6-luna', settings: {} });
    expect(hint(c)?.textContent).toBe(en.modelReasoning.hint.forcedNoneOnChat);
  });

  it('knows the driver from the model record as well as from the provider list', () => {
    const c = picker({ providerDriver: 'openai', modelId: 'gpt-5.2', settings: {} });
    expect(hint(c)?.textContent).toBe(en.modelReasoning.hint.forcedNoneOnChat);
  });

  it('says it in the row of a list too', () => {
    const c = picker({ providerKey: 'azureProv', modelId: 'gpt-6-luna', settings: {} }, { compact: true });
    expect(hint(c)).not.toBeNull();
  });

  it('keeps quiet on the Responses upstream API', () => {
    const c = picker({ providerKey: 'azureProv', modelId: 'gpt-6-luna', settings: { upstreamApi: 'responses' } });
    expect(hint(c)).toBeNull();
  });

  it('keeps quiet for a model whose rule takes an effort next to tools, for Claude and for a model without a driver', () => {
    expect(hint(picker({ providerKey: 'openaiProv', modelId: 'gpt-5', settings: {} }))).toBeNull();
    expect(hint(picker({ providerKey: 'claudeProv', modelId: 'claude-sonnet-5-5', settings: {} }))).toBeNull();
    expect(hint(picker({ providerKey: 'missing', modelId: 'gpt-6-luna', settings: {} }))).toBeNull();
  });
});

describe('the strings', () => {
  it('exist in both languages, and the Turkish one is translated', () => {
    expect(en.modelReasoning.hint.forcedNoneOnChat).toMatch(/Chat Completions/);
    expect(en.modelReasoning.hint.forcedNoneOnChat).toMatch(/Responses/);
    expect(tr.modelReasoning.hint.forcedNoneOnChat).toBeTruthy();
    expect(tr.modelReasoning.hint.forcedNoneOnChat).not.toBe(en.modelReasoning.hint.forcedNoneOnChat);
    expect(tr.modelReasoning.hint.forcedNoneOnChat).toMatch(/Responses/);
  });
});
