'use client';

import { ActionIcon, CopyButton as MantineCopyButton, Tooltip, VisuallyHidden } from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';

export interface CopyButtonProps {
  /** The text put on the clipboard. */
  value: string;
  /** What the button says to a screen reader and in its tooltip ("Copy key of report.pdf"); defaults to "Copy". */
  label?: string;
  size?: number;
}

/** A small icon button that copies `value` and says "Copied" for a moment. */
export default function CopyButton({ value, label, size = 14 }: CopyButtonProps) {
  const t = useTranslations('files.common');
  const name = label ?? t('copy.copy');
  return (
    <MantineCopyButton value={value} timeout={1800}>
      {({ copied, copy }) => (
        <>
          <Tooltip label={copied ? t('copy.copied') : name} withArrow>
            <ActionIcon
              variant="subtle"
              color={copied ? 'teal' : 'gray'}
              size="sm"
              onClick={copy}
              aria-label={name}
            >
              {copied ? <IconCheck size={size} /> : <IconCopy size={size} />}
            </ActionIcon>
          </Tooltip>
          {copied ? <VisuallyHidden role="status">{t('copy.copied')}</VisuallyHidden> : null}
        </>
      )}
    </MantineCopyButton>
  );
}
