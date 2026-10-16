/**
 * Messages carry no plural rules. A message that can be shown for a count of one has a sibling `<key>One`, and this
 * picks it ("1 rule", "Assign incident"): English reads differently for one, so each such message has the two keys.
 * Turkish keeps the noun singular after any number, so its two keys often read the same.
 */
export function pluralKey(key: string, count: number): string {
  return count === 1 ? `${key}One` : key;
}
