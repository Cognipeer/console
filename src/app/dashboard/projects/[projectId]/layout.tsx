import { redirect } from 'next/navigation';

export default async function ProjectLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  void children;
  // Project detail/settings page removed; use /dashboard/settings instead.
  redirect('/dashboard/settings');
}
