/**
 * PII detector core.
 *
 * Pure functions — no I/O, no DB access. Given a text and a (built-in + custom)
 * pattern set, return an array of findings, applying:
 *   - regex matching with global semantics
 *   - optional value validation (Luhn, TC kimlik checksum, phone length, …)
 *   - overlap resolution: when two patterns match overlapping ranges, prefer
 *     the higher-severity finding; ties broken by longer match
 *   - replacement string generation via the category's mask strategy
 */

import type { PiiLanguage, IPiiCustomPattern } from '@/lib/database';
import type { PiiFinding } from './types';
import {
  PII_CATEGORIES,
  PII_CATEGORIES_BY_ID,
  filterCategoriesByLanguages,
  categoryLabel,
  type PiiCategoryDefinition,
  type PiiMaskStrategy,
  type PiiSeverity,
} from './categories';

const SEVERITY_WEIGHT: Record<PiiSeverity, number> = { low: 1, medium: 2, high: 3 };

/** Configuration consumed by `detect()`. */
export interface DetectorConfig {
  /** Categories enabled: { [categoryId]: true|false }. If omitted, the
   *  `defaultEnabled` flag from the catalog is used. */
  categories?: Record<string, boolean>;
  /** Tenant-defined custom patterns. */
  customPatterns?: IPiiCustomPattern[];
  /** Restrict to these languages. ['global'] always included. */
  languages?: PiiLanguage[];
  /** Locale for labels & messages. */
  locale?: PiiLanguage;
}

interface CompiledPattern {
  source: 'builtin' | 'custom';
  categoryId: string;
  severity: PiiSeverity;
  regex: RegExp;
  validate?: (value: string) => boolean;
  label: string;
  mask: PiiMaskStrategy;
}

function compileBuiltin(
  cat: PiiCategoryDefinition,
  locale: PiiLanguage,
): CompiledPattern {
  const flags = cat.pattern.flags.includes('g') ? cat.pattern.flags : `${cat.pattern.flags}g`;
  return {
    source: 'builtin',
    categoryId: cat.id,
    severity: cat.severity,
    regex: new RegExp(cat.pattern.source, flags),
    validate: cat.validate,
    label: categoryLabel(cat, locale),
    mask: cat.mask,
  };
}

function compileCustom(
  p: IPiiCustomPattern,
  locale: PiiLanguage,
): CompiledPattern | null {
  if (!p.enabled) return null;
  if (!p.pattern || typeof p.pattern !== 'string') return null;
  let regex: RegExp;
  try {
    const flags = (p.flags ?? '').includes('g') ? (p.flags ?? 'g') : `${p.flags ?? ''}g`;
    regex = new RegExp(p.pattern, flags);
  } catch {
    return null;
  }
  return {
    source: 'custom',
    categoryId: p.categoryId,
    severity: p.severity ?? 'medium',
    regex,
    label: p.labels?.[locale] ?? p.label,
    mask: { kind: 'fixed', replacement: `[REDACTED_${p.categoryId.toUpperCase()}]` },
  };
}

function customAppliesToLanguages(
  p: IPiiCustomPattern,
  langs: PiiLanguage[] | undefined,
): boolean {
  if (!p.languages || p.languages.length === 0) return true; // global
  if (!langs || langs.length === 0) return true;
  return p.languages.some((l) => langs.includes(l));
}

function pickActiveBuiltins(
  config: DetectorConfig,
): PiiCategoryDefinition[] {
  const langFiltered = filterCategoriesByLanguages(config.languages);
  if (!config.categories) {
    return langFiltered.filter((c) => c.defaultEnabled);
  }
  return langFiltered.filter((c) => config.categories?.[c.id] === true);
}

function buildReplacement(value: string, mask: PiiMaskStrategy, categoryId: string): string {
  switch (mask.kind) {
    case 'fixed':
      return mask.replacement;
    case 'keep-edges': {
      const fill = mask.fillChar ?? '*';
      if (value.length <= mask.head + mask.tail) return fill.repeat(value.length);
      const head = value.slice(0, mask.head);
      const tail = mask.tail > 0 ? value.slice(-mask.tail) : '';
      const middle = fill.repeat(Math.max(0, value.length - mask.head - mask.tail));
      return `${head}${middle}${tail}`;
    }
    case 'keep-last': {
      const fill = mask.fillChar ?? '*';
      if (value.length <= mask.tail) return fill.repeat(value.length);
      const tail = value.slice(-mask.tail);
      const middle = fill.repeat(value.length - mask.tail);
      return `${middle}${tail}`;
    }
    case 'keep-domain': {
      const at = value.indexOf('@');
      if (at <= 0) return `[REDACTED_${categoryId.toUpperCase()}]`;
      const local = value.slice(0, at);
      const domain = value.slice(at);
      const masked = local.length <= 1 ? '*' : `${local[0]}${'*'.repeat(Math.max(1, local.length - 1))}`;
      return `${masked}${domain}`;
    }
  }
}

function redactReplacement(categoryId: string): string {
  return `[REDACTED_${categoryId.toUpperCase()}]`;
}

/** Stable-sort findings: lower start first, longer-match wins ties. */
function sortFindings(findings: PiiFinding[]): PiiFinding[] {
  return findings.slice().sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return (b.end - b.start) - (a.end - a.start);
  });
}

/**
 * Drop overlapping findings: when two ranges overlap, keep the one with the
 * higher severity; break ties by length, then by source (builtin > custom).
 */
function resolveOverlaps(findings: PiiFinding[]): PiiFinding[] {
  if (findings.length <= 1) return findings;
  const sorted = sortFindings(findings);
  const out: PiiFinding[] = [];
  for (const f of sorted) {
    const last = out[out.length - 1];
    if (!last || f.start >= last.end) {
      out.push(f);
      continue;
    }
    const scoreA = SEVERITY_WEIGHT[last.severity] * 1000 + (last.end - last.start);
    const scoreB = SEVERITY_WEIGHT[f.severity] * 1000 + (f.end - f.start);
    if (scoreB > scoreA) {
      out[out.length - 1] = f;
    }
  }
  return out;
}

/**
 * Detect PII findings in `text` given the supplied config.
 *
 * `actionMode` controls the `replacement` field on each finding:
 *   - 'detect' or undefined → still computes a default replacement (mask preview)
 *   - 'redact' → replacement is a tag like [REDACTED_EMAIL]
 *   - 'mask' → replacement is the partial mask (j***@gmail.com)
 *
 * Use `applyReplacements(text, findings)` to materialize the output.
 */
export function detect(
  text: string,
  config: DetectorConfig = {},
  actionMode: 'detect' | 'redact' | 'mask' | 'block' = 'detect',
): PiiFinding[] {
  if (!text) return [];

  const locale: PiiLanguage = config.locale ?? 'en';
  const compiled: CompiledPattern[] = [];

  // Built-ins
  for (const cat of pickActiveBuiltins(config)) {
    compiled.push(compileBuiltin(cat, locale));
  }

  // Custom patterns
  for (const p of config.customPatterns ?? []) {
    if (!customAppliesToLanguages(p, config.languages)) continue;
    const c = compileCustom(p, locale);
    if (c) compiled.push(c);
  }

  const raw: PiiFinding[] = [];
  for (const c of compiled) {
    c.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = c.regex.exec(text)) !== null) {
      if (m[0].length === 0) {
        // safety against zero-width matches looping forever
        c.regex.lastIndex += 1;
        continue;
      }
      const value = m[0];
      if (c.validate && !c.validate(value)) continue;
      const start = m.index;
      const end = start + value.length;
      const replacement = actionMode === 'redact'
        ? redactReplacement(c.categoryId)
        : buildReplacement(value, c.mask, c.categoryId);
      raw.push({
        category: c.categoryId,
        source: c.source,
        severity: c.severity,
        value,
        start,
        end,
        label: c.label,
        message: formatMessage(c.label, locale),
        action: actionMode,
        block: actionMode === 'block',
        replacement,
      });
    }
  }

  return resolveOverlaps(raw);
}

const MESSAGE_TEMPLATES: Partial<Record<PiiLanguage, (label: string) => string>> = {
  en: (l) => `${l} detected`,
  tr: (l) => `${l} tespit edildi`,
  de: (l) => `${l} erkannt`,
  fr: (l) => `${l} détecté`,
  es: (l) => `${l} detectado`,
  it: (l) => `${l} rilevato`,
  pt: (l) => `${l} detectado`,
};

function formatMessage(label: string, locale: PiiLanguage): string {
  const fmt = MESSAGE_TEMPLATES[locale] ?? MESSAGE_TEMPLATES.en!;
  return fmt(label);
}

/**
 * Apply the findings' `replacement` field to the original text in a single
 * left-to-right pass. Findings must not overlap (use the output of `detect()`).
 */
export function applyReplacements(text: string, findings: PiiFinding[]): string {
  if (findings.length === 0) return text;
  const sorted = findings.slice().sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const f of sorted) {
    if (f.start < cursor) continue; // safety
    out += text.slice(cursor, f.start);
    out += f.replacement;
    cursor = f.end;
  }
  out += text.slice(cursor);
  return out;
}

/** Convenience: enumerate built-in catalog ids (used by API). */
export function builtinCategoryIds(): string[] {
  return PII_CATEGORIES.map((c) => c.id);
}

export { PII_CATEGORIES, PII_CATEGORIES_BY_ID };
