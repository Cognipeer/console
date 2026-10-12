'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Anchor, Badge, Button, Group, Text } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import {
  iamLinks,
  policyReach,
  type AttachedPolicy,
  type GroupRef,
  type PolicyReach,
  type PrincipalType,
} from './client';
import type { Translate } from './format';
import styles from './PrincipalDetail.module.css';

const EFFECT_COLOR = { permit: 'green', forbid: 'red', mixed: 'yellow' } as const;

function reachLabel(reach: PolicyReach, groups: Map<string, string>, t: Translate): string {
  if (reach.kind === 'group') {
    return t('drawer.policies.reach.group', {
      name: reach.groupIds.map((id) => groups.get(id) ?? id).join(', '),
    });
  }
  return t(`drawer.policies.reach.${reach.kind}`);
}

/**
 * The custom policies that apply to one principal: what each does, whether it
 * is enabled, and why it reaches this principal (named, via a group, everyone...).
 */
export default function AttachedPolicies({
  policies,
  principal,
  groups,
  ownerId,
  t,
}: {
  policies: AttachedPolicy[];
  principal: { type: PrincipalType; id: string };
  /** The principal's groups (for a token: its owner's). */
  groups: GroupRef[];
  /** The user who owns the token, when the principal is a token. */
  ownerId?: string | null;
  t: Translate;
}) {
  const groupNames = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);
  const groupIds = useMemo(() => groups.map((g) => g.id), [groups]);

  if (policies.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {t('drawer.policies.empty')}
      </Text>
    );
  }

  return (
    <div className={styles.bordered}>
      {policies.map((policy) => {
        const reach = policyReach(policy, principal, groupIds, ownerId);
        return (
          <div key={policy.policyId} className={styles.listRow}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <Group gap={6} wrap="wrap" align="center">
                <Anchor component={Link} href={iamLinks.policy(policy.policyId)} size="sm" fw={600}>
                  {policy.name}
                </Anchor>
                {policy.effect ? (
                  <Badge size="sm" variant="light" color={EFFECT_COLOR[policy.effect]}>
                    {t(`drawer.policies.effect.${policy.effect}`)}
                  </Badge>
                ) : null}
                {!policy.enabled ? (
                  <Badge size="sm" variant="default">
                    {t('drawer.policies.disabled')}
                  </Badge>
                ) : null}
              </Group>
              {policy.description ? (
                <Text size="xs" c="dimmed" lineClamp={2}>
                  {policy.description}
                </Text>
              ) : null}
              {reach.length > 0 ? (
                <Group gap={4} mt={6} wrap="wrap">
                  <Text size="xs" c="dimmed">
                    {t('drawer.policies.appliesLabel')}
                  </Text>
                  {reach.map((r, i) => (
                    <Badge key={`${r.kind}:${i}`} size="xs" variant="default" tt="none" fw={500}>
                      {reachLabel(r, groupNames, t)}
                    </Badge>
                  ))}
                </Group>
              ) : null}
            </div>
            <Button
              component={Link}
              href={iamLinks.policy(policy.policyId)}
              size="compact-xs"
              variant="subtle"
              rightSection={<IconExternalLink size={12} />}
            >
              {t('drawer.policies.open')}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
