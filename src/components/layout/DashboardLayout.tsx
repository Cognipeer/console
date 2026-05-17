'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ActionIcon,
  AppShell,
  Button,
  Group,
  Stack,
  Text,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconExternalLink, IconX } from '@tabler/icons-react';
import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import DashboardBreadcrumbs from './DashboardBreadcrumbs';
import CommandPalette, { openCommandPalette } from './CommandPalette';
import SlimRail from './launcher/SlimRail';
import TopbarV2 from './launcher/TopbarV2';
import ServiceLauncher from './launcher/ServiceLauncher';
import ServiceSubNav, {
  SUBNAV_CONFIG,
  findServiceForPath,
} from './launcher/ServiceSubNav';
import { useLauncherState } from './launcher/useLauncherState';
import { LauncherProvider } from './launcher/LauncherContext';
import { useTranslations } from '@/lib/i18n';
import classes from './launcher/LauncherShell.module.css';
import { DocsDrawerProvider } from '@/components/docs/DocsDrawerContext';
import { DEFAULT_SDK_DOC, resolveSdkDoc, type SdkDocId } from '@/lib/docs/sdkDocs';
import { getDashboardServices } from '@/lib/utils/dashboardServices';
import type { UserServicePermissions } from '@/lib/security/rbac';

interface DashboardLayoutProps {
  children: ReactNode;
  user?: {
    name: string;
    email: string;
    licenseType: string;
    role?: 'owner' | 'admin' | 'project_admin' | 'user';
    servicePermissions?: UserServicePermissions;
  };
}

export default function DashboardLayout({ children, user }: DashboardLayoutProps) {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const [docsOpened, docsControls] = useDisclosure(false);
  const [docsDocId, setDocsDocId] = useState<SdkDocId>(DEFAULT_SDK_DOC);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const t = useTranslations('layout');
  const tNotifications = useTranslations('notifications');

  const activeDoc = useMemo(() => resolveSdkDoc(docsDocId), [docsDocId]);

  const openDocs = useCallback(
    (docId?: SdkDocId) => {
      setDocsDocId(docId ?? DEFAULT_SDK_DOC);
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

  const defaultUser = user || {
    name: t('defaultUser.name'),
    email: t('defaultUser.email'),
    licenseType: t('defaultUser.license'),
    role: 'user' as const,
    servicePermissions: {},
  };

  const isTenantAdmin = defaultUser.role === 'owner' || defaultUser.role === 'admin';

  const allowedServices = useMemo(
    () =>
      getDashboardServices({
        isTenantAdmin,
        role: defaultUser.role,
        servicePermissions: defaultUser.servicePermissions,
      }),
    [defaultUser.role, defaultUser.servicePermissions, isTenantAdmin],
  );

  const defaultPinnedIds = useMemo(
    () =>
      allowedServices
        .filter((svc) => svc.defaultPinned && svc.id !== 'services-home')
        .map((svc) => svc.id),
    [allowedServices],
  );

  const { pinned, recents, togglePin, recordVisit, hydrated } =
    useLauncherState(defaultPinnedIds);

  const pinnedServices = useMemo(
    () =>
      allowedServices.filter((svc) => pinned.has(svc.id) && svc.id !== 'services-home'),
    [allowedServices, pinned],
  );

  const recentServices = useMemo(() => {
    const byId = new Map(allowedServices.map((svc) => [svc.id as string, svc]));
    return recents
      .map((id) => byId.get(id))
      .filter((svc): svc is NonNullable<typeof svc> => !!svc)
      .filter((svc) => !pinned.has(svc.id))
      .slice(0, 4);
  }, [allowedServices, pinned, recents]);

  const activeService = useMemo(
    () => findServiceForPath(allowedServices, pathname),
    [allowedServices, pathname],
  );

  useEffect(() => {
    if (activeService) {
      recordVisit(activeService.id);
    }
  }, [activeService, recordVisit]);

  const hasSubnav = Boolean(activeService && SUBNAV_CONFIG[activeService.id]);

  const handleNavigate = useCallback(
    (href: string) => {
      if (href === '/dashboard/docs') {
        openDocs(DEFAULT_SDK_DOC);
        return;
      }
      router.push(href);
    },
    [openDocs, router],
  );

  const docsAside = (
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
  );

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
    ],
  );

  return (
    <DocsDrawerProvider value={{ openDocs }}>
      <LauncherProvider value={launcherContextValue}>
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
              onSearchClick={openCommandPalette}
              onLauncherClick={() => setLauncherOpen(true)}
              onDocsClick={() => openDocs(DEFAULT_SDK_DOC)}
              onLogout={handleLogout}
              onNavigate={handleNavigate}
            />

            <SlimRail
              pinned={pinnedServices}
              recents={recentServices}
              activeServiceId={activeService?.id ?? null}
              onLauncherClick={() => setLauncherOpen(true)}
            />

            {activeService && hasSubnav ? (
              <ServiceSubNav
                service={activeService}
                pathname={pathname}
                isPinned={pinned.has(activeService.id)}
                onTogglePin={() => togglePin(activeService.id)}
                onOpenDocs={() => openDocs(DEFAULT_SDK_DOC)}
              />
            ) : null}

            <main className={classes.main}>
              <div className={classes.mainBreadcrumb}>
                <DashboardBreadcrumbs />
              </div>
              {children}
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
              onSelect={(svc) => router.push(svc.href)}
            />
          ) : null}
        </AppShell.Main>

        {docsAside}
      </AppShell>
      </LauncherProvider>
    </DocsDrawerProvider>
  );
}
