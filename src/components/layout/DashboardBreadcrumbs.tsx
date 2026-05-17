'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Anchor, Breadcrumbs, Text } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import { BREADCRUMB_RESOLVERS } from './breadcrumbResolvers';

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
  overview: 'overview',
  tracing: 'tracing',
  models: 'models',
  sessions: 'sessions',
  threads: 'threads',
  agents: 'agents',
  settings: 'settings',
  'tenant-settings': 'tenant-settings',
  vector: 'vector',
  prompts: 'prompts',
  projects: 'projects',
  'inference-monitoring': 'inference-monitoring',
  mcp: 'mcp',
  'js-sandbox': 'js-sandbox',
  servers: 'servers',
  members: 'members',
  providers: 'providers',
  tokens: 'tokens',
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
  files: 'files',
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

function isLikelyId(value: string): boolean {
  if (!value) return false;
  if (isMongoObjectId(value)) return true;
  // UUID v4 or similar: 8-4-4-4-12 hex
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return true;
  }
  // Any long alphanumeric id (24+ chars, mostly hex/dash/underscore)
  if (value.length >= 16 && /^[0-9a-zA-Z_-]+$/.test(value) && /\d/.test(value)) {
    return true;
  }
  return false;
}

function shortenId(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

type ResolvedSegmentLabels = Record<number, string>;

export default function DashboardBreadcrumbs() {
  const pathname = usePathname();
  const t = useTranslations('breadcrumbs');

  const cacheRef = useRef<Map<string, string>>(new Map());
  const [resolvedLabels, setResolvedLabels] = useState<ResolvedSegmentLabels>({});

  const segments = useMemo(() => {
    if (!pathname) return [] as string[];
    return pathname.split('/').filter(Boolean);
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

  if (segments.length === 0 || segments[0] !== 'dashboard') {
    return null;
  }

  const items = segments.map((segment, index) => {
    const href = `/${segments.slice(0, index + 1).join('/')}`;
    const resolved = resolvedLabels[index];
    const label =
      resolved ?? (isLikelyId(segment) ? shortenId(segment) : formatSegment(segment, t));
    const isLast = index === segments.length - 1;

    if (isLast) {
      return (
        <Text key={href} fw={500} size="xs" style={{ color: 'var(--ds-text)' }}>
          {label}
        </Text>
      );
    }

    return (
      <Anchor
        key={href}
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
      }}
    >
      {items}
    </Breadcrumbs>
  );
}
