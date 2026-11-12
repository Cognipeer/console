'use client';

import { useProjectAdminRecipients } from '@/lib/api/queries/alerts';

/** Admins of the active project that alert emails can reach (`null` while unknown). */
export function useProjectAdminCount(enabled: boolean): number | null {
  return useProjectAdminRecipients(enabled);
}
