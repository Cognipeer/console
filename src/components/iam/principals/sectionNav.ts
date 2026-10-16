/**
 * The jump bar of a person's page: which sections it offers, the address of each
 * (an `id` on the section frame) and which one the reader is in. Pure.
 */

export const PERSON_SECTIONS = ['profile', 'effective', 'groups', 'projects', 'policies', 'tokens', 'activity'] as const;
export type PersonSection = (typeof PERSON_SECTIONS)[number];

export const sectionAnchor = (section: string): string => `section-${section}`;

/**
 * The sections the page actually shows, in page order: the profile, the effective
 * permissions, groups (hidden for none), projects, policies, and the tokens (hidden
 * from a viewer who may not see them) and the activity.
 */
export function visibleSections(input: { hasGroups: boolean; hasTokens: boolean }): PersonSection[] {
  return PERSON_SECTIONS.filter((section) => {
    if (section === 'tokens') return input.hasTokens;
    if (section === 'groups') return input.hasGroups;
    return true;
  });
}

/**
 * The section the reader is in: the last one whose top edge has scrolled up to
 * `offset` (the bar's height plus a margin), the first one before any has.
 * `tops` are the sections' distances from the top of the viewport, in page order.
 */
export function activeSection<T extends string>(tops: ReadonlyArray<{ id: T; top: number }>, offset: number): T | null {
  if (tops.length === 0) return null;
  let current = tops[0]!.id;
  for (const entry of tops) {
    if (entry.top <= offset) current = entry.id;
    else break;
  }
  return current;
}
