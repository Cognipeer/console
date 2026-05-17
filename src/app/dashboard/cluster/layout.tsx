'use client';

import { usePathname, useRouter } from 'next/navigation';
import { Tabs } from '@mantine/core';
import { IconServer, IconCircuitChangeover } from '@tabler/icons-react';

const TABS = [
  { value: 'nodes', label: 'Nodes', icon: <IconServer size={16} />, href: '/dashboard/cluster/nodes' },
  { value: 'instances', label: 'Instances', icon: <IconCircuitChangeover size={16} />, href: '/dashboard/cluster/instances' },
];

export default function ClusterLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const active = pathname?.includes('/instances') ? 'instances' : 'nodes';

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
