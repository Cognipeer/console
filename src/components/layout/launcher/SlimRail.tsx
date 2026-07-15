'use client';

import { useRouter, usePathname } from 'next/navigation';
import {
  IconHelp,
  IconLayoutDashboard,
  IconSettings,
} from '@tabler/icons-react';
import { Tooltip } from '@mantine/core';
import classes from './LauncherShell.module.css';
import type { DashboardServiceDefinition } from '@/lib/utils/dashboardServices';
import { useTranslations } from '@/lib/i18n';

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
  const router = useRouter();
  const pathname = usePathname();
  const tNav = useTranslations('navigation');

  const goTo = (href: string) => router.push(href);

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
        <button
          type="button"
          onClick={() => goTo(service.href)}
          className={`${classes.railBtn} ${isActive ? classes.railBtnActive : ''}`}
          style={opts.recent ? { opacity: 0.75 } : undefined}
          aria-label={tNav(service.navLabelKey)}
          aria-current={isActive ? 'page' : undefined}
        >
          <Icon size={opts.recent ? 16 : 18} stroke={1.7} />
        </button>
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
        <button
          type="button"
          className={`${classes.railBtn} ${overviewActive ? classes.railBtnActive : ''}`}
          onClick={() => goTo('/dashboard/overview')}
          aria-label="Home"
          aria-current={overviewActive ? 'page' : undefined}
        >
          <IconLayoutDashboard size={18} stroke={1.7} />
        </button>
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
        <button
          type="button"
          className={`${classes.railBtn} ${settingsActive ? classes.railBtnActive : ''}`}
          aria-label="Settings"
          aria-current={settingsActive ? 'page' : undefined}
          onClick={() => goTo(settingsHref)}
        >
          <IconSettings size={17} stroke={1.7} />
        </button>
      </Tooltip>
      <Tooltip label="Help" position="right" withArrow offset={8} openDelay={120}>
        <button
          type="button"
          className={classes.railBtn}
          aria-label="Help"
          onClick={() => goTo('/dashboard/docs')}
        >
          <IconHelp size={17} stroke={1.7} />
        </button>
      </Tooltip>
    </aside>
  );
}
