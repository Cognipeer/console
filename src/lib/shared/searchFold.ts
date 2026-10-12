/**
 * Case folding for the search boxes, in English and Turkish.
 *
 * `toLowerCase()` is wrong for Turkish text in two ways. "İstanbul" becomes
 * "i̇stanbul" (a dotted i followed by a combining dot), which no typed
 * "istanbul" ever matches; and "ISPARTA" becomes "isparta" although the word is
 * "Isparta" = "ısparta" (dotless). `toLocaleLowerCase('tr')` fixes those, but
 * then "isparta" typed on an English keyboard no longer finds "Isparta", and a
 * server has no way to know which locale the person reading the list uses.
 *
 * So the four letters of the Turkish i family (I, İ, i, ı) meet at "i" here,
 * whatever the locale. Every other letter is folded with the plain Unicode
 * mapping, which already pairs Ş/ş, Ğ/ğ, Ü/ü, Ö/ö and Ç/ç. Accents are NOT
 * stripped ("sule" does not find "Şule"): that is what the directory searches
 * on the server do, and a list must not match differently from the search that
 * fed it.
 *
 * Free of React, Next and Node APIs: the browser (filters, pickers) and the
 * server (search ranking) fold the same way.
 */

/** Folds `value` for comparison; the result is only for matching, never for display. */
export function foldSearchText(value: string): string {
  return (
    value
      // Compose first: "İ" may arrive as "I" + U+0307 (a decomposed filename, a pasted string).
      .normalize('NFC')
      .replace(/[İIı]/g, 'i')
      .toLowerCase()
      // A lower-case dotted capital I is spelled "i" + U+0307 by some systems: that dot is not a different letter.
      .replace(/i̇/g, 'i')
  );
}

/**
 * Whether `haystack` contains `needle` once both are folded. A needle that is
 * empty (or only blanks) matches everything; a missing haystack matches nothing.
 */
export function includesFolded(haystack: string | null | undefined, needle: string): boolean {
  const wanted = foldSearchText(needle.trim());
  if (!wanted) return true;
  return haystack ? foldSearchText(haystack).includes(wanted) : false;
}

/**
 * A regular-expression source for a database that matches by pattern instead of
 * by folded text (MongoDB `$regex`): the typed words, escaped, with the letters
 * of the Turkish i family interchangeable. Used with the case-insensitive flag,
 * which already pairs Ş/ş, Ğ/ğ, Ü/ü, Ö/ö and Ç/ç but not İ, ı, I and i.
 *
 * (`foldSearchText` is for matching in JavaScript, and for SQLite through a
 * registered function; this is the same rule written as a pattern.)
 */
export function foldedRegexSource(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[İIıi]/g, '[iİıI]');
}
