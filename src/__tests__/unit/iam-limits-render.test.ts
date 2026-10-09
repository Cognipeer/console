/**
 * Smoke render of the Limits tab with data: the table cells (target, mode,
 * project, amounts, inert badge), the read-only variant, and the empty state.
 * Server-side render only (no effects run), with the data hook stubbed.
 */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ limits: { current: null as unknown } }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {}, refresh: () => {}, back: () => {} }),
  usePathname: () => '/dashboard/iam',
}));
vi.mock('@/components/iam/limits/useLimits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/iam/limits/useLimits')>();
  return {
    ...actual,
    useLimits: () => hoisted.limits.current,
    useProjectOptions: () => [{ value: 'proj-1', label: 'Retail (retail)' }],
  };
});
vi.mock('@/components/common/confirm', () => ({
  useDeleteResource: () => async () => true,
  useConfirm: () => ({}),
}));

import LimitsTab from '@/components/iam/limits/LimitsTab';
import { parseLimitRows } from '@/components/iam/limits/limitsModel';

function stub(policies: unknown[], overrides: Record<string, unknown> = {}) {
  hoisted.limits.current = {
    rows: parseLimitRows({ policies }),
    loading: false,
    refreshing: false,
    error: null,
    saving: false,
    reload: async () => {},
    save: async () => ({ warnings: [] }),
    setEnabled: async () => {},
    remove: async () => {},
    ...overrides,
  };
}

const render = (canManage: boolean) =>
  renderToString(createElement(MantineProvider, null, createElement(LimitsTab, { canManage })));

const policies = [
  {
    _id: 'g', scope: 'group', scopeId: 'g1', groupMode: 'shared', domain: 'agent', priority: 20, enabled: true, label: 'Branch runs',
    limits: { rateLimit: { requests: { perDay: 200 }, tokens: { perDay: 100000 } }, budget: { monthlySpendLimit: 5000 } },
    target: { type: 'group', id: 'g1', label: 'Branch staff', sublabel: 'Retail branches' },
  },
  {
    _id: 'u', scope: 'user', scopeId: 'u1', domain: 'llm', priority: 10, enabled: false, label: 'Alice cap', projectId: 'proj-1', projectName: 'Retail',
    limits: { rateLimit: { requests: { perMinute: 60 } } },
    target: { type: 'user', id: 'u1', label: 'Alice', sublabel: 'alice@acme.test' },
  },
  {
    _id: 'a', scope: 'resource', scopeId: 'credit-bot', domain: 'agent', priority: 10, enabled: true, label: 'Credit bot', projectId: 'proj-1', projectName: 'Retail',
    limits: { rateLimit: { requests: { perHour: 30 } } },
    target: { type: 'agent', id: 'credit-bot', label: 'Credit assistant', sublabel: 'credit-bot' },
  },
  {
    _id: 'x', scope: 'user', scopeId: 'gone', domain: 'llm', priority: 10, enabled: true, label: 'Orphan',
    limits: { rateLimit: { requests: { perMinute: 1 } } },
    target: { type: 'user', id: 'gone', label: 'gone', missing: true },
  },
];

// These render whole component trees (jsdom + Mantine) or run the policy engine; on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe('LimitsTab (server render)', () => {
  beforeEach(() => stub(policies));

  it('shows every limit with who it applies to, the service, the project and its amounts', () => {
    const html = render(true);

    for (const text of ['Branch runs', 'Alice cap', 'Credit bot', 'Orphan']) expect(html).toContain(text);
    // Names resolved by the server, not raw ids.
    expect(html).toContain('Branch staff');
    expect(html).toContain('alice@acme.test');
    expect(html).toContain('Credit assistant');
    // How a group is counted.
    expect(html).toContain('Shared');
    // Service and project columns.
    expect(html).toContain('Agent runs');
    expect(html).toContain('Retail');
    expect(html).toContain('All projects');
    // Amounts, in words.
    expect(html).toContain('Requests / day: 200');
    expect(html).toContain('Requests / min: 60');
    expect(html).toContain('$5,000');
    // A deleted target and a limit that is never applied are called out.
    expect(html).toContain('Deleted');
    expect(html).toContain('Not applied');
  });

  it('counts group limits, agent-run limits and unapplied limits in the tiles', () => {
    const html = render(true);
    expect(html).toContain('Group limits');
    expect(html).toContain('Agent-run limits');
    expect(html).toContain('Not applied');
  });

  it('offers the create action only to someone who can manage', () => {
    expect(render(true)).toContain('New limit');
    const readOnly = render(false);
    expect(readOnly).not.toContain('New limit');
    expect(readOnly).toContain('View only');
  });

  it('explains an empty tenant and how to start', () => {
    stub([]);
    const html = render(true);
    expect(html).toContain('No limits yet');
    expect(html).toContain('New limit');
  });

  it('shows the load error without hiding the tab', () => {
    stub([], { error: 'Request failed (500)' });
    const html = render(true);
    expect(html).toContain('Limits could not be loaded');
    expect(html).toContain('Request failed (500)');
  });
});
