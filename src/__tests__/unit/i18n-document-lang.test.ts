// @vitest-environment jsdom
/**
 * The document's language follows the locale of the page. The root layout renders `<html lang>` before it
 * can know the locale, and the browser takes its text rules from that attribute: with lang="en", CSS
 * `text-transform: uppercase` turns Turkish "i" into "I" instead of "İ".
 */
import { act, createElement, type ComponentType, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import { installDomStubs, mount, type Mounted } from '../helpers/iamCenterUi';

/** `children` optional for createElement's typing (the component itself requires them). */
const Provider = I18nProvider as unknown as ComponentType<{ locale?: string; children?: ReactNode }>;

let mounted: Mounted | undefined;

beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.documentElement.removeAttribute('lang');
});

describe('<html lang>', () => {
  it('is Turkish under the Turkish locale, so uppercase and hyphenation follow Turkish rules', async () => {
    document.documentElement.lang = 'en'; // what the root layout renders
    mounted = await mount(createElement('p', null, 'yerleşik kural'), 'tr');
    expect(document.documentElement.lang).toBe('tr');
  });

  it('is English under the English locale', async () => {
    document.documentElement.lang = 'tr';
    mounted = await mount(createElement('p', null, 'built-in rule'), 'en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('follows the locale when it changes', async () => {
    mounted = await mount(createElement('p', null, 'x'), 'en');
    expect(document.documentElement.lang).toBe('en');
    await act(async () => {
      mounted!.root.render(createElement(Provider, { locale: 'tr' }, createElement('p', null, 'x')));
    });
    expect(document.documentElement.lang).toBe('tr');
  });
});
