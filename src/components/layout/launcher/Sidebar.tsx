'use client';

/**
 * The single left menu (see sidebarNav.ts): Home, Reports, Favorites, the services the person can open under their
 * categories, Settings, help and a toggle to an icon-only strip. Someone with few services gets one plain list instead
 * of categories.
 *
 * Favorites are the services the person pinned, in the order pinned, kept in this browser (useLauncherState, the store
 * the old rail used). Every service row has a pin: shown on hover or keyboard focus with a pointer, always on a touch
 * screen. A service's own level has one in its header. Favorites stay closed: a row under Home and Reports (with their
 * count) opens them as a level of their own, the icon strip has one button that opens them in a menu, and the nested
 * style folds them, closed. A favorite is a shortcut to the service's page and keeps its pin shown to take it out
 * again; while that service is in view it is only named, and the service's own row is the one marked.
 *
 * Its style is SIDEBAR_STYLE:
 * - `drill` (the menu): one level at a time. The first lists the services; one with several pages opens a level of its
 *   own (its pages, a way back and its pin) and one with a single page is a plain link. Reports, Favorites and Settings
 *   are levels too. The menu opens at the level of the page in view (never Favorites), and the first level names that
 *   page next to its service.
 * - `tree` (kept): each category folds; the service in view opens its pages in place, Settings its grouped pages while
 *   one of them is in view. The page under the service's own name (Agents › Agents) is not repeated there: the
 *   service's row is that page.
 *
 * What it lists is decided by the shell, the same way as the rail and the sub-nav it replaces: `services` holds only
 * what the person may open (role, the engine's levels for the active project, tenant-admin pages, deployment), and
 * `activeItems` / `settingsItems` / `pagesFor` are the sub-nav entries already filtered for them. `reportsItems` are the
 * reports the reports API lets them read (none in community or without the license).
 *
 * A phone has no side column: the top bar's drawer shows this same menu (`variant="drawer"`), always labelled, without
 * the collapse toggle, and closing when a link in it is followed (`onNavigate`).
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Menu, Tooltip } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconArrowLeft,
  IconBook,
  IconChartBar,
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
import {
  REPORTS_HREF,
  SIDEBAR_NARROW_QUERY,
  SIDEBAR_STYLE,
  isFlatSidebar,
  sidebarGroups,
  sidebarServices,
  type SidebarStyle,
} from './sidebarNav';
import classes from './Sidebar.module.css';

const COLLAPSED_KEY = 'cgn:sidebar:collapsed';
const CLOSED_GROUPS_KEY = 'cgn:sidebar:closed-groups';
const HOME_HREF = '/dashboard/overview';

/** The levels of the step-by-step style: the first one, Settings, Reports, Favorites, or a service's id. */
const ROOT_LEVEL = '';
const SETTINGS_LEVEL = '@settings';
const REPORTS_LEVEL = '@reports';
const FAVORITES_LEVEL = '@favorites';

const NO_PINS: ReadonlySet<string> = new Set();

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

/**
 * The pages a service's own menu shows: none for a service with a single page (Files: Buckets — the page is the
 * service's own link), and never the page under the service's own name (Agents › Agents — the service's row is it).
 */
function pagesUnder(items: SubNavItem[] | undefined): SubNavItem[] {
  return items && items.length > 1 ? items.filter((item) => !item.sameAsService) : [];
}

export interface SidebarProps {
  /** The services the person may open (filtered by the shell). */
  services: DashboardServiceDefinition[];
  /** The service in view; null on Home and on a Settings page. */
  activeService: DashboardServiceDefinition | null;
  /** The pages of the service in view, filtered like its sub-nav. */
  activeItems?: SubNavItem[];
  /**
   * The pages of any service, filtered the same way: the step-by-step style opens a service that is not in view. A
   * service it gives nothing for is a plain link there.
   */
  pagesFor?: (service: DashboardServiceDefinition) => SubNavItem[] | undefined;
  /** The Settings pages the person may open, with their group headings. */
  settingsItems: SubNavItem[];
  settingsHref: string;
  settingsActive: boolean;
  /**
   * The reports the person may read: the summary first, then each report under its group's heading. Empty or missing
   * (community, no license, nothing they may read): no Reports row. With several, Reports is a level of its own.
   */
  reportsItems?: SubNavItem[];
  /** A Reports page is in view. */
  reportsActive?: boolean;
  /** The ids of the services the person pinned, in the order pinned: listed under Favorites. */
  pinnedIds?: ReadonlySet<string>;
  /** Pins or unpins a service. Without it the menu offers no pin and shows no Favorites. */
  onTogglePin?: (id: string) => void;
  /** Opens the docs panel on the page of the service in view. */
  onHelpClick: () => void;
  pathname: string;
  /** `drawer`: inside the phone's menu drawer, always labelled and without the collapse toggle. */
  variant?: 'side' | 'drawer';
  /** Called when a link in the menu is followed or help is opened (the drawer closes). */
  onNavigate?: () => void;
  /** Another style than SIDEBAR_STYLE (tests render both). */
  menuStyle?: SidebarStyle;
}

export default function Sidebar({
  services,
  activeService,
  activeItems,
  pagesFor,
  settingsItems,
  settingsHref,
  settingsActive,
  reportsItems,
  reportsActive = false,
  pinnedIds = NO_PINS,
  onTogglePin,
  onHelpClick,
  pathname,
  variant = 'side',
  onNavigate,
  menuStyle,
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

  const style: SidebarStyle = menuStyle ?? SIDEBAR_STYLE;
  const drill = style === 'drill';

  const flat = isFlatSidebar(services);
  const listed = useMemo(() => sidebarServices(services), [services]);
  const groups = useMemo(() => sidebarGroups(services), [services]);
  const reports = reportsItems ?? [];
  // A pin that names a service the person can no longer open is skipped (it stays stored for when they can again).
  const favorites = useMemo(() => {
    if (!onTogglePin) return [];
    const byId = new Map(listed.map((service) => [String(service.id), service]));
    return [...pinnedIds]
      .map((id) => byId.get(id))
      .filter((service): service is DashboardServiceDefinition => service !== undefined);
  }, [listed, pinnedIds, onTogglePin]);
  const homeActive = pathname === '/dashboard' || pathname.startsWith(HOME_HREF);
  const showSettings = settingsItems.length > 0;
  const servicePages = (service: DashboardServiceDefinition) =>
    service.id === activeService?.id ? activeItems : pagesFor?.(service);

  // ── The step-by-step style's level ──────────────────────────────────────────
  // It opens at the level of the page in view (Settings, or a service with several pages), and again on every page
  // followed; Back and a service's row move between levels without leaving the page.
  const levelInView =
    settingsActive && settingsItems.length > 1
      ? SETTINGS_LEVEL
      : reportsActive && reports.length > 1
        ? REPORTS_LEVEL
        : activeService && (activeItems?.length ?? 0) > 1
          ? activeService.id
          : ROOT_LEVEL;
  const viewKey = `${style}|${levelInView}|${pathname}`;
  const [level, setLevel] = useState(levelInView);
  const [levelMotion, setLevelMotion] = useState<'in' | 'back' | null>(null);
  const [seenView, setSeenView] = useState(viewKey);
  if (seenView !== viewKey) {
    setSeenView(viewKey);
    setLevel(levelInView);
    setLevelMotion(null);
  }
  // Favorites' level closes once its last favorite is taken out: a pin added later must not open it again.
  if (level === FAVORITES_LEVEL && favorites.length === 0) {
    setLevel(ROOT_LEVEL);
    setLevelMotion('back');
  }
  // The nested style's Favorites fold, closed on every page load.
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  // Where focus and the list's scroll go once a level is shown: the way back on the way in, the row that opened the
  // level (and the first level's scroll) on the way back.
  const levelMove = useRef<{ focus: string; scrollTop: number } | null>(null);
  const cameFrom = useRef<{ focus: string; scrollTop: number } | null>(null);

  // The page in view stays in sight in a long menu (a Settings page sits below every category): the last marked
  // entry is the deepest one, the page under its service. Checked again when the rows above it settle — the reports
  // arrive after the first render (from the reports API), the favorites once the browser's pins are read, and the
  // services once the engine has answered.
  const scrollRef = useRef<HTMLDivElement>(null);
  // The icon strip's Favorites button, for its tooltip.
  const favoritesButton = useRef<HTMLButtonElement>(null);
  const reportsCount = reports.length;
  const favoritesCount = favorites.length;
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
  }, [pathname, collapsed, settingsActive, reportsCount, favoritesCount, listedCount, drill]);

  useEffect(() => {
    const move = levelMove.current;
    const container = scrollRef.current;
    if (!move || !container) return;
    levelMove.current = null;
    container.scrollTop = move.scrollTop;
    container.querySelector<HTMLElement>(`[data-focus-key="${move.focus}"]`)?.focus({ preventScroll: true });
  }, [level]);

  const openLevel = (next: string, rowKey: string) => {
    cameFrom.current = { focus: rowKey, scrollTop: scrollRef.current?.scrollTop ?? 0 };
    levelMove.current = { focus: 'back', scrollTop: 0 };
    setLevelMotion('in');
    setLevel(next);
  };
  const closeLevel = () => {
    const service =
      level === SETTINGS_LEVEL
        ? 'settings'
        : level === REPORTS_LEVEL
          ? 'reports'
          : level === FAVORITES_LEVEL
            ? 'favorites'
            : `service-${level}`;
    levelMove.current = cameFrom.current ?? { focus: `row-${service}`, scrollTop: 0 };
    cameFrom.current = null;
    setLevelMotion('back');
    setLevel(ROOT_LEVEL);
  };

  const pendingFor = (href: string, active: boolean) =>
    !active && typeof window !== 'undefined' && isNavigationPendingFor(pendingKey, href, window.location.href)
      ? 'true'
      : undefined;
  const itemActive = (item: SubNavItem) =>
    item.matcher ? item.matcher(pathname, searchParams) : pathname === item.href;
  const itemLabel = (item: SubNavItem) => (item.labelKey ? tNav(item.labelKey) : item.label);

  // ── Icon-only strip ──────────────────────────────────────────────────────────
  if (collapsed) {
    const iconLink = (
      href: string,
      icon: Icon,
      label: string,
      mark: 'page' | 'ancestor' | null,
      testId: string,
      small = false,
    ) => {
      const ItemIcon = icon;
      const markClass = mark === 'page' ? classes.iconBtnActive : mark === 'ancestor' ? classes.iconBtnAncestor : '';
      return (
        <Tooltip key={testId} label={label} position="right" withArrow offset={8} openDelay={120}>
          <Link
            href={href}
            className={`${classes.iconBtn} ${small ? classes.iconBtnSmall : ''} ${markClass}`}
            aria-label={label}
            aria-current={mark === 'page' ? 'page' : mark ? 'true' : undefined}
            data-pending={pendingFor(href, mark !== null)}
            data-testid={testId}
            onNavigate={onNavigate}
            {...getIntentProps(href)}
          >
            <ItemIcon size={small ? 15 : 18} stroke={1.7} />
          </Link>
        </Tooltip>
      );
    };
    const pageIcons = (items: SubNavItem[]) =>
      items.map((item) =>
        iconLink(item.href, item.icon, itemLabel(item), itemActive(item) ? 'page' : null, `sidebar-subitem-${item.id}`, true),
      );
    const activePages = pagesUnder(activeItems);
    const shownSettings = settingsActive ? pagesUnder(settingsItems) : [];
    // Every service the first level lists, with a line between categories (one run when the list is short).
    const stripGroups = flat ? [{ category: 'all', services: listed }] : groups;

    return (
      <nav
        className={`${classes.sidebar} ${classes.collapsed}`}
        aria-label={tNav('sidebarLabel')}
        data-testid="sidebar-nav"
        data-collapsed="true"
      >
        <div className={classes.scroll} ref={scrollRef}>
          {iconLink(HOME_HREF, IconLayoutDashboard, tNav('sidebarHome'), homeActive ? 'page' : null, 'sidebar-home')}
          {reports.length > 0
            ? iconLink(REPORTS_HREF, IconChartBar, tNav('sidebarReports'), reportsActive ? 'page' : null, 'sidebar-reports')
            : null}
          {favorites.length > 0 ? (
            // One button: the favorites open in a menu beside it (shortcuts; the service in view is marked below).
            <>
              <Menu position="right-start" offset={8} shadow="md" width={240}>
                <Menu.Target>
                  <button
                    ref={favoritesButton}
                    type="button"
                    className={classes.iconBtn}
                    aria-label={tNav('sidebarFavorites')}
                    data-testid="sidebar-favorites"
                  >
                    <IconPin size={18} stroke={1.7} />
                  </button>
                </Menu.Target>
                <Menu.Dropdown data-testid="sidebar-favorites-menu">
                  <Menu.Label>{tNav('sidebarFavorites')}</Menu.Label>
                  {favorites.map((service) => {
                    const ServiceIcon = service.icon;
                    return (
                      <Menu.Item
                        key={service.id}
                        component={Link}
                        href={service.href}
                        leftSection={<ServiceIcon size={16} stroke={1.7} />}
                        data-testid={`sidebar-favorite-${service.id}`}
                        {...getIntentProps(service.href)}
                      >
                        {tNav(service.navLabelKey)}
                      </Menu.Item>
                    );
                  })}
                </Menu.Dropdown>
              </Menu>
              {/* Pointed at the button, not wrapped around it: wrapped, the menu's aria-* would land on the tooltip. */}
              <Tooltip
                label={tNav('sidebarFavorites')}
                target={favoritesButton}
                position="right"
                withArrow
                offset={8}
                openDelay={120}
              />
            </>
          ) : null}
          {stripGroups.map((group) => (
            <Fragment key={group.category}>
              <div className={classes.iconDivider} />
              {group.services.map((service) => {
                const active = activeService?.id === service.id;
                const mark = active ? (activePages.some(itemActive) ? 'ancestor' : 'page') : null;
                return (
                  <Fragment key={service.id}>
                    {iconLink(service.href, service.icon, tNav(service.navLabelKey), mark, `sidebar-service-${service.id}`)}
                    {active ? pageIcons(activePages) : null}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
          <div className={classes.spacer} />
          {showSettings ? (
            <>
              {iconLink(
                settingsHref,
                IconSettings,
                tNav('settings'),
                settingsActive ? (shownSettings.some(itemActive) ? 'ancestor' : 'page') : null,
                'sidebar-settings',
              )}
              {pageIcons(shownSettings)}
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

  // ── Labelled menu, both styles ───────────────────────────────────────────────
  /** How a row is marked: the page in view, or (named, not filled) the service or shortcut the page in view is under. */
  const markClass = (mark: 'page' | 'ancestor' | null) =>
    mark === 'page' ? classes.itemActive : mark === 'ancestor' ? classes.itemAncestor : '';

  const homeRow = (
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
  );

  /** A page row: small under its service (tree), a full row on its own level (drill). */
  const pageLink = (item: SubNavItem, opts: { level: boolean; ownerLabel: string }) => {
    const ItemIcon = item.icon;
    const active = itemActive(item);
    const rowClass = opts.level ? classes.item : classes.page;
    const activeClass = opts.level ? classes.itemActive : classes.pageActive;
    const heading = item.sectionKey ? (
      <div className={opts.level ? `${classes.sectionHeading} ${classes.levelHeading}` : classes.pagesHeading}>
        {tNav(item.sectionKey)}
      </div>
    ) : null;
    const link = (
      <Link
        href={item.href}
        className={`${rowClass} ${active ? activeClass : ''}`}
        aria-current={active ? 'page' : undefined}
        data-pending={pendingFor(item.href, active)}
        data-testid={`sidebar-subitem-${item.id}`}
        onNavigate={onNavigate}
        {...getIntentProps(item.href)}
      >
        <ItemIcon size={opts.level ? 16 : 14} stroke={1.7} />
        <span className={classes.label}>
          {item.sameAsService ? tNav('sidebarAllOf', { service: opts.ownerLabel }) : itemLabel(item)}
        </span>
        {item.badge ? <span className={classes.count}>{item.badge}</span> : null}
      </Link>
    );
    return (
      <Fragment key={item.id}>
        {heading}
        {opts.level ? <div className={classes.row}>{link}</div> : link}
      </Fragment>
    );
  };

  /** The pages opened under the service in view or under Settings (tree). */
  const pages = (shown: SubNavItem[], ownerLabel: string): ReactNode =>
    shown.length > 0 ? (
      <div className={classes.pages} role="group" aria-label={ownerLabel}>
        {shown.map((item) => pageLink(item, { level: false, ownerLabel }))}
      </div>
    ) : null;

  /**
   * Pins or unpins a service. `row`: on a service row, shown on hover or focus (`beforeArrow` on a row that opens a
   * level, so the arrow stays at the edge); `favorite`: on a favorite, always shown; `level`: in a service level's header.
   */
  const pinButton = (
    service: DashboardServiceDefinition,
    label: string,
    place: 'row' | 'beforeArrow' | 'favorite' | 'level',
    testId: string,
  ) => {
    if (!onTogglePin) return null;
    const isPinned = pinnedIds.has(String(service.id));
    const action = tNav(isPinned ? 'sidebarUnpin' : 'sidebarPin', { service: label });
    const placeClass =
      place === 'level'
        ? classes.levelPin
        : place === 'favorite'
          ? `${classes.pin} ${classes.pinStay}`
          : place === 'beforeArrow'
            ? `${classes.pin} ${classes.pinBeforeArrow}`
            : classes.pin;
    return (
      <button
        type="button"
        className={`${placeClass} ${isPinned ? classes.pinned : ''}`}
        aria-label={action}
        aria-pressed={isPinned}
        title={action}
        onClick={() => onTogglePin(String(service.id))}
        data-testid={testId}
      >
        {isPinned ? <IconPinFilled size={place === 'level' ? 15 : 13} /> : <IconPin size={place === 'level' ? 15 : 13} />}
      </button>
    );
  };

  /**
   * A service's own link; in the tree style the service in view opens its pages under it. A favorite is the same link
   * as a shortcut: it opens nothing under it and is only named while the service is in view.
   */
  const serviceRow = (service: DashboardServiceDefinition, opts: { opensPages: boolean; favorite?: boolean }) => {
    const ServiceIcon = service.icon;
    const label = tNav(service.navLabelKey);
    const active = activeService?.id === service.id;
    const shown = opts.opensPages && !opts.favorite && active ? pagesUnder(activeItems) : [];
    const mark = !active ? null : opts.favorite || shown.some(itemActive) ? 'ancestor' : 'page';
    const scope = opts.favorite ? 'favorite' : 'service';
    return (
      <Fragment key={`${scope}-${service.id}`}>
        <div className={classes.row}>
          <Link
            href={service.href}
            className={`${classes.item} ${markClass(mark)}`}
            aria-current={mark === 'page' ? 'page' : mark ? 'true' : undefined}
            data-pending={pendingFor(service.href, active)}
            data-testid={`sidebar-${scope}-${service.id}`}
            onNavigate={onNavigate}
            {...getIntentProps(service.href)}
          >
            <ServiceIcon size={16} stroke={1.7} />
            <span className={classes.label}>{label}</span>
          </Link>
          {opts.favorite
            ? pinButton(service, label, 'favorite', `sidebar-pin-favorite-${service.id}`)
            : pinButton(service, label, 'row', `sidebar-pin-${service.id}`)}
        </div>
        {pages(shown, label)}
      </Fragment>
    );
  };

  /** The favorites, in the order pinned: what Favorites opens (its level step by step, its fold nested). */
  const favoriteRows = () => favorites.map((service) => serviceRow(service, { opensPages: false, favorite: true }));

  /** Nested style: Favorites folds under Home and Reports, closed; nothing while nothing is pinned. */
  const favoritesFold = () =>
    favorites.length > 0 ? (
      <div className={classes.section}>
        <div className={classes.group}>
          <button
            type="button"
            className={classes.groupHeader}
            aria-expanded={favoritesOpen}
            aria-controls="sidebar-favorites-list"
            onClick={() => setFavoritesOpen((open) => !open)}
            data-testid="sidebar-favorites"
          >
            {favoritesOpen ? <IconChevronDown size={12} stroke={2} /> : <IconChevronRight size={12} stroke={2} />}
            <span className={classes.label}>{tNav('sidebarFavorites')}</span>
            <span className={classes.count}>{favorites.length}</span>
          </button>
          {favoritesOpen ? <div id="sidebar-favorites-list">{favoriteRows()}</div> : null}
        </div>
      </div>
    ) : null;

  // Reports: the summary and the reports under their groups (a level of its own step by step, pages in place nested).
  const reportsShown = reportsActive ? reports : [];
  const reportsLink = (
    <div className={classes.row}>
      <Link
        href={REPORTS_HREF}
        className={`${classes.item} ${markClass(reportsActive ? (reportsShown.some(itemActive) ? 'ancestor' : 'page') : null)}`}
        aria-current={reportsActive ? 'true' : undefined}
        data-pending={pendingFor(REPORTS_HREF, reportsActive)}
        data-testid="sidebar-reports"
        onNavigate={onNavigate}
        {...getIntentProps(REPORTS_HREF)}
      >
        <IconChartBar size={16} stroke={1.7} />
        <span className={classes.label}>{tNav('sidebarReports')}</span>
      </Link>
    </div>
  );

  const settingsShown = settingsActive ? pagesUnder(settingsItems) : [];
  const settingsLink = (
    <div className={classes.row}>
      <Link
        href={settingsHref}
        className={`${classes.item} ${markClass(settingsActive ? (settingsShown.some(itemActive) ? 'ancestor' : 'page') : null)}`}
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
  );

  // ── Tree style ──────────────────────────────────────────────────────────────
  const tree = () => (
    <>
      {homeRow}
      {reports.length > 0 ? (
        <>
          {reportsLink}
          {pages(reportsShown, tNav('sidebarReports'))}
        </>
      ) : null}
      {favoritesFold()}

      {flat ? (
        <div className={classes.section}>
          {listed.map((service) => serviceRow(service, { opensPages: true }))}
        </div>
      ) : (
        <>
          <div className={classes.section}>
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
                      {group.services.map((service) => serviceRow(service, { opensPages: true }))}
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
          {settingsLink}
          {pages(settingsShown, tNav('settings'))}
        </div>
      ) : null}
    </>
  );

  // ── Step-by-step style ──────────────────────────────────────────────────────
  /** A row that opens a level: the service (or Settings), the page in view under it, and an arrow. */
  const levelRow = (opts: {
    rowKey: string;
    level: string;
    icon: Icon;
    label: string;
    items: SubNavItem[];
    active: boolean;
    mark: 'page' | 'ancestor' | null;
    testId: string;
    after?: ReactNode;
    /** The service's pin, beside the button (a button cannot hold another). */
    pin?: ReactNode;
  }) => {
    const RowIcon = opts.icon;
    const current = opts.active ? opts.items.find(itemActive) : undefined;
    // "Agents  Tools ›"; not "Agents  All Agents ›".
    const hint = current && !current.sameAsService ? itemLabel(current) : null;
    return (
      <div className={classes.row} key={opts.rowKey}>
        <button
          type="button"
          className={`${classes.item} ${markClass(opts.mark)}`}
          aria-current={opts.mark ? 'true' : undefined}
          onClick={() => openLevel(opts.level, opts.rowKey)}
          data-testid={opts.testId}
          data-focus-key={opts.rowKey}
          data-opens="level"
        >
          <RowIcon size={16} stroke={1.7} />
          <span className={classes.label}>{opts.label}</span>
          {hint ? <span className={classes.hint}>{hint}</span> : (opts.after ?? null)}
          <IconChevronRight size={14} stroke={1.8} className={classes.chev} />
        </button>
        {opts.pin ?? null}
      </div>
    );
  };

  const drillServiceRow = (service: DashboardServiceDefinition) => {
    const items = servicePages(service);
    // One page: the service's own link.
    if (!items || items.length <= 1) return serviceRow(service, { opensPages: false });
    const active = activeService?.id === service.id;
    const label = tNav(service.navLabelKey);
    return levelRow({
      rowKey: `row-service-${service.id}`,
      level: service.id,
      icon: service.icon,
      label,
      items,
      active,
      mark: active ? 'page' : null,
      testId: `sidebar-service-${service.id}`,
      pin: pinButton(service, label, 'beforeArrow', `sidebar-pin-${service.id}`),
    });
  };

  const firstLevel = () => (
    <>
      {homeRow}
      {reports.length > 1
        ? levelRow({
            rowKey: 'row-reports',
            level: REPORTS_LEVEL,
            icon: IconChartBar,
            label: tNav('sidebarReports'),
            items: reports,
            active: reportsActive,
            mark: reportsActive ? 'page' : null,
            testId: 'sidebar-reports',
          })
        : reports.length === 1
          ? reportsLink
          : null}
      {favorites.length > 0
        ? levelRow({
            rowKey: 'row-favorites',
            level: FAVORITES_LEVEL,
            icon: IconPin,
            label: tNav('sidebarFavorites'),
            items: [],
            active: false,
            mark: null,
            testId: 'sidebar-favorites',
            after: <span className={classes.count}>{favorites.length}</span>,
          })
        : null}
      {flat ? (
        <div className={classes.section}>{listed.map((service) => drillServiceRow(service))}</div>
      ) : (
        groups.map((group) => (
          <div key={group.category} className={classes.section} data-testid={`sidebar-category-${group.category}`}>
            <div className={classes.sectionHeading}>
              <span>{group.label}</span>
            </div>
            {group.services.map((service) => drillServiceRow(service))}
          </div>
        ))
      )}

      <div className={classes.spacer} />

      {showSettings ? (
        <div className={classes.section}>
          {settingsItems.length > 1
            ? levelRow({
                rowKey: 'row-settings',
                level: SETTINGS_LEVEL,
                icon: IconSettings,
                label: tNav('settings'),
                items: settingsItems,
                active: settingsActive,
                mark: settingsActive ? 'page' : null,
                testId: 'sidebar-settings',
                after: <span className={classes.count}>{settingsItems.length}</span>,
              })
            : settingsLink}
        </div>
      ) : null}
    </>
  );

  /** A level's header: the way back under the owner's name, and a service's pin (not for Reports, Favorites or Settings). */
  const levelHeader = (ownerLabel: string, service?: DashboardServiceDefinition) => (
    <div className={classes.levelHeader}>
      <button
        type="button"
        className={classes.backBtn}
        onClick={closeLevel}
        title={tNav('sidebarBack')}
        data-testid="sidebar-back"
        data-focus-key="back"
      >
        <IconArrowLeft size={16} stroke={1.8} />
        <span className={classes.levelTitle}>{ownerLabel}</span>
        <span className={classes.srOnly}>{tNav('sidebarBack')}</span>
      </button>
      {service ? pinButton(service, ownerLabel, 'level', 'sidebar-level-pin') : null}
    </div>
  );

  /** A level of its own: its header, and its pages with their group headings. */
  const ownLevel = (ownerLabel: string, items: SubNavItem[], service?: DashboardServiceDefinition) => (
    <>
      {levelHeader(ownerLabel, service)}
      <div className={classes.levelPages} role="group" aria-label={ownerLabel}>
        {items.map((item) => pageLink(item, { level: true, ownerLabel }))}
      </div>
    </>
  );

  /** Favorites' level: its header, and the favorites in the order pinned, each with its pin. */
  const favoritesLevel = () => (
    <>
      {levelHeader(tNav('sidebarFavorites'))}
      <div className={classes.levelPages} role="group" aria-label={tNav('sidebarFavorites')}>
        {favoriteRows()}
      </div>
    </>
  );

  const stepByStep = () => {
    // Favorites' level shows while something is pinned: taking out the last favorite there goes back to the first level.
    if (level === FAVORITES_LEVEL && favorites.length > 0) {
      return (
        <div
          key="level-favorites"
          className={classes.level}
          data-motion={levelMotion ?? undefined}
          data-testid="sidebar-level-favorites"
        >
          {favoritesLevel()}
        </div>
      );
    }
    const special = level === SETTINGS_LEVEL || level === REPORTS_LEVEL || level === FAVORITES_LEVEL;
    const levelService = level && !special ? listed.find((service) => service.id === level) : undefined;
    const levelItems =
      level === SETTINGS_LEVEL
        ? settingsItems
        : level === REPORTS_LEVEL
          ? reports
          : levelService
            ? servicePages(levelService)
            : undefined;
    // A level that has nothing to show any more (the service left the list) falls back to the first one.
    const shownLevel = levelItems && levelItems.length > 1 ? level : ROOT_LEVEL;
    const ownerLabel =
      shownLevel === SETTINGS_LEVEL
        ? tNav('settings')
        : shownLevel === REPORTS_LEVEL
          ? tNav('sidebarReports')
          : levelService
            ? tNav(levelService.navLabelKey)
            : '';
    const testLevel =
      shownLevel === SETTINGS_LEVEL ? 'settings' : shownLevel === REPORTS_LEVEL ? 'reports' : shownLevel || 'root';
    return (
      <div
        key={`level-${shownLevel || 'root'}`}
        className={classes.level}
        data-motion={levelMotion ?? undefined}
        data-testid={`sidebar-level-${testLevel}`}
      >
        {shownLevel === ROOT_LEVEL || !levelItems
          ? firstLevel()
          : ownLevel(ownerLabel, levelItems, special ? undefined : levelService)}
      </div>
    );
  };

  return (
    <nav
      className={`${classes.sidebar} ${drawer ? classes.drawer : ''}`}
      aria-label={tNav('sidebarLabel')}
      data-testid={drawer ? 'sidebar-drawer' : 'sidebar-nav'}
      data-flat={flat ? 'true' : undefined}
      data-style={style}
    >
      <div className={classes.scroll} ref={scrollRef}>
        {drill ? stepByStep() : tree()}
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
