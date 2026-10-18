'use client';

import { useTranslations } from '@/lib/i18n';
import { Anchor, Breadcrumbs, Text } from '@mantine/core';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { readLastListUrl } from '@/components/iam/principals/lastList';
import { BREADCRUMB_RESOLVERS } from './breadcrumbResolvers';
import { hasNoPage, iamCrumbPlan, type IamCrumbLabel } from './iamBreadcrumbs';

/**
 * Translation keys for static path segments. A segment listed here is
 * rendered with `breadcrumbs.<key>` from the i18n bundle; everything else
 * falls through to `formatSegment` (Title Case) or `shortenId` if the
 * segment looks like an opaque identifier.
 *
 * Add a new entry here when you introduce a static path segment that
 * should appear in the breadcrumb. Dynamic ID labels are handled by
 * `breadcrumbResolvers.ts`.
 */
const SEGMENT_KEYS: Record<string, string> = {
  dashboard: 'dashboard',
  iam: 'iam',
  overview: 'overview',
  tracing: 'tracing',
  health: 'health',
  // Entity health detail pages: /dashboard/tracing/health/<type>/<entity key>
  agent: 'healthAgent',
  model: 'healthModel',
  kb: 'healthKb',
  tool: 'healthTool',
  models: 'models',
  sessions: 'sessions',
  threads: 'threads',
  agents: 'agents',
  portals: 'portals',
  settings: 'settings',
  account: 'account',
  vector: 'vector',
  prompts: 'prompts',
  projects: 'projects',
  'inference-monitoring': 'inference-monitoring',
  mcp: 'mcp',
  servers: 'servers',
  providers: 'providers',
  tokens: 'tokens',
  webhooks: 'webhooks',
  incidents: 'incidents',
  guardrails: 'guardrails',
  pii: 'pii',
  alerts: 'alerts',
  automations: 'automations',
  history: 'history',
  memory: 'memory',
  rag: 'rag',
  reranker: 'reranker',
  config: 'config',
  audit: 'audit',
  tools: 'tools',
  browser: 'browser',
  license: 'license',
  sso: 'sso',
  ldap: 'ldap',
  files: 'files',
  resources: 'resources',
  cluster: 'cluster',
  nodes: 'nodes',
  instances: 'instances',
  cost: 'cost',
  docs: 'docs',
  migrations: 'migrations',
  edit: 'edit',
  new: 'new',
};

function formatSegment(
  segment: string,
  translate: ReturnType<typeof useTranslations>,
): string {
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
}

function isMongoObjectId(value: string) {
  return /^[a-f\d]{24}$/i.test(value);
}

/**
 * `SEGMENT_KEYS` is keyed by bare segment string with no path context, so a
 * leaf folder that happens to share its name with an unrelated top-level
 * route silently gets that route's label instead. Currently only one such
 * collision exists: `/dashboard/gpu-fleet/models` (the GPU Fleet model
 * marketplace) vs `/dashboard/models` (Model Hub) both end in "models", so
 * without this override the marketplace page's breadcrumb (and tab title)
 * incorrectly showed "Model Hub". Keyed by the full path relative to
 * `dashboard`, checked before the generic segment-name lookup.
 */
const PATH_LABEL_OVERRIDES: Record<string, string> = {
  'gpu-fleet/models': 'Model Marketplace',
  // Product names whose nav label differs from Title-Cased folder name.
  'gpu-fleet': 'GPU Fleet',
  'ai-app-gateway': 'AI App Gateway',
  'ocr-jobs': 'OCR Jobs',
  redteam: 'Red Team',
  websearch: 'Web Search',
};

function pathOverrideLabel(
  segments: string[],
  index: number,
): string | undefined {
  return PATH_LABEL_OVERRIDES[segments.slice(1, index + 1).join('/')];
}

function isLikelyId(value: string): boolean {
  if (!value) return false;
  if (isMongoObjectId(value)) return true;
  // UUID v4 or similar: 8-4-4-4-12 hex
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    return true;
  }
  // Any long alphanumeric id (24+ chars, mostly hex/dash/underscore)
  if (
    value.length >= 16 &&
    /^[0-9a-zA-Z_-]+$/.test(value) &&
    /\d/.test(value)
  ) {
    return true;
  }
  return false;
}

function shortenId(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

type ResolvedSegmentLabels = Record<number, string>;

interface Crumb {
  key: string;
  label: string;
  /** `null`: not a link (the current page, or a folder without a page). */
  href: string | null;
  current: boolean;
}

/** `breadcrumbs.*` keys of the IAM trail's own labels. */
const IAM_CRUMB_KEYS: Record<IamCrumbLabel, string> = {
  people: 'iamPeople',
  groups: 'iamGroups',
  tokens: 'iamTokens',
  policies: 'iamPolicies',
};

export default function DashboardBreadcrumbs() {
  const pathname = usePathname();
  const t = useTranslations('breadcrumbs');

  const cacheRef = useRef<Map<string, string>>(new Map());
  // The principals list view a person's page was opened from (session storage: unknown until mounted).
  const [lastListUrl, setLastListUrl] = useState<string | null>(null);
  const [resolvedLabels, setResolvedLabels] = useState<ResolvedSegmentLabels>(
    {},
  );

  const segments = useMemo(() => {
    if (!pathname) return [] as string[];
    return pathname.split('/').filter(Boolean);
  }, [pathname]);

  useEffect(() => {
    setLastListUrl(readLastListUrl());
  }, [pathname]);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!segments.length || segments[0] !== 'dashboard') {
        if (!cancelled) setResolvedLabels({});
        return;
      }

      const ctx = { segments, cache: cacheRef.current };
      const results = await Promise.all(
        BREADCRUMB_RESOLVERS.map((resolver) =>
          resolver.resolve(ctx).catch(() => []),
        ),
      );

      if (cancelled) return;

      const next: ResolvedSegmentLabels = {};
      for (const entries of results) {
        for (const entry of entries) {
          next[entry.index] = entry.label;
        }
      }
      setResolvedLabels(next);
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [segments]);

  const labels = useMemo(
    () =>
      segments.map((segment, index) => {
        const resolved = resolvedLabels[index];
        if (resolved) return resolved;
        const override = pathOverrideLabel(segments, index);
        if (override) return override;
        return isLikelyId(segment)
          ? shortenId(segment)
          : formatSegment(segment, t);
      }),
    [segments, resolvedLabels, t],
  );

  // IAM pages have their own trail (IAM / People / <name>): the folders between are not pages.
  const crumbs = useMemo<Crumb[]>(() => {
    const iamPlan = iamCrumbPlan(segments, lastListUrl);
    if (iamPlan) {
      return iamPlan.map((item, i) => ({
        key: `${item.segmentIndex}:${item.href ?? ''}`,
        label: item.label ? t(IAM_CRUMB_KEYS[item.label]) : labels[item.segmentIndex],
        href: item.href,
        current: i === iamPlan.length - 1,
      }));
    }
    return segments.map((_segment, index) => {
      const current = index === segments.length - 1;
      const path = `/${segments.slice(0, index + 1).join('/')}`;
      return {
        key: path,
        label: labels[index],
        href: current || hasNoPage(segments, index) ? null : path,
        current,
      };
    });
  }, [segments, labels, lastListUrl, t]);

  // Browser tab title: breadcrumb labels minus "Dashboard". A layout effect
  // + MutationObserver is used (instead of a plain useEffect) because Next's
  // App Router can reset document.title on navigation without changing our
  // deps, so a dep-based effect wouldn't reliably re-fire to correct it.
  const titleRef = useRef('Cognipeer Console');

  useLayoutEffect(() => {
    if (!segments.length || segments[0] !== 'dashboard') return;
    const pageLabels = crumbs.slice(1).map((crumb) => crumb.label);
    titleRef.current = pageLabels.length
      ? `${[...pageLabels].reverse().join(' · ')} - Cognipeer Console`
      : 'Cognipeer Console';
    document.title = titleRef.current;
  }, [segments, crumbs]);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (document.title !== titleRef.current) {
        document.title = titleRef.current;
      }
    });
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, []);

  if (segments.length === 0 || segments[0] !== 'dashboard') {
    return null;
  }

  const items = crumbs.map(({ key, label, href, current }) => {
    if (href === null) {
      return (
        <Text
          key={key}
          fw={current ? 500 : undefined}
          size="xs"
          style={{ color: current ? 'var(--ds-text)' : 'var(--ds-text-faint)' }}>
          {label}
        </Text>
      );
    }

    return (
      <Anchor
        key={key}
        component={Link}
        href={href}
        size="xs"
        style={{ textTransform: 'none', color: 'var(--ds-text-faint)' }}>
        {label}
      </Anchor>
    );
  });

  return (
    <Breadcrumbs
      separator="/"
      separatorMargin={6}
      styles={{
        separator: { color: 'var(--ds-text-faint)', opacity: 0.6 },
      }}>
      {items}
    </Breadcrumbs>
  );
}
