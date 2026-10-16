/**
 * Breadcrumb plan of the IAM pages.
 *
 * The IAM center is one page with tabs: `/dashboard/iam/principals/<type>/<id>` is a person's
 * page, but the folders above it hold no page of their own. A plain path-segment trail would
 * link to them, so the IAM trail is planned here: IAM / People / <name> and IAM / Policies /
 * <name>, each crumb leading to a page that exists (People -> the principals tab narrowed to
 * that kind, or the very list view the person came from).
 *
 * Pure module (no React / Next imports).
 */

import { lastListUrlFor } from '../iam/principals/lastList';
import { IAM_PATH, isListType, policiesListHref, principalsListHref } from '../iam/links';

export type IamCrumbLabel = 'people' | 'groups' | 'tokens' | 'policies';

export interface CrumbPlanItem {
  /** The path segment this crumb stands for; its normal label (resolved name or id) is used unless `label` is set. */
  segmentIndex: number;
  label?: IamCrumbLabel;
  /** `null`: no link (the current page, or an address with no page). */
  href: string | null;
}

const TYPE_LABEL: Record<'user' | 'group' | 'token', IamCrumbLabel> = {
  user: 'people',
  group: 'groups',
  token: 'tokens',
};

/**
 * `segments` is the whole path split on `/` (`['dashboard', 'iam', ...]`).
 * Null when the path is not below the IAM center, so the generic trail applies.
 */
export function iamCrumbPlan(segments: string[], lastListUrl?: string | null): CrumbPlanItem[] | null {
  if (segments[0] !== 'dashboard' || segments[1] !== 'iam') return null;

  const plan: CrumbPlanItem[] = [{ segmentIndex: 0, href: '/dashboard' }];
  const rest = segments.slice(2);

  if (rest.length === 0) {
    plan.push({ segmentIndex: 1, href: null });
    return plan;
  }
  plan.push({ segmentIndex: 1, href: IAM_PATH });

  if (rest[0] === 'principals') {
    const type = rest[1];
    const known = isListType(type) ? type : null;
    const id = rest[2];
    const listHref = (known ? lastListUrlFor(known, lastListUrl) : null) ?? principalsListHref(known);
    // Index 2 ("principals") or 3 (the kind) names the People crumb; whichever is the page is the last.
    const peopleIndex = known ? 3 : 2;
    plan.push({
      segmentIndex: peopleIndex,
      label: known ? TYPE_LABEL[known] : 'people',
      href: id ? listHref : null,
    });
    if (id) plan.push({ segmentIndex: 4, href: null });
    return plan;
  }

  if (rest[0] === 'policies') {
    const id = rest[1];
    plan.push({ segmentIndex: 2, label: 'policies', href: id ? policiesListHref() : null });
    if (id) plan.push({ segmentIndex: 3, href: null });
    return plan;
  }

  // Any other IAM address: the trail of path segments, the last one without a link.
  for (let i = 2; i < segments.length; i++) {
    plan.push({
      segmentIndex: i,
      href: i === segments.length - 1 ? null : `/${segments.slice(0, i + 1).join('/')}`,
    });
  }
  return plan;
}

/**
 * Paths (relative to `dashboard`) that are folders without a page: a link to them is a 404.
 * The generic trail renders such a crumb as plain text.
 */
export const NO_PAGE_PATHS: ReadonlySet<string> = new Set([
  'analysis/definitions',
  'evaluations/targets',
  'evaluations/snapshots',
  'redteam/campaigns',
]);

export function hasNoPage(segments: string[], index: number): boolean {
  return NO_PAGE_PATHS.has(segments.slice(1, index + 1).join('/'));
}
