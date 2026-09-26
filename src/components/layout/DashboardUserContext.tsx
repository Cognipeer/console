'use client';

import { createContext, useContext, type ReactNode } from 'react';

/** Signed-in user as resolved by the dashboard shell from the request headers. */
export interface DashboardUser {
  name: string;
  email: string;
  licenseType: string;
  role?: 'owner' | 'admin' | 'project_admin' | 'user';
}

const DashboardUserContext = createContext<DashboardUser | null>(null);

export function DashboardUserProvider({
  value,
  children,
}: {
  value: DashboardUser | null;
  children: ReactNode;
}) {
  return <DashboardUserContext.Provider value={value}>{children}</DashboardUserContext.Provider>;
}

/**
 * The shell's user, available on the first render of every dashboard page
 * (no API round trip). `null` outside the dashboard shell.
 */
export function useDashboardUser(): DashboardUser | null {
  return useContext(DashboardUserContext);
}
