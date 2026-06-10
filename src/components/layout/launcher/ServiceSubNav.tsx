'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import {
  IconAlertTriangle,
  IconArrowLeftRight,
  IconArrowsSort,
  IconBell,
  IconBook,
  IconBrain,
  IconBug,
  IconChecklist,
  IconClipboardText,
  IconCode,
  IconDatabase,
  IconExternalLink,
  IconFolder,
  IconHistory,
  IconLayoutDashboard,
  IconSparkles,
  IconMessage,
  IconMessages,
  IconMicrophone,
  IconPin,
  IconPinFilled,
  IconPlayerPlay,
  IconReportAnalytics,
  IconRobot,
  IconScan,
  IconServer,
  IconShield,
  IconStack2,
  IconTimeline,
  IconUsers,
  IconVector,
  IconVolume,
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
  matcher?: (pathname: string, search: URLSearchParams) => boolean;
}

/** Model categories surfaced as their own sub-nav entries under the Models service. */
const MODEL_TYPE_KEYS = ['llm', 'embedding', 'rerank', 'stt', 'tts', 'ocr'];

export const SUBNAV_CONFIG: Record<string, SubNavItem[]> = {
  evaluations: [
    {
      id: 'targets',
      label: 'Targets',
      href: '/dashboard/evaluations',
      icon: IconRobot,
      matcher: (p) =>
        p === '/dashboard/evaluations' ||
        (p.startsWith('/dashboard/evaluations') &&
          !p.startsWith('/dashboard/evaluations/datasets') &&
          !p.startsWith('/dashboard/evaluations/suites') &&
          !p.startsWith('/dashboard/evaluations/runs') &&
          !p.startsWith('/dashboard/evaluations/api')),
    },
    {
      id: 'datasets',
      label: 'Datasets',
      href: '/dashboard/evaluations/datasets',
      icon: IconDatabase,
      matcher: (p) => p.startsWith('/dashboard/evaluations/datasets'),
    },
    {
      id: 'suites',
      label: 'Suites',
      href: '/dashboard/evaluations/suites',
      icon: IconChecklist,
      matcher: (p) => p.startsWith('/dashboard/evaluations/suites'),
    },
    {
      id: 'runs',
      label: 'Runs',
      href: '/dashboard/evaluations/runs',
      icon: IconPlayerPlay,
      matcher: (p) => p.startsWith('/dashboard/evaluations/runs'),
    },
    {
      id: 'api',
      label: 'API',
      href: '/dashboard/evaluations/api',
      icon: IconCode,
      matcher: (p) => p.startsWith('/dashboard/evaluations/api'),
    },
  ],
  redteam: [
    {
      id: 'overview',
      label: 'Overview',
      href: '/dashboard/redteam/overview',
      icon: IconReportAnalytics,
      matcher: (p) => p.startsWith('/dashboard/redteam/overview'),
    },
    {
      id: 'campaigns',
      label: 'Campaigns',
      href: '/dashboard/redteam',
      icon: IconShield,
      matcher: (p) =>
        p === '/dashboard/redteam' ||
        (p.startsWith('/dashboard/redteam') &&
          !p.startsWith('/dashboard/redteam/runs') &&
          !p.startsWith('/dashboard/redteam/probes') &&
          !p.startsWith('/dashboard/redteam/overview') &&
          !p.startsWith('/dashboard/redteam/api')),
    },
    {
      id: 'runs',
      label: 'Scans',
      href: '/dashboard/redteam/runs',
      icon: IconPlayerPlay,
      matcher: (p) => p.startsWith('/dashboard/redteam/runs'),
    },
    {
      id: 'probes',
      label: 'Probes',
      href: '/dashboard/redteam/probes',
      icon: IconBug,
      matcher: (p) => p.startsWith('/dashboard/redteam/probes'),
    },
    {
      id: 'api',
      label: 'API',
      href: '/dashboard/redteam/api',
      icon: IconCode,
      matcher: (p) => p.startsWith('/dashboard/redteam/api'),
    },
  ],
  analysis: [
    {
      id: 'definitions',
      label: 'Definitions',
      href: '/dashboard/analysis',
      icon: IconClipboardText,
      matcher: (p) =>
        p === '/dashboard/analysis' ||
        (p.startsWith('/dashboard/analysis') &&
          !p.startsWith('/dashboard/analysis/conversations') &&
          !p.startsWith('/dashboard/analysis/runs')),
    },
    {
      id: 'conversations',
      label: 'Conversations',
      href: '/dashboard/analysis/conversations',
      icon: IconMessages,
      matcher: (p) => p.startsWith('/dashboard/analysis/conversations'),
    },
    {
      id: 'runs',
      label: 'Runs',
      href: '/dashboard/analysis/runs',
      icon: IconReportAnalytics,
      matcher: (p) => p.startsWith('/dashboard/analysis/runs'),
    },
  ],
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
      id: 'all',
      label: 'All models',
      href: '/dashboard/models',
      icon: IconStack2,
      // Active on the list with no type filter and on every model detail/edit page.
      matcher: (p, s) =>
        p.startsWith('/dashboard/models') &&
        !MODEL_TYPE_KEYS.includes(s.get('type') ?? ''),
    },
    {
      id: 'llm',
      label: 'LLM',
      href: '/dashboard/models?type=llm',
      icon: IconBrain,
      matcher: (p, s) => p === '/dashboard/models' && s.get('type') === 'llm',
    },
    {
      id: 'embedding',
      label: 'Embedding',
      href: '/dashboard/models?type=embedding',
      icon: IconVector,
      matcher: (p, s) => p === '/dashboard/models' && s.get('type') === 'embedding',
    },
    {
      id: 'rerank',
      label: 'Rerank',
      href: '/dashboard/models?type=rerank',
      icon: IconArrowsSort,
      matcher: (p, s) => p === '/dashboard/models' && s.get('type') === 'rerank',
    },
    {
      id: 'stt',
      label: 'Speech-to-Text',
      href: '/dashboard/models?type=stt',
      icon: IconMicrophone,
      matcher: (p, s) => p === '/dashboard/models' && s.get('type') === 'stt',
    },
    {
      id: 'tts',
      label: 'Text-to-Speech',
      href: '/dashboard/models?type=tts',
      icon: IconVolume,
      matcher: (p, s) => p === '/dashboard/models' && s.get('type') === 'tts',
    },
    {
      id: 'ocr',
      label: 'OCR',
      href: '/dashboard/models?type=ocr',
      icon: IconScan,
      matcher: (p, s) => p === '/dashboard/models' && s.get('type') === 'ocr',
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
  realtime: [
    {
      id: 'models',
      label: 'Realtime models',
      href: '/dashboard/realtime',
      icon: IconLayoutDashboard,
      matcher: (p) => p === '/dashboard/realtime' || p.startsWith('/dashboard/realtime/models'),
    },
    {
      id: 'playground',
      label: 'Playground',
      href: '/dashboard/realtime/playground',
      icon: IconSparkles,
      matcher: (p) => p.startsWith('/dashboard/realtime/playground'),
    },
    {
      id: 'sessions',
      label: 'Sessions',
      href: '/dashboard/realtime/sessions',
      icon: IconTimeline,
      matcher: (p) => p.startsWith('/dashboard/realtime/sessions'),
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
  const rawSearchParams = useSearchParams();
  const searchParams = new URLSearchParams(rawSearchParams?.toString() ?? '');
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
            ? item.matcher(pathname, searchParams)
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
