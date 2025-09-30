'use client';

import { ReactNode } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';

interface DashboardRouteLayoutProps {
  children: ReactNode;
}

export default function DashboardRouteLayout({ children }: DashboardRouteLayoutProps) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
