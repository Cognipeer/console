// @vitest-environment jsdom
/**
 * Reasoning depth in the model playgrounds and the "Edit" shortcut on the model page.
 *
 *  - which levels the control offers, and what the request carries ("Model default" sends nothing;
 *    a model with a Model Hub default shows it locked and sends nothing, because that default wins);
 *  - the hint under an answer that billed reasoning tokens but returned no reasoning text;
 *  - no show/hide switch: reasoning text is on screen as soon as it streams;
 *  - the model page's Reasoning "Edit" opens the edit overlay at that section.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MantineProvider } from '@mantine/core';
import ModelPlayground from '@/components/playground/ModelPlayground';
import { Playground } from '@/components/playground/Playground';
import ReasoningSummary from '@/components/models/ReasoningSummary';
import { ReasoningSection } from '@/components/models/modelFormSections';
import { EMPTY_REASONING_FORM } from '@/components/models/reasoningForm';
import {
  playgroundReasoningControl,
  playgroundReasoningFields,
  playgroundReasoningHint,
  readReasoningTokens,
} from '@/components/playground/playgroundReasoning';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

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
  Element.prototype.scrollIntoView = scrollIntoView;
});

const scrollIntoView = vi.fn();
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  scrollIntoView.mockClear();
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(h(MantineProvider, null, element)));
  return container;
}

const flush = async () => {
  for (let i = 0; i < 12; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
};

function sse(frames: unknown[]) {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(new TextEncoder().encode(body), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const delta = (d: Record<string, unknown>) => ({ choices: [{ delta: d }] });
const usageFrame = (reasoningTokens: number) => ({
  choices: [],
  usage: { prompt_tokens: 5, completion_tokens: 80, completion_tokens_details: { reasoning_tokens: reasoningTokens } },
});

/** Stubs fetch; resolves chat calls with `frames` and records their JSON bodies. */
function stubChat(frames: unknown[], extra?: (url: string) => Response | undefined) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const special = extra?.(String(url));
    if (special) return special;
    bodies.push(JSON.parse(String(init?.body)));
    return sse(frames);
  }));
  return bodies;
}

function select(container: HTMLElement, value: string) {
  const el = container.querySelector<HTMLSelectElement>('[data-testid="playground-reasoning-control"] select')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function clickRun(container: HTMLElement) {
  const run = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Run'))!;
  await act(async () => { run.click(); });
  await flush();
}

const optionLabels = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-testid="playground-reasoning-control"] option')).map((o) => o.textContent);

describe('which levels the control offers', () => {
  it('follows the driver and, for OpenAI-family models, the model line', () => {
    expect(playgroundReasoningControl({ driver: 'anthropic', modelId: 'claude-sonnet-5' })?.efforts)
      .toEqual(['none', 'low', 'medium', 'high']);
    expect(playgroundReasoningControl({ driver: 'openai', modelId: 'gpt-5.1' })?.efforts)
      .toEqual(['none', 'minimal', 'low', 'medium', 'high']);
    // `none` is a value only the GPT-5.1+ line takes.
    expect(playgroundReasoningControl({ driver: 'azure', modelId: 'gpt-5' })?.efforts)
      .toEqual(['minimal', 'low', 'medium', 'high']);
    // OpenAI-compatible engines only have on/off (and `none` is gated like any request effort).
    const toggle = playgroundReasoningControl({ driver: 'openai-compatible', modelId: 'qwen3-32b' });
    expect(toggle?.kind).toBe('toggle');
    expect(toggle?.efforts).toEqual(['medium']);
  });

  it('offers nothing where the gateway would drop the effort or the driver has no reasoning', () => {
    expect(playgroundReasoningControl({ driver: 'openai', modelId: 'gpt-4o' })).toBeNull();
    expect(playgroundReasoningControl({ driver: 'mystery', modelId: 'x' })).toBeNull();
    expect(playgroundReasoningControl(undefined)).toBeNull();
  });

  it('a Model Hub default is shown as the value, and wins: no levels to choose', () => {
    const control = playgroundReasoningControl({
      driver: 'openai', modelId: 'gpt-4o', settings: { reasoning: { effort: 'low' } },
    });
    expect(control?.pinned).toEqual({ effort: 'low' });
    expect(control?.efforts).toEqual([]);
  });
});

describe('what the request carries', () => {
  const control = playgroundReasoningControl({ driver: 'anthropic', modelId: 'claude-sonnet-5' });

  it('sends reasoning_effort for a chosen level and nothing for "Model default"', () => {
    expect(playgroundReasoningFields(control, 'high')).toEqual({ reasoning_effort: 'high' });
    expect(playgroundReasoningFields(control, '')).toEqual({});
  });

  it('sends nothing for a level the model does not offer, or when the model default wins', () => {
    expect(playgroundReasoningFields(control, 'minimal')).toEqual({});
    const pinned = playgroundReasoningControl({ driver: 'anthropic', settings: { reasoning: { effort: 'low' } } });
    expect(playgroundReasoningFields(pinned, 'high')).toEqual({});
    expect(playgroundReasoningFields(null, 'high')).toEqual({});
  });
});

describe('the hint under an answer without reasoning text', () => {
  const base = { hasReasoningText: false, reasoningTokens: 120 };

  it('OpenAI / Azure on Chat Completions: reasoning text needs the Responses upstream', () => {
    expect(playgroundReasoningHint({ ...base, driver: 'openai', modelId: 'gpt-5' })).toBe('responsesOnly');
    expect(playgroundReasoningHint({ ...base, driver: 'azure', modelId: 'gpt-5', settings: { upstreamApi: 'chat' } }))
      .toBe('responsesOnly');
    expect(playgroundReasoningHint({ ...base, driver: 'openai', settings: { upstreamApi: 'responses' } })).toBeNull();
  });

  it('Claude: try a higher effort', () => {
    expect(playgroundReasoningHint({ ...base, driver: 'anthropic', modelId: 'claude-sonnet-5' })).toBe('tryHigher');
    expect(playgroundReasoningHint({ ...base, driver: 'bedrock', modelId: 'anthropic.claude-sonnet-5-v1:0' })).toBe('tryHigher');
    expect(playgroundReasoningHint({ ...base, driver: 'bedrock', modelId: 'meta.llama3' })).toBeNull();
  });

  it('nothing when text came back, no reasoning tokens were billed, the operator hid the text, or the driver is another', () => {
    expect(playgroundReasoningHint({ ...base, driver: 'anthropic', hasReasoningText: true })).toBeNull();
    expect(playgroundReasoningHint({ ...base, driver: 'anthropic', reasoningTokens: 0 })).toBeNull();
    expect(playgroundReasoningHint({ ...base, driver: 'anthropic', settings: { returnReasoning: false } })).toBeNull();
    expect(playgroundReasoningHint({ ...base, driver: 'vertex' })).toBeNull();
  });

  it('reads reasoning tokens from the usage frame', () => {
    expect(readReasoningTokens({ completion_tokens_details: { reasoning_tokens: 42 } })).toBe(42);
    expect(readReasoningTokens({ completion_tokens: 9 })).toBe(0);
    expect(readReasoningTokens(undefined)).toBe(0);
  });
});

describe('model playground', () => {
  const claude = { driver: 'anthropic', modelId: 'claude-sonnet-5', settings: {} };

  it('sends the chosen level as reasoning_effort, asks for the usage frame, and omits it for "Model default"', async () => {
    const bodies = stubChat([delta({ content: 'ok' })]);
    const c = mount(h(ModelPlayground, { modelKey: 'm', defaultUser: 'hi', modelInfo: claude }));
    expect(optionLabels(c)).toEqual(['Model default', 'None (thinking off)', 'Low', 'Medium', 'High']);

    await clickRun(c);
    expect(bodies[0]).not.toHaveProperty('reasoning_effort');
    expect(bodies[0].stream_options).toEqual({ include_usage: true });

    select(c, 'high');
    await clickRun(c);
    expect(bodies[1].reasoning_effort).toBe('high');

    select(c, '');
    await clickRun(c);
    expect(bodies[2]).not.toHaveProperty('reasoning_effort');
  });

  it('a model with a Model Hub default shows it locked with where to change it, and sends nothing', async () => {
    const bodies = stubChat([delta({ content: 'ok' })]);
    const c = mount(h(ModelPlayground, {
      modelKey: 'm', defaultUser: 'hi',
      modelInfo: { ...claude, settings: { reasoning: { effort: 'low' } } },
    }));
    const el = c.querySelector<HTMLSelectElement>('[data-testid="playground-reasoning-control"] select')!;
    expect(el.disabled).toBe(true);
    expect(el.textContent).toBe('Low');
    expect(c.querySelector('[data-testid="playground-reasoning-pinned"]')?.textContent)
      .toBe(en.modelReasoning.playground.control.pinned);

    await clickRun(c);
    expect(bodies[0]).not.toHaveProperty('reasoning_effort');
  });

  it('has no control for a model without reasoning', () => {
    const c = mount(h(ModelPlayground, { modelKey: 'm', modelInfo: { driver: 'openai', modelId: 'gpt-4o' } }));
    expect(c.querySelector('[data-testid="playground-reasoning-control"]')).toBeNull();
  });

  it('shows streamed reasoning directly: no show/hide switch, nothing read from or written to storage', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    stubChat([delta({ reasoning_content: 'Let me think.' }), delta({ content: 'Done.' })]);
    const c = mount(h(ModelPlayground, { modelKey: 'm', defaultUser: 'hi', modelInfo: claude }));
    expect(c.querySelector('[data-testid="playground-reasoning-toggle"]')).toBeNull();
    expect(c.querySelector('[aria-pressed]')).toBeNull();

    await clickRun(c);
    expect(c.textContent).toContain('Let me think.');
    expect(c.textContent).toContain('Done.');
    expect(getItem).not.toHaveBeenCalledWith('playground.showReasoning');
    expect(setItem).not.toHaveBeenCalled();
  });

  it('explains an answer that billed reasoning tokens but showed no reasoning', async () => {
    stubChat([delta({ content: 'Done.' }), usageFrame(64)]);
    const openai = mount(h(ModelPlayground, {
      modelKey: 'm', defaultUser: 'hi', modelInfo: { driver: 'openai', modelId: 'gpt-5.1', settings: {} },
    }));
    expect(openai.querySelector('[data-testid="playground-reasoning-hint"]')).toBeNull();
    await clickRun(openai);
    expect(openai.querySelector('[data-testid="playground-reasoning-hint"]')?.textContent)
      .toBe(en.modelReasoning.playground.hint.responsesOnly);
    act(() => root?.unmount());
    openai.remove();

    stubChat([delta({ content: 'Done.' }), usageFrame(64)]);
    const claudeView = mount(h(ModelPlayground, { modelKey: 'm', defaultUser: 'hi', modelInfo: claude }));
    await clickRun(claudeView);
    expect(claudeView.querySelector('[data-testid="playground-reasoning-hint"]')?.textContent)
      .toBe('No visible reasoning: try a higher effort.');
  });

  it('shows no hint when reasoning text came back', async () => {
    stubChat([delta({ reasoning_content: 'thinking' }), delta({ content: 'Done.' }), usageFrame(64)]);
    const c = mount(h(ModelPlayground, { modelKey: 'm', defaultUser: 'hi', modelInfo: claude }));
    await clickRun(c);
    expect(c.querySelector('[data-testid="playground-reasoning-hint"]')).toBeNull();
  });
});

describe('general playground (a model chat with a model picker, used for prompt testing)', () => {
  it('offers the control for the selected model and sends the level; the hint rides on the answer', async () => {
    const models = {
      models: [{
        key: 'claude', name: 'Claude', category: 'llm', provider: 'p',
        providerDriver: 'anthropic', modelId: 'claude-sonnet-5', settings: {},
      }],
    };
    const bodies = stubChat(
      [delta({ content: 'Done.' }), usageFrame(30)],
      (url) => (url.startsWith('/api/models') ? new Response(JSON.stringify(models), { status: 200 }) : undefined),
    );
    const c = mount(h(Playground, { initialModelKey: 'claude', hideModelSelector: true, hideSystemPrompt: true }));
    await flush();
    expect(optionLabels(c)).toContain('Model default');

    select(c, 'medium');
    const input = c.querySelector('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, 'hello');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = Array.from(c.querySelectorAll('button')).find((b) => b.textContent?.includes('Send'))!;
    await act(async () => { send.click(); });
    await flush();

    expect(bodies[0].reasoning_effort).toBe('medium');
    expect(c.querySelector('[data-testid="playground-reasoning-hint"]')?.textContent)
      .toBe(en.modelReasoning.playground.hint.tryHigher);
    // The UI-only hint is never sent back with the conversation.
    expect(JSON.stringify(bodies[0].messages)).not.toContain('reasoningHint');
  });
});

describe('model page: Reasoning "Edit"', () => {
  it('shows an Edit action that opens the edit overlay, and none for a model without that editor', () => {
    const onEdit = vi.fn();
    const withEdit = mount(h(ReasoningSummary, { settings: {}, driver: 'openai', modelId: 'gpt-5', onEdit }));
    const button = withEdit.querySelector<HTMLButtonElement>('[data-testid="model-reasoning-edit"]')!;
    expect(button.textContent).toBe('Edit');
    act(() => button.click());
    expect(onEdit).toHaveBeenCalledTimes(1);
    act(() => root?.unmount());
    withEdit.remove();

    const without = mount(h(ReasoningSummary, { settings: {}, driver: 'openai', modelId: 'gpt-5' }));
    expect(without.querySelector('[data-testid="model-reasoning-edit"]')).toBeNull();
  });

  // (A driver with no reasoning knob renders no Mantine Select, which jsdom renders very slowly;
  // the section's first control is then its "return reasoning" switch.)
  it('the Reasoning section scrolls into view and focuses its first control when opened from that shortcut', async () => {
    const c = mount(h(ReasoningSection, {
      number: 4, driver: undefined, value: EMPTY_REASONING_FORM, onChange: () => undefined, focusOnMount: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scrollIntoView).toHaveBeenCalled();
    expect(c.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.tagName).toBe('INPUT');
  });

  it('does not move the page when the section is opened the ordinary way', async () => {
    mount(h(ReasoningSection, { number: 4, driver: undefined, value: EMPTY_REASONING_FORM, onChange: () => undefined }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('strings', () => {
  it('the new strings exist in both languages', () => {
    for (const messages of [en, tr]) {
      const r = messages.modelReasoning;
      expect(r.detail.edit).toBeTruthy();
      expect(r.playground.control.modelDefault).toBeTruthy();
      expect(r.playground.control.pinned).toBeTruthy();
      expect(r.playground.hint.responsesOnly).toBeTruthy();
      expect(r.playground.hint.tryHigher).toBeTruthy();
    }
  });
});
