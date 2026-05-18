import { ReactNode } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { getDatabase } from '@/lib/database';
import { normalizeServicePermissions } from '@/lib/security/rbac';

interface DashboardRouteLayoutProps {
  children: ReactNode;
}

export default async function DashboardRouteLayout({ children }: DashboardRouteLayoutProps) {
  const h = await headers();
  const email = h.get('x-user-email') ?? '';
  const licenseType = h.get('x-license-type') ?? '—';
  const role = (h.get('x-user-role') ?? 'user') as
    | 'owner'
    | 'admin'
    | 'project_admin'
    | 'user';

  const tenantDbName = h.get('x-tenant-db-name');
  const userId = h.get('x-user-id');
  const tenantId = h.get('x-tenant-id');

  if (!tenantDbName || !tenantId || !userId) {
    redirect('/login');
  }

  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const user = await db.findUserById(userId);

  if (!user) {
    redirect('/login');
  }

  // If a non-admin user has no assigned projects, do not render the dashboard at all.
  if (role === 'user' || role === 'project_admin') {
    const assigned = new Set((user?.projectIds ?? []).map(String).filter(Boolean));
    const memberships = await db.listUserProjectsByUser(userId);

    for (const membership of memberships) {
      if (membership.projectId) {
        assigned.add(String(membership.projectId));
      }
    }

    if (assigned.size === 0) {
      redirect('/no-project');
    }
  }

  return (
    <DashboardLayout
      user={{
        name: email ? email.split('@')[0] : 'Account',
        email,
        licenseType,
        role,
        servicePermissions: normalizeServicePermissions(user.servicePermissions),
      }}
    >
      {children}
    </DashboardLayout>
  );
}
