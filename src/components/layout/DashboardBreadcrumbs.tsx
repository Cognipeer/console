'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Anchor, Breadcrumbs, Text } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';

const SEGMENT_KEYS: Record<string, string> = {
  dashboard: 'dashboard',
  tracing: 'tracing',
  sessions: 'sessions',
  agents: 'agents',
  settings: 'settings',
};

const formatSegment = (segment: string, translate: ReturnType<typeof useTranslations>): string => {
  const normalized = segment.toLowerCase();
  const translationKey = SEGMENT_KEYS[normalized];

  if (translationKey) {
    return translate(translationKey);
  }

  const decoded = decodeURIComponent(segment);
  return decoded
    .split('-')
    .filter((part) => part.trim().length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
};

export default function DashboardBreadcrumbs() {
  const pathname = usePathname();

  const t = useTranslations('breadcrumbs');

  const segments = useMemo(() => {
    if (!pathname) return [] as string[];
    return pathname.split('/').filter(Boolean);
  }, [pathname]);

  if (segments.length === 0 || segments[0] !== 'dashboard') {
    return null;
  }

  const items = segments.map((segment, index) => {
    const href = `/${segments.slice(0, index + 1).join('/')}`;
    const label = formatSegment(segment, t);
    const isLast = index === segments.length - 1;

    if (isLast) {
      return (
        <Text key={href} fw={600} c="dimmed" size="sm">
          {label}
        </Text>
      );
    }

    return (
      <Anchor
        key={href}
        component={Link}
        href={href}
        size="sm"
        c="blue"
        style={{ textTransform: 'none' }}
      >
        {label}
      </Anchor>
    );
  });

  return <Breadcrumbs separator="/">{items}</Breadcrumbs>;
}
