import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import { canOpenIamCenter, getCurrentIdentity } from '@/lib/auth/serverIdentity';

/**
 * Gate of the IAM center. The center is for owners, admins and anyone with an
 * `iam` grant: an end user gets the same "not found" as for a page that does not
 * exist (the API refuses them as well - this keeps the page itself from loading).
 *
 * The role is read from the account record, not from the session header: a role
 * that changed after sign-in is honoured on the very next navigation.
 */
export default async function IamLayout({ children }: { children: ReactNode }) {
  const identity = await getCurrentIdentity();
  if (!identity || identity.state !== 'active') redirect('/login');
  if (!(await canOpenIamCenter(identity))) notFound();
  return children;
}
