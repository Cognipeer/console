import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import ProjectSettingsPage from '@/components/settings/ProjectSettingsPage';

export default async function SettingsPage() {
  const h = await headers();
  const role = h.get('x-user-role');

  // Tenant admins manage projects under Tenant Settings.
  if (role === 'owner' || role === 'admin') {
    redirect('/dashboard/tenant-settings');
  }

  return <ProjectSettingsPage />;
}
