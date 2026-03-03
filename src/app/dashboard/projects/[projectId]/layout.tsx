import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

export default async function ProjectLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const headerList = await headers();
  const role = headerList.get('x-user-role');

  // Only owner/admin can access project detail (users, providers, quotas)
  if (role !== 'owner' && role !== 'admin') {
    notFound();
  }

  return children;
}
