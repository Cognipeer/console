/**
 * The policy editor's action picker explains that levels add up in an allow rule: choosing Admin on a service shows
 * Write and Read as included (the server adds them when the rule is saved - policySpec.ts `withImpliedLevels`), a deny
 * rule shows nothing included, and the picker says which of the two it is. (createElement, not JSX: the suite only
 * collects `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { I18nProvider } from '@/lib/i18n';
import ActionMatrix from '@/components/iam/policies/ActionMatrix';
import { indexCatalog } from '@/components/iam/catalogModel';
import type { CatalogAction, IamCatalog } from '@/components/iam/api';
import type { IamLabels } from '@/components/iam/useIamLabels';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

(globalThis as { React?: typeof React }).React = React;

const render = (node: ReactNode, locale: 'en' | 'tr' = 'en') =>
  renderToStaticMarkup(h(MantineProvider, null, h(I18nProvider, { locale, children: node })));

const LEVELS = ['read', 'write', 'admin'] as const;
const group = (level: (typeof LEVELS)[number]): CatalogAction => ({
  id: level[0].toUpperCase() + level.slice(1), kind: 'group', level, labelKey: `iam.action.group.${level}`, labelParams: {},
});
const serviceAction = (service: string, level: (typeof LEVELS)[number]): CatalogAction => ({
  id: `${service}.${level}`, kind: 'service', level, service, labelKey: `iam.action.service.${level}`, labelParams: { service },
});

const catalog: IamCatalog = {
  services: [
    { id: 'webhooks', labelKey: 'x', adminService: true, label: 'Webhooks', category: 'admin' },
    { id: 'agents', labelKey: 'y', adminService: false, label: 'Agents', category: 'build' },
  ],
  actions: [...LEVELS.map(group), ...['webhooks', 'agents'].flatMap((service) => LEVELS.map((level) => serviceAction(service, level)))],
  resourceTypes: [],
  contextAttrs: [],
  channels: [],
};
const index = indexCatalog(catalog);
const labels = {
  level: (level: string) => ({ read: 'Read', write: 'Write', admin: 'Admin' }[level] ?? level),
  service: (id: string) => ({ webhooks: 'Webhooks', agents: 'Agents' }[id] ?? id),
  action: (id: string) => id,
  resourceType: (type: string) => type,
} as unknown as IamLabels;

const matrix = (props: { effect?: 'permit' | 'forbid'; value: string[] }, locale: 'en' | 'tr' = 'en') =>
  render(h(ActionMatrix, { catalog, index, labels, onChange: () => undefined, ...props }), locale);

/** The chips (<button>) of the row named `rowName`: label, pressed, and whether they are shown as included. */
function chipsOf(html: string, rowName: string) {
  // every row opens with its name: `<div class="…rowName…">Webhooks<small>…`; its chips follow, up to the next row
  const segment = html.split(/class="[^"]*rowName[^"]*"/).slice(1).find((part) => new RegExp(`^>(<strong>)?${rowName}`).test(part));
  if (!segment) throw new Error(`no row ${rowName}`);
  return [...segment.matchAll(/<button[^>]*class="[^"]*chip[^"]*"[^>]*>([^<]*)<\/button>/g)].map((m) => ({
    label: m[1],
    pressed: m[0].includes('aria-pressed="true"'),
    implied: m[0].includes('data-implied="true"'),
  }));
}

describe('the action picker of an allow rule', () => {
  it('shows Write and Read as included when Admin is chosen on a service - and only on that service', () => {
    const html = matrix({ value: ['webhooks.admin'] });
    expect(chipsOf(html, 'Webhooks')).toEqual([
      { label: 'Read', pressed: true, implied: true },
      { label: 'Write', pressed: true, implied: true },
      { label: 'Admin', pressed: true, implied: false },
    ]);
    expect(chipsOf(html, 'Agents').some((chip) => chip.pressed || chip.implied)).toBe(false);
  });

  it('shows Read as included when Write is chosen, and nothing for Read', () => {
    expect(chipsOf(matrix({ value: ['agents.write'] }), 'Agents').map((chip) => [chip.label, chip.pressed, chip.implied]))
      .toEqual([['Read', true, true], ['Write', true, false], ['Admin', false, false]]);
    expect(chipsOf(matrix({ value: ['agents.read'] }), 'Agents').filter((chip) => chip.implied)).toEqual([]);
  });

  it('adds up for the level shortcuts that span every service, too', () => {
    const html = matrix({ value: ['Admin'] });
    expect(chipsOf(html, 'Every service')).toEqual([
      { label: 'Read', pressed: true, implied: true },
      { label: 'Write', pressed: true, implied: true },
      { label: 'Admin', pressed: true, implied: false },
    ]);
  });

  it('an included chip is not a button to toggle: it is marked, not clickable, and says why', () => {
    const html = matrix({ value: ['webhooks.admin'] });
    const tag = (html.match(/<button[^>]*data-implied="true"[^>]*>/) ?? [''])[0];
    expect(tag).toMatch(/aria-disabled="true"/);
    expect(tag).toMatch(/tabindex="-1"/);
    expect(tag).toMatch(/title="Included in a higher level you chose"/);
  });

  it('says that levels add up', () => {
    expect(matrix({ value: [] })).toContain('Levels add up in an allow rule: Admin includes Write and Read');
    expect(matrix({ value: [] }, 'tr')).toContain('İzin kuralında seviyeler birikir');
  });
});

describe('the action picker of a deny rule', () => {
  it('shows nothing as included: a deny rule blocks exactly the levels it names', () => {
    const html = matrix({ effect: 'forbid', value: ['webhooks.admin', 'Write'] });
    expect(html).not.toContain('data-implied');
    expect(chipsOf(html, 'Webhooks').map((chip) => [chip.label, chip.pressed])).toEqual([['Read', false], ['Write', false], ['Admin', true]]);
  });

  it('says so', () => {
    expect(matrix({ effect: 'forbid', value: [] })).toContain('A deny rule blocks only the levels you choose');
    expect(matrix({ effect: 'forbid', value: [] }, 'tr')).toContain('Engelleme kuralı yalnızca seçtiğiniz seviyeleri engeller');
  });
});

describe('the strings', () => {
  it('exist in English and Turkish, with no placeholders to fill', () => {
    for (const messages of [en, tr]) {
      const matrixStrings = (messages as unknown as { iamCenter: { matrix: Record<string, string> } }).iamCenter.matrix;
      for (const key of ['levelsHintAllow', 'levelsHintDeny', 'includedChip']) {
        expect(typeof matrixStrings[key], key).toBe('string');
        expect(matrixStrings[key].length, key).toBeGreaterThan(10);
        expect(matrixStrings[key], key).not.toMatch(/\{/);
      }
    }
    expect(tr.iamCenter.matrix.levelsHintAllow).not.toBe(en.iamCenter.matrix.levelsHintAllow);
  });
});
