'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ActionIcon, Text } from '@mantine/core';
import {
  IconBook,
  IconExternalLink,
  IconLayoutDashboard,
  IconLayoutGrid,
  IconSettings,
  IconX,
} from '@tabler/icons-react';
import classes from './LauncherShell.module.css';
import { SUBNAV_CONFIG, type SubNavItem } from './ServiceSubNav';
import type { DashboardServiceDefinition } from '@/lib/utils/dashboardServices';
import { useTranslations } from '@/lib/i18n';
import { usePendingNavigationKey } from '@/components/common/navigation/useNavigationFeedback';
import { isNavigationPendingFor } from '@/lib/navigation/navigationProgress';

interface MobileNavDrawerProps {
  open: boolean;
  onClose: () => void;
  pathname: string;
  pinned: DashboardServiceDefinition[];
  recents: DashboardServiceDefinition[];
  activeService: DashboardServiceDefinition | null;
  onOpenLauncher: () => void;
  onOpenDocs: () => void;
  /** Overrides the active service's sub-nav (used for the Settings section). */
  subnavOverride?: { title: string; items: SubNavItem[] } | null;
  settingsHref: string;
  settingsActive: boolean;
}

export default function MobileNavDrawer({
  open,
  onClose,
  pathname,
  pinned,
  recents,
  activeService,
  onOpenLauncher,
  onOpenDocs,
  subnavOverride = null,
  settingsHref,
  settingsActive,
}: MobileNavDrawerProps) {
  const rawSearchParams = useSearchParams();
  const pendingKey = usePendingNavigationKey();
  const searchParams = new URLSearchParams(rawSearchParams?.toString() ?? '');
  const tNav = useTranslations('navigation');

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  const pendingAttr = (href: string, active: boolean) =>
    !active && isNavigationPendingFor(pendingKey, href, window.location.href)
      ? 'true'
      : undefined;

  const overviewActive =
    pathname === '/dashboard' || pathname?.startsWith('/dashboard/overview');
  const subnavItems =
    subnavOverride?.items ??
    (activeService ? (SUBNAV_CONFIG[activeService.id] ?? []) : []);
  const subnavTitle =
    subnavOverride?.title ??
    (activeService ? tNav(activeService.navLabelKey) : '');

  const renderServiceItem = (service: DashboardServiceDefinition) => {
    const Icon = service.icon;
    const isActive = activeService?.id === service.id;
    return (
      <Link
        key={service.id}
        href={service.href}
        className={`${classes.mobileNavItem} ${isActive ? classes.mobileNavItemActive : ''}`}
        onNavigate={onClose}
        aria-current={isActive ? 'page' : undefined}
        data-pending={pendingAttr(service.href, isActive)}
      >
        <span className={classes.mobileNavItemIcon}>
          <Icon size={17} stroke={1.7} />
        </span>
        <span>{tNav(service.navLabelKey)}</span>
      </Link>
    );
  };

  return (
    <div
      className={classes.mobileNavOverlay}
      role="dialog"
      aria-modal="true"
      aria-label="Navigation"
    >
      <button
        type="button"
        className={classes.mobileNavBackdrop}
        onClick={onClose}
        aria-label="Close navigation"
        tabIndex={-1}
      />
      <nav className={classes.mobileNavPanel}>
        <div className={classes.mobileNavHeader}>
          <Text fw={600} size="sm">
            Navigation
          </Text>
          <ActionIcon
            variant="subtle"
            color="gray"
            radius="md"
            onClick={onClose}
            aria-label="Close navigation"
          >
            <IconX size={16} />
          </ActionIcon>
        </div>

        <button
          type="button"
          className={classes.mobileNavBrowseAll}
          onClick={() => {
            onClose();
            onOpenLauncher();
          }}
        >
          <IconLayoutGrid size={16} stroke={1.8} />
          <span>Browse all services</span>
        </button>

        <div className={classes.mobileNavSection}>
          <Link
            href="/dashboard/overview"
            className={`${classes.mobileNavItem} ${overviewActive ? classes.mobileNavItemActive : ''}`}
            onNavigate={onClose}
            aria-current={overviewActive ? 'page' : undefined}
            data-pending={pendingAttr('/dashboard/overview', Boolean(overviewActive))}
          >
            <span className={classes.mobileNavItemIcon}>
              <IconLayoutDashboard size={17} stroke={1.7} />
            </span>
            <span>Home</span>
          </Link>
        </div>

        {pinned.length > 0 ? (
          <div className={classes.mobileNavSection}>
            <div className={classes.mobileNavSectionTitle}>Pinned</div>
            {pinned.map(renderServiceItem)}
          </div>
        ) : null}

        {recents.length > 0 ? (
          <div className={classes.mobileNavSection}>
            <div className={classes.mobileNavSectionTitle}>Recent</div>
            {recents.map(renderServiceItem)}
          </div>
        ) : null}

        {subnavItems.length > 0 ? (
          <>
            <div className={classes.mobileNavDivider} />
            <div className={classes.mobileNavSection}>
              <div className={classes.mobileNavSectionTitle}>{subnavTitle}</div>
              {subnavItems.map((item) => {
                const ItemIcon = item.icon;
                const active = item.matcher
                  ? item.matcher(pathname, searchParams)
                  : pathname === item.href;
                return (
                  <Link
                    key={item.id}
                    href={item.href}
                    className={`${classes.mobileNavItem} ${active ? classes.mobileNavItemActive : ''}`}
                    onNavigate={onClose}
                    aria-current={active ? 'page' : undefined}
                    data-pending={pendingAttr(item.href, active)}
                  >
                    <span className={classes.mobileNavItemIcon}>
                      <ItemIcon size={16} stroke={1.7} />
                    </span>
                    <span>{item.label}</span>
                    {item.badge ? (
                      <span className={classes.subnavBadge}>{item.badge}</span>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          </>
        ) : null}

        <div className={classes.mobileNavDivider} />
        <div className={classes.mobileNavSection}>
          <Link
            href={settingsHref}
            className={`${classes.mobileNavItem} ${settingsActive ? classes.mobileNavItemActive : ''}`}
            onNavigate={onClose}
            aria-current={settingsActive ? 'page' : undefined}
            data-pending={pendingAttr(settingsHref, settingsActive)}
          >
            <span className={classes.mobileNavItemIcon}>
              <IconSettings size={16} stroke={1.7} />
            </span>
            <span>Settings</span>
          </Link>
          <button
            type="button"
            className={classes.mobileNavItem}
            onClick={() => {
              onClose();
              onOpenDocs();
            }}
          >
            <span className={classes.mobileNavItemIcon}>
              <IconBook size={16} stroke={1.7} />
            </span>
            <span>Documentation</span>
            <IconExternalLink size={12} stroke={1.7} className={classes.mobileNavExternal} />
          </button>
        </div>
      </nav>
    </div>
  );
}
