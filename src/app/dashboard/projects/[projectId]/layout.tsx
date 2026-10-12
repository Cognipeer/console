import { notFound, redirect } from 'next/navigation';
import { getCurrentIdentity } from '@/lib/auth/serverIdentity';
import { getDatabase } from '@/lib/database';
import { findGroupProjectMembership } from '@/lib/services/projects/accessibleProjects';

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  // The account as it is now (state and role from the account record, cached for 30 s at
  // most), not as the session was issued: a promotion, a demotion or a disable is honoured
  // on the next navigation. A lookup failure throws (error page), never falls through.
  const identity = await getCurrentIdentity();
  const { projectId } = await params;

  // Checked before the admin short-circuit below: admins can be disabled too.
  if (!identity || identity.state !== 'active') {
    redirect('/login');
  }

  const { tenantDbName, tenantId, userId, role } = identity;

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
  if (legacyAllowed) {
    return children;
  }

  // A project reached only through a group the member belongs to is still theirs.
  if (await findGroupProjectMembership(db, userId, projectId)) {
    return children;
  }

  notFound();
}
