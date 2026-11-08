/**
 * Narrow windows, tablets and phones: nothing of the page header or the top bar may run past the right edge, where
 * it was cut off (the content area hides what sticks out sideways).
 * - Page header: its actions wrap at the header's width instead of staying on one line.
 * - Top bar: from 68em down, search and the services launcher keep only their icons, and the name and plan beside the
 *   avatar show from 75em; at about 820px the theme, docs and account buttons were past the edge. Phones keep their
 *   own bar.
 * - Detail pages: the shared detail header moves its actions under the title when they don't fit beside it, and the
 *   stacked columns of a detail page may be narrower than their longest unbreakable line.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h } from 'react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { PageHeader } from '@/components/common/ui/PageContainer';

(globalThis as { React?: typeof React }).React = React;

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('page header on a narrow screen', () => {
  it('lets its actions wrap at the width of the header', () => {
    const html = renderToStaticMarkup(h(PageHeader, { title: 'Agents', actions: h('button', null, 'New agent') }));
    expect(html).toContain('<div class="ds-row ds-gap-sm" style="flex-shrink:0;max-width:100%">');
    expect(read('src/app/globals.css')).toMatch(/\.ds-row \{[^}]*flex-wrap: wrap;/);
  });
});

describe('numbers and tables on a phone', () => {
  const css = read('src/app/globals.css');
  const phoneBlocks = css.split('@media (max-width: 48em)').slice(1).map((rest) => rest.slice(0, rest.indexOf('\n}\n')));

  it('puts two stat cards on a row instead of one', () => {
    const block = phoneBlocks.find((b) => b.includes('.ds-stat-grid'));
    expect(block).toMatch(/\.ds-stat-grid \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    // The line under the number wraps in a half-width card (it was cut at the card's edge).
    expect(block).toMatch(/\.ds-stat-delta \{\s*white-space: normal;/);
    // After the card rules, so its padding wins.
    expect(css.indexOf('.ds-stat-grid {\n    grid-template-columns: repeat(2')).toBeGreaterThan(css.indexOf('.ds-stat-spark {'));
  });

  it('keeps table columns readable and lets the table scroll, except the selection and action columns', () => {
    const block = phoneBlocks.find((b) => b.includes('.ds-tbl'));
    expect(block).toMatch(/\.ds-tbl th,\s*\.ds-tbl td \{\s*min-width: 5\.5rem;/);
    expect(block).toContain(".ds-tbl :is(th, td):has(> input[type='checkbox']:only-child)");
    expect(block).toContain('.ds-tbl :is(th, td):has(> .mantine-ActionIcon-root:only-child)');
    expect(css).toMatch(/\.ds-tbl-wrap \{ overflow-x: auto; \}/);
  });

  it('wraps a name beside its badges inside a narrow column (it ran under the next column)', () => {
    expect(css).toMatch(/\.ds-badge-cluster > \* \{\s*flex: 0 0 auto;/);
    expect(css).toMatch(/\.ds-badge-cluster > :not\(\.mantine-Badge-root\) \{\s*flex-shrink: 1;\s*min-width: 0;/);
  });
});

describe('full-screen forms on a phone', () => {
  const css = read('src/app/globals.css');
  const block = css.split('@media (max-width: 48em)').slice(1).map((rest) => rest.slice(0, rest.indexOf('\n}\n'))).find((b) => b.includes('.form-header'));

  it('lets the header grow with its subtitle and drops the Escape hint', () => {
    expect(css).toMatch(/\.form-header \{[^}]*height: 56px;/);
    expect(block).toMatch(/\.form-header \{\s*height: auto;\s*min-height: 56px;/);
    expect(block).toMatch(/\.form-header-hint \{\s*display: none;/);
    expect(block).toMatch(/\.form-header-sub \{[^}]*-webkit-line-clamp: 2;/);
  });

  it('wraps the footer and keeps its button labels whole', () => {
    expect(block).toMatch(/\.form-footer \{\s*flex-wrap: wrap;/);
    expect(css).toMatch(/\.form-footer > \.mantine-Button-root \{\s*flex-shrink: 0;/);
  });
});

describe('top bar between a phone and a wide screen', () => {
  const css = read('src/components/layout/launcher/LauncherShell.module.css');

  it('shows the name and plan beside the avatar from 75em only', () => {
    expect(css).toMatch(/@media \(min-width: 75em\) \{\s*\.accountInfo \{\s*display: flex;/);
    expect(css).not.toMatch(/@media \(min-width: 64em\) \{\s*\.accountInfo/);
  });

  it('keeps only the icons of search and the services launcher from 68em down', () => {
    const start = css.indexOf('@media (max-width: 68em)');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf('\n}\n', start));
    expect(block).toMatch(/\.searchBox \{[^}]*flex: 0 0 36px;[^}]*min-width: 0;/);
    expect(block).toMatch(/\.searchPlaceholder,\s*\.searchBox \.kbd \{\s*display: none;/);
    // The launcher's label only: the portal switcher shares the button style and keeps its text.
    expect(block).toMatch(/\.svcTrigger > \.dotGridSm \+ span \{\s*display: none;/);
  });

  it('leaves the phone bar as it was', () => {
    const phone = css.slice(css.indexOf('@media (max-width: 48em)'));
    expect(phone).toMatch(/\.searchBox \{\s*display: none;/);
    expect(phone).toMatch(/\.hamburgerBtn \{\s*display: inline-flex;/);
  });
});

describe('detail pages on a narrow screen', () => {
  const css = read('src/app/globals.css');

  it('moves the header actions under the title instead of squeezing the title to nothing', () => {
    expect(css).toMatch(/\.detail-header \{[^}]*flex-wrap: wrap;/);
    const shell = read('src/components/common/ui/DetailShell.tsx');
    expect(shell).toContain("<div style={{ flex: '1 1 220px', minWidth: 0 }}>");
    expect(shell).toContain(`<div className="ds-row ds-gap-sm" style={{ flexShrink: 0, maxWidth: '100%' }}>`);
  });

  it('stacks the columns of a detail page at the width of the screen, not of its widest line', () => {
    expect(css).toMatch(/\.ds-detail-grid \{\s*grid-template-columns: minmax\(0, 1fr\) !important;/);
  });

  it('lets the model page title block keep the header basis (no inline flex overriding it)', () => {
    const page = read('src/app/dashboard/models/[id]/page.tsx');
    const header = page.slice(page.indexOf('<header className="ds-page-header"'));
    expect(header.slice(0, 600)).toContain(`<div className="ds-row ds-gap-md" style={{ minWidth: 0 }}>`);
    expect(css).toMatch(/\.ds-page-header > :first-child \{ flex: 1 1 320px; min-width: 0; \}/);
  });
});
