'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ActionIcon,
  AppShell,
  Avatar,
  Burger,
  Button,
  Divider,
  Group,
  Menu,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconChevronDown,
  IconChevronsLeft,
  IconChevronsRight,
  IconExternalLink,
  IconLayoutDashboard,
  IconLogout,
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
  const [opened, { toggle, close, open }] = useDisclosure(true);
  const [docsOpened, docsControls] = useDisclosure(false);
  const [docsDocId, setDocsDocId] = useState<SdkDocId>(DEFAULT_SDK_DOC);
  const pathname = usePathname();
  const t = useTranslations('layout');
  const tNav = useTranslations('navigation');
  const tNotifications = useTranslations('notifications');
  const tAccount = useTranslations('account');
  const isMobile = useMediaQuery('(max-width: 48em)');

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

  const navItems = [
    {
      label: tNav('dashboard'),
      icon: IconLayoutDashboard,
      href: '/dashboard',
    },
    {
      label: tNav('models'),
      icon: IconBrain,
      href: '/dashboard/models',
    },
    {
      label: tNav('prompts'),
      icon: IconSparkles,
      href: '/dashboard/prompts',
    },
    {
      label: tNav('vector'),
      icon: IconVectorBezier,
      href: '/dashboard/vector',
    },
    {
      label: tNav('files'),
      icon: IconFolder,
      href: '/dashboard/files',
    },
    {
      label: tNav('agentTracing'),
      icon: IconTimeline,
      href: '/dashboard/tracing',
    },
    ...(!isTenantAdmin
      ? [
        {
          label: tNav('settings'),
          icon: IconSettings,
          href: '/dashboard/settings',
        }
      ]
      : []),
    ...(isTenantAdmin
      ? [
        {
          label: tNav('tenantSettings'),
          icon: IconSettings,
          href: '/dashboard/tenant-settings',
        },
      ]
      : []),
  ];

  const activeNavHref = navItems
    .map((item) => item.href)
    .filter((href): href is string => typeof href === 'string' && href.length > 0)
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];

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
    if (isMobile) {
      close();
    }
  };

  const navbarWidth = opened ? 240 : 76;
  const collapseLabel = opened ? 'Collapse sidebar' : 'Expand sidebar';

  return (
    <DocsDrawerProvider value={{ openDocs }}>
      <AppShell
        navbar={{
          width: navbarWidth,
          breakpoint: 'sm',
          collapsed: { mobile: !opened },
        }}
        aside={{
          width: 560,
          breakpoint: 'md',
          collapsed: { desktop: !docsOpened, mobile: !docsOpened },
        }}
        padding="md"
      >
        <AppShell.Navbar p="sm" className={classes.navbar} withBorder={false}>
          <Stack gap="md" className={classes.sidebarContent}>
          <Stack gap="xs" className={classes.logoRow}>
            <Group align="center" w="100%">
              <div
                className={classes.logoInner}
                data-opened={opened ? 'true' : undefined}
              >
                <Link href="/" className={classes.logoLink} aria-label="Cognipeer dashboard">
                  {opened ? (
                    <>
                      <Image
                        src="/images/cognipeer-logo-d.png"
                        alt="Cognipeer logo"
                        width={180}
                        height={42}
                        className={classes.logoDark}
                        priority
                      />
                      <Image
                        src="/images/cognipeer-logo-w.png"
                        alt="Cognipeer logo"
                        width={180}
                        height={42}
                        className={classes.logoLight}
                        priority
                      />
                    </>
                  ) : (
                    <></>
                    // <Image
                    //   src="/images/cognipeer-icon.png"
                    //   alt="Cognipeer icon"
                    //   width={100}
                    //   height={100}
                    //   priority
                    // />
                  )}
                </Link>
              </div>

              <Tooltip label={collapseLabel} position="right" withArrow withinPortal>
                <ActionIcon
                  variant="filled"
                  size="sm"
                  radius="md"
                  className={classes.collapseControl}
                  visibleFrom="sm"
                  onClick={toggle}
                  aria-label={collapseLabel}
                >
                  {opened ? <IconChevronsLeft size={16} /> : <IconChevronsRight size={16} />}
                </ActionIcon>
              </Tooltip>
            </Group>
          </Stack>

          <Divider size="xs" />

          {opened ? (
            <>
              <ProjectSelector />
              <Divider size="xs" />
            </>
          ) : null}

          <ScrollArea.Autosize mah="100%" className={classes.navLinks} offsetScrollbars>
            <Stack gap={4}>
              {navItems.map((item) => {
                const itemHref = item.href;
                const isActive = itemHref ? itemHref === activeNavHref : false;
                const linkClassName = [
                  classes.menuLink,
                  classes.mainLink,
                  !opened ? classes.menuLinkCollapsed : '',
                ]
                  .filter(Boolean)
                  .join(' ');

                return (
                  <Tooltip
                    key={item.label}
                    label={item.label}
                    position="right"
                    withArrow
                    disabled={opened}
                  >
                    <Link
                      href={itemHref}
                      onClick={(event) => {
                        event.preventDefault();
                        handleNavClick(itemHref);
                      }}
                      data-active={isActive || undefined}
                      className={linkClassName}
                    >
                      <Group gap={10} justify={opened ? 'flex-start' : 'center'}>
                        <item.icon size={20} />
                        {opened && <Text size="sm">{item.label}</Text>}
                      </Group>
                    </Link>
                  </Tooltip>
                );
              })}
            </Stack>
          </ScrollArea.Autosize>

          <div className={classes.footer}>
            <Tooltip label={tNav('docs')} position="right" withArrow disabled={opened}>
              <UnstyledButton
                className={classes.menuLink}
                onClick={() => openDocs(DEFAULT_SDK_DOC)}
              >
                <Group gap={10} justify={opened ? 'flex-start' : 'center'}>
                  <IconBook size={20} />
                  {opened && <Text size="sm">{tNav('docs')}</Text>}
                </Group>
              </UnstyledButton>
            </Tooltip>

            <Divider my="xs" />

            <Menu shadow="md" width={220}>
              <Menu.Target>
                <UnstyledButton className={classes.accountButton}>
                  <Group
                    gap="xs"
                    justify={opened ? 'flex-start' : 'center'}
                    wrap="nowrap"
                  >
                    <Avatar color="teal" radius="xl">
                      {defaultUser.name.charAt(0)}
                    </Avatar>
                    {opened && (
                      <>
                        <div className={classes.accountDetails}>
                          <Text size="sm" fw={500}>
                            {defaultUser.name}
                          </Text>
                          <Text c="dimmed" size="xs">
                            {defaultUser.licenseType}
                          </Text>
                        </div>
                        <IconChevronDown size={16} />
                      </>
                    )}
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
          </div>
          </Stack>
        </AppShell.Navbar>

        <AppShell.Main>
          <Stack gap="md">
            <Group gap="sm" align="center" justify="space-between">
              <Group gap="sm" align="center">
                <Burger
                  opened={opened}
                  onClick={() => (opened ? close() : open())}
                  hiddenFrom="sm"
                  size="sm"
                  aria-label={opened ? 'Close sidebar' : 'Open sidebar'}
                />
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
