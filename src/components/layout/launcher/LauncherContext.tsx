'use client';

import { createContext, ReactNode, useContext, useMemo } from 'react';
import type { DashboardServiceDefinition } from '@/lib/utils/dashboardServices';

export interface LauncherContextValue {
  pinned: Set<string>;
  recents: string[];
  togglePin: (id: string) => void;
  recordVisit: (id: string) => void;
  services: DashboardServiceDefinition[];
  pinnedServices: DashboardServiceDefinition[];
  recentServices: DashboardServiceDefinition[];
  isTenantAdmin: boolean;
  openLauncher: () => void;
}

const LauncherContext = createContext<LauncherContextValue | null>(null);

export function LauncherProvider({
  value,
  children,
}: {
  value: LauncherContextValue;
  children: ReactNode;
}) {
  const memo = useMemo(() => value, [value]);
  return <LauncherContext.Provider value={memo}>{children}</LauncherContext.Provider>;
}

export function useLauncher() {
  const ctx = useContext(LauncherContext);
  if (!ctx) {
    throw new Error('useLauncher must be used within LauncherProvider');
  }
  return ctx;
}

export function useOptionalLauncher() {
  return useContext(LauncherContext);
}
