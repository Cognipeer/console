'use client';

import { usePathname, useRouter } from 'next/navigation';
import { Tabs } from '@mantine/core';
import {
  IconCpu,
  IconSparkles,
  IconBoxModel,
  IconSettings,
  IconStackPush,
} from '@tabler/icons-react';

const TABS = [
  { value: 'overview', label: 'Overview', icon: <IconCpu size={16} />, href: '/dashboard/gpu-fleet' },
  { value: 'onboarding', label: 'Onboarding', icon: <IconSparkles size={16} />, href: '/dashboard/gpu-fleet/onboarding' },
  { value: 'models', label: 'Model Marketplace', icon: <IconBoxModel size={16} />, href: '/dashboard/gpu-fleet/models' },
  { value: 'pools', label: 'Pools', icon: <IconStackPush size={16} />, href: '/dashboard/gpu-fleet/pools' },
  { value: 'settings', label: 'Settings', icon: <IconSettings size={16} />, href: '/dashboard/gpu-fleet/settings' },
];

function activeTab(pathname: string | null): string {
  if (!pathname) return 'overview';
  if (pathname.includes('/onboarding')) return 'onboarding';
  if (pathname.includes('/models')) return 'models';
  if (pathname.includes('/pools')) return 'pools';
  if (pathname.includes('/settings')) return 'settings';
  return 'overview';
}

export default function GpuFleetLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const active = activeTab(pathname);

  return (
    <div>
      <Tabs
        value={active}
        onChange={(value) => {
          const tab = TABS.find((t) => t.value === value);
          if (tab) router.push(tab.href);
        }}
        mb="md"
      >
        <Tabs.List>
          {TABS.map((tab) => (
            <Tabs.Tab key={tab.value} value={tab.value} leftSection={tab.icon}>
              {tab.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs>
      {children}
    </div>
  );
}
