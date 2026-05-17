'use client';

import { useRouter } from 'next/navigation';
import {
  IconAlertTriangle,
  IconArrowLeftRight,
  IconBell,
  IconBook,
  IconDatabase,
  IconExternalLink,
  IconFolder,
  IconHistory,
  IconLayoutDashboard,
  IconMessage,
  IconPin,
  IconPinFilled,
  IconServer,
  IconTimeline,
  IconUsers,
} from '@tabler/icons-react';
import { ActionIcon, Text, Tooltip } from '@mantine/core';
import type { DashboardServiceDefinition } from '@/lib/utils/dashboardServices';
import { useTranslations } from '@/lib/i18n';
import classes from './LauncherShell.module.css';

export interface SubNavItem {
  id: string;
  label: string;
  href: string;
  icon: typeof IconLayoutDashboard;
  badge?: number | string;
  matcher?: (pathname: string) => boolean;
}

export const SUBNAV_CONFIG: Record<string, SubNavItem[]> = {
  tracing: [
    {
      id: 'overview',
      label: 'Overview',
      href: '/dashboard/tracing',
      icon: IconLayoutDashboard,
      matcher: (p) =>
        p === '/dashboard/tracing' ||
        (p.startsWith('/dashboard/tracing') &&
          !p.startsWith('/dashboard/tracing/sessions') &&
          !p.startsWith('/dashboard/tracing/threads')),
    },
    {
      id: 'sessions',
      label: 'Sessions',
      href: '/dashboard/tracing/sessions',
      icon: IconTimeline,
      matcher: (p) => p.startsWith('/dashboard/tracing/sessions'),
    },
    {
      id: 'threads',
      label: 'Threads',
      href: '/dashboard/tracing/threads',
      icon: IconMessage,
      matcher: (p) => p.startsWith('/dashboard/tracing/threads'),
    },
  ],
  vector: [
    {
      id: 'indexes',
      label: 'Indexes',
      href: '/dashboard/vector',
      icon: IconDatabase,
      matcher: (p) =>
        p === '/dashboard/vector' ||
        (p.startsWith('/dashboard/vector/') &&
          !p.startsWith('/dashboard/vector/migrations')),
    },
    {
      id: 'migrations',
      label: 'Migrations',
      href: '/dashboard/vector/migrations',
      icon: IconArrowLeftRight,
      matcher: (p) => p.startsWith('/dashboard/vector/migrations'),
    },
  ],
  models: [
    {
      id: 'list',
      label: 'Endpoints',
      href: '/dashboard/models',
      icon: IconServer,
      matcher: (p) => p.startsWith('/dashboard/models'),
    },
  ],
  files: [
    {
      id: 'buckets',
      label: 'Buckets',
      href: '/dashboard/files',
      icon: IconFolder,
      matcher: (p) => p.startsWith('/dashboard/files'),
    },
  ],
  rag: [
    {
      id: 'overview',
      label: 'Knowledge bases',
      href: '/dashboard/rag',
      icon: IconBook,
      matcher: (p) => p.startsWith('/dashboard/rag'),
    },
  ],
  reranker: [
    {
      id: 'overview',
      label: 'Rerankers',
      href: '/dashboard/reranker',
      icon: IconBook,
      matcher: (p) => p.startsWith('/dashboard/reranker'),
    },
  ],
  agents: [
    {
      id: 'list',
      label: 'Agents',
      href: '/dashboard/agents',
      icon: IconLayoutDashboard,
      matcher: (p) => p.startsWith('/dashboard/agents'),
    },
  ],
  alerts: [
    {
      id: 'rules',
      label: 'Rules',
      href: '/dashboard/alerts',
      icon: IconBell,
      matcher: (p) =>
        p === '/dashboard/alerts' ||
        (p.startsWith('/dashboard/alerts') &&
          !p.startsWith('/dashboard/alerts/history') &&
          !p.startsWith('/dashboard/alerts/incidents')),
    },
    {
      id: 'incidents',
      label: 'Incidents',
      href: '/dashboard/alerts/incidents',
      icon: IconAlertTriangle,
      matcher: (p) => p.startsWith('/dashboard/alerts/incidents'),
    },
    {
      id: 'history',
      label: 'History',
      href: '/dashboard/alerts/history',
      icon: IconHistory,
      matcher: (p) => p.startsWith('/dashboard/alerts/history'),
    },
  ],
  cluster: [
    {
      id: 'nodes',
      label: 'Nodes',
      href: '/dashboard/cluster/nodes',
      icon: IconServer,
      matcher: (p) => p.startsWith('/dashboard/cluster/nodes'),
    },
    {
      id: 'instances',
      label: 'Instances',
      href: '/dashboard/cluster/instances',
      icon: IconDatabase,
      matcher: (p) => p.startsWith('/dashboard/cluster/instances'),
    },
  ],
  'tenant-settings': [
    {
      id: 'projects',
      label: 'Projects',
      href: '/dashboard/tenant-settings/projects',
      icon: IconFolder,
      matcher: (p) => p.startsWith('/dashboard/tenant-settings/projects'),
    },
    {
      id: 'members',
      label: 'Members',
      href: '/dashboard/members',
      icon: IconUsers,
      matcher: (p) => p.startsWith('/dashboard/members'),
    },
  ],
};

interface ServiceSubNavProps {
  service: DashboardServiceDefinition;
  pathname: string;
  isPinned: boolean;
  onTogglePin: () => void;
  onOpenDocs: () => void;
  items?: SubNavItem[];
}

export default function ServiceSubNav({
  service,
  pathname,
  isPinned,
  onTogglePin,
  onOpenDocs,
  items,
}: ServiceSubNavProps) {
  const router = useRouter();
  const tNav = useTranslations('navigation');
  const ServiceIcon = service.icon;
  const navItems = items ?? SUBNAV_CONFIG[service.id] ?? [];

  return (
    <aside className={classes.subnav}>
      <div className={classes.subnavHeader}>
        <div className={classes.subnavTopRow}>
          <Text component="span" className={classes.subnavEyebrow}>
            {service.category}
          </Text>
          <Tooltip label={isPinned ? 'Unpin from rail' : 'Pin to rail'} withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              onClick={onTogglePin}
              aria-label={isPinned ? 'Unpin' : 'Pin'}
              className={isPinned ? classes.subnavPinActive : ''}
            >
              {isPinned ? <IconPinFilled size={13} /> : <IconPin size={13} />}
            </ActionIcon>
          </Tooltip>
        </div>
        <div className={classes.subnavTitle}>
          <span className={classes.subnavTitleIcon}>
            <ServiceIcon size={16} stroke={1.7} />
          </span>
          <span>{tNav(service.navLabelKey)}</span>
        </div>
        <Text size="xs" c="dimmed" className={classes.subnavDesc}>
          {tNav(service.navDescriptionKey)}
        </Text>
      </div>

      <div className={classes.subnavBody}>
        {navItems.map((item) => {
          const ItemIcon = item.icon;
          const active = item.matcher
            ? item.matcher(pathname)
            : pathname === item.href;
          return (
            <button
              key={item.id}
              type="button"
              className={`${classes.subnavItem} ${active ? classes.subnavItemActive : ''}`}
              onClick={() => router.push(item.href)}
              aria-current={active ? 'page' : undefined}
            >
              <ItemIcon size={15} stroke={1.7} />
              <span className={classes.subnavItemLabel}>{item.label}</span>
              {item.badge ? <span className={classes.subnavBadge}>{item.badge}</span> : null}
            </button>
          );
        })}

        <div className={classes.subnavSectionTitle}>Resources</div>
        <button
          type="button"
          className={classes.subnavItem}
          onClick={onOpenDocs}
        >
          <IconBook size={15} stroke={1.7} />
          <span className={classes.subnavItemLabel}>Documentation</span>
          <IconExternalLink size={11} stroke={1.7} className={classes.subnavExternal} />
        </button>
      </div>
    </aside>
  );
}

export function findServiceForPath(
  services: DashboardServiceDefinition[],
  pathname: string | null,
): DashboardServiceDefinition | null {
  if (!pathname || !pathname.startsWith('/dashboard')) return null;

  let best: DashboardServiceDefinition | null = null;
  let bestLength = 0;

  for (const svc of services) {
    if (svc.href === '/dashboard') continue;
    if (pathname === svc.href || pathname.startsWith(`${svc.href}/`)) {
      if (svc.href.length > bestLength) {
        best = svc;
        bestLength = svc.href.length;
      }
    }
  }
  return best;
}

export function getSubNavItemsForService(serviceId: string): SubNavItem[] | undefined {
  return SUBNAV_CONFIG[serviceId];
}
