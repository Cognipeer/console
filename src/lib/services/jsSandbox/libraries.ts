export interface JsSandboxLibraryDescriptor {
  key: string;
  label: string;
  description: string;
}

export const JS_SANDBOX_LIBRARY_DESCRIPTORS: JsSandboxLibraryDescriptor[] = [
  {
    key: 'std:collections',
    label: 'Collections',
    description: 'groupBy, countBy, uniqueBy and sortBy helpers.',
  },
  {
    key: 'std:math',
    label: 'Math',
    description: 'sum, avg, min, max and round helpers.',
  },
  {
    key: 'std:text',
    label: 'Text',
    description: 'slugify, truncate and compact whitespace helpers.',
  },
];

const ALLOWED_LIBRARY_KEYS = new Set(JS_SANDBOX_LIBRARY_DESCRIPTORS.map((library) => library.key));

export function normalizeSandboxLibraries(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => ALLOWED_LIBRARY_KEYS.has(item)),
    ),
  ];
}

export function buildLibraryBootstrap(libraries: string[]): string {
  const enabled = new Set(normalizeSandboxLibraries(libraries));
  const snippets: string[] = [
    'globalThis.libs = Object.create(null);',
  ];

  if (enabled.has('std:collections')) {
    snippets.push(`
      globalThis.libs.collections = Object.freeze({
        groupBy(items, selector) {
          const result = Object.create(null);
          for (const item of Array.isArray(items) ? items : []) {
            const key = typeof selector === 'function' ? selector(item) : item?.[selector];
            const bucket = String(key ?? '');
            if (!result[bucket]) result[bucket] = [];
            result[bucket].push(item);
          }
          return result;
        },
        countBy(items, selector) {
          const result = Object.create(null);
          for (const item of Array.isArray(items) ? items : []) {
            const key = typeof selector === 'function' ? selector(item) : item?.[selector];
            const bucket = String(key ?? '');
            result[bucket] = (result[bucket] ?? 0) + 1;
          }
          return result;
        },
        uniqueBy(items, selector) {
          const seen = new Set();
          const result = [];
          for (const item of Array.isArray(items) ? items : []) {
            const key = typeof selector === 'function' ? selector(item) : item?.[selector];
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(item);
          }
          return result;
        },
        sortBy(items, selector) {
          return [...(Array.isArray(items) ? items : [])].sort((left, right) => {
            const a = typeof selector === 'function' ? selector(left) : left?.[selector];
            const b = typeof selector === 'function' ? selector(right) : right?.[selector];
            return a < b ? -1 : a > b ? 1 : 0;
          });
        },
      });
    `);
  }

  if (enabled.has('std:math')) {
    snippets.push(`
      globalThis.libs.math = Object.freeze({
        sum(items, selector) {
          return (Array.isArray(items) ? items : []).reduce((total, item) => {
            const value = typeof selector === 'function' ? selector(item) : selector ? item?.[selector] : item;
            const numeric = Number(value);
            return Number.isFinite(numeric) ? total + numeric : total;
          }, 0);
        },
        avg(items, selector) {
          const values = (Array.isArray(items) ? items : [])
            .map((item) => Number(typeof selector === 'function' ? selector(item) : selector ? item?.[selector] : item))
            .filter((value) => Number.isFinite(value));
          return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
        },
        min(items, selector) {
          const values = (Array.isArray(items) ? items : [])
            .map((item) => Number(typeof selector === 'function' ? selector(item) : selector ? item?.[selector] : item))
            .filter((value) => Number.isFinite(value));
          return values.length ? Math.min(...values) : null;
        },
        max(items, selector) {
          const values = (Array.isArray(items) ? items : [])
            .map((item) => Number(typeof selector === 'function' ? selector(item) : selector ? item?.[selector] : item))
            .filter((value) => Number.isFinite(value));
          return values.length ? Math.max(...values) : null;
        },
        round(value, digits = 2) {
          const factor = 10 ** Number(digits || 0);
          return Math.round(Number(value) * factor) / factor;
        },
      });
    `);
  }

  if (enabled.has('std:text')) {
    snippets.push(`
      globalThis.libs.text = Object.freeze({
        compact(value) {
          return String(value ?? '').replace(/\\s+/g, ' ').trim();
        },
        slugify(value) {
          return String(value ?? '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        },
        truncate(value, max = 120) {
          const text = String(value ?? '');
          const limit = Math.max(Number(max) || 0, 0);
          return text.length > limit ? text.slice(0, limit) + '...' : text;
        },
      });
    `);
  }

  snippets.push('Object.freeze(globalThis.libs);');
  return snippets.join('\n');
}
