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
  Kbd,
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
  IconLogout,
  IconSearch,
  IconSettings,
  IconTimeline,
  IconBrain,
  IconChevronUp,
} from '@tabler/icons-react';
import { ReactNode } from 'react';
import DashboardBreadcrumbs from './DashboardBreadcrumbs';
import { useTranslations } from '@/lib/i18n';
import classes from './DashboardLayout.module.css';

interface DashboardLayoutProps {
  children: ReactNode;
  user?: {
    name: string;
    email: string;
    licenseType: string;
  };
}

export default function DashboardLayout({
  children,
  user,
}: DashboardLayoutProps) {
  const router = useRouter();
  const [opened, { toggle, close, open }] = useDisclosure(true);
  const pathname = usePathname();
  const t = useTranslations('layout');
  const tNav = useTranslations('navigation');
  const tNotifications = useTranslations('notifications');
  const tAccount = useTranslations('account');
  const isMobile = useMediaQuery('(max-width: 48em)');

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
  };

  const navItems = [
    {
      label: tNav('models'),
      icon: IconBrain,
      href: '/dashboard/models',
    },
    {
      label: tNav('agentTracing'),
      icon: IconTimeline,
      href: '/dashboard/tracing',
    },
    {
      label: tNav('settings'),
      icon: IconSettings,
      href: '/dashboard/settings',
    },
  ];

  const handleNavClick = (href?: string) => {
    if (!href) return;
    router.push(href);
    if (isMobile) {
      close();
    }
  };

  const navbarWidth = opened ? 240 : 76;
  const collapseLabel = opened ? 'Collapse sidebar' : 'Expand sidebar';

  return (
    <AppShell
      navbar={{
        width: navbarWidth,
        breakpoint: 'sm',
        collapsed: { mobile: !opened },
      }}
      padding="md">
      <AppShell.Navbar p="sm" className={classes.navbar} withBorder={false}>
        <Stack gap="md" className={classes.sidebarContent}>
          <Stack gap="xs" className={classes.logoRow}>
            <Group align="center" w="100%">
              <div
                className={classes.logoInner}
                data-opened={opened ? 'true' : undefined}>
                <Link
                  href="/dashboard"
                  className={classes.logoLink}
                  aria-label="Cognipeer dashboard">
                  {opened ? (
                    <>
                      <Image
                        src="/images/cognipeer-logo-d.png"
                        alt="Cognipeer logo"
                        width={180}
                        height={42}
                        className={classes.logoDark}
                      />
                      <Image
                        src="/images/cognipeer-logo-w.png"
                        alt="Cognipeer logo"
                        width={180}
                        height={42}
                        className={classes.logoLight}
                      />
                    </>
                  ) : (
                    <Image
                      src="/images/cognipeer-icon.png"
                      alt="Cognipeer icon"
                      width={38}
                      height={38}
                    />
                  )}
                </Link>
              </div>

              <Tooltip
                label={collapseLabel}
                position="right"
                withArrow
                withinPortal>
                <ActionIcon
                  variant="filled"
                  size="sm"
                  radius="lg"
                  className={classes.collapseControl}
                  visibleFrom="sm"
                  onClick={toggle}
                  aria-label={collapseLabel}>
                  {opened ? (
                    <IconChevronsLeft size={16} />
                  ) : (
                    <IconChevronsRight size={16} />
                  )}
                </ActionIcon>
              </Tooltip>
            </Group>
          </Stack>

          {opened ? (
            <Button
              variant="outline"
              color="gray"
              leftSection={<IconSearch size={16} />}
              className={classes.searchButton}>
              <Group gap={8} justify="space-between">
                <Text size="sm" fw={500}>
                  Search
                </Text>
                <span className={classes.searchShortcut}>
                  <Kbd size="xs">Ctrl</Kbd>
                  <Text component="span" size="xs">
                    +
                  </Text>
                  <Kbd size="xs">K</Kbd>
                </span>
              </Group>
            </Button>
          ) : (
            <Tooltip label="Search" position="right" withArrow>
              <ActionIcon
                variant="outline"
                color="gray"
                size="lg"
                className={classes.collapsedSearch}
                aria-label="Search">
                <IconSearch size={18} />
              </ActionIcon>
            </Tooltip>
          )}

          <Divider size="xs" />

          <Stack gap={4} className={classes.navLinks}>
            {navItems.map((item) => {
              const itemHref = item.href;
              const isActive = itemHref
                ? pathname === itemHref || pathname.startsWith(`${itemHref}/`)
                : false;
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
                  disabled={opened}>
                  <Link
                    href={itemHref}
                    onClick={(event) => {
                      event.preventDefault();
                      handleNavClick(itemHref);
                    }}
                    data-active={isActive || undefined}
                    className={linkClassName}>
                    <Group gap={10} justify={opened ? 'flex-start' : 'center'}>
                      <item.icon size={20} />
                      {opened && <Text size="sm">{item.label}</Text>}
                    </Group>
                  </Link>
                </Tooltip>
              );
            })}
          </Stack>

          <div className={classes.footer}>
            <Menu shadow="md" width={220}>
              <Menu.Target>
                <UnstyledButton
                  className={classes.accountButton}
                  style={{
                    padding: opened ? '8px 10px' : '8px 0',
                    justifyContent: opened ? 'unset' : 'center',
                  }}>
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
                      <IconChevronUp size={16} />
                    </>
                  )}
                </UnstyledButton>
              </Menu.Target>

              <Menu.Dropdown>
                <Menu.Label>{tAccount('menuLabel')}</Menu.Label>
                <Menu.Item
                  leftSection={<IconSettings size={14} />}
                  onClick={() => handleNavClick('/dashboard/settings')}>
                  {tAccount('settings')}
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item
                  color="red"
                  leftSection={<IconLogout size={14} />}
                  onClick={handleLogout}>
                  {tAccount('logout')}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </div>
        </Stack>
      </AppShell.Navbar>

      <AppShell.Main>
        <Stack gap="md">
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
          {children}
        </Stack>
      </AppShell.Main>
    </AppShell>
  );
}
