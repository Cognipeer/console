import { redirect } from 'next/navigation';

// Settings has been split into standalone pages (tokens, providers, projects...);
// people and groups live in the IAM center.
export default function SettingsPage() {
  redirect('/dashboard/tokens');
}
