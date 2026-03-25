'use client';

import { useEffect, useMemo, useState } from 'react';
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
} from '@mantine/core';
import PageHeader from '@/components/layout/PageHeader';
import { IconChevronRight, IconLayoutGrid, IconSearch } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import {
  getDashboardServices,
  type DashboardServiceCategory,
  type DashboardServiceDefinition,
} from '@/lib/utils/dashboardServices';

type ModuleCategory = 'all' | DashboardServiceCategory;

type ModuleCard = {
  id: string;
  title: string;
  description: string;
  href: string;
  icon: DashboardServiceDefinition['icon'];
  category: Exclude<ModuleCategory, 'all'>;
  tags: string[];
};

export default function DashboardPage() {
  const router = useRouter();
  const t = useTranslations('dashboard');
  const tNav = useTranslations('navigation');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ModuleCategory>('all');
  const [isTenantAdmin, setIsTenantAdmin] = useState(false);

  useEffect(() => {
    let active = true;

    const fetchSession = async () => {
      try {
        const res = await fetch('/api/auth/session', { cache: 'no-store' });
        if (!res.ok) return;

        const data = (await res.json()) as { role?: string };
        if (!active) return;

        setIsTenantAdmin(data.role === 'owner' || data.role === 'admin');
      } catch {
      }
    };

    fetchSession();

    return () => {
      active = false;
    };
  }, []);

  const modules = useMemo<ModuleCard[]>(
    () =>
      getDashboardServices({
        isTenantAdmin,
        servicesHomeOnly: true,
      }).map((service) => ({
        id: service.id,
        title: tNav(service.navLabelKey),
        description: tNav(service.navDescriptionKey),
        href: service.href,
        icon: service.icon,
        category: service.category,
        tags: service.tags,
      })),
    [isTenantAdmin, tNav],
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
    <Stack gap="md">
      <PageHeader
        icon={<IconLayoutGrid size={18} />}
        title={t('landing.title')}
        subtitle={t('landing.subtitle')}
        actions={
          <Group gap="sm" align="center" wrap="wrap">
            <TextInput
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={t('landing.searchPlaceholder')}
              leftSection={<IconSearch size={14} />}
              size="xs"
              style={{ minWidth: 200 }}
            />
            <SegmentedControl
              data={categoryOptions}
              value={category}
              size="xs"
              onChange={(value) => setCategory(value as ModuleCategory)}
            />
          </Group>
        }
      />

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
