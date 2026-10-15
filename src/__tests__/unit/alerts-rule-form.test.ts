// @vitest-environment jsdom
/**
 * The alert rule form (a full-screen FormShell): what an edit sends back (stored channels kept as
 * references, a cleared description sent as ''), the entity scope, the baseline payload, the
 * licence gating of condition modes, the deep-link prefill and the Send test / Preview calls.
 */
import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buttonByText,
  click,
  installApiMock,
  installDomStubs,
  jsonResponse,
  mount,
  q,
  qa,
  setInput,
  settle,
  text,
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/alerts',
  useSearchParams: () => new URLSearchParams(),
}));

import AlertRuleForm, { type AlertRuleFormProps } from '@/components/alerts/AlertRuleForm';
import { ALERT_METRIC_CATALOG } from '@/lib/services/alerts/metricCatalog';
import { prefillFromParams, duplicateRuleSeed } from '@/components/alerts/ruleForm';
import { DEFAULT_ALERT_CATALOG } from '@/components/alerts/alertCatalog';
import type { AlertMeta, AlertRuleDto } from '@/components/alerts/alertTypes';

let mounted: Mounted;
let api: ApiMock;

beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const META: AlertMeta = {
  validModules: ['agents', 'models', 'rag', 'mcp', 'tools', 'guardrails', 'inference', 'evaluation', 'analysis', 'redteam'],
  validWindows: [5, 15, 30, 60, 120, 240, 1440],
  catalog: ALERT_METRIC_CATALOG,
  modes: { threshold: { available: true }, baseline: { available: true }, absence: { available: true }, slo_burn: { available: true } },
  channelTypes: ['email', 'webhook', 'slack', 'teams', 'pagerduty'],
};

const RULE: AlertRuleDto = {
  _id: 'r1',
  name: 'Support errors',
  description: 'old description',
  module: 'agents',
  metric: 'agent_error_rate',
  condition: { operator: 'gt', threshold: 5, mode: 'threshold', forMinutes: 10 },
  windowMinutes: 30,
  cooldownMinutes: 60,
  enabled: true,
  entity: { entityType: 'agent', mode: 'selected', keys: ['support', 'sales'] },
  severity: 'warning',
  notifyOnResolve: true,
  renotifyMinutes: 0,
  channels: [
    { id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: ['ops@example.com'] },
    { id: 'ch_bbbbbbbbbbbb', type: 'slack', urlHint: 'https://hooks.slack.com/…abcd' },
    { id: 'ch_cccccccccccc', type: 'webhook', urlHint: 'https://example.com/…', hasSecret: true },
  ],
};

const NAME_PLACEHOLDER = 'e.g. Pulse Main error rate';

async function render(props: Partial<AlertRuleFormProps> = {}, locale = 'en') {
  api = installApiMock([
    ['GET', '/api/alerts/entities', () => ({ entities: [{ key: 'support', requests: 120 }] })],
    ['GET', '/api/alerts/rules', () => ({ rules: [], meta: META })],
    ['POST', '/api/alerts/rules', () => jsonResponse({ rule: { _id: 'new' } }, 201)],
    ['PUT', /^\/api\/alerts\/rules\/[^/]+$/, () => ({ rule: { _id: 'r1' } })],
    ['POST', '/api/alerts/rules/preview', () => ({ targets: [{ entityKey: 'support', value: 7.5, sampleCount: 40, breached: true, baseline: null }], notes: [] }) ],
    ['POST', '/api/alerts/channels/test', () => ({ result: { type: 'webhook', target: 'https://example.com/…', success: true } })],
  ]);
  const onSuccess = vi.fn();
  const onClose = vi.fn();
  mounted = await mount(createElement(AlertRuleForm, { opened: true, onClose, onSuccess, meta: META, ...props }), locale);
  await settle(100);
  return { onSuccess, onClose };
}

const saveButton = (label: string) => qa<HTMLButtonElement>('button').find((button) => button.textContent?.trim() === label);
const body = (call: ApiMock['calls'][number] | undefined) => call?.body as Record<string, unknown>;

describe('AlertRuleForm: edit', () => {
  it('shows the stored rule and its sentence', async () => {
    await render({ mode: 'edit', ruleId: 'r1', initialData: RULE as unknown as Record<string, unknown> });
    expect(text()).toContain('Edit Alert Rule');
    expect((q<HTMLInputElement>(`input[placeholder="${NAME_PLACEHOLDER}"]`))?.value).toBe('Support errors');
    expect(q('[data-testid="rule-sentence"]')?.textContent).toBe('Alert when the Agent Error Rate of support, sales is > 5% in a 30 min window for 10 min. Notify: Email, Slack, Webhook.');
  });

  it('keeps every stored channel as a reference and never sends a secret', async () => {
    await render({ mode: 'edit', ruleId: 'r1', initialData: RULE as unknown as Record<string, unknown> });
    await click(saveButton('Save'));
    await settle(50);
    const puts = api.to('PUT', '/api/alerts/rules/r1');
    expect(puts).toHaveLength(1);
    expect(body(puts[0])!.channels).toEqual([
      { id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: ['ops@example.com'] },
      { id: 'ch_bbbbbbbbbbbb', type: 'slack' },
      { id: 'ch_cccccccccccc', type: 'webhook' },
    ]);
    expect(JSON.stringify(puts[0]!.body)).not.toContain('hooks.slack.com');
    expect(body(puts[0])!.entity).toEqual({ entityType: 'agent', mode: 'selected', keys: ['support', 'sales'] });
    expect(body(puts[0])!.scope).toEqual({});
    expect(body(puts[0])!.description).toBe('old description');
  });

  it('sends an empty description to clear a stored one', async () => {
    const { onSuccess, onClose } = await render({ mode: 'edit', ruleId: 'r1', initialData: RULE as unknown as Record<string, unknown> });
    await setInput(q<HTMLTextAreaElement>('textarea')!, '');
    await click(saveButton('Save'));
    await settle(50);
    expect(body(api.to('PUT', '/api/alerts/rules/r1')[0])!.description).toBe('');
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not save while a check fails and keeps the dialog open on a server error', async () => {
    await render({ mode: 'edit', ruleId: 'r1', initialData: RULE as unknown as Record<string, unknown> });
    await setInput(q<HTMLInputElement>(`input[placeholder="${NAME_PLACEHOLDER}"]`)!, '   ');
    expect(saveButton('Save')?.hasAttribute('disabled')).toBe(true);
    await mounted.unmount();

    const { onSuccess, onClose } = await render({ mode: 'edit', ruleId: 'r1', initialData: RULE as unknown as Record<string, unknown> });
    api.on('PUT', /^\/api\/alerts\/rules\/[^/]+$/, () => jsonResponse({ message: 'nope' }, 400));
    await click(saveButton('Save'));
    await settle(50);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('AlertRuleForm: create', () => {
  it('prefills from the deep link and posts the entity scope with the typed name', async () => {
    const prefill = {
      ...prefillFromParams({ module: 'agents', metric: 'agent_error_rate', entityType: 'agent', entityKey: 'support' }, DEFAULT_ALERT_CATALOG),
      channels: [{ type: 'email' as const, recipients: ['a@example.com'] }],
    };
    await render({ initialData: prefill as unknown as Record<string, unknown> });
    expect(text()).toContain('Create Alert Rule');
    expect(saveButton('Create')?.hasAttribute('disabled')).toBe(true);
    await setInput(q<HTMLInputElement>(`input[placeholder="${NAME_PLACEHOLDER}"]`)!, 'Support watch');
    expect(saveButton('Create')?.hasAttribute('disabled')).toBe(false);
    await click(saveButton('Create'));
    await settle(50);
    const posts = api.to('POST', '/api/alerts/rules');
    expect(posts).toHaveLength(1);
    expect(body(posts[0])).toMatchObject({
      name: 'Support watch',
      module: 'agents',
      metric: 'agent_error_rate',
      entity: { entityType: 'agent', mode: 'selected', keys: ['support'] },
      channels: [{ type: 'email', recipients: ['a@example.com'] }],
    });
    // a create sends no description and no scope when empty
    expect(body(posts[0])).not.toHaveProperty('description');
    expect(body(posts[0])).not.toHaveProperty('scope');
  });

  it('sends the baseline condition with the selected preset', async () => {
    await render({ initialData: { ...duplicateRuleSeed(RULE, 'Baseline copy').seed } as unknown as Record<string, unknown> });
    await click(qa('button').find((button) => button.textContent?.startsWith('Baseline')));
    expect(q('[data-testid="rule-sentence"]')?.textContent).toContain('above its 14-day normal');
    await click(qa('button').find((button) => /^Sensitive/.test(button.textContent ?? '')));
    await click(saveButton('Create'));
    await settle(50);
    const post = body(api.to('POST', '/api/alerts/rules')[0])!;
    expect(post.condition).toMatchObject({ mode: 'baseline', baseline: { direction: 'up', minRatio: 1.5, minZ: 2, lookbackDays: 14, seasonality: 'daily' } });
    expect(post.condition).not.toHaveProperty('threshold');
    // the email channel carried over, the others did not
    expect(post.channels).toEqual([{ type: 'email', recipients: ['ops@example.com'] }]);
  });

  it('previews the rule without a name or channels', async () => {
    await render({ initialData: { module: 'agents', metric: 'agent_error_rate' } });
    await click(buttonByText('Preview now'));
    await settle(50);
    const previews = api.to('POST', '/api/alerts/rules/preview');
    expect(previews).toHaveLength(1);
    expect(body(previews[0])).toMatchObject({ module: 'agents', metric: 'agent_error_rate' });
    expect(body(previews[0])).not.toHaveProperty('name');
    expect(body(previews[0])).not.toHaveProperty('channels');
    expect(q('[data-testid="rule-preview"]')?.textContent).toContain('support');
  });
});

describe('AlertRuleForm: condition modes', () => {
  const gated: AlertMeta = {
    ...META,
    modes: { threshold: { available: true }, baseline: { available: false, reason: 'license_required' }, absence: { available: false, reason: 'license_required' }, slo_burn: { available: false, reason: 'license_required' } },
  };

  it('disables the modes the licence does not include and explains why', async () => {
    await render({ meta: gated, initialData: { module: 'agents', metric: 'agent_error_rate' } });
    const chips = qa<HTMLButtonElement>('.form-chip[aria-pressed]');
    const byLabel = (label: string) => chips.find((chip) => chip.textContent?.startsWith(label));
    expect(byLabel('Threshold')?.hasAttribute('disabled')).toBe(false);
    for (const label of ['Baseline', 'Absence', 'SLO burn']) expect(byLabel(label)?.hasAttribute('disabled'), label).toBe(true);
    expect(q('[data-testid="mode-upsell"]')?.textContent).toContain('need an active Enterprise licence');
    // a click on a blocked mode changes nothing
    await click(byLabel('Baseline'));
    expect(byLabel('Threshold')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('words the hint for a community build differently', async () => {
    const community: AlertMeta = { ...gated, modes: { ...gated.modes, baseline: { available: false, reason: 'not_enterprise_build' } } };
    await render({ meta: community, initialData: { module: 'agents', metric: 'agent_error_rate' } });
    expect(q('[data-testid="mode-upsell"]')?.textContent).toContain('part of the Enterprise edition');
  });

  it('offers every mode when the server reports them available, and only threshold for a legacy metric', async () => {
    await render({ initialData: { module: 'agents', metric: 'agent_error_rate' } });
    expect(qa('.form-chip[aria-pressed]').map((chip) => chip.textContent)).toEqual(['Threshold', 'Baseline', 'Absence', 'SLO burn']);
    expect(q('[data-testid="mode-upsell"]')).toBeNull();
    await mounted.unmount();
    await render({ initialData: { module: 'inference', metric: 'gpu_cache_usage' } });
    expect(qa('.form-chip[aria-pressed]').map((chip) => chip.textContent)).toEqual(['Threshold']);
  });
});

describe('AlertRuleForm: Send test', () => {
  it('tests a stored channel by reference on an edit', async () => {
    await render({ mode: 'edit', ruleId: 'r1', initialData: RULE as unknown as Record<string, unknown> });
    const buttons = qa<HTMLButtonElement>('button').filter((button) => button.textContent === 'Send test');
    expect(buttons).toHaveLength(3);
    await click(buttons[2]);
    await settle(50);
    const calls = api.to('POST', '/api/alerts/channels/test');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ ruleId: 'r1', channelId: 'ch_cccccccccccc' });
    expect(text()).toContain('Test message delivered.');
  });

  it('cannot test a stored channel of a rule that does not exist yet', async () => {
    await render({ initialData: { ...duplicateRuleSeed({ ...RULE, channels: [{ id: 'ch_cccccccccccc', type: 'webhook', hasSecret: true }] }, 'x').seed } as unknown as Record<string, unknown> });
    expect(qa('button').filter((button) => button.textContent === 'Send test')).toHaveLength(0);
  });
});

describe('AlertRuleForm: Turkish', () => {
  it('renders the form without a missing message', async () => {
    await render({ mode: 'edit', ruleId: 'r1', initialData: RULE as unknown as Record<string, unknown> }, 'tr');
    expect(text()).toContain('Uyarı Kuralını Düzenle');
    expect(text()).not.toMatch(/alerts\.[a-zA-Z]/);
    expect(q('[data-testid="rule-sentence"]')?.textContent).toContain('Ajan Hata Oranı');
  });
});
