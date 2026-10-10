// @vitest-environment jsdom
/**
 * The limit editor in Turkish: headings, labels, the summary pane and the
 * checklist are Turkish (they used to stay English), and the form is marked as
 * Turkish text so that the upper-cased labels keep their dots ("ÖNCELİK"). In
 * English nothing changes.
 */
import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installApiMock, installDomStubs, mount, q, qa, settle, text, type Mounted } from '../helpers/iamCenterUi';
import { QuotaPolicyModal } from '@/components/quota/QuotaPolicyModal';

beforeAll(() => installDomStubs());

// These render whole component trees (jsdom + Mantine); on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let mounted: Mounted;

afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
});

async function open(locale: string, props: Record<string, unknown> = {}) {
  installApiMock([
    ['GET', '/api/iam/principals', () => ({ items: [], nextCursor: null })],
    ['GET', '/api/resources/search', () => ({ items: [], total: 0 })],
  ]);
  mounted = await mount(
    createElement(QuotaPolicyModal, {
      opened: true,
      onClose: () => {},
      onSubmit: async () => {},
      defaultDomain: 'llm',
      projects: [{ value: 'p1', label: 'Retail (retail)' }],
      ...props,
    }),
    locale,
  );
  await settle(100);
}

describe('the limit editor in Turkish', () => {
  it('has Turkish headings, labels and descriptions', async () => {
    await open('tr');
    const t = text();
    for (const word of [
      'Kimlik', 'Kapsam', 'İstek hız limitleri', 'Etkinleştirme', 'Etiket', 'Açıklama', 'Öncelik', 'Servis', 'Aktif',
      'Bu kapsam için hız limitlerini, kaynak kotalarını ve bütçeleri yapılandırın.',
      'Kayan zaman pencerelerinde yapılabilecek istek sayısını sınırlayın.',
    ]) {
      expect(t, word).toContain(word);
    }
  });

  it('has a Turkish summary pane and checklist', async () => {
    await open('tr');
    const t = text();
    for (const word of ['Ön kontrol', 'Etiket girildi', 'Servis seçildi', 'Hedef geçerli', 'En az bir limit tanımlandı', 'İstek / dk (RPM)', 'Günlük $', 'etkin']) {
      expect(t, word).toContain(word);
    }
    expect(t).toMatch(/\d+ \/ \d+ hazır/);
  });

  it('shows none of the English the editor used to leave in', async () => {
    await open('tr');
    const t = text();
    for (const word of ['Identity', 'Pre-flight', 'Label set', 'Request RPM', 'Request rate limits', 'Activation', 'ready', 'Per minute', 'Daily Limit']) {
      expect(t, word).not.toContain(word);
    }
    expect(t).not.toMatch(/iamLimits\.|settings\.quotaSection/);
  });

  it('marks the form and its summary as Turkish, for the upper-cased labels', async () => {
    await open('tr');
    const labelled = qa('[lang="tr"]');
    expect(labelled.length).toBeGreaterThanOrEqual(2);
    // The labels (".form-field-label") and the summary headings (".form-summary-title") sit inside it.
    expect(q('.form-field-label')?.closest('[lang]')?.getAttribute('lang')).toBe('tr');
    expect(q('.form-summary-title')?.closest('[lang]')?.getAttribute('lang')).toBe('tr');
    // The wrapper takes no space of its own.
    for (const el of labelled) expect(el.style.display).toBe('contents');
  });

  it('is unchanged in English', async () => {
    await open('en');
    const t = text();
    for (const word of ['Identity', 'Pre-flight', 'Label set', 'Request RPM', 'Request rate limits', 'Activation', 'Per minute']) {
      expect(t, word).toContain(word);
    }
    expect(t).toMatch(/\d+ of \d+ ready/);
    expect(q('.form-field-label')?.closest('[lang]')?.getAttribute('lang')).toBe('en');
  });
});
