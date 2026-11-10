// @vitest-environment jsdom
/**
 * The detail pages of platform records: a platform model's Pricing card shows its credit price (the Model Hub list
 * wording), never "0.00 USD/1M"; a platform provider shows no connection card, since it cannot be tested.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */
import { createElement as h } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DocsDrawerProvider } from '@/components/docs/DocsDrawerContext';
import ModelDetailPage from '@/app/dashboard/models/[id]/page';
import ProviderDetailPage from '@/app/dashboard/providers/[providerId]/page';
import { installApiMock, installDomStubs, mount, settle, text, type Mounted } from '../helpers/iamCenterUi';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: 'm1', providerId: 'prov-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard',
}));

let mounted: Mounted | undefined;

beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

const model = (extra: Record<string, unknown>) => ({
  _id: 'm1', key: 'fast', name: 'Fast model', providerKey: 'hosted', providerDriver: 'openai', category: 'llm',
  modelId: 'fast', settings: {}, pricing: { inputTokenPer1M: 0, outputTokenPer1M: 0, currency: 'USD' }, ...extra,
});

async function showModel(record: Record<string, unknown>, locale = 'en') {
  installApiMock([['GET', '/api/models/m1', () => ({ model: record })]]);
  mounted = await mount(h(DocsDrawerProvider, { value: { openDocs: vi.fn() }, children: h(ModelDetailPage) }), locale);
  await settle(80);
}

describe('the Pricing card of a model', () => {
  it('shows the credit price of a platform model, not USD', async () => {
    await showModel(model({ platform: true, credits: { perCall: 1 } }));
    expect(text()).toContain('1 credit / call');
    expect(text()).not.toContain('USD/1M');
  });

  it('shows the per-token credit price of a platform embedding model, in Turkish too', async () => {
    await showModel(model({ platform: true, category: 'embedding', credits: { perMillionTokens: 2 } }));
    expect(text()).toContain('2 credits / 1M tokens');
    await mounted!.unmount();
    await showModel(model({ platform: true, category: 'embedding', credits: { perMillionTokens: 2 } }), 'tr');
    expect(text()).toContain('2 kredi / 1M token');
  });

  it('keeps the USD prices of a model of the tenant', async () => {
    await showModel(model({ pricing: { inputTokenPer1M: 3, outputTokenPer1M: 6, currency: 'USD' } }));
    expect(text()).toContain('3.00 USD/1M');
  });
});

describe('the provider page', () => {
  const provider = (extra: Record<string, unknown>) => ({
    _id: 'prov-1', tenantId: 'tenant-1', key: 'hosted', type: 'model', driver: 'openai', label: 'Hosted',
    status: 'active', settings: {}, hasCredentials: true, lastTest: null, ...extra,
  });
  async function showProvider(record: Record<string, unknown>) {
    installApiMock([
      ['GET', '/api/providers/prov-1', () => ({ provider: record })],
      ['GET', '/api/providers/prov-1/usage', () => ({ projects: [] })],
    ]);
    mounted = await mount(h(ProviderDetailPage));
    await settle(80);
  }

  it('shows no connection card on a platform provider, which cannot be tested', async () => {
    await showProvider(provider({ platform: true }));
    expect(text()).toContain('Platform-managed provider');
    expect(text()).not.toContain('Never tested');
  });

  it('still shows it on a provider of the tenant', async () => {
    await showProvider(provider({}));
    expect(text()).toContain('Never tested');
  });
});
