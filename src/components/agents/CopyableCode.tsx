'use client';

import { ActionIcon, Code, CopyButton, Group, Tooltip } from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import classes from './CopyableCode.module.css';

interface CopyableCodeProps {
  value: string;
  /** Where the copy button sits beside the block: centered for a one-liner, at the top for a tall snippet. */
  align?: 'center' | 'start';
}

/** A code block with a copy button. */
export default function CopyableCode({ value, align = 'center' }: CopyableCodeProps) {
  const t = useTranslations('agents.usage');
  return (
    <Group gap="xs" align={align === 'start' ? 'flex-start' : 'center'} wrap="nowrap">
      <Code block className={classes.grow}>{value}</Code>
      <CopyButton value={value}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? t('copied') : t('copy')}>
            <ActionIcon
              variant="subtle"
              onClick={copy}
              color={copied ? 'teal' : 'gray'}
              aria-label={copied ? t('copied') : t('copy')}
            >
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );
}
