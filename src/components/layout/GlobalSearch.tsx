'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  IconBrain,
  IconFolder,
  IconLayoutDashboard,
  IconSearch,
  IconSparkles,
  IconTimeline,
  IconVectorBezier,
  IconServerBolt,
  IconKey,
  IconPlug,
  IconUsers,
  IconApi,
} from '@tabler/icons-react';
import { Spotlight, spotlight, SpotlightActionData } from '@mantine/spotlight';
import { useTranslations } from '@/lib/i18n';

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
      {
        id: 'models',
        label: tNav('models'),
        description: tNav('modelsDescription'),
        onClick: () => router.push('/dashboard/models'),
        leftSection: <IconBrain size={20} stroke={1.5} />,
        keywords: ['model', 'llm', 'ai', 'gpt', 'openai', 'bedrock'],
      },
      {
        id: 'prompts',
        label: tNav('prompts'),
        description: tNav('promptsDescription'),
        onClick: () => router.push('/dashboard/prompts'),
        leftSection: <IconSparkles size={20} stroke={1.5} />,
        keywords: ['prompt', 'template', 'şablon'],
      },
      {
        id: 'vector',
        label: tNav('vector'),
        description: tNav('vectorDescription'),
        onClick: () => router.push('/dashboard/vector'),
        leftSection: <IconVectorBezier size={20} stroke={1.5} />,
        keywords: ['vector', 'embedding', 'pinecone', 'rag'],
      },
      {
        id: 'files',
        label: tNav('files'),
        description: tNav('filesDescription'),
        onClick: () => router.push('/dashboard/files'),
        leftSection: <IconFolder size={20} stroke={1.5} />,
        keywords: ['file', 'dosya', 'upload', 'storage'],
      },
      {
        id: 'tracing',
        label: tNav('agentTracing'),
        description: tNav('agentTracingDescription'),
        onClick: () => router.push('/dashboard/tracing'),
        leftSection: <IconTimeline size={20} stroke={1.5} />,
        keywords: ['trace', 'agent', 'log', 'debug'],
      },
      {
        id: 'inference-monitoring',
        label: tNav('inferenceMonitoring'),
        description: tNav('inferenceMonitoringDescription'),
        onClick: () => router.push('/dashboard/inference-monitoring'),
        leftSection: <IconServerBolt size={20} stroke={1.5} />,
        keywords: ['inference', 'monitoring', 'vllm', 'server', 'gpu'],
      },
      {
        id: 'projects',
        label: tNav('projects'),
        description: tNav('projectsDescription'),
        onClick: () => router.push('/dashboard/projects'),
        leftSection: <IconLayoutDashboard size={20} stroke={1.5} />,
        keywords: ['project', 'proje'],
      },
      ...(isTenantAdmin
        ? [
            {
              id: 'members',
              label: tNav('members'),
              description: tNav('membersDescription'),
              onClick: () => router.push('/dashboard/members'),
              leftSection: <IconUsers size={20} stroke={1.5} />,
              keywords: ['members', 'users', 'invite', 'tenant', 'üyeler'],
            },
            {
              id: 'providers',
              label: tNav('providers'),
              description: tNav('providersDescription'),
              onClick: () => router.push('/dashboard/providers'),
              leftSection: <IconPlug size={20} stroke={1.5} />,
              keywords: ['providers', 'integrations', 'sağlayıcılar'],
            },
          ]
        : []),
      {
        id: 'tokens',
        label: tNav('tokens'),
        description: tNav('tokensDescription'),
        onClick: () => router.push('/dashboard/tokens'),
        leftSection: <IconKey size={20} stroke={1.5} />,
        keywords: ['token', 'api', 'key', 'anahtar'],
      },
      {
        id: 'mcp',
        label: tNav('mcp'),
        description: tNav('mcpDescription'),
        onClick: () => router.push('/dashboard/mcp'),
        leftSection: <IconApi size={20} stroke={1.5} />,
        keywords: ['mcp', 'openapi', 'swagger', 'tool', 'server', 'proxy', 'api'],
      },
    ],
    [router, tNav, isTenantAdmin]
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
