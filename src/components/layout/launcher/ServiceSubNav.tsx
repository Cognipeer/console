'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from '@/lib/i18n';
import type { DashboardServiceDefinition } from '@/lib/utils/dashboardServices';
import { ActionIcon, Text, Tooltip } from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowLeftRight,
  IconArrowsSort,
  IconArrowsSplit,
  IconBell,
  IconBook,
  IconBox,
  IconBoxModel,
  IconBrain,
  IconBug,
  IconBulb,
  IconCalculator,
  IconChecklist,
  IconClipboardText,
  IconCode,
  IconCoins,
  IconCpu,
  IconDatabase,
  IconExternalLink,
  IconFolder,
  IconHistory,
  IconLayoutDashboard,
  IconMessage,
  IconMessages,
  IconMicrophone,
  IconPin,
  IconPinFilled,
  IconPlayerPlay,
  IconReportAnalytics,
  IconChartHistogram,
  IconStethoscope,
  IconRobot,
  IconScan,
  IconServer,
  IconSettings,
  IconShield,
  IconShieldLock,
  IconSparkles,
  IconStack2,
  IconStackPush,
  IconTimeline,
  IconTool,
  IconVector,
  IconVolume,
  IconWorld,
  type Icon,
} from '@tabler/icons-react';
import { useRouter, useSearchParams } from 'next/navigation';
import classes from './LauncherShell.module.css';

export interface SubNavItem {
  id: string;
  label: string;
  href: string;
  icon: Icon;
  badge?: number | string;
  matcher?: (pathname: string, search: URLSearchParams) => boolean;
}

/** Model categories surfaced as their own sub-nav entries under the Models service. */
const MODEL_TYPE_KEYS = ['llm', 'embedding', 'rerank', 'stt', 'tts', 'ocr'];

export const SUBNAV_CONFIG: Record<string, SubNavItem[]> = {
  sandbox: [
    {
      id: 'overview',
      label: 'Overview',
      href: '/dashboard/sandbox',
      icon: IconLayoutDashboard,
      matcher: (p) => p === '/dashboard/sandbox',
    },
    {
      id: 'instances',
      label: 'Sandboxes',
      href: '/dashboard/sandbox/instances',
      icon: IconBox,
      matcher: (p) => p.startsWith('/dashboard/sandbox/instances'),
    },
    {
      id: 'templates',
      label: 'Templates',
      href: '/dashboard/sandbox/templates',
      icon: IconCode,
      matcher: (p) => p.startsWith('/dashboard/sandbox/templates'),
    },
    {
      id: 'volumes',
      label: 'Volumes',
      href: '/dashboard/sandbox/volumes',
      icon: IconDatabase,
      matcher: (p) => p.startsWith('/dashboard/sandbox/volumes'),
    },
    {
      id: 'playground',
      label: 'Playground',
      href: '/dashboard/sandbox/playground',
      icon: IconPlayerPlay,
      matcher: (p) => p.startsWith('/dashboard/sandbox/playground'),
    },
    {
      id: 'settings',
      label: 'Settings',
      href: '/dashboard/sandbox/settings',
      icon: IconSettings,
      matcher: (p) => p.startsWith('/dashboard/sandbox/settings'),
    },
  ],
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
          !p.startsWith('/dashboard/redteam/policy') &&
          !p.startsWith('/dashboard/redteam/api')),
    },
    {
      id: 'policy',
      label: 'Policy Probes',
      href: '/dashboard/redteam/policy',
      icon: IconShieldLock,
      matcher: (p) => p.startsWith('/dashboard/redteam/policy'),
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
          !p.startsWith('/dashboard/tracing/threads') &&
          !p.startsWith('/dashboard/tracing/agents')),
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
  cost: [
    {
      id: 'models',
      label: 'Model costs',
      href: '/dashboard/cost',
      icon: IconCoins,
      matcher: (p) =>
        p === '/dashboard/cost' ||
        (p.startsWith('/dashboard/cost') &&
          !p.startsWith('/dashboard/cost/agents') &&
          !p.startsWith('/dashboard/cost/pricing') &&
          !p.startsWith('/dashboard/cost/reports') &&
          !p.startsWith('/dashboard/cost/recommendations') &&
          !p.startsWith('/dashboard/cost/analysis') &&
          !p.startsWith('/dashboard/cost/prescriptions') &&
          !p.startsWith('/dashboard/cost/parity')),
    },
    {
      id: 'agents',
      label: 'Agent costs',
      href: '/dashboard/cost/agents',
      icon: IconRobot,
      matcher: (p) => p.startsWith('/dashboard/cost/agents'),
    },
    {
      id: 'analysis',
      label: 'Analysis',
      href: '/dashboard/cost/analysis',
      icon: IconChartHistogram,
      matcher: (p) => p.startsWith('/dashboard/cost/analysis'),
    },
    {
      id: 'prescriptions',
      label: 'Prescriptions',
      href: '/dashboard/cost/prescriptions',
      icon: IconStethoscope,
      matcher: (p) => p.startsWith('/dashboard/cost/prescriptions'),
    },
    {
      // EE overlay routes (abacus module) — community builds without the
      // overlay 404 here; the API behind them is enterprise-402 gated anyway.
      id: 'recommendations',
      label: 'Recommendations',
      href: '/dashboard/cost/recommendations',
      icon: IconBulb,
      matcher: (p) =>
        p.startsWith('/dashboard/cost/recommendations') ||
        (p.startsWith('/dashboard/abacus') && !p.startsWith('/dashboard/abacus/parity')),
    },
    {
      id: 'parity',
      label: 'Parity tests',
      href: '/dashboard/cost/parity',
      icon: IconChecklist,
      matcher: (p) =>
        p.startsWith('/dashboard/cost/parity') || p.startsWith('/dashboard/abacus/parity'),
    },
    {
      id: 'pricing',
      label: 'Pricing',
      href: '/dashboard/cost/pricing',
      icon: IconCalculator,
      matcher: (p) => p.startsWith('/dashboard/cost/pricing'),
    },
    {
      id: 'reports',
      label: 'Reports',
      href: '/dashboard/cost/reports',
      icon: IconReportAnalytics,
      matcher: (p) => p.startsWith('/dashboard/cost/reports'),
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
        !MODEL_TYPE_KEYS.includes(s.get('type') ?? '') &&
        s.get('create') !== 'dynamic',
    },
    {
      id: 'llm',
      label: 'LLM',
      href: '/dashboard/models?type=llm',
      icon: IconBrain,
      matcher: (p, s) => p === '/dashboard/models' && s.get('type') === 'llm',
    },
    {
      id: 'dynamic-llm',
      label: 'Dynamic LLM',
      href: '/dashboard/models?create=dynamic',
      icon: IconArrowsSplit,
      matcher: (p, s) =>
        p === '/dashboard/models' && s.get('create') === 'dynamic',
    },
    {
      id: 'embedding',
      label: 'Embedding',
      href: '/dashboard/models?type=embedding',
      icon: IconVector,
      matcher: (p, s) =>
        p === '/dashboard/models' && s.get('type') === 'embedding',
    },
    {
      id: 'rerank',
      label: 'Rerank',
      href: '/dashboard/models?type=rerank',
      icon: IconArrowsSort,
      matcher: (p, s) =>
        p === '/dashboard/models' && s.get('type') === 'rerank',
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
      label: 'Knowledge Engine',
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
  websearch: [
    {
      id: 'instances',
      label: 'Instances',
      href: '/dashboard/websearch',
      icon: IconWorld,
      matcher: (p) => p.startsWith('/dashboard/websearch'),
    },
  ],
  realtime: [
    {
      id: 'models',
      label: 'Realtime models',
      href: '/dashboard/realtime',
      icon: IconLayoutDashboard,
      matcher: (p) =>
        p === '/dashboard/realtime' ||
        p.startsWith('/dashboard/realtime/models'),
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
      matcher: (p) =>
        p.startsWith('/dashboard/agents') &&
        !p.startsWith('/dashboard/agents/tools'),
    },
    {
      id: 'tools',
      label: 'Tools',
      href: '/dashboard/agents/tools',
      icon: IconTool,
      matcher: (p) => p.startsWith('/dashboard/agents/tools'),
    },
  ],
  mcp: [
    {
      id: 'servers',
      label: 'Servers',
      href: '/dashboard/mcp',
      icon: IconServer,
      matcher: (p) =>
        p.startsWith('/dashboard/mcp') &&
        !p.startsWith('/dashboard/mcp/monitor') &&
        !p.startsWith('/dashboard/mcp/hubs'),
    },
    {
      id: 'hubs',
      label: 'MCP Hubs',
      href: '/dashboard/mcp/hubs',
      icon: IconStack2,
      matcher: (p) => p.startsWith('/dashboard/mcp/hubs'),
    },
    {
      id: 'monitor',
      label: 'Monitor',
      href: '/dashboard/mcp/monitor',
      icon: IconTimeline,
      matcher: (p) => p.startsWith('/dashboard/mcp/monitor'),
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
  'gpu-fleet': [
    {
      id: 'overview',
      label: 'Overview',
      href: '/dashboard/gpu-fleet',
      icon: IconCpu,
      // Host + deployment detail pages drill down from the overview list,
      // so keep this item active there too (they're separate top-level
      // route folders, not nested under /dashboard/gpu-fleet itself).
      matcher: (p) =>
        p === '/dashboard/gpu-fleet' ||
        p.startsWith('/dashboard/gpu-fleet/hosts') ||
        p.startsWith('/dashboard/gpu-fleet/deployments'),
    },
    {
      id: 'onboarding',
      label: 'Onboarding',
      href: '/dashboard/gpu-fleet/onboarding',
      icon: IconSparkles,
      matcher: (p) => p.startsWith('/dashboard/gpu-fleet/onboarding'),
    },
    {
      id: 'models',
      label: 'Model Marketplace',
      href: '/dashboard/gpu-fleet/models',
      icon: IconBoxModel,
      matcher: (p) => p.startsWith('/dashboard/gpu-fleet/models'),
    },
    {
      id: 'planner',
      label: 'Planner',
      href: '/dashboard/gpu-fleet/planner',
      icon: IconCalculator,
      matcher: (p) => p.startsWith('/dashboard/gpu-fleet/planner'),
    },
    {
      id: 'pools',
      label: 'Pools',
      href: '/dashboard/gpu-fleet/pools',
      icon: IconStackPush,
      matcher: (p) => p.startsWith('/dashboard/gpu-fleet/pools'),
    },
    {
      id: 'settings',
      label: 'Settings',
      href: '/dashboard/gpu-fleet/settings',
      icon: IconSettings,
      matcher: (p) => p.startsWith('/dashboard/gpu-fleet/settings'),
    },
  ],
};

// ── Dynamic agent directory for the Tracing sub-nav ────────────────────────
// The observability landing page intentionally has NO agent list — agents
// live here in the left menu instead. Fetched once per page load (module
// cache, 5-minute TTL) so navigating between tracing pages doesn't refetch.

interface TracingNavAgent {
  name: string;
  sessionsCount: number;
}

const TRACING_AGENT_NAV_CAP = 20;
const TRACING_AGENT_CACHE_TTL_MS = 5 * 60 * 1000;
let tracingAgentCache: { at: number; agents: TracingNavAgent[] } | null = null;
let tracingAgentInflight: Promise<TracingNavAgent[]> | null = null;

async function fetchTracingNavAgents(): Promise<TracingNavAgent[]> {
  if (tracingAgentCache && Date.now() - tracingAgentCache.at < TRACING_AGENT_CACHE_TTL_MS) {
    return tracingAgentCache.agents;
  }
  if (!tracingAgentInflight) {
    tracingAgentInflight = (async () => {
      try {
        const res = await fetch(`/api/tracing/agents?limit=${TRACING_AGENT_NAV_CAP}`, {
          cache: 'no-store',
        });
        if (!res.ok) return tracingAgentCache?.agents ?? [];
        const payload = (await res.json()) as { agents?: TracingNavAgent[] };
        const agents = (payload.agents ?? []).filter((a) => a.name);
        tracingAgentCache = { at: Date.now(), agents };
        return agents;
      } catch {
        return tracingAgentCache?.agents ?? [];
      } finally {
        tracingAgentInflight = null;
      }
    })();
  }
  return tracingAgentInflight;
}

function useTracingNavAgents(enabled: boolean): TracingNavAgent[] {
  const [agents, setAgents] = useState<TracingNavAgent[]>(
    () => tracingAgentCache?.agents ?? [],
  );
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void fetchTracingNavAgents().then((result) => {
      if (alive) setAgents(result);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return agents;
}

interface ServiceSubNavProps {
  service: DashboardServiceDefinition;
  pathname: string;
  isPinned: boolean;
  onTogglePin: () => void;
  onOpenDocs: () => void;
  items?: SubNavItem[];
  /** Hide the pin toggle — used for sections that are not pinnable (e.g. Settings). */
  hidePin?: boolean;
}

export default function ServiceSubNav({
  service,
  pathname,
  isPinned,
  onTogglePin,
  onOpenDocs,
  items,
  hidePin = false,
}: ServiceSubNavProps) {
  const router = useRouter();
  const rawSearchParams = useSearchParams();
  const searchParams = new URLSearchParams(rawSearchParams?.toString() ?? '');
  const tNav = useTranslations('navigation');
  const ServiceIcon = service.icon;
  const navItems = items ?? SUBNAV_CONFIG[service.id] ?? [];
  const tracingAgents = useTracingNavAgents(service.id === 'tracing');

  return (
    <aside className={classes.subnav}>
      <div className={classes.subnavHeader}>
        <div className={classes.subnavTopRow}>
          <Text component="span" className={classes.subnavEyebrow}>
            {service.category}
          </Text>
          <Tooltip
            label={isPinned ? 'Unpin from rail' : 'Pin to rail'}
            withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              onClick={onTogglePin}
              aria-label={isPinned ? 'Unpin' : 'Pin'}
              className={isPinned ? classes.subnavPinActive : ''}>
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
              aria-current={active ? 'page' : undefined}>
              <ItemIcon size={15} stroke={1.7} />
              <span className={classes.subnavItemLabel}>{item.label}</span>
              {item.badge ? (
                <span className={classes.subnavBadge}>{item.badge}</span>
              ) : null}
            </button>
          );
        })}

        {service.id === 'tracing' && tracingAgents.length > 0 ? (
          <>
            <div className={classes.subnavSectionTitle}>Agents</div>
            {tracingAgents.map((agent) => {
              const href = `/dashboard/tracing/agents/${encodeURIComponent(agent.name)}`;
              const active = pathname === href
                || pathname === `/dashboard/tracing/agents/${agent.name}`;
              return (
                <button
                  key={agent.name}
                  type="button"
                  className={`${classes.subnavItem} ${active ? classes.subnavItemActive : ''}`}
                  onClick={() => router.push(href)}
                  aria-current={active ? 'page' : undefined}
                  title={agent.name}>
                  <IconRobot size={15} stroke={1.7} />
                  <span className={classes.subnavItemLabel}>{agent.name}</span>
                  <span className={classes.subnavBadge}>
                    {agent.sessionsCount.toLocaleString()}
                  </span>
                </button>
              );
            })}
          </>
        ) : null}

        <div className={classes.subnavSectionTitle}>Resources</div>
        <button
          type="button"
          className={classes.subnavItem}
          onClick={onOpenDocs}>
          <IconBook size={15} stroke={1.7} />
          <span className={classes.subnavItemLabel}>Documentation</span>
          <IconExternalLink
            size={11}
            stroke={1.7}
            className={classes.subnavExternal}
          />
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

export function getSubNavItemsForService(
  serviceId: string,
): SubNavItem[] | undefined {
  return SUBNAV_CONFIG[serviceId];
}
