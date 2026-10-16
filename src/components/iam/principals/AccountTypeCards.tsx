'use client';

import type { ReactNode } from 'react';
import { IconKey, IconLink, IconMail } from '@tabler/icons-react';
import { SourceCard, SourceToggle } from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';

export type AccountKind = 'person' | 'service' | 'external';

/** The kind of account to add: invite a person, a service account, or an external identity. */
export default function AccountTypeCards({
  value,
  onChange,
  disabled,
}: {
  value: AccountKind;
  onChange: (kind: AccountKind) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('iamDirectory');
  const cards: Array<{ kind: AccountKind; icon: ReactNode }> = [
    { kind: 'person', icon: <IconMail size={15} /> },
    { kind: 'service', icon: <IconKey size={15} /> },
    { kind: 'external', icon: <IconLink size={15} /> },
  ];
  return (
    <SourceToggle>
      {cards.map((card) => (
        <SourceCard
          key={card.kind}
          selected={value === card.kind}
          onClick={() => !disabled && onChange(card.kind)}
          icon={card.icon}
          title={t(`invite.kinds.${card.kind}.title`)}
          description={t(`invite.kinds.${card.kind}.description`)}
        />
      ))}
    </SourceToggle>
  );
}
