'use client';

/**
 * The behaviour every searchable picker of the quota editor shares, as props for
 * a Mantine `<Select searchable>`:
 *
 *  - typing into a box that holds a choice starts a FRESH search: the keyboard
 *    path selects the shown name first so the first character replaces it (and a
 *    paste does too); an edit that only appended to the name is repaired in
 *    `onSearchChange` (see `nextSearchBoxText`);
 *  - Enter picks the FIRST result, the best-ranked one, so
 *    "type, Enter" works without reaching for the arrow keys. While a search is
 *    still on its way, the Enter waits for its answer instead of picking from the
 *    stale list; once the answer is in, the first result is highlighted so the
 *    person sees what Enter will choose. A highlighted option (arrow keys) wins
 *    over all of this, and Enter with nothing typed does nothing special.
 *
 * Mantine keeps the highlighted option in the DOM (`data-combobox-selected`) and
 * its own store, which `Select` does not expose; so this reads the DOM (the
 * listbox is named by the input's `aria-controls`) and, to highlight, sends the
 * ArrowDown key the store already understands.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { isTextKey, nextSearchBoxText } from './searchBox';

/** An option a person can pick: not the "showing the first N" note. */
const PICKABLE = '[data-combobox-option]:not([data-combobox-disabled])';
const HIGHLIGHTED = '[data-combobox-selected]';

function listboxOf(input: HTMLElement): HTMLElement | null {
  const id = input.getAttribute('aria-controls');
  return id ? input.ownerDocument.getElementById(id) : null;
}

/** Clicks the first pickable option (Mantine's own submit path: closes the list, writes the name). */
function pickFirst(input: HTMLElement): boolean {
  const first = listboxOf(input)?.querySelector<HTMLElement>(PICKABLE);
  if (!first) return false;
  first.click();
  return true;
}

function highlightFirst(input: HTMLElement): void {
  const list = listboxOf(input);
  if (!list || list.querySelector(HIGHLIGHTED) || !list.querySelector(PICKABLE)) return;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true }));
}

export interface SearchBoxEnter {
  /** The list shows the answer to the typed words: no search is pending. */
  ready: boolean;
  /** Changes whenever a new answer arrives (the options array itself will do). */
  results: unknown;
}

export interface UseSearchBoxOptions {
  /** The name of the chosen option, which the box shows while nothing is being typed. */
  label: string | undefined;
  /** The value of the chosen option, as the `<Select>` holds it (to tell a pick of the same option from a pick of another). */
  value?: string | null;
  /** What the box shows before anything is known (a saved value that is still being looked up). */
  initialText?: string;
  /** Receives the question to ask on every change; `''` = no question (the list is the first page). */
  onQuery: (query: string) => void;
  /**
   * Makes Enter pick the first result. Leave out for a list that Mantine filters
   * itself (its `selectFirstOptionOnChange` does this for a synchronous list).
   */
  enter?: SearchBoxEnter;
}

export interface SearchBox {
  /** What the box shows. */
  text: string;
  /** Empties the box and the question (the picker is about a different kind of thing now). */
  reset: () => void;
  /** Spread on the `<Select>`. */
  props: {
    ref: RefObject<HTMLInputElement | null>;
    searchValue: string;
    onSearchChange: (text: string) => void;
    onOptionSubmit: (value: string) => void;
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
    onPaste: (event: ClipboardEvent<HTMLInputElement>) => void;
    /** Choosing the shown option again must not clear it: Enter on the first result could be the current choice. */
    allowDeselect: false;
  };
}

export function useSearchBox({ label, value, initialText = '', onQuery, enter }: UseSearchBoxOptions): SearchBox {
  const [text, setText] = useState(initialText);
  const inputRef = useRef<HTMLInputElement>(null);

  const labelRef = useRef(label);
  labelRef.current = label;
  const valueRef = useRef(value);
  valueRef.current = value;
  const onQueryRef = useRef(onQuery);
  onQueryRef.current = onQuery;
  const enterRef = useRef(enter);
  enterRef.current = enter;

  const showingLabel = useRef(label !== undefined && initialText === label);
  /** The words the person typed (what was last asked), for "is there anything to pick for". */
  const queryRef = useRef('');
  /** Enter was pressed while the search was still running: pick the first result when it answers. */
  const pendingEnter = useRef(false);

  const onSearchChange = useCallback((value: string) => {
    const next = nextSearchBoxText({ showingLabel: showingLabel.current }, value, labelRef.current);
    showingLabel.current = next.showingLabel;
    queryRef.current = next.query;
    pendingEnter.current = false;
    setText(next.typed);
    onQueryRef.current(next.query);
  }, []);

  // Choosing the option that is already chosen changes nothing, so Mantine never writes its name back into the
  // box: the words typed to find it would stay there. Put the name back.
  const onOptionSubmit = useCallback((submitted: string) => {
    const name = labelRef.current;
    if (name === undefined || submitted !== valueRef.current) return;
    showingLabel.current = true;
    queryRef.current = '';
    pendingEnter.current = false;
    setText(name);
    onQueryRef.current('');
  }, []);

  const reset = useCallback(() => {
    showingLabel.current = false;
    queryRef.current = '';
    pendingEnter.current = false;
    setText('');
    onQueryRef.current('');
  }, []);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const name = labelRef.current;

    if (isTextKey(event)) {
      // The box shows the chosen name untouched: select it so this character replaces it.
      if (name && input.value === name) input.select();
      return;
    }
    if (event.key === 'Escape') {
      pendingEnter.current = false;
      return;
    }
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || !enterRef.current) return;
    // Nothing typed: there is no "best match" to speak of.
    if (!queryRef.current.trim()) return;
    const list = listboxOf(input);
    // The list is closed, or an option is highlighted (Mantine submits that one).
    if (!list || list.querySelector(HIGHLIGHTED)) return;

    if (enterRef.current.ready) {
      if (pickFirst(input)) event.preventDefault();
    } else {
      pendingEnter.current = true;
      event.preventDefault();
    }
  }, []);

  const onPaste = useCallback((event: ClipboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    if (labelRef.current && input.value === labelRef.current) input.select();
  }, []);

  const ready = enter?.ready ?? false;
  const results = enter?.results;
  useEffect(() => {
    if (!ready) return;
    const input = inputRef.current;
    if (!input) return;
    if (pendingEnter.current) {
      pendingEnter.current = false;
      pickFirst(input);
      return;
    }
    if (queryRef.current.trim()) highlightFirst(input);
  }, [ready, results]);

  return {
    text,
    reset,
    props: { ref: inputRef, searchValue: text, onSearchChange, onOptionSubmit, onKeyDown, onPaste, allowDeselect: false },
  };
}
