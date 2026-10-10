'use client';

import { useState } from 'react';
import { Accordion, Alert, Badge, Button, Group, Stack, Text } from '@mantine/core';
import { IconCode, IconLock } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { ManagedPolicy } from '../api';
import type { IamLabels } from '../useIamLabels';
import CedarView from './CedarView';

interface ManagedPoliciesProps {
  policies: ManagedPolicy[];
  labels: IamLabels;
}

/**
 * The built-in policies: read-only, with the reason each one exists. They can
 * neither be edited nor disabled. The plain-language texts come from the server
 * (translated through the keys it sends); the English text it also sends is the
 * fallback.
 */
export default function ManagedPolicies({ policies, labels }: ManagedPoliciesProps) {
  const t = useTranslations('iamCenter');
  const [shown, setShown] = useState<Set<string>>(() => new Set());

  if (policies.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {t('managed.none')}
      </Text>
    );
  }

  const roleBased = policies.filter((p) => p.group === 'rbac');
  const boundaries = policies.filter((p) => p.group === 'boundary');
  const portals = policies.filter((p) => p.group === 'portal');
  const agents = policies.filter((p) => p.group === 'agent');

  const toggleCedar = (id: string) =>
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderItem = (policy: ManagedPolicy) => {
    const name = labels.lookup(policy.nameKey) ?? policy.name;
    const explanation = labels.lookup(policy.descriptionKey) ?? policy.description;
    const open = shown.has(policy.id);
    return (
      <Accordion.Item key={policy.id} value={policy.id}>
        <Accordion.Control icon={<IconLock size={16} />}>
          <Group gap="xs" wrap="nowrap">
            <Text size="sm" fw={500}>
              {name}
            </Text>
            <Badge size="xs" variant="default">
              {t('managed.badge')}
            </Badge>
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <Stack gap="xs">
            {explanation ? <Text size="sm">{explanation}</Text> : null}
            <Group>
              <Button
                size="compact-xs"
                variant="subtle"
                leftSection={<IconCode size={12} />}
                onClick={() => toggleCedar(policy.id)}
              >
                {open ? t('managed.hideCedar') : t('managed.showCedar')}
              </Button>
              <Text size="xs" c="dimmed" ff="monospace">
                {policy.id}
              </Text>
            </Group>
            {open ? <CedarView code={policy.cedar} maxHeight={220} /> : null}
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    );
  };

  return (
    <Stack gap="md">
      <Alert color="blue" variant="light">
        {t('managed.intro')}
      </Alert>
      {roleBased.length > 0 ? (
        <div>
          <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb={4}>
            {t('managed.roleBased')}
          </Text>
          <Accordion variant="separated" multiple>
            {roleBased.map(renderItem)}
          </Accordion>
        </div>
      ) : null}
      {boundaries.length > 0 ? (
        <div>
          <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb={4}>
            {t('managed.boundaries')}
          </Text>
          <Text size="xs" c="dimmed" mb={6}>
            {t('managed.boundariesHelp')}
          </Text>
          <Accordion variant="separated" multiple>
            {boundaries.map(renderItem)}
          </Accordion>
        </div>
      ) : null}
      {portals.length > 0 ? (
        <div data-testid="managed-portal-group">
          <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb={4}>
            {t('managed.portalBased')}
          </Text>
          <Text size="xs" c="dimmed" mb={6}>
            {t('managed.portalHelp')}
          </Text>
          <Accordion variant="separated" multiple>
            {portals.map(renderItem)}
          </Accordion>
        </div>
      ) : null}
      {agents.length > 0 ? (
        <div data-testid="managed-agent-group">
          <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb={4}>
            {t('managed.agentBased')}
          </Text>
          <Text size="xs" c="dimmed" mb={6}>
            {t('managed.agentHelp')}
          </Text>
          <Accordion variant="separated" multiple>
            {agents.map(renderItem)}
          </Accordion>
        </div>
      ) : null}
    </Stack>
  );
}
