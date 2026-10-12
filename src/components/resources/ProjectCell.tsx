'use client';

import { Tooltip } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';

// Mirrors the server-computed ProjectDisplay of src/lib/resources/types.ts: the
// UI renders it and never infers it from `projectId === null`, which means four
// different things (tenant-wide, no project concept, unassigned, several).
export type ProjectDisplay =
  | { kind: 'project'; projectId: string; projectName: string | null }
  | { kind: 'multi-project'; projectIds: string[]; projectNames: string[] }
  | { kind: 'all-projects' }
  | { kind: 'tenant-level' }
  | { kind: 'unassigned' };

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Plain-text label (badges, inline sentences); `ProjectCell` adds the tooltip and colour. */
export function projectDisplayLabel(t: Translate, display: ProjectDisplay | null | undefined): string {
  if (!display) return '—';
  switch (display.kind) {
    case 'project':
      return display.projectName ?? display.projectId;
    case 'multi-project': {
      const [first = '—', ...rest] = display.projectNames;
      return rest.length > 0 ? `${first} +${rest.length}` : first;
    }
    case 'all-projects':
      return t('projectDisplay.allProjects');
    case 'tenant-level':
      return t('projectDisplay.tenantLevel');
    case 'unassigned':
      return t('projectDisplay.unassigned');
  }
}

function projectDisplayHint(t: Translate, display: ProjectDisplay): string | null {
  switch (display.kind) {
    case 'multi-project':
      return display.projectNames.join(', ');
    case 'all-projects':
      return t('projectDisplay.allProjectsHint');
    case 'tenant-level':
      return t('projectDisplay.tenantLevelHint');
    case 'unassigned':
      return t('projectDisplay.unassignedHint');
    case 'project':
    default:
      return null;
  }
}

export interface ProjectCellProps {
  display: ProjectDisplay | null | undefined;
}

/** One place that says which project (if any) a resource belongs to. */
export default function ProjectCell({ display }: ProjectCellProps) {
  const t = useTranslations('resources');
  if (!display) return <span className="ds-muted">—</span>;
  const label = projectDisplayLabel(t, display);
  const hint = projectDisplayHint(t, display);
  const muted = display.kind === 'all-projects' || display.kind === 'tenant-level';
  const unassigned = display.kind === 'unassigned';
  // Unusable is a state, not just a colour: the icon keeps it readable without hue (--ds-warn is the theme's warning text token).
  const text = (
    <span
      className={muted ? 'ds-muted' : undefined}
      style={unassigned ? { color: 'var(--ds-warn)', fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 4 } : undefined}
    >
      {unassigned ? <IconAlertTriangle size={13} aria-hidden /> : null}
      {label}
    </span>
  );
  return hint ? (
    <Tooltip label={hint} multiline w={260} withArrow>
      {text}
    </Tooltip>
  ) : (
    text
  );
}
