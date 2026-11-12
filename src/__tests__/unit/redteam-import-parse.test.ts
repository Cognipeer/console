/**
 * Unit tests — probe import file parsing (CSV, JSONL, JSON, YAML) and hashText.
 * Fixtures are tiny synthetic files with placeholder text.
 */

import { describe, it, expect } from 'vitest';
import { parseCsv, parseImportFile, hashText, ImportError } from '@/lib/services/redteam/import';
import { IMPORT_LIMITS } from '@/lib/services/redteam/limits';

describe('parseCsv', () => {
  it('reads plain rows with LF and CRLF', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a,b\r\n1,2\r\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  it('handles quotes, doubled quotes, commas and newlines inside quotes', () => {
    const rows = parseCsv('id,text\n1,"placeholder, with comma"\n2,"say ""hi"""\n3,"line one\nline two"\n');
    expect(rows[1]).toEqual(['1', 'placeholder, with comma']);
    expect(rows[2]).toEqual(['2', 'say "hi"']);
    expect(rows[3]).toEqual(['3', 'line one\nline two']);
  });

  it('strips a BOM and keeps empty cells', () => {
    expect(parseCsv('﻿a,b\n,x\n')).toEqual([['a', 'b'], ['', 'x']]);
  });

  it('refuses a quoted value that is never closed instead of swallowing the rows after it', () => {
    expect(() => parseCsv('a,b\n1,"oops\n2,3\n4,5\n')).toThrow(/starts in row 2 is never closed/);
    expect(() => parseImportFile('x.csv', 'a,b\n1,"oops\n2,3\n')).toThrow(ImportError);
  });

  it('is linear on a large input', () => {
    const big = `a,b\n${'placeholder request,"quoted ""text"""\n'.repeat(50_000)}`;
    const started = Date.now();
    expect(parseCsv(big).length).toBe(50_001);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('parseImportFile', () => {
  it('skips blank lines before the CSV header', () => {
    const t = parseImportFile('x.csv', '\n\r\n  \ngoal,target\nplaceholder request 1,ok\n');
    expect(t.columns).toEqual(['goal', 'target']);
    expect(t.rows).toEqual([{ goal: 'placeholder request 1', target: 'ok' }]);
  });

  it('reads a CSV into row objects with the header as columns', () => {
    const t = parseImportFile('x.csv', 'goal,target\nplaceholder request 1,ok\nplaceholder request 2,ok\n');
    expect(t.fileType).toBe('csv');
    expect(t.columns).toEqual(['goal', 'target']);
    expect(t.rows).toEqual([
      { goal: 'placeholder request 1', target: 'ok' },
      { goal: 'placeholder request 2', target: 'ok' },
    ]);
    expect(t.truncatedRows).toBe(0);
  });

  it('skips blank CSV lines and pads short rows', () => {
    const t = parseImportFile('x.csv', 'a,b\n\n1\n');
    expect(t.rows).toEqual([{ a: '1', b: '' }]);
  });

  it('reads JSONL and names a bad line', () => {
    const t = parseImportFile('x.jsonl', '{"text":"placeholder 1","label":1}\n\n{"text":"placeholder 2","label":0}\n');
    expect(t.fileType).toBe('jsonl');
    expect(t.rows).toHaveLength(2);
    expect(t.columns).toEqual(['text', 'label']);
    expect(() => parseImportFile('x.jsonl', '{"a":1}\n{oops}\n')).toThrow(/Line 2/);
  });

  it('reads a JSON array of objects, of strings and of string lists', () => {
    expect(parseImportFile('x.json', '[{"a":"1"},{"a":"2","b":"3"}]').columns).toEqual(['a', 'b']);
    expect(parseImportFile('x.json', '["one","two"]').rows).toEqual([{ prompt: 'one' }, { prompt: 'two' }]);
    expect(parseImportFile('x.json', '[["a","b"],"c"]').rows).toEqual([{ turns: ['a', 'b'] }, { prompt: 'c' }]);
  });

  it('keeps a JSON object as a document', () => {
    const t = parseImportFile('x.json', '{"payloads":["a"]}');
    expect(t.rows).toEqual([]);
    expect(t.document).toEqual({ payloads: ['a'] });
  });

  it('reads YAML, .yml and .prompt files', () => {
    expect(parseImportFile('x.yaml', '- prompt: one\n- prompt: two\n').rows).toHaveLength(2);
    expect(parseImportFile('x.yml', 'name: placeholder\nvalue: text\n').document).toEqual({ name: 'placeholder', value: 'text' });
    expect(parseImportFile('seed.prompt', 'dataset_name: x\nseeds:\n  - value: placeholder\n').fileType).toBe('yaml');
  });

  it('throws ImportError for empty, headerless, unsupported and invalid files', () => {
    expect(() => parseImportFile('x.csv', '')).toThrow(ImportError);
    expect(() => parseImportFile('x.csv', '   \n')).toThrow(ImportError);
    expect(() => parseImportFile('x.csv', ',,\n1,2,3\n')).toThrow(/header/);
    expect(() => parseImportFile('x.csv', 'a,b\n')).toThrow(/no rows/);
    expect(() => parseImportFile('x.txt', 'hello')).toThrow(/Unsupported/);
    expect(() => parseImportFile('x.json', '{not json')).toThrow(/valid JSON/);
    expect(() => parseImportFile('x.json', '[]')).toThrow(/no rows/);
    expect(() => parseImportFile('x.json', '[1,2]')).toThrow(/item 1/);
    expect(() => parseImportFile('x.yaml', 'a: [unclosed')).toThrow(/valid YAML/);
  });

  it('rejects a file over the size limit', () => {
    const text = 'a'.repeat(IMPORT_LIMITS.maxFileBytes + 1);
    expect(() => parseImportFile('x.csv', text)).toThrow(/larger than/);
  });

  it('stops at maxRows and counts the rest', () => {
    const rows = IMPORT_LIMITS.maxRows + 7;
    const t = parseImportFile('x.csv', `p\n${'x\n'.repeat(rows)}`);
    expect(t.rows).toHaveLength(IMPORT_LIMITS.maxRows);
    expect(t.truncatedRows).toBe(7);
  });
});

describe('hashText', () => {
  it('is FNV-1a 32 bit, unsigned and stable', () => {
    expect(hashText('')).toBe(0x811c9dc5);
    expect(hashText('a')).toBe(0xe40c292c);
    expect(hashText('foobar')).toBe(0xbf9cf968);
    expect(hashText('some text')).toBe(hashText('some text'));
    expect(hashText('x')).toBeGreaterThanOrEqual(0);
  });
});
