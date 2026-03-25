import { redirect } from 'next/navigation';

// Tenant Settings has been split into standalone pages:
// /dashboard/members, /dashboard/providers, /dashboard/projects
export default function TenantSettingsPage() {
  redirect('/dashboard/members');
}
