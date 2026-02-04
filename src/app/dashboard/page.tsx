'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Box,
  Group,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconBrain,
  IconChevronRight,
  IconFolder,
  IconLayoutGrid,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconTimeline,
  IconVectorBezier,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';

type ModuleCategory = 'all' | 'build' | 'data' | 'operate' | 'admin';

type ModuleCard = {
  id: string;
  title: string;
  description: string;
  href: string;
  icon: typeof IconBrain;
  category: Exclude<ModuleCategory, 'all'>;
  tags: string[];
};

export default function DashboardPage() {
  const router = useRouter();
  const t = useTranslations('dashboard');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ModuleCategory>('all');

  const modules = useMemo<ModuleCard[]>(
    () => [
      {
        id: 'models',
        title: t('modules.models.title'),
        description: t('modules.models.description'),
        href: '/dashboard/models',
        icon: IconBrain,
        category: 'build',
        tags: ['llm', 'providers', 'inference'],
      },
      {
        id: 'prompts',
        title: t('modules.prompts.title'),
        description: t('modules.prompts.description'),
        href: '/dashboard/prompts',
        icon: IconSparkles,
        category: 'build',
        tags: ['templates', 'prompting'],
      },
      {
        id: 'vector',
        title: t('modules.vector.title'),
        description: t('modules.vector.description'),
        href: '/dashboard/vector',
        icon: IconVectorBezier,
        category: 'data',
        tags: ['indexes', 'embeddings'],
      },
      {
        id: 'files',
        title: t('modules.files.title'),
        description: t('modules.files.description'),
        href: '/dashboard/files',
        icon: IconFolder,
        category: 'data',
        tags: ['storage', 'uploads'],
      },
      {
        id: 'tracing',
        title: t('modules.tracing.title'),
        description: t('modules.tracing.description'),
        href: '/dashboard/tracing',
        icon: IconTimeline,
        category: 'operate',
        tags: ['observability', 'sessions'],
      },
      {
        id: 'projects',
        title: t('modules.projects.title'),
        description: t('modules.projects.description'),
        href: '/dashboard/projects',
        icon: IconLayoutGrid,
        category: 'operate',
        tags: ['workspaces', 'access'],
      },
      {
        id: 'settings',
        title: t('modules.settings.title'),
        description: t('modules.settings.description'),
        href: '/dashboard/settings',
        icon: IconSettings,
        category: 'admin',
        tags: ['users', 'tokens', 'providers'],
      },
    ],
    [t],
  );

  const filteredModules = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return modules.filter((module) => {
      const matchesCategory = category === 'all' || module.category === category;
      if (!matchesCategory) return false;
      if (!normalized) return true;
      const haystack = [
        module.title,
        module.description,
        module.category,
        module.tags.join(' '),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalized);
    });
  }, [modules, category, query]);

  const categoryOptions = [
    { value: 'all', label: t('filters.all') },
    { value: 'build', label: t('filters.build') },
    { value: 'data', label: t('filters.data') },
    { value: 'operate', label: t('filters.operate') },
    { value: 'admin', label: t('filters.admin') },
  ];

  const categoryLabel = (value: ModuleCategory) =>
    categoryOptions.find((option) => option.value === value)?.label ?? value;

  return (
    <Stack gap="lg">
      <Paper
        p="xl"
        radius="lg"
        withBorder
        style={{
          background:
            'linear-gradient(135deg, var(--mantine-color-teal-0) 0%, var(--mantine-color-cyan-0) 100%)',
          borderColor: 'var(--mantine-color-teal-2)',
        }}
      >
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <div>
              <Title order={2}>{t('landing.title')}</Title>
              <Text size="sm" c="dimmed" mt={6}>
                {t('landing.subtitle')}
              </Text>
            </div>
          </Group>

          <Group gap="md" align="center" wrap="wrap">
            <TextInput
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={t('landing.searchPlaceholder')}
              leftSection={<IconSearch size={16} />}
              style={{ flex: 1, minWidth: 260 }}
            />
            <SegmentedControl
              data={categoryOptions}
              value={category}
              onChange={(value) => setCategory(value as ModuleCategory)}
            />
          </Group>
        </Stack>
      </Paper>

      <Group justify="space-between" align="center">
        <Text size="sm" c="dimmed">
          {t('landing.results', { count: filteredModules.length })}
        </Text>
      </Group>

      {filteredModules.length === 0 ? (
        <Paper p="xl" radius="lg" withBorder>
          <Text size="sm" c="dimmed">
            {t('landing.empty')}
          </Text>
        </Paper>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
          {filteredModules.map((module) => (
            <Paper
              key={module.id}
              p="lg"
              radius="lg"
              withBorder
              onClick={() => router.push(module.href)}
              style={{ cursor: 'pointer', transition: 'all 0.2s ease' }}
              className="hover-lift"
            >
              <Stack gap="sm">
                <Group justify="space-between" align="flex-start">
                  <ThemeIcon size={44} radius="xl" variant="light" color="teal">
                    <module.icon size={22} />
                  </ThemeIcon>
                  <IconChevronRight size={18} color="var(--mantine-color-dimmed)" />
                </Group>
                <Box>
                  <Text fw={600} size="lg">
                    {module.title}
                  </Text>
                  <Text size="sm" c="dimmed" mt={6}>
                    {module.description}
                  </Text>
                </Box>
                <Group gap={6} wrap="wrap">
                  <Badge variant="light" color="gray">
                    {categoryLabel(module.category)}
                  </Badge>
                  {module.tags.map((tag) => (
                    <Badge key={tag} variant="light" color="teal">
                      {tag}
                    </Badge>
                  ))}
                </Group>
              </Stack>
            </Paper>
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}
