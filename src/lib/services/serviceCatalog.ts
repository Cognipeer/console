import catalogJson from '@/config/service-catalog.json';
import type { ProviderDomain } from '@/lib/database';

export interface ServiceCatalogEntry {
  id: string;
  /** Backend driver id this service maps to. */
  driver: string;
  name: string;
  tagline: string;
  description: string;
  domains: ProviderDomain[];
  /** Hex color for the brand swatch. */
  color: string;
  /** Optional 1-3 character mark for the swatch (e.g. "S3"); the first letter of the name when absent. */
  glyph?: string;
  /** Free-form tags (popular, managed, self-hosted, …). */
  tags: string[];
  /** Extra search terms / brand aliases. */
  aliases: string[];
}

const RAW = catalogJson as { services: ServiceCatalogEntry[] };

/** All entries from `service-catalog.json`. */
export const SERVICE_CATALOG: ServiceCatalogEntry[] = RAW.services;

/** Lookup by catalog id. */
const BY_ID = new Map<string, ServiceCatalogEntry>(
  SERVICE_CATALOG.map((s) => [s.id, s]),
);

/** Lookup by backend driver id. Returns first matching catalog entry. */
const BY_DRIVER = new Map<string, ServiceCatalogEntry[]>();
for (const s of SERVICE_CATALOG) {
  const list = BY_DRIVER.get(s.driver) ?? [];
  list.push(s);
  BY_DRIVER.set(s.driver, list);
}

export function findServiceById(id: string): ServiceCatalogEntry | undefined {
  return BY_ID.get(id);
}

function normalizeCatalogCandidate(value?: string): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  return trimmed.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function findServicesByDriver(driver: string): ServiceCatalogEntry[] {
  return BY_DRIVER.get(driver) ?? [];
}

function selectCanonicalDriverEntry(
  list: ServiceCatalogEntry[],
  driver: string,
  domain?: ProviderDomain,
): ServiceCatalogEntry | undefined {
  const domainMatches = domain
    ? list.filter((service) => service.domains.includes(domain))
    : list;

  if (domainMatches.length === 0) {
    return undefined;
  }

  return (
    domainMatches.find((service) => service.id === driver) ?? domainMatches[0]
  );
}

export function findServiceByDriver(
  driver: string,
  domain?: ProviderDomain,
): ServiceCatalogEntry | undefined {
  const list = BY_DRIVER.get(driver);
  if (!list || list.length === 0) return undefined;
  return (
    selectCanonicalDriverEntry(list, driver, domain) ??
    selectCanonicalDriverEntry(list, driver)
  );
}

export function resolveServiceCatalogEntry(options: {
  driver: string;
  domain?: ProviderDomain;
  serviceId?: string;
  key?: string;
  label?: string;
}): ServiceCatalogEntry | undefined {
  const candidates = [options.serviceId, options.key, options.label]
    .map((value) => normalizeCatalogCandidate(value))
    .filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const match = findServiceById(candidate);
    if (!match) {
      continue;
    }

    if (
      match.driver === options.driver &&
      (!options.domain || match.domains.includes(options.domain))
    ) {
      return match;
    }
  }

  return findServiceByDriver(options.driver, options.domain);
}

export interface ServiceCatalogFilter {
  domain?: ProviderDomain | 'all';
  query?: string;
  tag?: string;
}

/** Domain-aware filter + search across name/tagline/aliases. */
export function filterServiceCatalog(
  filter: ServiceCatalogFilter,
): ServiceCatalogEntry[] {
  const q = (filter.query ?? '').trim().toLowerCase();
  return SERVICE_CATALOG.filter((s) => {
    if (filter.domain && filter.domain !== 'all' && !s.domains.includes(filter.domain)) {
      return false;
    }
    if (filter.tag && !s.tags.includes(filter.tag)) return false;
    if (!q) return true;
    const haystack = [
      s.name,
      s.tagline,
      s.description,
      s.driver,
      ...s.aliases,
      ...s.tags,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

/** Distinct domain counts (used for filter chips). */
export function domainCounts(): Record<ProviderDomain | 'all', number> {
  const counts: Record<string, number> = { all: SERVICE_CATALOG.length };
  for (const s of SERVICE_CATALOG) {
    for (const d of s.domains) {
      counts[d] = (counts[d] ?? 0) + 1;
    }
  }
  return counts as Record<ProviderDomain | 'all', number>;
}

/** Human-readable label for a domain. */
export const DOMAIN_LABELS: Record<ProviderDomain, string> = {
  model: 'Model',
  embedding: 'Embedding',
  vector: 'Vector',
  file: 'File',
  datasource: 'Datasource',
  stt: 'Speech-to-Text',
  tts: 'Text-to-Speech',
  image: 'Image Generation',
  moderation: 'Moderation',
  decision: 'Decision',
  ocr: 'OCR',
  websearch: 'Web Search',
  telephony: 'Telephony',
};

/** The longest mark a catalog entry may declare (`glyph` in service-catalog.schema.json). */
export const MAX_SERVICE_GLYPH_LENGTH = 3;

/**
 * The mark of the service's swatch: the entry's own `glyph` (at most three characters) when it has one, otherwise
 * the first letter of its name.
 */
export function serviceGlyph(service: ServiceCatalogEntry): string {
  const declared = Array.from(service.glyph?.trim() ?? '')
    .slice(0, MAX_SERVICE_GLYPH_LENGTH)
    .join('');
  if (declared) return declared;
  return service.name
    .replace(/[^A-Za-z0-9]/g, '')
    .charAt(0)
    .toUpperCase();
}

/** A swatch sized for one letter, scaled down so a two or three character mark still fits it. */
export function serviceGlyphFontSize(glyph: string, baseSize: number): number {
  const length = Array.from(glyph).length;
  if (length <= 1) return baseSize;
  return Math.round(baseSize * (length === 2 ? 0.85 : 0.7) * 10) / 10;
}
