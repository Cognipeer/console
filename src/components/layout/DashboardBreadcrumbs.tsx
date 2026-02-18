'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Anchor, Breadcrumbs, Text } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';

const SEGMENT_KEYS: Record<string, string> = {
  dashboard: 'dashboard',
  overview: 'overview',
  tracing: 'tracing',
  models: 'models',
  sessions: 'sessions',
  agents: 'agents',
  settings: 'settings',
  'tenant-settings': 'tenant-settings',
  vector: 'vector',
  prompts: 'prompts',
  projects: 'projects',
  'inference-monitoring': 'inference-monitoring',
  servers: 'servers',
};

const formatSegment = (
  segment: string,
  translate: ReturnType<typeof useTranslations>,
): string => {
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

function isMongoObjectId(value: string) {
  return /^[a-f\d]{24}$/i.test(value);
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

    const resolveLabel = async (cacheKey: string, fn: () => Promise<string | undefined>) => {
      const cached = cacheRef.current.get(cacheKey);
      if (cached) return cached;

      try {
        const label = await fn();
        if (label) {
          cacheRef.current.set(cacheKey, label);
          return label;
        }
      } catch {
        // Ignore breadcrumb resolution failures.
      }

      return undefined;
    };

    const run = async () => {
      if (!segments.length || segments[0] !== 'dashboard') {
        if (!cancelled) {
          setResolvedLabels({});
        }
        return;
      }

      const next: ResolvedSegmentLabels = {};
      const tasks: Array<Promise<void>> = [];

      // Models: /dashboard/models/:id(/edit)
      const modelsIndex = segments.indexOf('models');
      if (modelsIndex >= 0) {
        const modelId = segments[modelsIndex + 1];
        if (modelId && isMongoObjectId(modelId)) {
          tasks.push(
            (async () => {
              const label = await resolveLabel(`model:${modelId}`, async () => {
                const res = await fetch(`/api/models/${encodeURIComponent(modelId)}`, {
                  cache: 'no-store',
                });
                if (!res.ok) return undefined;
                const body = (await res.json()) as { model?: { name?: string; key?: string } };
                return body.model?.name || body.model?.key;
              });
              if (label) {
                next[modelsIndex + 1] = label;
              }
            })(),
          );
        }
      }

      // Files: /dashboard/files/:bucketKey
      const filesIndex = segments.indexOf('files');
      if (filesIndex >= 0) {
        const bucketKey = segments[filesIndex + 1];
        // Only resolve for the detail page (bucketKey exists and isn't a known static segment).
        if (bucketKey && bucketKey !== 'providers') {
          tasks.push(
            (async () => {
              const label = await resolveLabel(`bucket:${bucketKey}`, async () => {
                const res = await fetch(`/api/files/buckets/${encodeURIComponent(bucketKey)}`, {
                  cache: 'no-store',
                });
                if (!res.ok) return undefined;
                const body = (await res.json()) as { bucket?: { name?: string; key?: string } };
                return body.bucket?.name || body.bucket?.key;
              });
              if (label) {
                next[filesIndex + 1] = label;
              }
            })(),
          );
        }
      }

      // Vector: /dashboard/vector/:providerKey/:externalId
      const vectorIndex = segments.indexOf('vector');
      if (vectorIndex >= 0) {
        const providerKey = segments[vectorIndex + 1];
        const externalId = segments[vectorIndex + 2];
        if (providerKey && externalId) {
          tasks.push(
            (async () => {
              const label = await resolveLabel(`vectorIndex:${providerKey}:${externalId}`, async () => {
                const url = `/api/vector/indexes/${encodeURIComponent(externalId)}?providerKey=${encodeURIComponent(providerKey)}`;
                const res = await fetch(url, { cache: 'no-store' });
                if (!res.ok) return undefined;
                const body = (await res.json()) as {
                  index?: { name?: string };
                  provider?: { label?: string };
                };

                const providerLabel = body.provider?.label;
                const indexName = body.index?.name;
                if (providerLabel) {
                  cacheRef.current.set(`vectorProvider:${providerKey}`, providerLabel);
                }
                if (indexName) {
                  cacheRef.current.set(`vectorIndexName:${providerKey}:${externalId}`, indexName);
                }
                return indexName;
              });

              const providerLabel = cacheRef.current.get(`vectorProvider:${providerKey}`);
              const indexName = cacheRef.current.get(`vectorIndexName:${providerKey}:${externalId}`) || label;

              if (providerLabel) {
                next[vectorIndex + 1] = providerLabel;
              }
              if (indexName) {
                next[vectorIndex + 2] = indexName;
              }
            })(),
          );
        }
      }

      // Tracing agent: /dashboard/tracing/agents/:agentName
      const tracingIndex = segments.indexOf('tracing');
      if (tracingIndex >= 0) {
        const agentsIndex = segments.indexOf('agents');
        const agentName = agentsIndex >= 0 ? segments[agentsIndex + 1] : undefined;
        if (agentsIndex >= 0 && agentName) {
          tasks.push(
            (async () => {
              const label = await resolveLabel(`agent:${agentName}`, async () => {
                const url = `/api/tracing/agents/${encodeURIComponent(agentName)}/overview`;
                const res = await fetch(url, { cache: 'no-store' });
                if (!res.ok) return undefined;
                const body = (await res.json()) as { agent?: { label?: string; name?: string } };
                return body.agent?.label || body.agent?.name;
              });
              if (label) {
                next[agentsIndex + 1] = label;
              }
            })(),
          );
        }

        // Tracing session: /dashboard/tracing/sessions/:sessionId
        const sessionsIndex = segments.indexOf('sessions');
        const sessionId = sessionsIndex >= 0 ? segments[sessionsIndex + 1] : undefined;
        if (sessionsIndex >= 0 && sessionId) {
          tasks.push(
            (async () => {
              const label = await resolveLabel(`session:${sessionId}`, async () => {
                const res = await fetch(`/api/tracing/sessions/${encodeURIComponent(sessionId)}`, {
                  cache: 'no-store',
                });
                if (!res.ok) return undefined;
                const body = (await res.json()) as { session?: { agentName?: string } };
                const agentNameFromSession = body.session?.agentName;
                if (agentNameFromSession) {
                  return `${agentNameFromSession} session`;
                }
                return 'Session';
              });
              if (label) {
                next[sessionsIndex + 1] = label;
              }
            })(),
          );
        }
      }

      // Projects: /dashboard/projects/:projectId or /dashboard/tenant-settings/projects/:projectId
      const projectsIndex = segments.lastIndexOf('projects');
      if (projectsIndex >= 0) {
        const projectId = segments[projectsIndex + 1];
        if (projectId && isMongoObjectId(projectId)) {
          tasks.push(
            (async () => {
              const label = await resolveLabel(`project:${projectId}`, async () => {
                const res = await fetch('/api/projects', { cache: 'no-store' });
                if (!res.ok) return undefined;
                const body = (await res.json()) as { projects?: Array<{ _id: string; name: string }> };
                const project = (body.projects ?? []).find((p) => String(p._id) === String(projectId));
                return project?.name;
              });
              if (label) {
                next[projectsIndex + 1] = label;
              }
            })(),
          );
        }
      }

      await Promise.all(tasks);
      if (!cancelled) {
        setResolvedLabels(next);
      }
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
    const label = resolvedLabels[index] ?? formatSegment(segment, t);
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
        style={{ textTransform: 'none' }}>
        {label}
      </Anchor>
    );
  });

  return <Breadcrumbs separator="/">{items}</Breadcrumbs>;
}
