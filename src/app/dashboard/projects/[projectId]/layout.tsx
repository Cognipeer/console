import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@/lib/database';

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const headerList = await headers();
  const tenantDbName = headerList.get('x-tenant-db-name');
  const tenantId = headerList.get('x-tenant-id');
  const userId = headerList.get('x-user-id');
  const role = headerList.get('x-user-role');
  const { projectId } = await params;

  if (!tenantDbName || !tenantId || !userId || !role) {
    redirect('/login');
  }

  if (role === 'owner' || role === 'admin') {
    return children;
  }

  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const project = await db.findProjectById(projectId);
  if (!project || String(project.tenantId) !== String(tenantId)) {
    notFound();
  }

  const membership = await db.findUserProject(userId, projectId);
  if (membership) {
    return children;
  }

  const user = await db.findUserById(userId);
  const legacyAllowed = (user?.projectIds ?? []).map(String).includes(String(projectId));
  if (!legacyAllowed) {
    notFound();
  }

  return children;
}
