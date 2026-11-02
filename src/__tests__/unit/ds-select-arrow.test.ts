/**
 * The arrow of a native `<select className="ds-select">` (DataGrid filters, the Incidents toolbar, the model
 * playground…). The browser's own arrow sits against the right border whatever the padding, so the class hides it and
 * draws Mantine's Select chevron as an SVG data URI. A data URI cannot read a CSS variable: its colour is written out
 * in each theme block, and these tests keep it equal to that theme's --ds-text-muted and readable on the page.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(__dirname, '../../app/globals.css'), 'utf8');

/** Body of the first block that opens with `opening`. */
function block(opening: string): string {
  const open = css.indexOf(opening);
  expect(open, opening).toBeGreaterThanOrEqual(0);
  const start = css.indexOf('{', open);
  let depth = 0;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start + 1, i);
    }
  }
  throw new Error(`unclosed block: ${opening}`);
}

const hex = (body: string, token: string) => body.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})\\s*;`))?.[1]?.toLowerCase();
const arrowFill = (body: string) =>
  body.match(/--ds-select-chevron:\s*url\("data:image\/svg\+xml;utf8,[^"]*fill='%23([0-9a-fA-F]{6})'/)?.[1]?.toLowerCase();

function luminance(color: string): number {
  const n = parseInt(color.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('the arrow of a native .ds-select', () => {
  for (const [scheme, opening] of [
    ['light', ':root {'],
    ['dark', ":root[data-mantine-color-scheme='dark'] {"],
  ] as const) {
    it(`is drawn in --ds-text-muted and holds 3:1 on the page (${scheme})`, () => {
      const body = block(opening);
      const muted = hex(body, '--ds-text-muted');
      const page = hex(body, '--ds-surface-0');
      const fill = arrowFill(body);
      expect(muted, '--ds-text-muted').toBeDefined();
      expect(page, '--ds-surface-0').toBeDefined();
      expect(fill, '--ds-select-chevron fill').toBeDefined();
      expect(`#${fill}`).toBe(muted);
      expect(contrast(`#${fill}`, page!)).toBeGreaterThanOrEqual(3);
    });
  }

  it('replaces the browser arrow and keeps room for its own on the right', () => {
    const rule = block('.ds-select {');
    expect(rule).toMatch(/appearance:\s*none;/);
    expect(rule).toMatch(/background-image:\s*var\(--ds-select-chevron\);/);
    const [, right, left] = rule.match(/padding:\s*0\s+(\d+)px\s+0\s+(\d+)px;/) ?? [];
    expect(Number(right)).toBeGreaterThanOrEqual(26);
    expect(Number(left)).toBeLessThan(Number(right));
  });

  it('gives the arrow back to the system in forced colours, where an image keeps its own colour', () => {
    const media = block('@media (forced-colors: active) {');
    expect(media).toMatch(/\.ds-select\s*\{[^}]*appearance:\s*auto;[^}]*background-image:\s*none;/);
  });

  it('only tints the border on hover while the select is enabled', () => {
    expect(css).toContain('.ds-select:hover:not(:disabled)');
    expect(css).not.toMatch(/\.ds-select:hover\s*\{/);
  });
});
