import { notFound, redirect } from 'next/navigation';
import { getCurrentIdentity } from '@/lib/auth/serverIdentity';

/**
 * Providers are for owners and admins. The role is the account's current one
 * (read from the account record, cached for 30 s at most), not the one the
 * session was issued with: a promotion or a demotion is honoured on the next
 * navigation, the same as in the navigation menu.
 */
export default async function ProvidersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const identity = await getCurrentIdentity();
  if (!identity || identity.state !== 'active') redirect('/login');

  if (identity.role !== 'owner' && identity.role !== 'admin') {
    notFound();
  }

  return children;
}
