import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

export default async function ProjectsPage() {
  const h = await headers();
  const role = h.get('x-user-role');

  // Projects management was consolidated under Tenant Settings.
  if (role === 'owner' || role === 'admin') {
    redirect('/dashboard/tenant-settings');
  }

  redirect('/dashboard/settings');
}
