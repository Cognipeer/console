'use client';

/**
 * The single left menu (see sidebarNav.ts): Home, the pinned services, the services the person can open under their
 * categories (each category folds), Settings, help and a toggle to an icon-only strip. The service in view opens
 * its pages in place; Settings opens its grouped pages while one of them is in view. Someone with few services gets
 * one plain list instead of categories.
 *
 * What it lists is decided by the shell, the same way as the rail and the sub-nav it replaces: `services` holds only
 * what the person may open (role, the engine's levels for the active project, tenant-admin pages, deployment), and
 * `activeItems` / `settingsItems` are the sub-nav entries already filtered for them.
 *
 * A phone has no side column: the top bar's drawer shows this same menu (`variant="drawer"`), always labelled, without
 * the collapse toggle, and closing when a link in it is followed (`onNavigate`).
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Tooltip } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconBook,
  IconChevronDown,
  IconChevronRight,
  IconLayoutDashboard,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconPin,
  IconPinFilled,
  IconSettings,
  type Icon,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { DashboardServiceDefinition } from '@/lib/utils/dashboardServices';
import {
  useIntentPrefetch,
  usePendingNavigationKey,
} from '@/components/common/navigation/useNavigationFeedback';
import { isNavigationPendingFor } from '@/lib/navigation/navigationProgress';
import type { SubNavItem } from './ServiceSubNav';
import { SIDEBAR_NARROW_QUERY, isFlatSidebar, sidebarGroups, sidebarServices } from './sidebarNav';
import classes from './Sidebar.module.css';

const COLLAPSED_KEY = 'cgn:sidebar:collapsed';
const CLOSED_GROUPS_KEY = 'cgn:sidebar:closed-groups';
const HOME_HREF = '/dashboard/overview';

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private window or blocked storage: the choice lasts until reload */
  }
}

/**
 * Icon-only or labelled, and which categories are folded: this browser's choice, read after the first render.
 * A narrow window or a tablet (SIDEBAR_NARROW_QUERY) starts with the icons whatever was chosen on a wide screen,
 * since the labelled menu left the page about 550px there; opening it lasts for the visit and is not stored.
 */
function useSidebarPrefs(activeCategory: string | undefined) {
  const [loaded, setLoaded] = useState(false);
  const [storedCollapsed, setStoredCollapsed] = useState(false);
  const narrow = useMediaQuery(SIDEBAR_NARROW_QUERY) ?? false;
  const [narrowOpen, setNarrowOpen] = useState(false);
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const collapsed = narrow ? !narrowOpen : storedCollapsed;

  useEffect(() => {
    setStoredCollapsed(readStored<boolean>(COLLAPSED_KEY, false) === true);
    const stored = readStored<unknown>(CLOSED_GROUPS_KEY, []);
    setClosedGroups(new Set(Array.isArray(stored) ? stored.filter((v): v is string => typeof v === 'string') : []));
    setLoaded(true);
  }, []);

  // Arriving at a service opens its category, even one folded earlier; it can be folded again after.
  useEffect(() => {
    if (!loaded || !activeCategory) return;
    setClosedGroups((previous) => {
      if (!previous.has(activeCategory)) return previous;
      const next = new Set(previous);
      next.delete(activeCategory);
      writeStored(CLOSED_GROUPS_KEY, [...next]);
      return next;
    });
  }, [loaded, activeCategory]);

  const toggleCollapsed = useCallback(() => {
    if (narrow) {
      setNarrowOpen((open) => !open);
      return;
    }
    setStoredCollapsed((previous) => {
      writeStored(COLLAPSED_KEY, !previous);
      return !previous;
    });
  }, [narrow]);

  const toggleGroup = useCallback((category: string) => {
    setClosedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      writeStored(CLOSED_GROUPS_KEY, [...next]);
      return next;
    });
  }, []);

  return { collapsed, toggleCollapsed, closedGroups, toggleGroup };
}

export interface SidebarProps {
  /** The services the person may open (filtered by the shell). */
  services: DashboardServiceDefinition[];
  /** The service in view; null on Home and on a Settings page. */
  activeService: DashboardServiceDefinition | null;
  /** The pages of the service in view, filtered like its sub-nav. */
  activeItems?: SubNavItem[];
  /** The Settings pages the person may open, with their group headings. */
  settingsItems: SubNavItem[];
  settingsHref: string;
  settingsActive: boolean;
  pinnedIds: ReadonlySet<string>;
  onTogglePin: (id: string) => void;
  /** Opens the docs panel on the page of the service in view. */
  onHelpClick: () => void;
  pathname: string;
  /** `drawer`: inside the phone's menu drawer, always labelled and without the collapse toggle. */
  variant?: 'side' | 'drawer';
  /** Called when a link in the menu is followed or help is opened (the drawer closes). */
  onNavigate?: () => void;
}

export default function Sidebar({
  services,
  activeService,
  activeItems,
  settingsItems,
  settingsHref,
  settingsActive,
  pinnedIds,
  onTogglePin,
  onHelpClick,
  pathname,
  variant = 'side',
  onNavigate,
}: SidebarProps) {
  const drawer = variant === 'drawer';
  const tNav = useTranslations('navigation');
  const rawSearchParams = useSearchParams();
  const searchParams = useMemo(() => new URLSearchParams(rawSearchParams?.toString() ?? ''), [rawSearchParams]);
  const pendingKey = usePendingNavigationKey();
  const { getIntentProps } = useIntentPrefetch({ kind: 'full' });
  const prefs = useSidebarPrefs(activeService?.category);
  const { toggleCollapsed, closedGroups, toggleGroup } = prefs;
  // The drawer is the phone's whole menu: never the icon strip (a phone is "narrow", which starts the side menu folded).
  const collapsed = drawer ? false : prefs.collapsed;
  const openHelp = () => {
    onNavigate?.();
    onHelpClick();
  };

  const flat = isFlatSidebar(services);
  const listed = useMemo(() => sidebarServices(services), [services]);
  const groups = useMemo(() => sidebarGroups(services), [services]);
  const pinned = useMemo(() => listed.filter((service) => pinnedIds.has(service.id)), [listed, pinnedIds]);
  const homeActive = pathname === '/dashboard' || pathname.startsWith(HOME_HREF);
  const showSettings = settingsItems.length > 0;

  // The page in view stays in sight in a long menu (a Settings page sits below every category): the last marked
  // entry is the deepest one, the page under its service. Checked again when the rows above it settle — the pinned
  // list arrives after the first render (it is read from the browser) and the services once the engine has answered.
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasPinned = pinned.length > 0;
  const listedCount = listed.length;
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const marked = container.querySelectorAll<HTMLElement>('[aria-current]');
    const target = marked[marked.length - 1];
    if (!target) return;
    const box = container.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    if (rect.top < box.top || rect.bottom > box.bottom) {
      container.scrollTop += rect.top - box.top - box.height / 3;
    }
  }, [pathname, collapsed, settingsActive, hasPinned, listedCount]);

  const pendingFor = (href: string, active: boolean) =>
    !active && typeof window !== 'undefined' && isNavigationPendingFor(pendingKey, href, window.location.href)
      ? 'true'
      : undefined;
  const itemActive = (item: SubNavItem) =>
    item.matcher ? item.matcher(pathname, searchParams) : pathname === item.href;
  const itemLabel = (item: SubNavItem) => (item.labelKey ? tNav(item.labelKey) : item.label);

  // ── Icon-only strip ──────────────────────────────────────────────────────────
  if (collapsed) {
    const iconLink = (href: string, icon: Icon, label: string, active: boolean, testId: string, small = false) => {
      const ItemIcon = icon;
      return (
        <Tooltip key={testId} label={label} position="right" withArrow offset={8} openDelay={120}>
          <Link
            href={href}
            className={`${classes.iconBtn} ${small ? classes.iconBtnSmall : ''} ${active ? classes.iconBtnActive : ''}`}
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            data-pending={pendingFor(href, active)}
            data-testid={testId}
            onNavigate={onNavigate}
            {...getIntentProps(href)}
          >
            <ItemIcon size={small ? 15 : 18} stroke={1.7} />
          </Link>
        </Tooltip>
      );
    };
    const pagesOf = (items: SubNavItem[] | undefined) =>
      items && items.length > 1
        ? items.map((item) => iconLink(item.href, item.icon, itemLabel(item), itemActive(item), `sidebar-subitem-${item.id}`, true))
        : null;
    // The pinned services, and the one in view when it is not pinned; everything when the list is short.
    const strip = flat
      ? listed
      : activeService && !pinnedIds.has(activeService.id) && listed.some((s) => s.id === activeService.id)
        ? [...pinned, activeService]
        : pinned;

    return (
      <nav
        className={`${classes.sidebar} ${classes.collapsed}`}
        aria-label={tNav('sidebarLabel')}
        data-testid="sidebar-nav"
        data-collapsed="true"
      >
        <div className={classes.scroll} ref={scrollRef}>
          {iconLink(HOME_HREF, IconLayoutDashboard, tNav('sidebarHome'), homeActive, 'sidebar-home')}
          <div className={classes.iconDivider} />
          {strip.map((service) => (
            <Fragment key={service.id}>
              {iconLink(service.href, service.icon, tNav(service.navLabelKey), activeService?.id === service.id, `sidebar-service-${service.id}`)}
              {activeService?.id === service.id ? pagesOf(activeItems) : null}
            </Fragment>
          ))}
          <div className={classes.spacer} />
          {showSettings ? (
            <>
              {iconLink(settingsHref, IconSettings, tNav('settings'), settingsActive, 'sidebar-settings')}
              {settingsActive ? pagesOf(settingsItems) : null}
            </>
          ) : null}
        </div>
        <div className={classes.footer}>
          <Tooltip label={tNav('sidebarHelp')} position="right" withArrow offset={8} openDelay={120}>
            <button type="button" className={classes.iconBtn} aria-label={tNav('sidebarHelp')} onClick={openHelp}>
              <IconBook size={17} stroke={1.7} />
            </button>
          </Tooltip>
          <Tooltip label={tNav('sidebarExpand')} position="right" withArrow offset={8} openDelay={120}>
            <button
              type="button"
              className={classes.iconBtn}
              aria-label={tNav('sidebarExpand')}
              aria-expanded={false}
              onClick={toggleCollapsed}
              data-testid="sidebar-toggle"
            >
              <IconLayoutSidebarLeftExpand size={17} stroke={1.7} />
            </button>
          </Tooltip>
        </div>
      </nav>
    );
  }

  // ── Labelled menu ────────────────────────────────────────────────────────────
  // A service whose menu has one page (Files: Buckets) opens nothing: the page is the service's own link.
  const pages = (items: SubNavItem[] | undefined, ownerLabel: string): ReactNode =>
    items && items.length > 1 ? (
      <div className={classes.pages} role="group" aria-label={ownerLabel}>
        {items.map((item) => {
          const ItemIcon = item.icon;
          const active = itemActive(item);
          return (
            <Fragment key={item.id}>
              {item.sectionKey ? <div className={classes.pagesHeading}>{tNav(item.sectionKey)}</div> : null}
              <Link
                href={item.href}
                className={`${classes.page} ${active ? classes.pageActive : ''}`}
                aria-current={active ? 'page' : undefined}
                data-pending={pendingFor(item.href, active)}
                data-testid={`sidebar-subitem-${item.id}`}
                onNavigate={onNavigate}
                {...getIntentProps(item.href)}
              >
                <ItemIcon size={14} stroke={1.7} />
                <span className={classes.label}>{itemLabel(item)}</span>
                {item.badge ? <span className={classes.count}>{item.badge}</span> : null}
              </Link>
            </Fragment>
          );
        })}
      </div>
    ) : null;

  const serviceRow = (service: DashboardServiceDefinition, opts: { pinnable: boolean; opensPages: boolean; testScope: string }) => {
    const ServiceIcon = service.icon;
    const label = tNav(service.navLabelKey);
    const active = activeService?.id === service.id;
    const isPinned = pinnedIds.has(service.id);
    return (
      <Fragment key={`${opts.testScope}-${service.id}`}>
        <div className={classes.row}>
          <Link
            href={service.href}
            className={`${classes.item} ${active ? classes.itemActive : ''}`}
            aria-current={active ? 'true' : undefined}
            data-pending={pendingFor(service.href, active)}
            data-testid={`sidebar-${opts.testScope}-${service.id}`}
            onNavigate={onNavigate}
            {...getIntentProps(service.href)}
          >
            <ServiceIcon size={16} stroke={1.7} />
            <span className={classes.label}>{label}</span>
          </Link>
          {opts.pinnable ? (
            <button
              type="button"
              // Shown all the time in the pinned list (to unpin); elsewhere on hover, filled when pinned.
              className={`${classes.pin} ${isPinned ? classes.pinned : ''} ${isPinned && opts.testScope === 'pinned' ? classes.pinStay : ''}`}
              aria-label={tNav(isPinned ? 'sidebarUnpin' : 'sidebarPin', { service: label })}
              aria-pressed={isPinned}
              onClick={() => onTogglePin(service.id)}
            >
              {isPinned ? <IconPinFilled size={12} /> : <IconPin size={12} />}
            </button>
          ) : null}
        </div>
        {opts.opensPages && active ? pages(activeItems, label) : null}
      </Fragment>
    );
  };

  return (
    <nav
      className={`${classes.sidebar} ${drawer ? classes.drawer : ''}`}
      aria-label={tNav('sidebarLabel')}
      data-testid={drawer ? 'sidebar-drawer' : 'sidebar-nav'}
      data-flat={flat ? 'true' : undefined}
    >
      <div className={classes.scroll} ref={scrollRef}>
        <div className={classes.row}>
          <Link
            href={HOME_HREF}
            className={`${classes.item} ${homeActive ? classes.itemActive : ''}`}
            aria-current={homeActive ? 'page' : undefined}
            data-pending={pendingFor(HOME_HREF, homeActive)}
            data-testid="sidebar-home"
            onNavigate={onNavigate}
            {...getIntentProps(HOME_HREF)}
          >
            <IconLayoutDashboard size={16} stroke={1.7} />
            <span className={classes.label}>{tNav('sidebarHome')}</span>
          </Link>
        </div>

        {flat ? (
          <div className={classes.section}>
            {listed.map((service) => serviceRow(service, { pinnable: false, opensPages: true, testScope: 'service' }))}
          </div>
        ) : (
          <>
            {pinned.length > 0 ? (
              <div className={classes.section} data-testid="sidebar-pinned">
                <div className={classes.sectionHeading}>
                  <span>{tNav('sidebarPinned')}</span>
                </div>
                {pinned.map((service) => serviceRow(service, { pinnable: true, opensPages: false, testScope: 'pinned' }))}
              </div>
            ) : null}
            <div className={classes.section}>
              <div className={classes.sectionHeading}>
                <span>{tNav('sidebarAllServices')}</span>
              </div>
              {groups.map((group) => {
                const open = !closedGroups.has(group.category);
                const listId = `sidebar-group-list-${group.category}`;
                return (
                  <div key={group.category} className={classes.group}>
                    <button
                      type="button"
                      className={classes.groupHeader}
                      aria-expanded={open}
                      aria-controls={listId}
                      onClick={() => toggleGroup(group.category)}
                      data-testid={`sidebar-group-${group.category}`}
                    >
                      {open ? <IconChevronDown size={12} stroke={2} /> : <IconChevronRight size={12} stroke={2} />}
                      <span className={classes.label}>{group.label}</span>
                      <span className={classes.count}>{group.services.length}</span>
                    </button>
                    {open ? (
                      <div id={listId}>
                        {group.services.map((service) => serviceRow(service, { pinnable: true, opensPages: true, testScope: 'service' }))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className={classes.spacer} />

        {showSettings ? (
          <div className={classes.section}>
            <div className={classes.row}>
              <Link
                href={settingsHref}
                className={`${classes.item} ${settingsActive ? classes.itemActive : ''}`}
                aria-current={settingsActive ? 'true' : undefined}
                data-pending={pendingFor(settingsHref, settingsActive)}
                data-testid="sidebar-settings"
                onNavigate={onNavigate}
                {...getIntentProps(settingsHref)}
              >
                <IconSettings size={16} stroke={1.7} />
                <span className={classes.label}>{tNav('settings')}</span>
                {settingsActive ? null : <span className={classes.count}>{settingsItems.length}</span>}
              </Link>
            </div>
            {settingsActive ? pages(settingsItems, tNav('settings')) : null}
          </div>
        ) : null}
      </div>

      <div className={classes.footer}>
        <button type="button" className={classes.item} onClick={openHelp} data-testid="sidebar-help">
          <IconBook size={16} stroke={1.7} />
          <span className={classes.label}>{tNav('sidebarHelp')}</span>
        </button>
        {drawer ? null : (
          <button
            type="button"
            className={classes.item}
            onClick={toggleCollapsed}
            aria-expanded
            data-testid="sidebar-toggle"
          >
            <IconLayoutSidebarLeftCollapse size={16} stroke={1.7} />
            <span className={classes.label}>{tNav('sidebarCollapse')}</span>
          </button>
        )}
      </div>
    </nav>
  );
}
