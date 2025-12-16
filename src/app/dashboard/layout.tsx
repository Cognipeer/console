import { ReactNode } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { getDatabase } from '@/lib/database';

interface DashboardRouteLayoutProps {
  children: ReactNode;
}

export default async function DashboardRouteLayout({ children }: DashboardRouteLayoutProps) {
  const h = await headers();
  const email = h.get('x-user-email') ?? 'user@example.com';
  const licenseType = h.get('x-license-type') ?? 'FREE';
  const role = (h.get('x-user-role') ?? 'user') as
    | 'owner'
    | 'admin'
    | 'project_admin'
    | 'user';

  // If a non-admin user has no assigned projects, do not render the dashboard at all.
  if (role === 'user' || role === 'project_admin') {
    const tenantDbName = h.get('x-tenant-db-name');
    const userId = h.get('x-user-id');
    const tenantId = h.get('x-tenant-id');

    if (!tenantDbName || !tenantId || !userId) {
      redirect('/login');
    }

    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    const user = await db.findUserById(userId);

    const assigned = (user?.projectIds ?? []).map(String).filter(Boolean);
    if (assigned.length === 0) {
      redirect('/no-project');
    }
  }

  return (
    <DashboardLayout
      user={{
        name: email.split('@')[0] || 'User',
        email,
        licenseType,
        role,
      }}
    >
      {children}
    </DashboardLayout>
  );
}
