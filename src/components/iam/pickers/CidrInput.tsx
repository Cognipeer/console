'use client';

import { useState, type ReactNode } from 'react';
import { TagsInput } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import { parseCidr } from '../ipRanges';

interface CidrInputProps {
  label?: ReactNode;
  description?: ReactNode;
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

/**
 * A list of CIDR ranges. Entries are validated as they are typed (a range the
 * server would reject never reaches the list) and a bare address becomes a
 * single-host range (`/32`, `/128`).
 */
export default function CidrInput({ label, description, value, onChange, disabled }: CidrInputProps) {
  const t = useTranslations('iamCenter');
  const [rejected, setRejected] = useState<string[]>([]);

  return (
    <TagsInput
      label={label}
      description={description}
      placeholder={value.length === 0 ? t('conditions.ipPlaceholder') : undefined}
      value={value}
      splitChars={[',', ' ', ';']}
      clearable
      disabled={disabled}
      error={rejected.length > 0 ? t('conditions.ipInvalid', { value: rejected.join(', ') }) : undefined}
      onChange={(next) => {
        const kept: string[] = [];
        const bad: string[] = [];
        for (const raw of next) {
          if (value.includes(raw)) {
            if (!kept.includes(raw)) kept.push(raw);
            continue;
          }
          const parsed = parseCidr(raw);
          if (!parsed.ok) {
            bad.push(raw);
          } else if (!kept.includes(parsed.normalized)) {
            kept.push(parsed.normalized);
          }
        }
        setRejected(bad);
        onChange(kept);
      }}
    />
  );
}
