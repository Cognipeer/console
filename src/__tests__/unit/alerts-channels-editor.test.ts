// @vitest-environment jsdom
/**
 * The reusable channels editor: stored channels show only masked hints (never a secret, never an
 * input holding one), "Replace" opens the write-only inputs, and the Test button reports the result.
 */
import { createElement, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buttonByText, click, installDomStubs, mount, q, qa, setInput, settle, text, type Mounted } from '../helpers/iamCenterUi';
import ChannelsEditor, { type ChannelsEditorProps } from '@/components/alerts/ChannelsEditor';
import { channelsFromStored, channelsToInput, type ChannelItem } from '@/components/alerts/channelItems';
import type { ChannelTestResult } from '@/components/alerts/alertTypes';

let mounted: Mounted;

beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  vi.restoreAllMocks();
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const STORED = channelsFromStored([
  { id: 'ch_aaaaaaaaaaaa', type: 'webhook', urlHint: 'https://hooks.example.com/…9f2a', hasSecret: true },
  { id: 'ch_bbbbbbbbbbbb', type: 'pagerduty', keyHint: '…c0de' },
  { id: 'ch_cccccccccccc', type: 'email', recipients: ['ops@example.com'] },
]);

/** The editor controlled by a parent, the way the rule form and the digest settings use it. */
function Harness(props: { initial: ChannelItem[]; onValue: (value: ChannelItem[]) => void } & Partial<ChannelsEditorProps>) {
  const { initial, onValue, ...rest } = props;
  const [value, setValue] = useState(initial);
  return createElement(ChannelsEditor, {
    ...rest,
    value,
    onChange: (next: ChannelItem[]) => {
      setValue(next);
      onValue(next);
    },
  });
}

async function render(props: Partial<ChannelsEditorProps> & { initial?: ChannelItem[] } = {}) {
  const seen: ChannelItem[][] = [];
  const { initial = STORED, ...rest } = props;
  mounted = await mount(createElement(Harness, { initial, onValue: (value: ChannelItem[]) => seen.push(value), ...rest }));
  await settle(50);
  return { seen, last: () => seen[seen.length - 1] ?? initial };
}

describe('ChannelsEditor', () => {
  it('shows the masked hints of stored channels and no secret input', async () => {
    await render();
    expect(text()).toContain('https://hooks.example.com/…9f2a');
    expect(text()).toContain('…c0de');
    expect(text()).toContain('Secret set');
    // nothing holds a secret: the only inputs are the email recipients tag input
    expect(qa('input[type="password"]')).toHaveLength(0);
    expect(qa('input').every((input) => !/secret|routing/i.test((input as HTMLInputElement).value))).toBe(true);
    // stored ones are marked, and the editor still lets the user replace them
    expect(qa('.ds-badge').filter((badge) => badge.textContent === 'Saved')).toHaveLength(2);
    expect(buttonByText('Replace')).toBeDefined();
  });

  it('opens write-only inputs on Replace and reports what is typed', async () => {
    const { last } = await render();
    await click(qa('button').filter((button) => button.textContent === 'Replace')[0]);
    const url = q<HTMLInputElement>('input[placeholder="https://"]');
    expect(url).not.toBeNull();
    expect(url!.value).toBe('');
    expect(qa('input[type="password"]')).toHaveLength(1);
    await setInput(url!, 'https://new.example.com/hook');
    await setInput(q<HTMLInputElement>('input[type="password"]')!, 'topsecret');
    expect(channelsToInput(last())[0]).toEqual({ id: 'ch_aaaaaaaaaaaa', type: 'webhook', url: 'https://new.example.com/hook', secret: 'topsecret' });
    // an untouched stored channel is still just a reference
    expect(channelsToInput(last())[1]).toEqual({ id: 'ch_bbbbbbbbbbbb', type: 'pagerduty' });
  });

  it('removes a stored signing secret through the checkbox', async () => {
    const { last } = await render();
    await click(qa('button').filter((button) => button.textContent === 'Replace')[0]);
    await click(q('input[type="checkbox"]'));
    expect(channelsToInput(last())[0]).toEqual({ id: 'ch_aaaaaaaaaaaa', type: 'webhook', secret: '' });
    // keeping the stored value drops the pending change again
    await click(buttonByText('Keep the stored value'));
    expect(channelsToInput(last())[0]).toEqual({ id: 'ch_aaaaaaaaaaaa', type: 'webhook' });
  });

  it('adds only the allowed channel types and removes a channel', async () => {
    const { last } = await render({ initial: [], allowedTypes: ['email', 'slack'] });
    expect(text()).toContain('No channel yet');
    expect(buttonByText(/Webhook/)).toBeUndefined();
    expect(buttonByText(/PagerDuty/)).toBeUndefined();
    await click(buttonByText(/Slack/));
    expect(last()).toHaveLength(1);
    expect(last()[0]).toMatchObject({ type: 'slack' });
    // an empty new Slack channel asks for its URL
    expect(text()).toContain('A URL is required');
    await click(q('button[aria-label="Remove channel"]'));
    expect(last()).toHaveLength(0);
  });

  it('shows a Test button only with onTest and reports success and failure', async () => {
    await render({ initial: [STORED[2]!] });
    expect(buttonByText('Send test')).toBeUndefined();
    await mounted.unmount();

    const onTest = vi.fn<(channel: ChannelItem) => Promise<ChannelTestResult>>(async () => ({ type: 'email', target: 'ops@example.com', success: true }));
    await render({ initial: [STORED[2]!], onTest });
    await click(buttonByText('Send test'));
    await settle(20);
    expect(onTest).toHaveBeenCalledTimes(1);
    expect(onTest.mock.calls[0]![0]).toMatchObject({ id: 'ch_cccccccccccc', type: 'email' });
    expect(text()).toContain('Test message delivered.');
    await mounted.unmount();

    const failing = vi.fn(async () => ({ type: 'email', target: 'ops@example.com', success: false, error: 'mailbox full' }) as ChannelTestResult);
    await render({ initial: [STORED[2]!], onTest: failing });
    await click(buttonByText('Send test'));
    await settle(20);
    expect(text()).toContain('Test failed: mailbox full');
    await mounted.unmount();

    const throwing = vi.fn(async (): Promise<ChannelTestResult> => {
      throw new Error('network down');
    });
    await render({ initial: [STORED[2]!], onTest: throwing });
    await click(buttonByText('Send test'));
    await settle(20);
    expect(text()).toContain('Test failed: network down');
  });

  it('disables the Test button of a channel that cannot be tested yet', async () => {
    const onTest = vi.fn(async () => ({ type: 'slack', target: '', success: true }) as ChannelTestResult);
    await render({ initial: [], onTest, allowedTypes: ['slack'] });
    await click(buttonByText(/Slack/));
    expect(buttonByText('Send test')?.hasAttribute('disabled')).toBe(true);
  });

  it('renders in Turkish', async () => {
    mounted = await mount(createElement(Harness, { initial: STORED, onValue: () => {} }), 'tr');
    await settle(50);
    expect(text()).toContain('Anahtar tanımlı');
    expect(text()).toContain('Değiştir');
    expect(text()).not.toContain('alerts.');
  });
});
