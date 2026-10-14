'use client';

import { Avatar } from '@mantine/core';
import { IconKey, IconUser, IconUsersGroup } from '@tabler/icons-react';
import type { PermissionLevel } from './client';
import { initialsOf } from './format';

/** Mantine colour per principal kind, shared by avatars, chips and links. */
export function principalColor(type: string): string {
  if (type === 'group') return 'teal';
  if (type === 'token') return 'grape';
  return 'blue';
}

export function PrincipalIcon({ type, size = 16 }: { type: string; size?: number }) {
  if (type === 'group') return <IconUsersGroup size={size} stroke={1.6} aria-hidden />;
  if (type === 'token') return <IconKey size={size} stroke={1.6} aria-hidden />;
  return <IconUser size={size} stroke={1.6} aria-hidden />;
}

/** Initials for a user, a glyph for groups and tokens. */
export function PrincipalAvatar({ type, label, size = 32 }: { type: string; label: string; size?: number }) {
  return (
    <Avatar size={size} radius="xl" variant="light" color={principalColor(type)}>
      {type === 'user' ? initialsOf(label) : <PrincipalIcon type={type} size={Math.round(size * 0.55)} />}
    </Avatar>
  );
}

/**
 * The light variant of Mantine's gray is too pale to read; a neutral label uses
 * the `default` variant (white, bordered, regular text colour) instead.
 */
export function badgeVariant(color: string): 'light' | 'default' {
  return color === 'gray' ? 'default' : 'light';
}

export const LEVEL_COLOR: Record<PermissionLevel, string> = {
  none: 'gray',
  read: 'blue',
  write: 'orange',
  admin: 'red',
};

const ROLE_COLOR: Record<string, string> = {
  owner: 'blue',
  admin: 'grape',
  project_admin: 'cyan',
  user: 'gray',
};

export function roleColor(role: string): string {
  return ROLE_COLOR[role] ?? 'gray';
}

const STATUS_COLOR: Record<string, string> = {
  active: 'green',
  disabled: 'red',
  revoked: 'red',
  expired: 'orange',
  invited: 'orange',
  no_login: 'gray',
};

export function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? 'gray';
}

const SOURCE_COLOR: Record<string, string> = {
  role: 'violet',
  direct: 'blue',
  group: 'teal',
  'token-scope': 'orange',
  project: 'cyan',
  policy: 'grape',
};

export function sourceColor(kind: string): string {
  return SOURCE_COLOR[kind] ?? 'gray';
}
