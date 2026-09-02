/**
 * Bulk user import parsing.
 *
 * Every case here is a real export shape an admin will paste in — Active
 * Directory, Excel, a wiki table — and the failure mode when it is mishandled
 * is silent: a person imported under a mangled name, or a row that vanishes
 * without being reported.
 */
import { describe, expect, it } from 'vitest';
import { CsvImportError, MAX_BULK_IMPORT_ROWS, parseUserCsv } from '@/lib/services/users/csvImport';

describe('parseUserCsv', () => {
  it('reads a header, commas and a quoted name containing a comma', () => {
    const { rows, invalid } = parseUserCsv(
      'email,name\nayse@firma.com,"Yılmaz, Ayşe"\nmehmet@firma.com,Mehmet Demir\n',
    );
    expect(invalid).toEqual([]);
    expect(rows).toEqual([
      { name: 'Yılmaz, Ayşe', email: 'ayse@firma.com' },
      { name: 'Mehmet Demir', email: 'mehmet@firma.com' },
    ]);
  });

  it('accepts either column order', () => {
    expect(parseUserCsv('Ada Lovelace,ada@x.com').rows)
      .toEqual([{ name: 'Ada Lovelace', email: 'ada@x.com' }]);
    expect(parseUserCsv('ada@x.com,Ada Lovelace').rows)
      .toEqual([{ name: 'Ada Lovelace', email: 'ada@x.com' }]);
  });

  it('handles semicolon and tab exports', () => {
    expect(parseUserCsv('Grace Hopper;grace@x.com').rows)
      .toEqual([{ name: 'Grace Hopper', email: 'grace@x.com' }]);
    expect(parseUserCsv('alan@x.com\tAlan Turing').rows)
      .toEqual([{ name: 'Alan Turing', email: 'alan@x.com' }]);
  });

  it('names someone from a bare email list', () => {
    const { rows } = parseUserCsv('a@x.com\nb@x.com\n');
    expect(rows).toEqual([
      { name: 'a', email: 'a@x.com' },
      { name: 'b', email: 'b@x.com' },
    ]);
  });

  it('de-duplicates on email, case-insensitively', () => {
    expect(parseUserCsv('a@x.com,Ada\nA@X.COM,Ada again\n').rows).toHaveLength(1);
  });

  /**
   * A row that cannot be imported must come BACK. An admin who uploads 500
   * rows and reads "480 created" needs the other twenty, by name.
   */
  it('reports unusable rows instead of dropping them', () => {
    const { rows, invalid } = parseUserCsv('email,name\nok@x.com,Fine\n@@@\n');
    expect(rows).toHaveLength(1);
    expect(invalid).toEqual(['@@@']);
  });

  it('skips a header row without reporting it as broken', () => {
    const { rows, invalid } = parseUserCsv('name,email\nok@x.com,Fine\n');
    expect(rows).toHaveLength(1);
    expect(invalid).toEqual([]);
  });

  it('keeps a name-only row rather than refusing the file', () => {
    const { rows } = parseUserCsv('Ada Lovelace\n');
    expect(rows).toEqual([{ name: 'Ada Lovelace', email: undefined }]);
  });

  /**
   * The delimiter is a property of the FILE. Sniffing it per line by mere
   * presence split `"Smith; John",john@x.com` on the `;` inside the quotes and
   * imported a person called `Smith; John,john@x.com` with no email.
   */
  it('sniffs the delimiter once, ignoring separators inside quotes', () => {
    const { rows, invalid } = parseUserCsv(
      '"Smith; John",john@x.com\n"Doe, Jane",jane@x.com\n',
    );
    expect(invalid).toEqual([]);
    expect(rows).toEqual([
      { name: 'Smith; John', email: 'john@x.com' },
      { name: 'Doe, Jane', email: 'jane@x.com' },
    ]);
  });

  it('treats a header-like first line as a header even when the words are not exact', () => {
    const { rows } = parseUserCsv('Email Address,Display Name\nada@x.com,Ada Lovelace\n');
    expect(rows).toEqual([{ name: 'Ada Lovelace', email: 'ada@x.com' }]);
  });

  it('does not mistake a first-line person for a header', () => {
    // "İsmail" contains "mail"; "Ada" starts with "ad". Both are people.
    const { rows } = parseUserCsv('İsmail Kaya\nAda Lovelace\n');
    expect(rows.map((r) => r.name)).toEqual(['İsmail Kaya', 'Ada Lovelace']);
  });

  it('refuses a file past the row cap with the cap in the error', () => {
    const csv = ['a@x.com', 'b@x.com', 'c@x.com'].join('\n');
    expect(() => parseUserCsv(csv, { maxRows: 2 })).toThrow(CsvImportError);
    try {
      parseUserCsv(csv, { maxRows: 2 });
    } catch (error) {
      expect((error as CsvImportError).status).toBe(400);
      expect((error as CsvImportError).details).toEqual({ maxRows: 2 });
    }
    expect(MAX_BULK_IMPORT_ROWS).toBe(2000);
    // Rows the parser skips (duplicates, headers) do not count toward the cap.
    expect(parseUserCsv('email\na@x.com\nA@X.COM\nb@x.com', { maxRows: 2 }).rows).toHaveLength(2);
  });
});
