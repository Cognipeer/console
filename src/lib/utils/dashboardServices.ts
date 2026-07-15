import {
  IconApi,
  IconArrowsSort,
  IconBell,
  IconBook2,
  IconBrain,
  IconBulb,
  IconCertificate,
  IconChecklist,
  IconClipboardList,
  IconClock,
  IconCode,
  IconCpu,
  IconCube,
  IconFileText,
  IconFolder,
  IconHeadset,
  IconKey,
  IconLayoutDashboard,
  IconLock,
  IconPlug,
  IconReportAnalytics,
  IconRobot,
  IconServerBolt,
  IconSettings,
  IconShield,
  IconSparkles,
  IconTimeline,
  IconTool,
  IconUsers,
  IconVectorBezier,
  IconWorld,
  IconWorldSearch,
  type Icon,
} from '@tabler/icons-react';
import platformServicesJson from '@/config/platform-services.json';
import {
  getEffectiveServicePermission,
  type PermissionService,
  type UserRole,
  type UserServicePermissions,
} from '@/lib/security/rbac';

/* ──────────────────────────────────────────────────────────────────────────
   Icon registry — JSON references icons by string name, resolved here.
   Add a new entry to expose more Tabler icons to the platform-services.json
   schema. Unknown names fall back to IconCube.
   ────────────────────────────────────────────────────────────────────────── */

const ICON_REGISTRY = {
  IconApi,
  IconArrowsSort,
  IconBell,
  IconBook2,
  IconBrain,
  IconBulb,
  IconCertificate,
  IconChecklist,
  IconClipboardList,
  IconClock,
  IconCode,
  IconCpu,
  IconFileText,
  IconFolder,
  IconHeadset,
  IconKey,
  IconLayoutDashboard,
  IconLock,
  IconPlug,
  IconReportAnalytics,
  IconRobot,
  IconServerBolt,
  IconShield,
  IconSparkles,
  IconTimeline,
  IconTool,
  IconUsers,
  IconVectorBezier,
  IconWorld,
  IconWorldSearch,
} satisfies Record<string, Icon>;

export type PlatformIconName = keyof typeof ICON_REGISTRY;

export function resolveIcon(name: string): Icon {
  return ICON_REGISTRY[name as PlatformIconName] ?? IconCube;
}

/* ──────────────────────────────────────────────────────────────────────────
   Types
   ────────────────────────────────────────────────────────────────────────── */

export type DashboardServiceCategory = 'build' | 'data' | 'operate' | 'admin';

export type DashboardServiceDefinition = {
  id: PermissionService | 'services-home';
  href: string;
  navLabelKey: string;
  navDescriptionKey: string;
  icon: Icon;
  /** Underlying icon name from `platform-services.json`. */
  iconName: PlatformIconName | string;
  category: DashboardServiceCategory;
  tags: string[];
  searchKeywords: string[];
  showInServicesHome?: boolean;
  tenantAdminOnly?: boolean;
  defaultPinned?: boolean;
  popular?: boolean;
  badge?: 'new';
  /** Gated to the ENTERPRISE tier; absent in the community build. */
  requiresEnterprise?: boolean;
  /** Closed-source overlay module that provides this service. */
  enterpriseModule?: string;
  /** Settings entry — shown in the Settings section of the left nav, not the services launcher. */
  isSettings?: boolean;
};

/* JSON schema mirror — used internally to type the raw config. */
interface RawPlatformServicesConfig {
  categories: {
    order: DashboardServiceCategory[];
    labels: Record<DashboardServiceCategory, string>;
  };
  services: Array<{
    id: string;
    href: string;
    icon: string;
    category: DashboardServiceCategory;
    navLabelKey: string;
    navDescriptionKey: string;
    tags?: string[];
    searchKeywords?: string[];
    showInServicesHome?: boolean;
    tenantAdminOnly?: boolean;
    defaultPinned?: boolean;
    popular?: boolean;
    badge?: 'new';
    requiresEnterprise?: boolean;
    enterpriseModule?: string;
    settings?: boolean;
  }>;
}

const RAW = platformServicesJson as RawPlatformServicesConfig;

/* ──────────────────────────────────────────────────────────────────────────
   Public exports
   ────────────────────────────────────────────────────────────────────────── */

export const DASHBOARD_CATEGORY_LABELS: Record<DashboardServiceCategory, string> =
  RAW.categories.labels;

export const DASHBOARD_CATEGORY_ORDER: DashboardServiceCategory[] = RAW.categories.order;

const DASHBOARD_SERVICE_DEFINITIONS: DashboardServiceDefinition[] = RAW.services.map(
  (entry) => ({
    id: entry.id as DashboardServiceDefinition['id'],
    href: entry.href,
    navLabelKey: entry.navLabelKey,
    navDescriptionKey: entry.navDescriptionKey,
    icon: resolveIcon(entry.icon),
    iconName: entry.icon,
    category: entry.category,
    tags: entry.tags ?? [],
    searchKeywords: entry.searchKeywords ?? [],
    showInServicesHome: entry.showInServicesHome,
    tenantAdminOnly: entry.tenantAdminOnly,
    defaultPinned: entry.defaultPinned,
    popular: entry.popular,
    badge: entry.badge,
    requiresEnterprise: entry.requiresEnterprise,
    enterpriseModule: entry.enterpriseModule,
    isSettings: entry.settings,
  }),
);

type DashboardServicesOptions = {
  isTenantAdmin?: boolean;
  role?: UserRole;
  servicesHomeOnly?: boolean;
  servicePermissions?: UserServicePermissions;
};

export function getDashboardServices(
  options: DashboardServicesOptions = {},
): DashboardServiceDefinition[] {
  const {
    isTenantAdmin = false,
    role = 'user',
    servicesHomeOnly = false,
    servicePermissions = {},
  } = options;

  return DASHBOARD_SERVICE_DEFINITIONS.filter((service) => {
    if (service.id !== 'services-home') {
      const level = getEffectiveServicePermission(
        { role, servicePermissions },
        service.id,
      );
      if (level === 'none') return false;
    }

    if (
      service.tenantAdminOnly &&
      !isTenantAdmin &&
      service.id !== 'services-home' &&
      getEffectiveServicePermission({ role, servicePermissions }, service.id) !==
        'admin'
    ) {
      return false;
    }

    if (servicesHomeOnly && service.showInServicesHome === false) {
      return false;
    }

    return true;
  });
}

/**
 * Synthetic definition for the Settings section of the left nav. Not part of
 * the service registry — used as the sub-nav header when a settings page
 * (projects, providers, members, tokens, audit, license) is active.
 */
export const SETTINGS_NAV_SECTION: DashboardServiceDefinition = {
  id: 'settings' as DashboardServiceDefinition['id'],
  href: '/dashboard/projects',
  navLabelKey: 'settings',
  navDescriptionKey: 'settingsDescription',
  icon: IconSettings,
  iconName: 'IconSettings',
  category: 'admin',
  tags: [],
  searchKeywords: [],
};

/** All known service definitions (does not honor permissions). */
export const ALL_DASHBOARD_SERVICES: ReadonlyArray<DashboardServiceDefinition> =
  DASHBOARD_SERVICE_DEFINITIONS;

/** Lookup by service id. */
export function findDashboardService(
  id: string,
): DashboardServiceDefinition | undefined {
  return DASHBOARD_SERVICE_DEFINITIONS.find((s) => s.id === id);
}
