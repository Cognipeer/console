'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { IconLayoutDashboard, IconSearch } from '@tabler/icons-react';
import { Spotlight, spotlight, SpotlightActionData } from '@mantine/spotlight';
import { useTranslations } from '@/lib/i18n';
import { getDashboardServices } from '@/lib/utils/dashboardServices';

interface GlobalSearchProps {
  isTenantAdmin?: boolean;
}

export function GlobalSearch({ isTenantAdmin = false }: GlobalSearchProps) {
  const router = useRouter();
  const tNav = useTranslations('navigation');
  const [query, setQuery] = useState('');

  const allActions: SpotlightActionData[] = useMemo(
    () => [
      {
        id: 'overview',
        label: tNav('dashboardOverview'),
        description: tNav('dashboardOverviewDescription') || 'View dashboard overview and stats',
        onClick: () => router.push('/dashboard/overview'),
        leftSection: <IconLayoutDashboard size={20} stroke={1.5} />,
        keywords: ['dashboard', 'overview', 'home', 'ana sayfa'],
      },
      ...getDashboardServices({ isTenantAdmin }).map((service) => ({
        id: service.id,
        label: tNav(service.navLabelKey),
        description: tNav(service.navDescriptionKey),
        onClick: () => router.push(service.href),
        leftSection: <service.icon size={20} stroke={1.5} />,
        keywords: service.searchKeywords,
      })),
    ],
    [router, tNav, isTenantAdmin],
  );

  const filteredActions = useMemo(() => {
    if (!query.trim()) return allActions;

    const lowerQuery = query.toLowerCase().trim();
    return allActions.filter((action) => {
      const labelMatch = action.label?.toLowerCase().includes(lowerQuery);
      const descMatch =
        typeof action.description === 'string' &&
        action.description.toLowerCase().includes(lowerQuery);
      const keywords = action.keywords;
      const keywordMatch =
        keywords &&
        Array.isArray(keywords) &&
        keywords.some((kw: string) => kw.toLowerCase().includes(lowerQuery));
      return labelMatch || descMatch || keywordMatch;
    });
  }, [allActions, query]);

  return (
    <Spotlight
      query={query}
      onQueryChange={setQuery}
      actions={filteredActions}
      nothingFound="Nothing found..."
      highlightQuery
      shortcut={['mod + K', '/']}
      searchProps={{
        leftSection: <IconSearch size={20} stroke={1.5} />,
        placeholder: tNav('globalSearchPlaceholder'),
      }}
    />
  );
}

export function openGlobalSearch() {
  spotlight.open();
}
