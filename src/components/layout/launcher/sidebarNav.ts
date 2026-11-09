/**
 * The single left menu: one labelled column in place of the icon rail and the second column with the pages of the
 * service in view. It lists the services the person can open, under the launcher's categories, and the service in
 * view opens its pages in place (the same entries, filtered the same way, as the sub-nav it replaces).
 *
 * SIDEBAR_NAV is the switch: `false` brings back the icon rail and the service sub-nav (SlimRail + ServiceSubNav),
 * which are kept unchanged.
 */

import {
  DASHBOARD_CATEGORY_LABELS,
  DASHBOARD_CATEGORY_ORDER,
  type DashboardServiceCategory,
  type DashboardServiceDefinition,
} from '@/lib/utils/dashboardServices';

export const SIDEBAR_NAV = true;

/**
 * The labelled menu's style (Sidebar.tsx): `drill` shows one level at a time — the services, then the pages of the one
 * chosen, with a way back; `tree` lists the services and opens the pages of the one in view under it.
 */
export type SidebarStyle = 'tree' | 'drill';

/** The menu goes step by step; `'tree'` brings back the nested style, which is kept. */
export const SIDEBAR_STYLE: SidebarStyle = 'drill';

/**
 * Someone who can open at most this many services gets one plain list without category headings (an enterprise user
 * typically sees three to five services).
 */
export const SIDEBAR_FLAT_MAX = 7;

/** The reports' summary; each report is under it (`/dashboard/analytics/<key>`). */
export const REPORTS_HREF = '/dashboard/analytics';

/**
 * A window this narrow (a tablet, a small laptop window) gets the icon-only menu by default: the labelled one takes
 * 248px and left the page about 550px at 820px. Phones (48em and below) have no side menu at all, only the top bar's
 * drawer.
 */
export const SIDEBAR_NARROW_QUERY = '(max-width: 62em)';

/** Category order in the menu: what is built, what it uses, how it runs. Any other category follows. */
const SIDEBAR_CATEGORY_ORDER: readonly DashboardServiceCategory[] = [
  'build',
  'data',
  'operate',
  ...DASHBOARD_CATEGORY_ORDER.filter((category) => !['build', 'data', 'operate'].includes(category)),
];

export interface SidebarGroup {
  category: DashboardServiceCategory;
  label: string;
  services: DashboardServiceDefinition[];
}

/** The services the menu lists: not the Settings pages (they sit under Settings) and not the services home. */
export function sidebarServices(
  services: readonly DashboardServiceDefinition[],
): DashboardServiceDefinition[] {
  return services.filter((service) => service.id !== 'services-home' && !service.isSettings);
}

/** The listed services by category, in the menu's order; a category with none of them is left out. */
export function sidebarGroups(services: readonly DashboardServiceDefinition[]): SidebarGroup[] {
  const listed = sidebarServices(services);
  return SIDEBAR_CATEGORY_ORDER.map((category) => ({
    category,
    label: DASHBOARD_CATEGORY_LABELS[category] ?? category,
    services: listed.filter((service) => service.category === category),
  })).filter((group) => group.services.length > 0);
}

/** Whether the menu is one plain list (few services) rather than categories. */
export function isFlatSidebar(services: readonly DashboardServiceDefinition[]): boolean {
  return sidebarServices(services).length <= SIDEBAR_FLAT_MAX;
}
