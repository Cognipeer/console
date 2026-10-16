'use client';

import { useEffect, useState } from 'react';
import type { AlertTemplateListDto } from './alertTypes';

/** Admins of the active project that alert emails can reach (`null` while unknown). */
export function useProjectAdminCount(enabled: boolean): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch('/api/alerts/templates')
      .then((res) => (res.ok ? (res.json() as Promise<AlertTemplateListDto>) : null))
      .then((data) => {
        if (!cancelled && data && typeof data.projectAdminRecipients === 'number') setCount(data.projectAdminRecipients);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return count;
}
