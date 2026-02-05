'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ActionIcon,
  AppShell,
  Avatar,
  Button,
  Divider,
  Group,
  Menu,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconChevronDown,
  IconExternalLink,
  IconLayoutDashboard,
  IconLogout,
  IconSearch,
  IconSettings,
  IconTimeline,
  IconBrain,
  IconSparkles,
  IconVectorBezier,
  IconFolder,
  IconBook,
  IconX,
} from '@tabler/icons-react';
import { ReactNode, useMemo, useState } from 'react';
import DashboardBreadcrumbs from './DashboardBreadcrumbs';
import { GlobalSearch, openGlobalSearch } from './GlobalSearch';
import { useTranslations } from '@/lib/i18n';
import classes from './DashboardLayout.module.css';
import ProjectSelector from '@/components/projects/ProjectSelector';
import { DocsDrawerProvider } from '@/components/docs/DocsDrawerContext';
import { DEFAULT_SDK_DOC, resolveSdkDoc, type SdkDocId } from '@/lib/docs/sdkDocs';

interface DashboardLayoutProps {
  children: ReactNode;
  user?: {
    name: string;
    email: string;
    licenseType: string;
    role?: 'owner' | 'admin' | 'project_admin' | 'user';
  };
}

export default function DashboardLayout({ children, user }: DashboardLayoutProps) {
  const router = useRouter();
  const [docsOpened, docsControls] = useDisclosure(false);
  const [docsDocId, setDocsDocId] = useState<SdkDocId>(DEFAULT_SDK_DOC);
  const isMobile = useMediaQuery('(max-width: 48em)');
  const pathname = usePathname();
  const t = useTranslations('layout');
  const tNav = useTranslations('navigation');
  const tNotifications = useTranslations('notifications');
  const tAccount = useTranslations('account');

  const activeDoc = useMemo(() => resolveSdkDoc(docsDocId), [docsDocId]);

  const openDocs = (docId?: SdkDocId) => {
    setDocsDocId(docId ?? DEFAULT_SDK_DOC);
    docsControls.open();
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      notifications.show({
        title: tNotifications('logoutSuccessTitle'),
        message: tNotifications('logoutSuccessMessage'),
        color: 'teal',
      });
      router.push('/login');
    } catch {
      notifications.show({
        title: tNotifications('logoutErrorTitle'),
        message: tNotifications('logoutErrorMessage'),
        color: 'red',
      });
    }
  };

  const defaultUser = user || {
    name: t('defaultUser.name'),
    email: t('defaultUser.email'),
    licenseType: t('defaultUser.license'),
    role: 'user' as const,
  };

  const isTenantAdmin = defaultUser.role === 'owner' || defaultUser.role === 'admin';

  const serviceItems = [
    {
      label: tNav('servicesHome'),
      description: tNav('servicesHomeDescription'),
      icon: IconLayoutDashboard,
      href: '/dashboard',
    },
    {
      label: tNav('models'),
      description: tNav('modelsDescription'),
      icon: IconBrain,
      href: '/dashboard/models',
    },
    {
      label: tNav('vector'),
      description: tNav('vectorDescription'),
      icon: IconVectorBezier,
      href: '/dashboard/vector',
    },
    {
      label: tNav('files'),
      description: tNav('filesDescription'),
      icon: IconFolder,
      href: '/dashboard/files',
    },
    {
      label: tNav('agentTracing'),
      description: tNav('agentTracingDescription'),
      icon: IconTimeline,
      href: '/dashboard/tracing',
    },
    {
      label: tNav('projects'),
      description: tNav('projectsDescription'),
      icon: IconLayoutDashboard,
      href: '/dashboard/projects',
    },
    ...(!isTenantAdmin
      ? [
          {
            label: tNav('settings'),
            description: tNav('settingsDescription'),
            icon: IconSettings,
            href: '/dashboard/settings',
          },
        ]
      : []),
    ...(isTenantAdmin
      ? [
          {
            label: tNav('tenantSettings'),
            description: tNav('tenantSettingsDescription'),
            icon: IconSettings,
            href: '/dashboard/tenant-settings',
          },
        ]
      : []),
  ];

  const handleNavClick = (href?: string) => {
    if (!href) return;

    if (href === '/dashboard/docs') {
      openDocs(DEFAULT_SDK_DOC);
      if (isMobile) {
        close();
      }
      return;
    }

    router.push(href);
  };

  return (
    <DocsDrawerProvider value={{ openDocs }}>
      <GlobalSearch isTenantAdmin={isTenantAdmin} />
      <AppShell
        header={{ height: 68 }}
        aside={{
          width: 560,
          breakpoint: 'md',
          collapsed: { desktop: !docsOpened, mobile: !docsOpened },
        }}
        padding="md"
      >
        <AppShell.Header className={classes.header}>
          <Group h="100%" px="md" justify="space-between" wrap="nowrap">
            {/* Left: Logo + Navigation */}
            <Group gap="md" wrap="nowrap">
              <Link href="/" className={classes.headerLogo} aria-label="Cognipeer dashboard">
                <Image
                  src="/images/cognipeer-logo-d.png"
                  alt="Cognipeer logo"
                  width={140}
                  height={32}
                  className={classes.logoDark}
                  priority
                />
                <Image
                  src="/images/cognipeer-logo-w.png"
                  alt="Cognipeer logo"
                  width={140}
                  height={32}
                  className={classes.logoLight}
                  priority
                />
              </Link>

              <Divider orientation="vertical" visibleFrom="sm" />

              <Group gap="xs" visibleFrom="sm">
                <Button
                  variant={pathname?.startsWith('/dashboard/overview') ? 'filled' : 'subtle'}
                  size="sm"
                  leftSection={<IconLayoutDashboard size={16} />}
                  onClick={() => handleNavClick('/dashboard/overview')}
                >
                  {tNav('dashboardOverview')}
                </Button>

                <Menu position="bottom-start" withinPortal shadow="md">
                  <Menu.Target>
                    <Button
                      variant="subtle"
                      size="sm"
                      rightSection={<IconChevronDown size={14} />}
                    >
                      {tNav('services')}
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown className={classes.servicesMenu}>
                    <div className={classes.servicesGrid}>
                      <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb={8}>
                        {tNav('servicesLabel')}
                      </Text>
                      <SimpleGrid cols={2} spacing="xs">
                        {serviceItems.map((item) => (
                          <UnstyledButton
                            key={item.href}
                            className={classes.servicesCard}
                            onClick={() => handleNavClick(item.href)}
                          >
                            <Group gap="sm" align="flex-start" wrap="nowrap">
                              <ThemeIcon size={34} radius="md" variant="light" color="teal">
                                <item.icon size={18} />
                              </ThemeIcon>
                              <div>
                                <Text fw={600} size="sm">
                                  {item.label}
                                </Text>
                                <Text size="xs" c="dimmed" lineClamp={2}>
                                  {item.description}
                                </Text>
                              </div>
                            </Group>
                          </UnstyledButton>
                        ))}
                      </SimpleGrid>
                    </div>
                  </Menu.Dropdown>
                </Menu>
              </Group>

              {/* Mobile menu */}
              <Group gap="xs" hiddenFrom="sm">
                <ActionIcon
                  variant={pathname?.startsWith('/dashboard/overview') ? 'filled' : 'light'}
                  radius="md"
                  onClick={() => handleNavClick('/dashboard/overview')}
                  aria-label={tNav('dashboardOverview')}
                >
                  <IconLayoutDashboard size={18} />
                </ActionIcon>

                <Menu position="bottom-start" withinPortal shadow="md">
                  <Menu.Target>
                    <ActionIcon variant="light" radius="md" aria-label={tNav('services')}>
                      <IconFolder size={18} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown className={classes.servicesMenuMobile}>
                    <div className={classes.servicesGrid}>
                      <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb={8}>
                        {tNav('servicesLabel')}
                      </Text>
                      <Stack gap="xs">
                        {serviceItems.map((item) => (
                          <UnstyledButton
                            key={item.href}
                            className={classes.servicesCard}
                            onClick={() => handleNavClick(item.href)}
                          >
                            <Group gap="sm" wrap="nowrap">
                              <ThemeIcon size={32} radius="md" variant="light" color="teal">
                                <item.icon size={16} />
                              </ThemeIcon>
                              <Text fw={500} size="sm">
                                {item.label}
                              </Text>
                            </Group>
                          </UnstyledButton>
                        ))}
                      </Stack>
                    </div>
                  </Menu.Dropdown>
                </Menu>
              </Group>
            </Group>

            {/* Center: Search */}
            <UnstyledButton
              visibleFrom="md"
              onClick={openGlobalSearch}
              className={classes.searchButton}
              style={{ flex: 1, maxWidth: 400 }}
            >
              <Group gap="xs" wrap="nowrap">
                <IconSearch size={16} color="var(--mantine-color-dimmed)" />
                <Text size="sm" c="dimmed">
                  {tNav('globalSearchPlaceholder')}
                </Text>
                <Text size="xs" c="dimmed" ml="auto" className={classes.searchShortcut}>
                  ⌘K
                </Text>
              </Group>
            </UnstyledButton>

            {/* Mobile Search */}
            <Tooltip label={tNav('globalSearchPlaceholder')} withArrow hiddenFrom="md">
              <ActionIcon
                hiddenFrom="md"
                variant="light"
                radius="md"
                onClick={openGlobalSearch}
                aria-label={tNav('globalSearchPlaceholder')}
              >
                <IconSearch size={18} />
              </ActionIcon>
            </Tooltip>

            {/* Right: Project, Docs, Account */}
            <Group gap="sm" wrap="nowrap">
              <ProjectSelector />

              <Tooltip label={tNav('docs')} withArrow>
                <ActionIcon
                  variant="light"
                  radius="md"
                  onClick={() => openDocs(DEFAULT_SDK_DOC)}
                  aria-label={tNav('docs')}
                >
                  <IconBook size={18} />
                </ActionIcon>
              </Tooltip>

              <Menu shadow="md" width={220} position="bottom-end">
                <Menu.Target>
                  <UnstyledButton className={classes.accountButton}>
                    <Group gap="xs" wrap="nowrap">
                      <Avatar color="teal" radius="xl" size="sm">
                        {defaultUser.name.charAt(0)}
                      </Avatar>
                      <div className={classes.accountDetails}>
                        <Text size="sm" fw={500} lineClamp={1}>
                          {defaultUser.name}
                        </Text>
                        <Text c="dimmed" size="xs">
                          {defaultUser.licenseType}
                        </Text>
                      </div>
                      <IconChevronDown size={14} />
                    </Group>
                  </UnstyledButton>
                </Menu.Target>

                <Menu.Dropdown>
                  <Menu.Label>{tAccount('menuLabel')}</Menu.Label>
                  <Menu.Item
                    leftSection={<IconSettings size={14} />}
                    onClick={() => handleNavClick('/dashboard/settings')}
                  >
                    {tAccount('settings')}
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Item
                    color="red"
                    leftSection={<IconLogout size={14} />}
                    onClick={handleLogout}
                  >
                    {tAccount('logout')}
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </Group>
          </Group>
        </AppShell.Header>

        <AppShell.Main>
          <Stack gap="md">
            <Group gap="sm" align="center" justify="space-between">
              <Group gap="sm" align="center">
                <DashboardBreadcrumbs />
              </Group>
            </Group>
            {children}
          </Stack>
        </AppShell.Main>

        <AppShell.Aside p="md" withBorder>
          <Stack gap="md" h="100%" style={{ minHeight: 0 }}>
            <Group justify="space-between" align="center" wrap="nowrap">
              <div style={{ minWidth: 0 }}>
                <Text fw={600}>Documentation</Text>
                <Text size="sm" c="dimmed" mt={4} lineClamp={1}>
                  {activeDoc.title}
                </Text>
              </div>
              <Group gap="xs" wrap="nowrap">
                <Button
                  component={Link}
                  href={activeDoc.url}
                  target="_blank"
                  rel="noreferrer"
                  variant="light"
                  leftSection={<IconExternalLink size={16} />}
                >
                  Open
                </Button>
                <ActionIcon
                  variant="light"
                  aria-label="Close documentation"
                  onClick={docsControls.close}
                >
                  <IconX size={16} />
                </ActionIcon>
              </Group>
            </Group>

            <div style={{ flex: 1, minHeight: 0 }}>
              <iframe
                title={activeDoc.title}
                src={activeDoc.url}
                style={{ width: '100%', height: '100%', border: 0, borderRadius: 12 }}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              />
            </div>
          </Stack>
        </AppShell.Aside>
      </AppShell>
    </DocsDrawerProvider>
  );
}
