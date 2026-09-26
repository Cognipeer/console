'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  IconHelp,
  IconLayoutDashboard,
  IconSettings,
} from '@tabler/icons-react';
import { Tooltip } from '@mantine/core';
import classes from './LauncherShell.module.css';
import type { DashboardServiceDefinition } from '@/lib/utils/dashboardServices';
import { useTranslations } from '@/lib/i18n';
import {
  useIntentPrefetch,
  usePendingNavigationKey,
} from '@/components/common/navigation/useNavigationFeedback';
import { getKeyPathname, isNavigationPendingFor } from '@/lib/navigation/navigationProgress';
import { findServiceForPath } from './ServiceSubNav';

interface SlimRailProps {
  pinned: DashboardServiceDefinition[];
  recents: DashboardServiceDefinition[];
  activeServiceId: string | null;
  onLauncherClick: () => void;
  settingsHref: string;
  settingsActive: boolean;
}

export default function SlimRail({
  pinned,
  recents,
  activeServiceId,
  onLauncherClick,
  settingsHref,
  settingsActive,
}: SlimRailProps) {
  const pathname = usePathname();
  const tNav = useTranslations('navigation');
  const pendingKey = usePendingNavigationKey();
  const { getIntentProps } = useIntentPrefetch({ kind: 'full' });
  // Instant acknowledgement: the rail item that owns the in-flight target is
  // marked pending; the committed active state stays pathname-derived.
  const pendingServiceId = pendingKey
    ? findServiceForPath([...pinned, ...recents], getKeyPathname(pendingKey))?.id ?? null
    : null;
  const isHrefPending = (href: string) =>
    typeof window !== 'undefined' && isNavigationPendingFor(pendingKey, href, window.location.href);
  const pendingAttr = (pending: boolean, active: boolean) =>
    pending && !active ? 'true' : undefined;

  const renderService = (
    service: DashboardServiceDefinition,
    opts: { recent?: boolean } = {},
  ) => {
    const Icon = service.icon;
    const isActive = activeServiceId === service.id;
    return (
      <Tooltip
        key={`${opts.recent ? 'r-' : 'p-'}${service.id}`}
        label={`${tNav(service.navLabelKey)}${opts.recent ? ' · recent' : ''}`}
        position="right"
        withArrow
        offset={8}
        openDelay={120}
      >
        <Link
          href={service.href}
          className={`${classes.railBtn} ${isActive ? classes.railBtnActive : ''}`}
          style={opts.recent ? { opacity: 0.75 } : undefined}
          aria-label={tNav(service.navLabelKey)}
          aria-current={isActive ? 'page' : undefined}
          data-pending={pendingAttr(pendingServiceId === service.id, isActive)}
          {...getIntentProps(service.href)}
        >
          <Icon size={opts.recent ? 16 : 18} stroke={1.7} />
        </Link>
      </Tooltip>
    );
  };

  const overviewActive = pathname === '/dashboard' || pathname?.startsWith('/dashboard/overview');

  return (
    <aside className={classes.rail}>
      <Tooltip
        label="All services · ⌘K"
        position="right"
        withArrow
        offset={8}
        openDelay={120}
      >
        <button
          type="button"
          className={`${classes.railBtn} ${classes.railBtnLauncher}`}
          onClick={onLauncherClick}
          aria-label="Open services launcher"
        >
          <span className={classes.dotGrid} aria-hidden="true">
            {Array.from({ length: 9 }).map((_, i) => (
              <i key={i} />
            ))}
          </span>
        </button>
      </Tooltip>

      <Tooltip label="Home" position="right" withArrow offset={8} openDelay={120}>
        <Link
          href="/dashboard/overview"
          className={`${classes.railBtn} ${overviewActive ? classes.railBtnActive : ''}`}
          aria-label="Home"
          aria-current={overviewActive ? 'page' : undefined}
          data-pending={pendingAttr(isHrefPending('/dashboard/overview'), Boolean(overviewActive))}
          {...getIntentProps('/dashboard/overview')}
        >
          <IconLayoutDashboard size={18} stroke={1.7} />
        </Link>
      </Tooltip>

      <div className={classes.railDivider} />

      {pinned.map((service) => renderService(service))}

      {pinned.length > 0 && recents.length > 0 ? (
        <div className={classes.railDivider} />
      ) : null}

      {recents.map((service) => renderService(service, { recent: true }))}

      <div className={classes.railSpacer} />

      <div className={classes.railDivider} />
      <Tooltip label="Settings" position="right" withArrow offset={8} openDelay={120}>
        <Link
          href={settingsHref}
          className={`${classes.railBtn} ${settingsActive ? classes.railBtnActive : ''}`}
          aria-label="Settings"
          aria-current={settingsActive ? 'page' : undefined}
          data-pending={pendingAttr(isHrefPending(settingsHref), settingsActive)}
          {...getIntentProps(settingsHref)}
        >
          <IconSettings size={17} stroke={1.7} />
        </Link>
      </Tooltip>
      <Tooltip label="Help" position="right" withArrow offset={8} openDelay={120}>
        <Link
          href="/dashboard/docs"
          className={classes.railBtn}
          aria-label="Help"
          data-pending={pendingAttr(isHrefPending('/dashboard/docs'), false)}
          {...getIntentProps('/dashboard/docs')}
        >
          <IconHelp size={17} stroke={1.7} />
        </Link>
      </Tooltip>
    </aside>
  );
}
