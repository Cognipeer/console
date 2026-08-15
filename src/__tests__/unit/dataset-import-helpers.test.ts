/**
 * Unit tests for the dataset-import wizard's pure helpers
 * (src/components/datasetImport/importHelpers.ts): byte formatting, UTF-8
 * sizing, truncation, RAW-preview content coercion, and the suggested
 * dataset name. No React/DOM involved.
 */

import { describe, expect, it } from 'vitest';
import {
  DATASET_IMPORT_FORMATS,
  MAX_IMPORT_BYTES,
  defaultDatasetName,
  formatBytes,
  isDatasetImportFormat,
  messageText,
  toShortDate,
  truncateText,
  utf8ByteLength,
} from '@/components/datasetImport/importHelpers';

describe('formatBytes', () => {
  it('renders sub-KB values in bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(842)).toBe('842 B');
  });

  it('renders KB/MB with one decimal below 100', () => {
    expect(formatBytes(1229)).toBe('1.2 KB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.0 MB');
  });

  it('drops the decimal at ≥ 100 in a unit', () => {
    expect(formatBytes(128 * 1024)).toBe('128 KB');
  });

  it('is defensive on garbage', () => {
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('utf8ByteLength', () => {
  it('counts multi-byte characters by encoded size', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('ağç')).toBe(5); // a=1, ğ=2, ç=2
  });

  it('agrees with the 10MB cap constant', () => {
    expect(MAX_IMPORT_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('truncateText', () => {
  it('collapses whitespace and leaves short text alone', () => {
    expect(truncateText('  a  b\n c ', 100)).toBe('a b c');
  });

  it('truncates with an ellipsis at the cap', () => {
    const out = truncateText('x'.repeat(150), 100);
    expect(out.length).toBe(100);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('messageText', () => {
  it('passes strings through and JSON-ifies structured content', () => {
    expect(messageText('hello')).toBe('hello');
    expect(messageText([{ type: 'text', text: 'hi' }])).toBe('[{"type":"text","text":"hi"}]');
    expect(messageText(null)).toBe('');
    expect(messageText(undefined)).toBe('');
  });
});

describe('isDatasetImportFormat', () => {
  it('accepts exactly the five pinned wire ids', () => {
    for (const id of DATASET_IMPORT_FORMATS) {
      expect(isDatasetImportFormat(id)).toBe(true);
    }
    expect(DATASET_IMPORT_FORMATS).toHaveLength(5);
    expect(isDatasetImportFormat('openai')).toBe(false);
    expect(isDatasetImportFormat(undefined)).toBe(false);
  });
});

describe('defaultDatasetName', () => {
  it('builds "import <format> <date>"', () => {
    const date = new Date(2026, 7, 14); // 2026-08-14 local
    expect(toShortDate(date)).toBe('2026-08-14');
    expect(defaultDatasetName('langfuse-generations', date)).toBe(
      'import langfuse-generations 2026-08-14',
    );
    expect(defaultDatasetName(null, date)).toBe('import data 2026-08-14');
  });
});
