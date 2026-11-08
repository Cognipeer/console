'use client';

import ActiveIncidentsCard from '@/components/alerts/ActiveIncidentsCard';
import classes from './HomeAttention.module.css';

export interface HomeAttentionProps {
  /** Whether the person can open a service in the active project (the navigation's list). */
  canOpen: (serviceId: string) => boolean;
}

/**
 * The home page's "needs attention" row: what is wrong right now, and nothing at all while nothing is. The community
 * build lists the project's open incidents (with Alerts).
 *
 * The Enterprise overlay replaces this file at the same path (it adds entity health), so keep the props as they are.
 */
export default function HomeAttention({ canOpen }: HomeAttentionProps) {
  return (
    <div className={classes.row} data-testid="home-attention">
      {canOpen('alerts') ? <ActiveIncidentsCard limit={5} compact hideWhenEmpty /> : null}
    </div>
  );
}
