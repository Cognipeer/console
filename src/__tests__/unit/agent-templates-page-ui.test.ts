// @vitest-environment jsdom
/**
 * The templates gallery reads through React Query: its loading state, the cards, and a failed load with a retry that
 * asks again. (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import { createElement as h } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AGENT_TEMPLATES } from '@/lib/services/agents/templates/catalog';
import {
  buttonByText,
  click,
  installApiMock,
  installDomStubs,
  jsonResponse,
  settle,
  text,
  type Mounted,
} from '../helpers/iamCenterUi';
import { renderWithQuery } from '../helpers/renderWithQuery';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/agents/templates',
}));

import AgentTemplatesPage from '@/components/agents/templates/AgentTemplatesPage';

beforeAll(() => installDomStubs());

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

const summary = (key: string) => {
  const found = AGENT_TEMPLATES.find((candidate) => candidate.key === key)!;
  return {
    key: found.key, version: found.version, category: found.category, icon: found.icon, featured: false,
    capabilities: found.capabilities, modelHint: found.modelHint, requires: found.requires, surfaces: found.surfaces,
    availability: { status: 'ready', items: [] },
  };
};

describe('AgentTemplatesPage', () => {
  it('shows the catalog the API sent, with its version', async () => {
    installApiMock([['GET', '/api/agents/templates', () => ({ templates: [summary('pr-reviewer')], catalogVersion: 7 })]]);
    mounted = await renderWithQuery(h(AgentTemplatesPage));
    await settle(50);
    expect(text()).toContain('1 templates · catalog v7');
  });

  it('says the load failed, and Try again asks the server once more', async () => {
    let healthy = false;
    const api = installApiMock([[
      'GET', '/api/agents/templates',
      () => (healthy ? { templates: [summary('pr-reviewer')], catalogVersion: 2 } : jsonResponse({ error: 'denied' }, 403)),
    ]]);
    mounted = await renderWithQuery(h(AgentTemplatesPage));
    await settle(50);
    expect(text()).toContain('Could not load the templates');
    expect(api.to('GET', '/api/agents/templates')).toHaveLength(1);

    healthy = true;
    await click(buttonByText('Try again'));
    await settle(50);
    expect(api.to('GET', '/api/agents/templates')).toHaveLength(2);
    expect(text()).not.toContain('Could not load the templates');
    expect(text()).toContain('1 templates · catalog v2');
  });
});
