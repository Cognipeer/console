/**
 * The text of a searchable picker, as plain functions (no React, no DOM), so the
 * rules are tested on their own; `useSearchBox` wires them to a Mantine Select.
 *
 * A Select that holds a choice shows the choice's NAME in its box. Mantine
 * writes that name into the box after a pick, on blur and when the choice is
 * resolved, and calls `onSearchChange` each time; none of those is a question
 * for the server. And when somebody then types into the box, the name must not
 * become the start of their question ("Alice" + "x" is not a search for
 * "Alicex"): typing starts a fresh search.
 */

export interface SearchBoxText {
  /** What the box shows. */
  typed: string;
  /** The question to ask: the words the person typed, never the name of the chosen option. */
  query: string;
  /** The box still shows the chosen option's name, as Mantine wrote it. */
  showingLabel: boolean;
}

/**
 * What a change of the box's text means.
 *
 *  - the text IS the chosen option's name: Mantine wrote it; nothing is asked;
 *  - the first edit after the name was shown only ADDED characters to it: the
 *    name goes and the added characters are the question (the keyboard path
 *    selects the name first, so this covers soft keyboards, drag-drop, scripts);
 *  - anything else is the person's own text and the question.
 */
export function nextSearchBoxText(
  current: Pick<SearchBoxText, 'showingLabel'>,
  text: string,
  label: string | undefined,
): SearchBoxText {
  if (label !== undefined && label !== '' && text === label) {
    return { typed: text, query: '', showingLabel: true };
  }
  if (label && current.showingLabel && text.length > label.length && text.startsWith(label)) {
    const fresh = text.slice(label.length);
    return { typed: fresh, query: fresh, showingLabel: false };
  }
  return { typed: text, query: text, showingLabel: false };
}

/**
 * Whether a key press adds text to the box (a letter, a digit, a space,
 * punctuation) as opposed to moving, deleting or being a shortcut. Composition
 * (an input method at work) is left alone.
 */
export function isTextKey(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  nativeEvent?: { isComposing?: boolean };
}): boolean {
  if (event.nativeEvent?.isComposing) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  // `key` is the character itself for text ("a", "İ", " ") and a word for everything else ("Enter", "ArrowDown").
  return event.key.length === 1;
}
