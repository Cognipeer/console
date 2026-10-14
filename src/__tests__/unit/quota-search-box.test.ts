/**
 * The text rules of the quota editor's searchable pickers (pure): what a change
 * of the box means once it holds a choice. The box shows the chosen NAME; the
 * name is never the start of a question.
 */
import { describe, expect, it } from 'vitest';
import { isTextKey, nextSearchBoxText } from '@/components/quota/searchBox';

describe('nextSearchBoxText', () => {
  it('asks the server whatever is typed while nothing is chosen', () => {
    expect(nextSearchBoxText({ showingLabel: false }, 'gp', undefined)).toEqual({ typed: 'gp', query: 'gp', showingLabel: false });
    expect(nextSearchBoxText({ showingLabel: false }, '', undefined)).toEqual({ typed: '', query: '', showingLabel: false });
  });

  it('asks nothing when the text IS the chosen name: Mantine wrote it after a pick, on blur or when it resolved', () => {
    expect(nextSearchBoxText({ showingLabel: false }, 'GPT-4o', 'GPT-4o')).toEqual({ typed: 'GPT-4o', query: '', showingLabel: true });
    expect(nextSearchBoxText({ showingLabel: true }, 'GPT-4o', 'GPT-4o')).toEqual({ typed: 'GPT-4o', query: '', showingLabel: true });
  });

  it('starts a fresh search when the first edit only added to the shown name', () => {
    expect(nextSearchBoxText({ showingLabel: true }, 'GPT-4ox', 'GPT-4o')).toEqual({ typed: 'x', query: 'x', showingLabel: false });
    expect(nextSearchBoxText({ showingLabel: true }, 'Alice Lee', 'Alice')).toEqual({ typed: ' Lee', query: ' Lee', showingLabel: false });
  });

  it('keeps what was typed after that first edit: it may happen to begin with the name', () => {
    // A name of one or two letters is easily typed again: only the FIRST edit is repaired.
    expect(nextSearchBoxText({ showingLabel: false }, 'QAB', 'QA')).toEqual({ typed: 'QAB', query: 'QAB', showingLabel: false });
  });

  it('treats an edit that cuts into the name as the person\'s own words', () => {
    expect(nextSearchBoxText({ showingLabel: true }, 'GPT-4', 'GPT-4o')).toEqual({ typed: 'GPT-4', query: 'GPT-4', showingLabel: false });
    expect(nextSearchBoxText({ showingLabel: true }, 'x', 'GPT-4o')).toEqual({ typed: 'x', query: 'x', showingLabel: false });
    expect(nextSearchBoxText({ showingLabel: true }, '', 'GPT-4o')).toEqual({ typed: '', query: '', showingLabel: false });
  });

  it('does not repair an edit when the box did not show the name untouched', () => {
    expect(nextSearchBoxText({ showingLabel: false }, 'GPT-4ox', 'GPT-4o')).toEqual({ typed: 'GPT-4ox', query: 'GPT-4ox', showingLabel: false });
  });

  it('has nothing to repair for an empty name', () => {
    expect(nextSearchBoxText({ showingLabel: true }, 'x', '')).toEqual({ typed: 'x', query: 'x', showingLabel: false });
  });
});

describe('isTextKey', () => {
  const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, ...extra });

  it('is true for characters, whatever the language', () => {
    for (const k of ['a', 'Z', '7', ' ', '-', 'ş', 'İ', 'ı']) expect(isTextKey(key(k)), k).toBe(true);
  });

  it('is false for keys that move, delete or submit', () => {
    for (const k of ['Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'Backspace', 'Delete', 'Tab', 'Shift', 'Control', 'Meta', 'F5']) {
      expect(isTextKey(key(k)), k).toBe(false);
    }
  });

  it('is false for shortcuts', () => {
    expect(isTextKey(key('a', { ctrlKey: true }))).toBe(false);
    expect(isTextKey(key('v', { metaKey: true }))).toBe(false);
    expect(isTextKey(key('a', { altKey: true }))).toBe(false);
  });

  it('is false while an input method is composing', () => {
    expect(isTextKey(key('a', { nativeEvent: { isComposing: true } }))).toBe(false);
    expect(isTextKey(key('a', { nativeEvent: { isComposing: false } }))).toBe(true);
  });
});
