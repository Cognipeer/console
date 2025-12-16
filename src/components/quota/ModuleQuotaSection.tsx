'use client';

import { useEffect, useState } from 'react';
import { Paper, Title, Text, Stack, Group, ThemeIcon, Collapse, ActionIcon, Badge, Modal, Button } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconChevronDown, IconChevronUp, IconShield } from '@tabler/icons-react';
import type { IQuotaPolicy } from '@/lib/database/provider.interface';
import type { QuotaDomain, QuotaScope } from '@/lib/quota/types';
import { QuotaPolicyList, QuotaPolicyModal, type QuotaPolicyFormData } from '@/components/quota';
import { useQuotaPolicies } from '@/hooks/useQuotaPolicies';
import { useTranslations } from '@/lib/i18n';

interface ModuleQuotaSectionProps {
  domain: QuotaDomain;
  title?: string;
  description?: string;
  allowedScopes?: QuotaScope[];
  icon?: React.ReactNode;
  defaultCollapsed?: boolean;
  compact?: boolean;
  resourceOptions?: { value: string; label: string }[];
}

export function ModuleQuotaSection({
  domain,
  title,
  description,
  allowedScopes = ['tenant', 'user', 'token'],
  icon,
  defaultCollapsed = true,
  compact = false,
  resourceOptions = [],
}: ModuleQuotaSectionProps) {
  const t = useTranslations('settings.quotaSection');
  const tDomains = useTranslations('settings.quotaSection.domains');
  const tDescriptions = useTranslations('settings.quotaSection.descriptions');
  
  const [opened, { toggle }] = useDisclosure(!defaultCollapsed);
  const [modalOpened, setModalOpened] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<IQuotaPolicy | null>(null);
  const [confirmDeletePolicy, setConfirmDeletePolicy] = useState<IQuotaPolicy | null>(null);
  
  const {
    policies,
    loading,
    error,
    saving,
    fetchPolicies,
    createPolicy,
    updatePolicy,
    deletePolicy,
  } = useQuotaPolicies({ domain });

  useEffect(() => {
    if (opened) {
      fetchPolicies();
    }
  }, [opened, fetchPolicies]);

  const handleAdd = () => {
    setEditingPolicy(null);
    setModalOpened(true);
  };

  const handleEdit = (policy: IQuotaPolicy) => {
    setEditingPolicy(policy);
    setModalOpened(true);
  };

  const handleDelete = (policy: IQuotaPolicy) => {
    setConfirmDeletePolicy(policy);
  };

  const confirmDelete = async () => {
    if (confirmDeletePolicy) {
      await deletePolicy(confirmDeletePolicy);
      setConfirmDeletePolicy(null);
    }
  };

  const handleSubmit = async (data: QuotaPolicyFormData) => {
    let success: boolean;
    if (editingPolicy?._id) {
      success = await updatePolicy(editingPolicy._id.toString(), data);
    } else {
      success = await createPolicy(data);
    }
    if (success) {
      setModalOpened(false);
      setEditingPolicy(null);
    }
  };

  const displayTitle = title || tDomains(domain);
  const displayDescription = description || (domain !== 'global' ? tDescriptions(domain) : undefined);
  const policyCount = policies.length;

  return (
    <>
      <Paper withBorder p="md" radius="md">
        <Group 
          justify="space-between" 
          style={{ cursor: 'pointer' }} 
          onClick={toggle}
        >
          <Group gap="sm">
            <ThemeIcon variant="light" size="lg" color="grape">
              {icon || <IconShield size={20} />}
            </ThemeIcon>
            <Stack gap={0}>
              <Group gap="xs">
                <Title order={5}>{t('title', { domain: displayTitle })}</Title>
                {policyCount > 0 && (
                  <Badge size="sm" variant="light" color="grape">
                    {policyCount}
                  </Badge>
                )}
              </Group>
              {displayDescription && (
                <Text size="xs" c="dimmed">
                  {displayDescription}
                </Text>
              )}
            </Stack>
          </Group>
          <ActionIcon variant="subtle" size="lg">
            {opened ? <IconChevronUp size={18} /> : <IconChevronDown size={18} />}
          </ActionIcon>
        </Group>

        <Collapse in={opened}>
          <Stack gap="md" mt="md">
            <QuotaPolicyList
              policies={policies as unknown as IQuotaPolicy[]}
              loading={loading}
              error={error}
              onAdd={handleAdd}
              onEdit={handleEdit}
              onDelete={handleDelete}
              showDomain={false}
              compact={compact}
              emptyMessage={t('emptyMessage', { domain: displayTitle })}
              addButtonLabel={t('addPolicy')}
              columns={compact ? 1 : 2}
            />
          </Stack>
        </Collapse>
      </Paper>

      <QuotaPolicyModal
        opened={modalOpened}
        onClose={() => {
          setModalOpened(false);
          setEditingPolicy(null);
        }}
        onSubmit={handleSubmit}
        policy={editingPolicy}
        loading={saving}
        defaultDomain={domain}
        allowedDomains={[domain]}
        allowedScopes={allowedScopes}
        resourceOptions={resourceOptions}
      />

      {/* Delete Confirmation Modal */}
      <Modal
        opened={!!confirmDeletePolicy}
        onClose={() => setConfirmDeletePolicy(null)}
        title={t('deleteConfirm.title')}
        size="sm"
      >
        <Stack gap="md">
          <Text size="sm">
            {t('deleteConfirm.message')}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirmDeletePolicy(null)}>
              {t('deleteConfirm.cancel')}
            </Button>
            <Button color="red" onClick={confirmDelete} loading={saving}>
              {t('deleteConfirm.confirm')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
