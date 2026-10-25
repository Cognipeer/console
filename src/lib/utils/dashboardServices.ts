import {
  IconAbacus,
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
  IconCoins,
  IconCpu,
  IconCube,
  IconFileText,
  IconFolder,
  IconHeadset,
  IconKey,
  IconLayoutDashboard,
  IconLock,
  IconMessageChatbot,
  IconPlug,
  IconReportAnalytics,
  IconRobot,
  IconServerBolt,
  IconSettings,
  IconShield,
  IconSparkles,
  IconTimeline,
  IconTool,
  IconTrashX,
  IconUsers,
  IconVectorBezier,
  IconWebhook,
  IconWorld,
  IconWorldSearch,
  type Icon,
} from '@tabler/icons-react';
import platformServicesJson from '@/config/platform-services.json';
import {
  getEffectiveServicePermission,
  type PermissionService,
  type ServicePermissionLevel,
  type UserRole,
  type UserServicePermissions,
} from '@/lib/security/rbac';

/* ──────────────────────────────────────────────────────────────────────────
   Icon registry — JSON references icons by string name, resolved here.
   Add a new entry to expose more Tabler icons to the platform-services.json
   schema. Unknown names fall back to IconCube.
   ────────────────────────────────────────────────────────────────────────── */

const ICON_REGISTRY = {
  IconAbacus,
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
  IconCoins,
  IconCpu,
  IconFileText,
  IconFolder,
  IconHeadset,
  IconKey,
  IconLayoutDashboard,
  IconLock,
  IconMessageChatbot,
  IconPlug,
  IconReportAnalytics,
  IconRobot,
  IconServerBolt,
  IconShield,
  IconSparkles,
  IconTimeline,
  IconTool,
  IconTrashX,
  IconUsers,
  IconVectorBezier,
  IconWebhook,
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
  /** Only usable on a self-hosted (onprem) deployment — hidden entirely on SaaS. */
  requiresOnPrem?: boolean;
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
    requiresOnPrem?: boolean;
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
    requiresOnPrem: entry.requiresOnPrem,
    enterpriseModule: entry.enterpriseModule,
    isSettings: entry.settings,
  }),
);

type DashboardServicesOptions = {
  isTenantAdmin?: boolean;
  role?: UserRole;
  servicesHomeOnly?: boolean;
  servicePermissions?: UserServicePermissions;
  /**
   * What the policy engine allows the person per service in the ACTIVE project
   * (groups, policies and project limits included; `GET /api/auth/session`).
   * A service named here is judged by this level; a service the map does not
   * name, or no map at all (loading, or the engine could not answer), falls back
   * to the role-based level.
   */
  effectivePermissions?: Partial<Record<string, ServicePermissionLevel>> | null;
  /** Current deployment mode. Services marked `requiresOnPrem` are hidden entirely when false. */
  isOnPrem?: boolean;
};

/**
 * The level the shell treats the person as having on a permission service: the
 * engine's answer for the active project when it names the service, else the
 * role-based level.
 */
function serviceLevelOf(
  options: Pick<DashboardServicesOptions, 'role' | 'servicePermissions' | 'effectivePermissions'>,
  id: PermissionService,
): ServicePermissionLevel {
  const { role = 'user', servicePermissions = {}, effectivePermissions = null } = options;
  return effectivePermissions?.[id] ?? getEffectiveServicePermission({ role, servicePermissions }, id);
}

/**
 * Whether the person may use a permission service at all. It answers for the
 * pages that sit inside another service's menu (Webhooks, in Agents) and have no
 * service entry to be offered by, with the same level the services are judged by.
 */
export function canUseDashboardService(
  options: Pick<DashboardServicesOptions, 'role' | 'servicePermissions' | 'effectivePermissions'>,
  id: PermissionService,
): boolean {
  return serviceLevelOf(options, id) !== 'none';
}

export function getDashboardServices(
  options: DashboardServicesOptions = {},
): DashboardServiceDefinition[] {
  const {
    isTenantAdmin = false,
    servicesHomeOnly = false,
    isOnPrem = false,
  } = options;

  const levelOf = (id: PermissionService): ServicePermissionLevel => serviceLevelOf(options, id);

  return DASHBOARD_SERVICE_DEFINITIONS.filter((service) => {
    if (service.requiresOnPrem && !isOnPrem) return false;

    if (service.id !== 'services-home') {
      if (levelOf(service.id) === 'none') return false;
    }

    if (
      service.tenantAdminOnly &&
      !isTenantAdmin &&
      service.id !== 'services-home' &&
      levelOf(service.id) !== 'admin'
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
 * (an entry with `settings: true`, grouped by SETTINGS_NAV_GROUPS) is active.
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

/**
 * A page that lives inside another service's sub-nav instead of being a service
 * of its own — searchable from the command palette, but with no launcher tile,
 * rail icon or path ownership (the section it sits in owns the path).
 */
export interface DashboardSubpage {
  id: string;
  /** The service whose sub-nav it is in. */
  parent: DashboardServiceDefinition['id'];
  /** The RBAC service that gates the page. */
  service: PermissionService;
  href: string;
  icon: Icon;
  navLabelKey: string;
  navDescriptionKey: string;
  tags: string[];
  searchKeywords: string[];
}

export const DASHBOARD_SUBPAGES: ReadonlyArray<DashboardSubpage> = [
  {
    // Project / tenant level, not per agent: what it announces is agent activity,
    // so it lives in the Agents menu (it used to be a Settings page).
    id: 'webhooks',
    parent: 'agents',
    service: 'webhooks',
    href: '/dashboard/agents/webhooks',
    icon: IconWebhook,
    navLabelKey: 'webhooks',
    navDescriptionKey: 'webhooksDescription',
    tags: ['webhooks', 'events', 'notifications', 'agents'],
    searchKeywords: ['webhook', 'event', 'callback', 'notification', 'olay', 'bildirim'],
  },
];

/** All known service definitions (does not honor permissions). */
export const ALL_DASHBOARD_SERVICES: ReadonlyArray<DashboardServiceDefinition> =
  DASHBOARD_SERVICE_DEFINITIONS;

/**
 * Enterprise pages that sit outside their module's service href, with the module whose upsell they
 * show (Abacus is the cost module's recommendation engine; its API is the `abacus` module).
 */
const ENTERPRISE_PAGES_OUTSIDE_SERVICE: ReadonlyArray<readonly [string, string]> = [['/dashboard/abacus', 'cost']];

/** The enterprise module that owns a dashboard page, if any (the service with `enterpriseModule` it lives under). */
export function enterpriseModuleForPath(pathname: string): string | undefined {
  const under = (prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);
  const service = DASHBOARD_SERVICE_DEFINITIONS.find((s) => s.enterpriseModule && under(s.href));
  if (service) return service.enterpriseModule;
  return ENTERPRISE_PAGES_OUTSIDE_SERVICE.find(([prefix]) => under(prefix))?.[1];
}

/** Lookup by service id. */
export function findDashboardService(
  id: string,
): DashboardServiceDefinition | undefined {
  return DASHBOARD_SERVICE_DEFINITIONS.find((s) => s.id === id);
}
