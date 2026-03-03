import { redirect } from 'next/navigation';

// Settings has been split into standalone pages:
// /dashboard/tokens, /dashboard/members, /dashboard/providers
export default function SettingsPage() {
  redirect('/dashboard/tokens');
}
