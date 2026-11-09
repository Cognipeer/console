'use client';

/**
 * The left menu's Reports entries: the summary, then every report the person may read, under its group's heading.
 *
 * The list is the reports API's (`GET /api/reports/dashboards`), which already leaves out what the person may not read
 * (each report's service, the active project, the tenant scope). The API is enterprise: in community it is missing and
 * without the license it answers 402 — then there are no entries and the menu has no Reports row.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  IconActivity,
  IconBolt,
  IconBook,
  IconBox,
  IconBroadcast,
  IconBrowser,
  IconChartBar,
  IconClipboardList,
  IconCoin,
  IconGauge,
  IconHeartbeat,
  IconLayoutGrid,
  IconListDetails,
  IconPlug,
  IconRobot,
  IconSearch,
  IconShield,
  IconSpider,
  IconTool,
  IconUsers,
  type Icon,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { SubNavItem } from './ServiceSubNav';
import { REPORTS_HREF } from './sidebarNav';

export type ReportGroup = 'usage' | 'quality' | 'safety' | 'infrastructure';

/** One report as the reports API lists it (the fields the menu reads). */
export interface ListedReport {
  key: string;
  title: string;
  icon?: string;
  /** The heading it sits under; a report without one (the summary's own data) is not listed. */
  group?: ReportGroup | null;
}

const GROUP_ORDER: ReportGroup[] = ['usage', 'quality', 'safety', 'infrastructure'];

/** `navigation` message keys of the group headings. */
export const REPORT_GROUP_HEADING: Record<ReportGroup, string> = {
  usage: 'reportsGroupUsage',
  quality: 'reportsGroupQuality',
  safety: 'reportsGroupSafety',
  infrastructure: 'reportsGroupInfrastructure',
};

/** The report configs' icon names (the reports API sends the name, not the icon). */
const REPORT_ICONS: Record<string, Icon> = {
  activity: IconActivity,
  bolt: IconBolt,
  book: IconBook,
  box: IconBox,
  broadcast: IconBroadcast,
  browser: IconBrowser,
  clipboard: IconClipboardList,
  coin: IconCoin,
  gauge: IconGauge,
  heartbeat: IconHeartbeat,
  list: IconListDetails,
  plug: IconPlug,
  robot: IconRobot,
  search: IconSearch,
  shield: IconShield,
  spider: IconSpider,
  tool: IconTool,
  users: IconUsers,
};

/**
 * The menu entries for a list of reports: the summary first, then the reports group by group (Usage & cost, Quality &
 * reliability, Safety & compliance, Infrastructure), each group under its heading. A list from an older reports API,
 * with no groups at all, is shown as it comes, without headings. No report: no entries.
 */
export function reportsNavItems(reports: ListedReport[], labelFor: (report: ListedReport) => string): SubNavItem[] {
  if (reports.length === 0) return [];
  const grouped = reports.some((report) => report.group);
  const ordered: Array<{ report: ListedReport; heading?: string }> = grouped
    ? GROUP_ORDER.flatMap((group) =>
        reports
          .filter((report) => report.group === group)
          .map((report, index) => ({ report, heading: index === 0 ? REPORT_GROUP_HEADING[group] : undefined })),
      )
    : reports.filter((report) => report.key !== 'overview').map((report) => ({ report }));
  if (ordered.length === 0) return [];
  const summary: SubNavItem = {
    id: 'reports-summary',
    label: 'Summary',
    labelKey: 'reportsSummary',
    href: REPORTS_HREF,
    icon: IconLayoutGrid,
    matcher: (pathname) => pathname === REPORTS_HREF,
  };
  return [
    summary,
    ...ordered.map(({ report, heading }) => {
      const href = `${REPORTS_HREF}/${encodeURIComponent(report.key)}`;
      return {
        id: `report-${report.key}`,
        label: labelFor(report),
        sectionKey: heading,
        href,
        icon: (report.icon && REPORT_ICONS[report.icon]) || IconChartBar,
        matcher: (pathname: string) => pathname === href || pathname.startsWith(`${href}/`),
      } satisfies SubNavItem;
    }),
  ];
}

/** Whether a page is one of the reports (the summary or a report). */
export function isReportsPath(pathname: string): boolean {
  return pathname === REPORTS_HREF || pathname.startsWith(`${REPORTS_HREF}/`);
}

/**
 * The Reports entries for the person, read once per page load (switching project reloads the page). `enabled` false
 * (the old rail, which has no Reports row) asks nothing.
 */
export function useReportsNav(enabled: boolean): SubNavItem[] {
  const tReports = useTranslations('analyticsDashboards');
  const [reports, setReports] = useState<ListedReport[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch('/api/reports/dashboards', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { dashboards?: ListedReport[] } | null) => {
        if (!cancelled && Array.isArray(body?.dashboards)) setReports(body.dashboards);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return useMemo(
    () =>
      reportsNavItems(reports, (report) => {
        // A missing message comes back as its own path: then the API's (English) title.
        const key = `dashboards.${report.key}.title`;
        const message = tReports(key);
        return message === `analyticsDashboards.${key}` ? report.title : message;
      }),
    [reports, tReports],
  );
}
