import { ReactNode } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { getConfig } from '@/lib/core/config';
import { getDatabase } from '@/lib/database';
import { isTenantRole } from '@/lib/iam/identity';
import { isUserDisabled } from '@/lib/services/users/userAuthState';
import { normalizeServicePermissions } from '@/lib/security/rbac';
import { collectAccessibleProjectIds } from '@/lib/services/projects/accessibleProjects';
import { isSupportEntryPointEnabled } from '@/lib/services/support/supportHandoff';
import { LicenseManager } from '@/lib/license/license-manager';
import { resolveLiveLicenseForTenant } from '@/lib/license/tenantLicense';

interface DashboardRouteLayoutProps {
  children: ReactNode;
}

export default async function DashboardRouteLayout({ children }: DashboardRouteLayoutProps) {
  const h = await headers();
  const email = h.get('x-user-email') ?? '';
  const licenseType = h.get('x-license-type') ?? '—';

  const tenantDbName = h.get('x-tenant-db-name');
  const userId = h.get('x-user-id');
  const tenantId = h.get('x-tenant-id');

  if (!tenantDbName || !tenantId || !userId) {
    redirect('/login');
  }

  const db = await getDatabase();
  const tenantSlug = h.get('x-tenant-slug') ?? '';
  // The account menu names the workspace; a failed lookup must never keep the dashboard from opening.
  const tenantRecord = await (async () => {
    try { return await db.findTenantById(tenantId); } catch { return null; }
  })();
  await db.switchToTenant(tenantDbName);
  const user = await db.findUserById(userId);

  // A disabled account keeps a valid JWT until it expires; treat it exactly
  // like a deleted one so it cannot render the dashboard shell.
  if (!user || isUserDisabled(user)) {
    redirect('/login');
  }

  // The role of the account record, not the one the session was issued with: a role that was
  // changed since sign-in shapes the navigation from the next page load on.
  const role = (isTenantRole(user.role) ? user.role : 'user') as
    | 'owner'
    | 'admin'
    | 'project_admin'
    | 'user'
    | 'portal_user';

  // A portal user signs in only to use portals: the dashboard is not theirs. `/p` shows the
  // portals open to them (or goes straight to the only one). Every service is also 'none' for
  // this role, so a direct API call is refused regardless of this redirect.
  if (role === 'portal_user') {
    redirect('/p');
  }

  // If a non-admin user has no assigned projects, do not render the dashboard at all.
  // A project counts however it was given: directly, in the legacy list, or through a group
  // (the same answer as the session endpoint and the project switcher).
  if (role === 'user' || role === 'project_admin') {
    const assigned = await collectAccessibleProjectIds(db, userId, user?.projectIds);
    if (assigned.length === 0) {
      redirect('/no-project');
    }
  }

  // The same live license the API guard decides enterprise routes by, so an enterprise page is
  // offered as an upsell instead of loading into a row of 402s. Unknown (lookup failed) gates nothing.
  const enterpriseLicensed = await (async () => {
    try {
      const license = await resolveLiveLicenseForTenant(tenantId);
      return LicenseManager.isEnterpriseActive(license.licenseType, license.licenseExpiresAt);
    } catch {
      return undefined;
    }
  })();

  return (
    <DashboardLayout
      supportEnabled={isSupportEntryPointEnabled()}
      isOnPrem={getConfig().deployment.isOnPrem}
      enterpriseLicensed={enterpriseLicensed}
      user={{
        name: user.name || (email ? email.split('@')[0] : 'Account'),
        email,
        licenseType,
        tenantName: tenantRecord?.companyName || tenantSlug,
        tenantSlug,
        role,
        servicePermissions: normalizeServicePermissions(user.servicePermissions),
      }}
    >
      {children}
    </DashboardLayout>
  );
}
