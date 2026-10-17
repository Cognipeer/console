// @vitest-environment jsdom
/**
 * Configure → Files → "Files the agent writes": the switch and the two limits, driven the way a
 * person drives them. Its default follows the uploads switch; a bucket is needed once it is on.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { AgentFilesPanelView } from '@/components/agents/studio/AgentFilesPanel';
import type { AttachmentBucketOption, AttachmentsSettings } from '@/components/agents/studio/filesSettings';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

(globalThis as { React?: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  window.matchMedia = window.matchMedia || ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

const bucket: AttachmentBucketOption = {
  key: 'docs', name: 'Docs', providerKey: 'builtin', providerLabel: 'Built-in', driver: 's3',
  bucketStatus: 'active', providerStatus: 'active', usable: true, localDisk: false,
};

function mount(initial?: AttachmentsSettings) {
  const seen: Array<AttachmentsSettings | undefined> = [];
  function Harness() {
    const [value, setValue] = useState<AttachmentsSettings | undefined>(initial);
    return h(MantineProvider, null, h(AgentFilesPanelView, {
      value,
      onChange: (next: AttachmentsSettings | undefined) => { seen.push(next); setValue(next); },
      agentKey: 'support',
      buckets: { status: 'ready', buckets: [bucket] },
    }));
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(h(Harness)));
  const outputsSwitch = () => [...container!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .find((input) => input.closest('.mantine-Switch-root')?.textContent?.includes('Let the agent create files'))!;
  const limit = (label: string) => [...container!.querySelectorAll('.mantine-NumberInput-root')]
    .find((root) => root.querySelector('label')?.textContent === label)?.querySelector<HTMLInputElement>('input');
  const bucketField = () => [...container!.querySelectorAll('label')].find((label) => label.textContent?.startsWith('Bucket'));
  return { outputsSwitch, limit, bucketField, seen };
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the files the agent writes, in the Files section', () => {
  it('follows the uploads by default: on with uploads and a bucket, and shows the two limits', () => {
    const { outputsSwitch, limit } = mount({ enabled: true, bucketKey: 'docs' });
    expect(outputsSwitch().checked).toBe(true);
    expect(outputsSwitch().disabled).toBe(false);
    expect(limit('Files per turn')?.placeholder).toBe('10');
    expect(limit('Largest file (MB)')?.placeholder).toBe('2');
    expect(container!.textContent).toContain('.md .csv .txt .json .html .xml .yaml .yml');
  });

  it('is off with uploads off, whatever the bucket — and the switch works without uploads', () => {
    const { outputsSwitch, limit, seen } = mount({ bucketKey: 'docs' });
    expect(outputsSwitch().checked).toBe(false);
    expect(outputsSwitch().disabled).toBe(false);
    expect(limit('Files per turn')).toBeUndefined();
    act(() => outputsSwitch().click());
    expect(seen.at(-1)).toEqual({ bucketKey: 'docs', outputs: { enabled: true } });
    expect(outputsSwitch().checked).toBe(true);
    expect(limit('Files per turn')).toBeDefined();
  });

  it('offers the bucket picker once the outputs are on, with uploads off', () => {
    const { outputsSwitch, bucketField } = mount(undefined);
    expect(bucketField()).toBeUndefined();
    act(() => outputsSwitch().click());
    expect(bucketField()).toBeDefined();
    // The upload-only limits stay with the uploads.
    expect(container!.textContent).not.toContain('Files per session');
  });

  it('shows how long files are kept for an agent that only writes files, and stores what is typed', () => {
    const { limit, seen } = mount({ bucketKey: 'docs', outputs: { enabled: true } });
    expect(limit('Files per session')).toBeUndefined();
    const retention = limit('Keep files for (days)');
    expect(retention?.placeholder).toBe('30');
    setValue(retention!, '7');
    expect(seen.at(-1)).toEqual({ bucketKey: 'docs', outputs: { enabled: true }, retentionDays: 7 });
  });

  it('does not offer a retention to an agent that stores no files at all', () => {
    const { limit } = mount(undefined);
    expect(limit('Keep files for (days)')).toBeUndefined();
  });

  it('switches off by storing `outputs.enabled: false`, and back on by storing `true`', () => {
    const { outputsSwitch, limit, seen } = mount({ enabled: true, bucketKey: 'docs', outputs: { maxFilesPerTurn: 5 } });
    act(() => outputsSwitch().click());
    expect(seen.at(-1)).toEqual({ enabled: true, bucketKey: 'docs', outputs: { maxFilesPerTurn: 5, enabled: false } });
    expect(limit('Files per turn')).toBeUndefined();
    act(() => outputsSwitch().click());
    expect(seen.at(-1)).toEqual({ enabled: true, bucketKey: 'docs', outputs: { maxFilesPerTurn: 5, enabled: true } });
  });

  it('stores the limits typed, and clears one that is emptied', () => {
    const { limit, seen } = mount({ enabled: true, bucketKey: 'docs' });
    setValue(limit('Files per turn')!, '7');
    expect(seen.at(-1)).toEqual({ enabled: true, bucketKey: 'docs', outputs: { maxFilesPerTurn: 7 } });
    setValue(limit('Largest file (MB)')!, '3');
    expect(seen.at(-1)).toEqual({ enabled: true, bucketKey: 'docs', outputs: { maxFilesPerTurn: 7, maxFileSizeMb: 3 } });
    setValue(limit('Files per turn')!, '');
    setValue(limit('Largest file (MB)')!, '');
    expect(seen.at(-1)).toEqual({ enabled: true, bucketKey: 'docs' });
  });
});

describe('the strings', () => {
  it('exist in English and Turkish', () => {
    const keys = ['outputsTitle', 'cfgOutputs', 'cfgOutputsDescription', 'cfgOutputsMaxFiles', 'cfgOutputsMaxFileSize'];
    for (const key of keys) {
      expect((en.agents.attachments as Record<string, string>)[key], `en ${key}`).toBeTruthy();
      expect((tr.agents.attachments as Record<string, string>)[key], `tr ${key}`).toBeTruthy();
    }
    expect(tr.agents.attachments.cfgOutputsDescription).toContain('{types}');
  });
});
