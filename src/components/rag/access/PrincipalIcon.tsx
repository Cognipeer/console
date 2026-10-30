'use client';

/** The icon of a kind of principal: person, group, API token, address, directory entry, everyone. */

import { ThemeIcon } from '@mantine/core';
import {
  IconKey,
  IconMail,
  IconPlugConnected,
  IconUser,
  IconUsers,
  IconUsersGroup,
  IconWorld,
  type Icon,
} from '@tabler/icons-react';
import type { RagPrincipalKind } from '@/lib/services/rag/access/principals';

const LOOK: Record<RagPrincipalKind, { icon: Icon; color: string }> = {
  everyone: { icon: IconWorld, color: 'teal' },
  user: { icon: IconUser, color: 'blue' },
  group: { icon: IconUsers, color: 'violet' },
  token: { icon: IconKey, color: 'orange' },
  email: { icon: IconMail, color: 'cyan' },
  external_user: { icon: IconPlugConnected, color: 'grape' },
  external_group: { icon: IconUsersGroup, color: 'grape' },
  external_all: { icon: IconPlugConnected, color: 'grape' },
};

export function PrincipalIcon({ kind, size = 28 }: { kind: RagPrincipalKind | null; size?: number }) {
  const look = kind ? LOOK[kind] : { icon: IconUser, color: 'gray' };
  const Glyph = look.icon;
  return (
    <ThemeIcon variant="light" color={look.color} size={size} radius="md" aria-hidden>
      <Glyph size={Math.round(size * 0.6)} />
    </ThemeIcon>
  );
}
