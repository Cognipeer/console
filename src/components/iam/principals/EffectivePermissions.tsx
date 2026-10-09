'use client';

import { useMemo, useState } from 'react';
import { Badge, Chip, Group, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import {
  countByLevel,
  filterEffective,
  isSourceKind,
  PERMISSION_LEVELS,
  sortEffective,
  type EffectiveLevelFilter,
  type EffectiveRow,
  type EffectiveSource,
  type PermissionLevel,
} from './client';
import { translateOr, type Translate } from './format';
import styles from './PrincipalDetail.module.css';
import { badgeVariant, LEVEL_COLOR, sourceColor } from './visuals';

const NS = 'iamPrincipals';

export function LevelBadge({ level, t }: { level: PermissionLevel; t: Translate }) {
  return (
    <Badge variant={level === 'none' ? 'default' : 'light'} color={LEVEL_COLOR[level]} radius="sm">
      {t(`drawer.levels.${level}`)}
    </Badge>
  );
}

/** Texts the server sends as the label of a source when there is nothing more specific to name. */
const GENERIC_SOURCE_LABELS: Record<string, readonly string[]> = {
  direct: ['Direct permission'],
  'token-scope': ['Token scope'],
  project: ['Project'],
  group: ['Group'],
  policy: ['Custom policy'],
};

/**
 * What a source chip says after its kind: the role in the user's language, a
 * policy id as the policy's name, nothing when the server only repeated the
 * kind ("Direct permission" next to "Direct grant").
 */
export function sourceDetail(source: EffectiveSource, policyNames: ReadonlyMap<string, string>, t: Translate): string {
  const label = source.label.trim();
  if (!label || GENERIC_SOURCE_LABELS[source.kind]?.includes(label)) return '';
  if (source.kind === 'role') return translateOr(t, NS, `roles.${label}`, label);
  if (source.kind === 'policy') {
    // The server lists the ids of the policies behind the level, comma separated.
    return label
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((id) => policyNames.get(id) ?? id)
      .join(', ');
  }
  return label;
}

/** One place a level comes from: a role, a group, a token scope, a project setting, a policy... */
export function SourceChip({
  source,
  policyNames,
  t,
}: {
  source: EffectiveSource;
  policyNames: ReadonlyMap<string, string>;
  t: Translate;
}) {
  const kind = isSourceKind(source.kind) ? source.kind : 'other';
  const color = sourceColor(source.kind);
  const kindLabel = t(`drawer.sources.kind.${kind}`);
  const detail = sourceDetail(source, policyNames, t);
  return (
    <Tooltip label={t(`drawer.sources.hint.${kind}`)} withArrow multiline w={240} openDelay={250}>
      <Badge
        variant={badgeVariant(color)}
        color={color}
        size="sm"
        radius="sm"
        tt="none"
        fw={500}
        maw="100%"
        data-source-kind={source.kind}
      >
        {detail ? `${kindLabel}: ${detail}` : kindLabel}
        {source.level ? ` · ${t(`drawer.levels.${source.level}`)}` : ''}
      </Badge>
    </Tooltip>
  );
}

interface LevelChip {
  value: EffectiveLevelFilter;
  label: string;
  count: number;
}

function Muted({ children }: { children: string }) {
  return (
    <Text size="sm" c="dimmed">
      {children}
    </Text>
  );
}

/**
 * The effective permissions of a principal: one row per service with the level
 * it ends up at and the chips that explain it. Filter chips by level (default:
 * the services the principal can use) and a text filter keep a 45-service table
 * scannable.
 */
export default function EffectivePermissions({
  rows,
  labelOf,
  policyNames,
  t,
}: {
  rows: EffectiveRow[];
  labelOf: (service: string) => string;
  /** Policy id -> name, to name the policies behind a level. */
  policyNames: ReadonlyMap<string, string>;
  t: Translate;
}) {
  const [query, setQuery] = useState('');
  // null = the default: what the principal can use, or everything when it can use nothing.
  const [picked, setPicked] = useState<EffectiveLevelFilter | null>(null);

  const sorted = useMemo(() => sortEffective(rows, labelOf), [rows, labelOf]);
  const counts = useMemo(() => countByLevel(rows), [rows]);
  const withAccess = rows.length - counts.none;
  const level: EffectiveLevelFilter = picked ?? (withAccess > 0 ? 'access' : 'all');
  const visible = useMemo(() => filterEffective(sorted, { query, level, labelOf }), [sorted, query, level, labelOf]);

  const levelChips = [...PERMISSION_LEVELS].reverse().map(
    (l): LevelChip => ({ value: l, label: t(`drawer.levels.${l}`), count: counts[l] }),
  );
  const accessChip: LevelChip = { value: 'access', label: t('drawer.effective.withAccess'), count: withAccess };
  const chips = [accessChip, ...levelChips].filter((c) => c.count > 0);

  return (
    <Stack gap="sm">
      <Group gap="sm" wrap="wrap" align="center">
        <TextInput
          size="xs"
          style={{ flex: '1 1 180px' }}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder={t('drawer.effective.filter')}
          aria-label={t('drawer.effective.filter')}
          leftSection={<IconSearch size={14} stroke={1.6} />}
        />
      </Group>

      {chips.length > 1 ? (
        <Chip.Group multiple={false} value={level} onChange={(v) => setPicked(v as EffectiveLevelFilter)}>
          <Group gap={6} wrap="wrap">
            {chips.map((chip) => (
              <Chip key={chip.value} value={chip.value} size="xs" variant="light">
                {`${chip.label} (${chip.count})`}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
      ) : null}

      {visible.length === 0 ? (
        <Muted>{query.trim() ? t('drawer.effective.emptyFilter') : t('drawer.effective.empty')}</Muted>
      ) : (
        <div className={styles.permList} role="table" aria-label={t('drawer.effective.title')}>
          <div className={styles.permHead} role="row">
            <span role="columnheader">{t('drawer.effective.columns.service')}</span>
            <span role="columnheader">{t('drawer.effective.columns.level')}</span>
            <span role="columnheader">{t('drawer.effective.columns.sources')}</span>
          </div>
          {visible.map((row) => (
            <div key={row.service} className={styles.permRow} role="row">
              <div role="cell" style={{ minWidth: 0 }}>
                <Text size="sm" fw={500} style={{ wordBreak: 'break-word' }}>
                  {labelOf(row.service)}
                </Text>
                <Text size="xs" c="dimmed" ff="monospace">
                  {row.service}
                </Text>
              </div>
              <div role="cell">
                <LevelBadge level={row.level} t={t} />
              </div>
              <div role="cell" className={styles.sources}>
                {row.sources.length === 0 ? (
                  <Text size="xs" c="dimmed">
                    —
                  </Text>
                ) : (
                  row.sources.map((source, i) => (
                    <SourceChip key={`${source.kind}:${source.label}:${i}`} source={source} policyNames={policyNames} t={t} />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Stack>
  );
}
