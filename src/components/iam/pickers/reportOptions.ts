'use client';

import { useMemo } from 'react';
import { useTranslations } from '@/lib/i18n';
import type { IamCatalog, ResourceOption } from '../api';

export const REPORT_TYPE = 'report';
export const REPORT_GROUP_TYPE = 'report-group';
const REPORT_GROUP_ORDER = ['usage', 'quality', 'safety', 'infrastructure'] as const;

/**
 * The choices for a report or a report group: reports are code, not registry entries, so they come from the catalog
 * (`GET /api/iam/catalog`) instead of the registry search. `null` for any other type (the picker then searches the
 * registry). A report is named by its translated title, a group by its heading.
 */
export function useReportOptions(
  catalog: Pick<IamCatalog, 'reports'> | null | undefined,
  type: string | null,
): ResourceOption[] | null {
  const t = useTranslations('iamCenter');
  const tReports = useTranslations('analyticsDashboards');
  const reports = catalog?.reports;
  return useMemo(() => {
    if (type !== REPORT_TYPE && type !== REPORT_GROUP_TYPE) return null;
    const list = reports ?? [];
    if (type === REPORT_TYPE) {
      return list.map((report) => {
        // A missing message comes back as its own path: then the catalog's (English) title.
        const key = `dashboards.${report.key}.title`;
        const title = tReports(key);
        return {
          type,
          id: report.key,
          key: report.key,
          name: title === `analyticsDashboards.${key}` ? report.title : title,
          projectName: null,
        };
      });
    }
    const present = new Set(list.map((report) => report.group));
    return REPORT_GROUP_ORDER.filter((group) => present.has(group)).map((group) => ({
      type,
      id: group,
      key: null,
      name: t(`pickers.reportGroups.${group}`),
      projectName: null,
    }));
  }, [reports, type, t, tReports]);
}
