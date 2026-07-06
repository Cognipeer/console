'use client';

import Image from 'next/image';
import Link from 'next/link';
import {
  ActionIcon,
  Avatar,
  Group,
  Menu,
  Text,
  Tooltip,
  UnstyledButton,
  useMantineColorScheme,
} from '@mantine/core';
import {
  IconBook,
  IconCertificate,
  IconChevronDown,
  IconLogout,
  IconMenu2,
  IconMoon,
  IconSearch,
  IconSettings,
  IconSun,
} from '@tabler/icons-react';
import ProjectPill from '@/components/projects/ProjectPill';
import { useTranslations } from '@/lib/i18n';
import classes from './LauncherShell.module.css';

interface TopbarV2Props {
  user: {
    name: string;
    email: string;
    licenseType: string;
  };
  isTenantAdmin: boolean;
  onSearchClick: () => void;
  onLauncherClick: () => void;
  onDocsClick: () => void;
  onLogout: () => void;
  onNavigate: (href: string) => void;
  onMobileNavClick: () => void;
}

export default function TopbarV2({
  user,
  isTenantAdmin,
  onSearchClick,
  onLauncherClick,
  onDocsClick,
  onLogout,
  onNavigate,
  onMobileNavClick,
}: TopbarV2Props) {
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const tNav = useTranslations('navigation');
  const tAccount = useTranslations('account');

  const isDark = colorScheme === 'dark';

  return (
    <header className={classes.topbar}>
      <ActionIcon
        variant="subtle"
        color="gray"
        radius="md"
        size="lg"
        className={classes.hamburgerBtn}
        onClick={onMobileNavClick}
        aria-label="Open navigation"
      >
        <IconMenu2 size={18} stroke={1.8} />
      </ActionIcon>

      <Link
        href="/dashboard/overview"
        className={classes.brand}
        aria-label="Cognipeer dashboard"
      >
        <Image
          src="/images/cognipeer-logo-d.png"
          alt="Cognipeer"
          width={130}
          height={28}
          className={classes.logoDark}
          priority
        />
        <Image
          src="/images/cognipeer-logo-w.png"
          alt="Cognipeer"
          width={130}
          height={28}
          className={classes.logoLight}
          priority
        />
      </Link>

      <button
        type="button"
        onClick={onLauncherClick}
        className={classes.svcTrigger}
        aria-label={tNav('servicesLabel')}
      >
        <span className={classes.dotGridSm} aria-hidden="true">
          {Array.from({ length: 9 }).map((_, i) => (
            <i key={i} />
          ))}
        </span>
        <span>{tNav('services')}</span>
        <IconChevronDown size={13} stroke={2} />
      </button>

      <UnstyledButton
        onClick={onSearchClick}
        className={classes.searchBox}
        aria-label={tNav('globalSearchPlaceholder')}
      >
        <IconSearch size={15} stroke={1.7} />
        <Text component="span" className={classes.searchPlaceholder}>
          {tNav('globalSearchPlaceholder')}
        </Text>
        <span className={classes.kbd}>⌘K</span>
      </UnstyledButton>

      <ProjectPill />

      <Tooltip label={isDark ? 'Light mode' : 'Dark mode'} withArrow>
        <ActionIcon
          variant="subtle"
          color="gray"
          radius="md"
          size="lg"
          onClick={() => toggleColorScheme()}
          aria-label="Toggle theme"
        >
          {isDark ? <IconSun size={16} /> : <IconMoon size={16} />}
        </ActionIcon>
      </Tooltip>

      <Tooltip label={tNav('docs')} withArrow>
        <ActionIcon
          variant="subtle"
          color="gray"
          radius="md"
          size="lg"
          className={classes.hideOnMobile}
          onClick={onDocsClick}
          aria-label={tNav('docs')}
        >
          <IconBook size={16} />
        </ActionIcon>
      </Tooltip>

      <Menu shadow="md" width={220} position="bottom-end">
        <Menu.Target>
          <UnstyledButton className={classes.accountBtn} aria-label="Account menu">
            <Group gap="xs" wrap="nowrap">
              <Avatar color="teal" radius="xl" size={30}>
                {user.name.charAt(0).toUpperCase()}
              </Avatar>
              <div className={classes.accountInfo}>
                <Text size="sm" fw={500} lineClamp={1}>
                  {user.name}
                </Text>
                <Text c="dimmed" size="xs" lineClamp={1}>
                  {user.licenseType}
                </Text>
              </div>
              <IconChevronDown size={13} />
            </Group>
          </UnstyledButton>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>{tAccount('menuLabel')}</Menu.Label>
          <Menu.Item
            leftSection={<IconSettings size={14} />}
            onClick={() => onNavigate('/dashboard/tokens')}
          >
            {tAccount('settings')}
          </Menu.Item>
          {isTenantAdmin ? (
            <Menu.Item
              leftSection={<IconCertificate size={14} />}
              onClick={() => onNavigate('/dashboard/license')}
            >
              {tAccount('license')}
            </Menu.Item>
          ) : null}
          <Menu.Divider />
          <Menu.Item color="red" leftSection={<IconLogout size={14} />} onClick={onLogout}>
            {tAccount('logout')}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </header>
  );
}
