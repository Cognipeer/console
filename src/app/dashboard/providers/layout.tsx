import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

export default async function ProvidersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const headerList = await headers();
  const role = headerList.get('x-user-role');

  if (role !== 'owner' && role !== 'admin') {
    notFound();
  }

  return children;
}
