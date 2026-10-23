'use client';

import { useEffect, useState } from 'react';
import { Avatar, Menu, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconExternalLink } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import classes from './LauncherShell.module.css';

interface MyPortal {
  key: string;
  name: string;
  description?: string;
  logo?: string;
}

/**
 * Quick links to the portals the signed-in user may open. The list comes from the enterprise
 * `/api/portal/my` endpoint; where the endpoint is missing (community), unlicensed, or returns no
 * portals, nothing is rendered.
 */
export default function PortalSwitcher() {
  const t = useTranslations('navigation');
  const [portals, setPortals] = useState<MyPortal[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/portal/my', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { portals?: MyPortal[] } | null) => {
        if (!cancelled && Array.isArray(body?.portals)) setPortals(body.portals);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (portals.length === 0) return null;

  return (
    <Menu shadow="md" width={260} position="bottom-end">
      <Menu.Target>
        <UnstyledButton className={`${classes.svcTrigger} ${classes.hideOnMobile}`} aria-label={t('portals')}>
          <span>{t('portals')}</span>
          <Text component="span" size="xs" c="dimmed">
            {portals.length}
          </Text>
          <IconChevronDown size={13} stroke={2} />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{t('portalsYours')}</Menu.Label>
        {portals.map((portal) => (
          <Menu.Item
            key={portal.key}
            component="a"
            href={`/p/${encodeURIComponent(portal.key)}`}
            target="_blank"
            rel="noopener noreferrer"
            leftSection={
              <Avatar size={22} radius="sm" src={portal.logo} color="teal">
                {portal.name.charAt(0).toUpperCase()}
              </Avatar>
            }
            rightSection={<IconExternalLink size={13} />}
          >
            <Text size="sm" lineClamp={1}>
              {portal.name}
            </Text>
            {portal.description && (
              <Text size="xs" c="dimmed" lineClamp={1}>
                {portal.description}
              </Text>
            )}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
