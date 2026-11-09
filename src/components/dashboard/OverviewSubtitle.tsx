'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { DashboardDateFilterState } from '@/lib/utils/dashboardDateFilter';

/**
 * Name of the active project. Same request as the topbar's project switcher; `null` until it answers (or when it
 * fails).
 */
export function useActiveProjectName(): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/projects', { cache: 'no-store', signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { projects?: Array<{ _id: string; name: string }>; activeProjectId?: string } | null) => {
        const active = body?.projects?.find((project) => project._id === body.activeProjectId);
        if (!controller.signal.aborted) setName(active?.name ?? null);
      })
      .catch(() => {
        // The subtitle goes without the project name.
      });
    return () => controller.abort();
  }, []);
  return name;
}

function formatDay(date: Date | null, locale: string): string {
  return date ? date.toLocaleDateString(locale, { month: 'short', day: 'numeric' }) : '…';
}

/** What the page's numbers cover: "Customer Support · last 7 days". */
export function OverviewSubtitle({ dateFilter }: { dateFilter: DashboardDateFilterState }) {
  const t = useTranslations('dashboardOverview.home.scope');
  const locale = useLocale();
  const project = useActiveProjectName();
  const range =
    dateFilter.period === 'custom'
      ? t('custom', { from: formatDay(dateFilter.dateRange[0], locale), to: formatDay(dateFilter.dateRange[1], locale) })
      : t(dateFilter.period);
  return (
    <span data-testid="overview-scope">
      {project ? t('withProject', { project, range }) : range}
    </span>
  );
}
