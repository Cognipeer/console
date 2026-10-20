// @vitest-environment jsdom
/**
 * The swatch of a service: the mark the catalog entry declares ("S3") where it has one, the first letter of the
 * name otherwise - on the cards of the Add Provider picker and in the header of the provider page. A mark longer
 * than one letter is set smaller so it fits.
 */
import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { click, installApiMock, installDomStubs, jsonResponse, mount, q, qa, settle, type Mounted } from '../helpers/iamCenterUi';
import ServiceCard from '@/components/common/ui/ServiceCard';
import ProviderDetailPage from '@/app/dashboard/providers/[providerId]/page';
import { findServiceById } from '@/lib/services/serviceCatalog';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ providerId: 'prov-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/providers/prov-1',
}));

// A small catalog: a two and a three character mark, a one character mark, and an entry without one.
vi.mock('@/config/service-catalog.json', () => ({
  default: {
    services: [
      {
        id: 'two', driver: 'two-files', name: 'Two Chars', tagline: 'Two Chars tagline', description: 'Two Chars description',
        domains: ['file'], color: '#112233', tags: [], aliases: [], glyph: 'S3',
      },
      {
        id: 'three', driver: 'three-files', name: 'Three Chars', tagline: 'Three Chars tagline', description: 'Three Chars description',
        domains: ['file'], color: '#112233', tags: [], aliases: [], glyph: 'S3C',
      },
      {
        id: 'one', driver: 'one-files', name: 'One Char', tagline: 'One Char tagline', description: 'One Char description',
        domains: ['file'], color: '#112233', tags: [], aliases: [], glyph: 'Z',
      },
      {
        id: 'plain', driver: 'plain-files', name: 'plain store', tagline: 'Plain tagline', description: 'Plain description',
        domains: ['file'], color: '#112233', tags: [], aliases: [],
      },
    ],
  },
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

const service = (id: string) => {
  const found = findServiceById(id);
  if (!found) throw new Error(`no service ${id}`);
  return found;
};
const swatch = () => q<HTMLElement>('.service-card-glyph')!;

describe('ServiceCard', () => {
  it('shows the mark the entry declares', async () => {
    mounted = await mount(createElement(ServiceCard, { service: service('two') }));
    expect(swatch().textContent).toBe('S3');
    await mounted.unmount();
    mounted = await mount(createElement(ServiceCard, { service: service('three') }));
    expect(swatch().textContent).toBe('S3C');
  });

  it('shows the first letter of the name when the entry declares none', async () => {
    mounted = await mount(createElement(ServiceCard, { service: service('plain') }));
    expect(swatch().textContent).toBe('P');
  });

  it('leaves a one-character mark at the size of the card, and scales a longer one down to fit the swatch', async () => {
    mounted = await mount(createElement(ServiceCard, { service: service('plain') }));
    expect(swatch().style.fontSize).toBe('');
    await mounted.unmount();

    mounted = await mount(createElement(ServiceCard, { service: service('one') }));
    expect(swatch().textContent).toBe('Z');
    expect(swatch().style.fontSize).toBe('');
    await mounted.unmount();

    mounted = await mount(createElement(ServiceCard, { service: service('two') }));
    expect(swatch().style.fontSize).toBe('12.8px');
    await mounted.unmount();

    mounted = await mount(createElement(ServiceCard, { service: service('three') }));
    expect(swatch().style.fontSize).toBe('10.5px');
  });

  it('scales from the smaller size of the compact card', async () => {
    mounted = await mount(createElement(ServiceCard, { service: service('three'), compact: true }));
    expect(q('.service-card')?.className).toContain('compact');
    expect(swatch().style.fontSize).toBe('8.8px');
  });

  it('keeps the brand colour and stays a button that picks the service', async () => {
    const onClick = vi.fn();
    mounted = await mount(createElement(ServiceCard, { service: service('two'), onClick }));
    expect(swatch().style.background).toBe('rgb(17, 34, 51)');
    await click(q('.service-card'));
    expect(onClick).toHaveBeenCalledWith(service('two'));
  });
});

// ── the provider page ───────────────────────────────────────────────────────────────────────────────────────────
describe('the header of the provider page', () => {
  const provider = (serviceCatalogId: string) => ({
    _id: 'prov-1',
    tenantId: 'tenant-1',
    key: 'files-main',
    type: 'file',
    driver: `${serviceCatalogId}-files`,
    label: 'Files main',
    status: 'active',
    settings: {},
    metadata: { serviceCatalogId },
    hasCredentials: true,
    lastTest: null,
  });

  async function showPage(serviceCatalogId: string) {
    installApiMock([
      ['GET', '/api/providers/prov-1', () => ({ provider: provider(serviceCatalogId) })],
      ['GET', '/api/providers/prov-1/usage', () => ({ projects: [] })],
    ]);
    mounted = await mount(createElement(ProviderDetailPage));
    await settle(80);
  }
  /** The coloured squares carrying the service mark: the header's and the Service card's. */
  const marks = () => qa<HTMLElement>('div').filter((d) => d.style.background !== '' && d.children.length === 0 && (d.textContent ?? '').length > 0 && d.style.fontWeight === '700');

  it('shows the declared mark, set smaller for a longer one, in the header and in the Service card', async () => {
    await showPage('three');
    const found = marks();
    expect(found.map((m) => m.textContent)).toEqual(['S3C', 'S3C']);
    // 48px header swatch at 20px, 40px Service card swatch at 16px
    expect(found.map((m) => m.style.fontSize)).toEqual(['14px', '11.2px']);
  });

  it('shows the first letter of the name at the full size when there is no mark', async () => {
    await showPage('plain');
    const found = marks();
    expect(found.map((m) => m.textContent)).toEqual(['P', 'P']);
    expect(found.map((m) => m.style.fontSize)).toEqual(['20px', '16px']);
  });

  it('still shows the page for a provider whose service is not in the catalog', async () => {
    installApiMock([
      ['GET', '/api/providers/prov-1', () => ({ provider: { ...provider('nope'), metadata: {}, driver: 'unknown-driver', key: 'x', label: 'Custom' } })],
      ['GET', '/api/providers/prov-1/usage', () => jsonResponse({ projects: [] })],
    ]);
    mounted = await mount(createElement(ProviderDetailPage));
    await settle(80);
    expect(q('h1')?.textContent).toBe('Custom');
    expect(marks()).toHaveLength(0);
  });
});

