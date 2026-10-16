'use client';

import type { ReactNode } from 'react';
import { Button, Menu } from '@mantine/core';
import { IconChevronDown, IconKey, IconLink, IconPlus, IconRobot, IconUpload, IconUserPlus, IconUsersGroup } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { DirectoryCapabilities } from './directoryApi';
import type { NewKind } from './listState';

interface AddMenuProps {
  capabilities: Pick<DirectoryCapabilities, 'peopleManage' | 'tokensManageOthers'>;
  onPick: (kind: NewKind) => void;
}

interface Item {
  kind: NewKind;
  icon: ReactNode;
  needsPeople: boolean;
}

const ITEMS: readonly Item[] = [
  { kind: 'person', icon: <IconUserPlus size={14} />, needsPeople: true },
  { kind: 'service', icon: <IconRobot size={14} />, needsPeople: true },
  { kind: 'external', icon: <IconLink size={14} />, needsPeople: true },
  { kind: 'import', icon: <IconUpload size={14} />, needsPeople: true },
  { kind: 'group', icon: <IconUsersGroup size={14} />, needsPeople: true },
  { kind: 'token', icon: <IconKey size={14} />, needsPeople: false },
];

/**
 * The "Add" menu of the Principals toolbar: invite a person, create a service
 * account, import service accounts, a group, a token. Entries the signed-in
 * person cannot use are disabled and say which permission is missing; for a
 * read-only viewer the whole menu is absent.
 */
export default function AddMenu({ capabilities, onPick }: AddMenuProps) {
  const t = useTranslations('iamDirectory');
  if (!capabilities.peopleManage && !capabilities.tokensManageOthers) return null;

  return (
    <Menu withinPortal position="bottom-end" shadow="md" width={260}>
      <Menu.Target>
        <Button
          color="teal"
          size="xs"
          leftSection={<IconPlus size={13} stroke={1.7} />}
          rightSection={<IconChevronDown size={12} />}
          data-testid="add-menu"
        >
          {t('add.button')}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {ITEMS.map((item) => {
          const allowed = !item.needsPeople || capabilities.peopleManage;
          return (
            <Menu.Item
              key={item.kind}
              leftSection={item.icon}
              disabled={!allowed}
              onClick={() => onPick(item.kind)}
              data-testid={`add-${item.kind}`}
            >
              <div>
                <div>{t(`add.items.${item.kind}.label`)}</div>
                <div className="ds-faint" style={{ fontSize: 11 }}>
                  {allowed ? t(`add.items.${item.kind}.hint`) : t('add.needsPeople')}
                </div>
              </div>
            </Menu.Item>
          );
        })}
      </Menu.Dropdown>
    </Menu>
  );
}
