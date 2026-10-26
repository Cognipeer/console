'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AppShell } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DashboardBreadcrumbs from './DashboardBreadcrumbs';
import CommandPalette, { openCommandPalette } from './CommandPalette';
import SlimRail from './launcher/SlimRail';
import TopbarV2 from './launcher/TopbarV2';
import ServiceLauncher from './launcher/ServiceLauncher';
import MobileNavDrawer from './launcher/MobileNavDrawer';
import ServiceSubNav, {
  SUBNAV_CONFIG,
  findServiceForPath,
  visibleSubNavItems,
  type SubNavItem,
} from './launcher/ServiceSubNav';
import { useLauncherState } from './launcher/useLauncherState';
import { useEffectivePermissions } from './useEffectivePermissions';
import { LauncherProvider } from './launcher/LauncherContext';
import { DashboardUserProvider, type DashboardUser } from './DashboardUserContext';
import { openSupport } from '@/lib/support/openSupport';
import { useLocale, useTranslations } from '@/lib/i18n';
import classes from './launcher/LauncherShell.module.css';
import { DocsDrawerProvider, type OpenDocs } from '@/components/docs/DocsDrawerContext';
import DocsAside from '@/components/docs/DocsAside';
import NavigationProgress from '@/components/common/navigation/NavigationProgress';
import { useNavigationFeedback } from '@/components/common/navigation/useNavigationFeedback';
import { isDocId, normalizeDocsBaseUrl, resolveDoc, type DocTarget } from '@/lib/docs/docsLinks';
import {
  canUseDashboardService,
  enterpriseModuleForPath,
  getDashboardServices,
  SETTINGS_NAV_SECTION,
} from '@/lib/utils/dashboardServices';
import { EnterpriseUpsell } from '@/components/enterprise/EnterpriseUpsell';
import type { PermissionService, UserServicePermissions } from '@/lib/security/rbac';

/**
 * The groups of the Settings section in the left nav, in display order. Each
 * heading is a `navigation` message key. Settings holds what configures the
 * workspace, who may enter it, what it keeps and how the platform runs; a page
 * people build or operate with is a service in the launcher.
 */
export const SETTINGS_NAV_GROUPS: ReadonlyArray<{ sectionKey: string; ids: readonly string[] }> = [
  { sectionKey: 'settingsWorkspace', ids: ['projects', 'providers', 'config', 'tokens', 'resources'] },
  { sectionKey: 'settingsAccess', ids: ['iam', 'sso', 'ldap'] },
  { sectionKey: 'settingsGovernance', ids: ['audit', 'data-retention'] },
  { sectionKey: 'settingsPlatform', ids: ['automations', 'cluster', 'license'] },
];

/** Display order of the Settings section items in the left nav. */
export const SETTINGS_NAV_ORDER: string[] = SETTINGS_NAV_GROUPS.flatMap((group) => [...group.ids]);

/** Position in the Settings section; an entry missing from the order goes last, not first. */
function settingsNavRank(id: string): number {
  const index = SETTINGS_NAV_ORDER.indexOf(id);
  return index === -1 ? SETTINGS_NAV_ORDER.length : index;
}

/**
 * The heading each entry of an ordered Settings list starts: the first entry the
 * viewer has of a group carries that group's heading, the rest none.
 */
export function settingsSectionKeys(ids: readonly string[]): Array<string | undefined> {
  let previous: string | undefined;
  return ids.map((id) => {
    const group = SETTINGS_NAV_GROUPS.find((candidate) => candidate.ids.includes(id))?.sectionKey;
    const starts = group !== undefined && group !== previous ? group : undefined;
    previous = group;
    return starts;
  });
}

interface DashboardLayoutProps {
  children: ReactNode;
  supportEnabled?: boolean;
  isOnPrem?: boolean;
  /** Whether the tenant holds an active ENTERPRISE license; undefined when it could not be read. */
  enterpriseLicensed?: boolean;
  /** Root of the docs site the docs panel and the docs links open (DOCS_BASE_URL). */
  docsBaseUrl?: string;
  user?: {
    name: string;
    email: string;
    licenseType: string;
    tenantName?: string;
    tenantSlug?: string;
    role?: 'owner' | 'admin' | 'project_admin' | 'user' | 'portal_user';
    servicePermissions?: UserServicePermissions;
  };
}

export default function DashboardLayout({ children, supportEnabled = false, isOnPrem = false, enterpriseLicensed, docsBaseUrl: configuredDocsBaseUrl, user }: DashboardLayoutProps) {
  const router = useRouter();
  const { push: navigate } = useNavigationFeedback();
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const [docsOpened, docsControls] = useDisclosure(false);
  // What the panel was last asked to show; `id` counts the requests, so asking again for the page
  // on screen takes the reader back to it.
  const [docsRequest, setDocsRequest] = useState<{ target?: DocTarget; title?: string; id: number }>({ id: 0 });
  const docsBaseUrl = useMemo(() => normalizeDocsBaseUrl(configuredDocsBaseUrl), [configuredDocsBaseUrl]);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const t = useTranslations('layout');
  const locale = useLocale();
  const tNotifications = useTranslations('notifications');
  const tNavigation = useTranslations('navigation');

  const activeDoc = useMemo(
    () => resolveDoc(docsRequest.target, docsRequest.title),
    [docsRequest.target, docsRequest.title],
  );

  const openDocs = useCallback<OpenDocs>(
    (target, options) => {
      setDocsRequest((previous) => ({ target, title: options?.title, id: previous.id + 1 }));
      docsControls.open();
    },
    [docsControls],
  );

  const handleLogout = useCallback(async () => {
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
  }, [router, tNotifications]);

  const handleSupportClick = useCallback(async () => {
    const opened = await openSupport(locale === 'tr' ? 'tr' : 'en');
    if (!opened) {
      notifications.show({
        title: tNotifications('supportErrorTitle'),
        message: tNotifications('supportErrorMessage'),
        color: 'red',
      });
    }
  }, [locale, tNotifications]);

  const defaultUser = user || {
    name: t('defaultUser.name'),
    email: t('defaultUser.email'),
    licenseType: t('defaultUser.license'),
    role: 'user' as const,
    servicePermissions: {},
  };

  const isTenantAdmin = defaultUser.role === 'owner' || defaultUser.role === 'admin';

  // Only the real signed-in user (not the placeholder above) is shared with pages.
  const hasShellUser = Boolean(user);
  const shellUserName = user?.name ?? '';
  const shellUserEmail = user?.email ?? '';
  const shellUserLicense = user?.licenseType ?? '';
  const shellUserRole = user?.role;
  const dashboardUser = useMemo<DashboardUser | null>(
    () =>
      hasShellUser
        ? {
            name: shellUserName,
            email: shellUserEmail,
            licenseType: shellUserLicense,
            role: shellUserRole,
          }
        : null,
    [hasShellUser, shellUserName, shellUserEmail, shellUserLicense, shellUserRole],
  );

  // What the engine allows in the ACTIVE project (null while loading or when it could not say:
  // the menu is then role-based). A service narrowed to "none" here is not offered at all.
  const effectivePermissions = useEffectivePermissions();

  // Same answer the services are offered by: the engine's for this project, else the role's.
  const canUseService = useCallback(
    (service: PermissionService) =>
      canUseDashboardService(
        { role: defaultUser.role, servicePermissions: defaultUser.servicePermissions, effectivePermissions },
        service,
      ),
    [defaultUser.role, defaultUser.servicePermissions, effectivePermissions],
  );

  const allowedServices = useMemo(
    () =>
      getDashboardServices({
        isTenantAdmin,
        role: defaultUser.role,
        servicePermissions: defaultUser.servicePermissions,
        effectivePermissions,
        isOnPrem,
      }),
    [defaultUser.role, defaultUser.servicePermissions, effectivePermissions, isTenantAdmin, isOnPrem],
  );

  const settingsServices = useMemo(
    () =>
      allowedServices
        .filter((svc) => svc.isSettings)
        .sort((a, b) => settingsNavRank(a.id) - settingsNavRank(b.id)),
    [allowedServices],
  );

  const settingsNavItems = useMemo<SubNavItem[]>(() => {
    const sectionKeys = settingsSectionKeys(settingsServices.map((svc) => svc.id));
    return settingsServices.map((svc, index) => ({
      id: svc.id,
      label: tNavigation(svc.navLabelKey),
      sectionKey: sectionKeys[index],
      href: svc.href,
      icon: svc.icon,
      matcher: (p: string) => p === svc.href || p.startsWith(`${svc.href}/`),
    }));
  }, [settingsServices, tNavigation]);

  const settingsHref = settingsServices[0]?.href ?? '/dashboard/tokens';

  const defaultPinnedIds = useMemo(
    () =>
      allowedServices
        .filter(
          (svc) => svc.defaultPinned && svc.id !== 'services-home' && !svc.isSettings,
        )
        .map((svc) => svc.id),
    [allowedServices],
  );

  const { pinned, recents, togglePin, recordVisit, hydrated } =
    useLauncherState(defaultPinnedIds);

  const pinnedServices = useMemo(
    () =>
      allowedServices.filter(
        (svc) => pinned.has(svc.id) && svc.id !== 'services-home' && !svc.isSettings,
      ),
    [allowedServices, pinned],
  );

  const recentServices = useMemo(() => {
    const byId = new Map(allowedServices.map((svc) => [svc.id as string, svc]));
    return recents
      .map((id) => byId.get(id))
      .filter((svc): svc is NonNullable<typeof svc> => !!svc)
      .filter((svc) => !pinned.has(svc.id) && !svc.isSettings)
      .slice(0, 4);
  }, [allowedServices, pinned, recents]);

  const activeService = useMemo(
    () => findServiceForPath(allowedServices, pathname),
    [allowedServices, pathname],
  );

  // An enterprise module's pages on a tenant without the license: the upsell, not a page whose
  // every request is refused with 402.
  const lockedModule = useMemo(
    () => (enterpriseLicensed === false ? enterpriseModuleForPath(pathname) : undefined),
    [enterpriseLicensed, pathname],
  );

  useEffect(() => {
    if (activeService) {
      recordVisit(activeService.id);
    }
  }, [activeService, recordVisit]);

  const isSettingsActive = Boolean(activeService?.isSettings);

  // A sub-nav entry can belong to another service than the section it sits in
  // (Webhooks, in Agents): it is left out for someone who has no access to that service.
  const serviceSubnavItems = useMemo(
    () =>
      activeService && !isSettingsActive
        ? visibleSubNavItems(
            SUBNAV_CONFIG[activeService.id],
            (service) => canUseService(service),
          )
        : undefined,
    [activeService, isSettingsActive, canUseService],
  );
  const hasSubnav = Boolean(
    activeService && (SUBNAV_CONFIG[activeService.id] || isSettingsActive),
  );

  // The Documentation entries (top bar, rail, service menu, mobile menu) open the page of the
  // service in view; outside any service, the start of the guide.
  const openServiceDocs = useCallback(() => {
    if (activeService) {
      openDocs(activeService.docsPath, { title: tNavigation(activeService.navLabelKey) });
    } else {
      openDocs();
    }
  }, [activeService, openDocs, tNavigation]);

  // An open panel follows the reader into another service: the page it shows belongs to the last one.
  const docsServiceRef = useRef(activeService?.id);
  useEffect(() => {
    const previous = docsServiceRef.current;
    docsServiceRef.current = activeService?.id;
    if (!docsOpened || !activeService || previous === activeService.id) return;
    openServiceDocs();
  }, [activeService, docsOpened, openServiceDocs]);

  // `?docs=<docs-links id>` on any dashboard address opens that page in the panel (older links to
  // /dashboard/docs arrive this way); the parameter is dropped from the address once read.
  const docsParam = searchParams?.get('docs') ?? null;
  useEffect(() => {
    if (!docsParam) return;
    openDocs(isDocId(docsParam) ? docsParam : undefined);
    const rest = new URLSearchParams(searchParams?.toString() ?? '');
    rest.delete('docs');
    const query = rest.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    // Only a new parameter value opens the panel again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docsParam]);

  // The frame loads the first time the panel opens, not with every dashboard page.
  const [docsMounted, setDocsMounted] = useState(false);
  useEffect(() => {
    if (docsOpened) setDocsMounted(true);
  }, [docsOpened]);

  const handleNavigate = useCallback(
    (href: string) => {
      if (href === '/dashboard/docs') {
        openServiceDocs();
        return;
      }
      navigate(href);
    },
    [openServiceDocs, navigate],
  );

  const docsAside = docsMounted ? (
    <DocsAside
      baseUrl={docsBaseUrl}
      doc={activeDoc}
      requestId={docsRequest.id}
      onClose={docsControls.close}
    />
  ) : null;

  const docsContextValue = useMemo(() => ({ openDocs, docsBaseUrl }), [openDocs, docsBaseUrl]);

  const launcherContextValue = useMemo(
    () => ({
      pinned,
      recents,
      togglePin,
      recordVisit,
      services: allowedServices,
      pinnedServices,
      recentServices,
      isTenantAdmin,
      openLauncher: () => setLauncherOpen(true),
      hydrated,
      canUseService,
    }),
    [
      pinned,
      recents,
      togglePin,
      recordVisit,
      allowedServices,
      pinnedServices,
      recentServices,
      isTenantAdmin,
      hydrated,
      canUseService,
    ],
  );

  return (
    <DocsDrawerProvider value={docsContextValue}>
      <DashboardUserProvider value={dashboardUser}>
      <LauncherProvider value={launcherContextValue}>
      <NavigationProgress />
      <CommandPalette isTenantAdmin={isTenantAdmin} />
      <AppShell
        header={{ height: 0 }}
        aside={{
          width: 560,
          breakpoint: 'md',
          collapsed: { desktop: !docsOpened, mobile: !docsOpened },
        }}
        padding={0}
        styles={{
          main: {
            paddingTop: 0,
            paddingBottom: 0,
            paddingLeft: 0,
            paddingRight: 0,
            height: '100vh',
            minHeight: '100vh',
            overflow: 'hidden',
          },
        }}
      >
        <AppShell.Main>
          <div className={`${classes.shell} ${hasSubnav ? classes.shellWithSubnav : ''}`}>
            <TopbarV2
              user={defaultUser}
              isTenantAdmin={isTenantAdmin}
              supportEnabled={supportEnabled}
              onSearchClick={openCommandPalette}
              onLauncherClick={() => setLauncherOpen(true)}
              onDocsClick={openServiceDocs}
              onSupportClick={handleSupportClick}
              onLogout={handleLogout}
              onNavigate={handleNavigate}
              onMobileNavClick={() => setMobileNavOpen(true)}
              settingsHref={settingsHref}
            />

            <SlimRail
              pinned={pinnedServices}
              recents={recentServices}
              activeServiceId={isSettingsActive ? null : (activeService?.id ?? null)}
              onLauncherClick={() => setLauncherOpen(true)}
              onHelpClick={openServiceDocs}
              settingsHref={settingsHref}
              settingsActive={isSettingsActive}
            />

            {activeService && hasSubnav ? (
              <ServiceSubNav
                service={isSettingsActive ? SETTINGS_NAV_SECTION : activeService}
                pathname={pathname}
                isPinned={pinned.has(activeService.id)}
                onTogglePin={() => togglePin(activeService.id)}
                onOpenDocs={openServiceDocs}
                items={isSettingsActive ? settingsNavItems : serviceSubnavItems}
                hidePin={isSettingsActive}
              />
            ) : null}

            <main className={classes.main}>
              <div className={classes.mainBreadcrumb}>
                <DashboardBreadcrumbs />
              </div>
              {lockedModule ? <EnterpriseUpsell module={lockedModule} /> : children}
            </main>
          </div>

          {hydrated ? (
            <ServiceLauncher
              open={launcherOpen}
              onClose={() => setLauncherOpen(false)}
              services={allowedServices}
              recents={recentServices}
              pinnedIds={pinned}
              onTogglePin={togglePin}
              onSelect={(svc) => navigate(svc.href)}
            />
          ) : null}

          {hydrated ? (
            <MobileNavDrawer
              open={mobileNavOpen}
              onClose={() => setMobileNavOpen(false)}
              pathname={pathname}
              pinned={pinnedServices}
              recents={recentServices}
              activeService={activeService}
              onOpenLauncher={() => setLauncherOpen(true)}
              onOpenDocs={openServiceDocs}
              subnavOverride={
                isSettingsActive
                  ? { title: tNavigation('settings'), items: settingsNavItems }
                  : activeService && serviceSubnavItems
                    ? { title: tNavigation(activeService.navLabelKey), items: serviceSubnavItems }
                    : null
              }
              settingsHref={settingsHref}
              settingsActive={isSettingsActive}
            />
          ) : null}
        </AppShell.Main>

        {docsAside}
      </AppShell>
      </LauncherProvider>
      </DashboardUserProvider>
    </DocsDrawerProvider>
  );
}
