/**
 * The mark in a service's swatch: the catalog entry's own `glyph` (one to three characters, "S3") when it has one,
 * otherwise the first letter of its name. The schema of the catalog file and the code agree on the limit.
 */
import { describe, expect, it } from 'vitest';
import schema from '@/config/service-catalog.schema.json';
import {
  MAX_SERVICE_GLYPH_LENGTH,
  SERVICE_CATALOG,
  serviceGlyph,
  serviceGlyphFontSize,
  type ServiceCatalogEntry,
} from '@/lib/services/serviceCatalog';

const entry = (overrides: Partial<ServiceCatalogEntry> = {}): ServiceCatalogEntry => ({
  id: 'sample',
  driver: 'sample',
  name: 'Sample Storage',
  tagline: 'tagline',
  description: 'description',
  domains: ['file'],
  color: '#112233',
  tags: [],
  aliases: [],
  ...overrides,
});

const characters = (value: string) => Array.from(value).length;

describe('serviceGlyph', () => {
  it('is the first letter of the name, upper-cased, when the entry has no glyph', () => {
    expect(serviceGlyph(entry({ name: 'sample storage' }))).toBe('S');
    expect(serviceGlyph(entry({ name: 'Amazon S3' }))).toBe('A');
  });

  it('skips leading characters that are not letters or digits', () => {
    expect(serviceGlyph(entry({ name: '  (beta) Store' }))).toBe('B');
  });

  it('is the entry\'s own glyph when it has one, as written', () => {
    expect(serviceGlyph(entry({ glyph: 'S3' }))).toBe('S3');
    expect(serviceGlyph(entry({ glyph: 'AB' }))).toBe('AB');
    expect(serviceGlyph(entry({ glyph: 'S3C' }))).toBe('S3C');
    expect(serviceGlyph(entry({ glyph: 'x' }))).toBe('x');
  });

  it('trims the glyph, and a glyph that is blank counts as none', () => {
    expect(serviceGlyph(entry({ glyph: '  S3 ' }))).toBe('S3');
    expect(serviceGlyph(entry({ glyph: '' }))).toBe('S');
    expect(serviceGlyph(entry({ glyph: '   ' }))).toBe('S');
  });

  it('never shows more than three characters, counting characters and not UTF-16 units', () => {
    expect(serviceGlyph(entry({ glyph: 'ABCDE' }))).toBe('ABC');
    expect(characters(serviceGlyph(entry({ glyph: '☁️☁️☁️☁️' })))).toBeLessThanOrEqual(MAX_SERVICE_GLYPH_LENGTH);
    // an astral character is one character, not a split surrogate pair
    expect(serviceGlyph(entry({ glyph: '𝔸𝔹' }))).toBe('𝔸𝔹');
  });
});

describe('serviceGlyphFontSize', () => {
  it('keeps the size sized for one letter, and scales a longer mark down so it fits the swatch', () => {
    expect(serviceGlyphFontSize('S', 15)).toBe(15);
    expect(serviceGlyphFontSize('', 15)).toBe(15);
    expect(serviceGlyphFontSize('S3', 15)).toBe(12.8);
    expect(serviceGlyphFontSize('S3C', 15)).toBe(10.5);
    expect(serviceGlyphFontSize('S3C', 20)).toBe(14);
    expect(serviceGlyphFontSize('S3', 12.5)).toBe(10.6);
  });

  it('the longer the mark the smaller, never larger than the base', () => {
    for (const base of [12.5, 15, 16, 20]) {
      const sizes = ['S', 'S3', 'S3C'].map((glyph) => serviceGlyphFontSize(glyph, base));
      expect(sizes[0]).toBe(base);
      expect(sizes[1]).toBeLessThan(sizes[0]!);
      expect(sizes[2]).toBeLessThan(sizes[1]!);
    }
  });
});

describe('the catalog', () => {
  it('declares glyphs of one to three characters only', () => {
    const bad = SERVICE_CATALOG.filter((service) => service.glyph !== undefined)
      .filter((service) => characters(service.glyph!) < 1 || characters(service.glyph!) > MAX_SERVICE_GLYPH_LENGTH)
      .map((service) => `${service.id}: "${service.glyph}"`);
    expect(bad).toEqual([]);
  });

  it('shows what the entry declares - and the first letter for the entries that declare nothing', () => {
    for (const service of SERVICE_CATALOG) {
      const shown = serviceGlyph(service);
      expect(characters(shown), service.id).toBeGreaterThanOrEqual(1);
      expect(characters(shown), service.id).toBeLessThanOrEqual(MAX_SERVICE_GLYPH_LENGTH);
      if (service.glyph) expect(shown, service.id).toBe(service.glyph.trim());
      else expect(shown, service.id).toBe(service.name.replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase());
    }
  });

  it('the schema of the file allows the property, with the same limit as the code', () => {
    const service = (schema as { definitions: { service: { properties: Record<string, Record<string, unknown>>; required: string[] } } })
      .definitions.service;
    expect(service.properties.glyph).toMatchObject({ type: 'string', minLength: 1, maxLength: MAX_SERVICE_GLYPH_LENGTH });
    // optional: entries without one stay valid
    expect(service.required).not.toContain('glyph');
  });
});
