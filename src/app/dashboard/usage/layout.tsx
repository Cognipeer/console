import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { planLimitsActive } from '@/lib/limits/mode';

/**
 * Gate of the usage page. The page exists only where plan limits are active
 * (a hosted deployment with limits measured); anywhere else it is the same
 * "not found" as a page that does not exist. Owners and admins only is enforced
 * by the API (`/api/usage/*` is part of the `license` service) and by the nav.
 */
export default function UsageLayout({ children }: { children: ReactNode }) {
  if (!planLimitsActive()) notFound();
  return children;
}
