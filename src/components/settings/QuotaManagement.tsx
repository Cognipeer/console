'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Group,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useTranslations } from '@/lib/i18n';
import type { QuotaPolicy, QuotaPolicyInput } from '@/lib/quota/types';

type Project = {
  _id: string;
  name: string;
  key: string;
};

interface QuotaManagementProps {
  projectId?: string;
}

interface FormState {
  label: string;
  description?: string;
  enabled: boolean;
  requestsPerMinute?: number;
  requestsPerHour?: number;
  requestsPerDay?: number;
  requestsPerMonth?: number;
  tokensPerMinute?: number;
  tokensPerHour?: number;
  tokensPerDay?: number;
  tokensPerMonth?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  maxFileSize?: number;
  maxVectorsPerUpsert?: number;
  maxQueryResults?: number;
  maxModels?: number;
  maxVectorIndexes?: number;
  maxApiTokens?: number;
  maxUsers?: number;
  maxAgents?: number;
  maxStorageBytes?: number;
  monthlySpendLimit?: number;
}

const emptyForm: FormState = {
  label: 'Project quota',
  description: '',
  enabled: true,
};

function toNumber(value?: number | string | null): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toFormValue(value?: number): number | '' {
  return value ?? '';
}

function hasValues(obj: Record<string, unknown>): boolean {
  return Object.values(obj).some((value) => value !== undefined && value !== null);
}

function policyToForm(policy: QuotaPolicy): FormState {
  return {
    label: policy.label ?? '',
    description: policy.description,
    enabled: policy.enabled,
    requestsPerMinute: policy.limits?.rateLimit?.requests?.perMinute,
    requestsPerHour: policy.limits?.rateLimit?.requests?.perHour,
    requestsPerDay: policy.limits?.rateLimit?.requests?.perDay,
    requestsPerMonth: policy.limits?.rateLimit?.requests?.perMonth,
    tokensPerMinute: policy.limits?.rateLimit?.tokens?.perMinute,
    tokensPerHour: policy.limits?.rateLimit?.tokens?.perHour,
    tokensPerDay: policy.limits?.rateLimit?.tokens?.perDay,
    tokensPerMonth: policy.limits?.rateLimit?.tokens?.perMonth,
    maxInputTokens: policy.limits?.perRequest?.maxInputTokens,
    maxOutputTokens: policy.limits?.perRequest?.maxOutputTokens,
    maxTotalTokens: policy.limits?.perRequest?.maxTotalTokens,
    maxFileSize: policy.limits?.perRequest?.maxFileSize,
    maxVectorsPerUpsert: policy.limits?.perRequest?.maxVectorsPerUpsert,
    maxQueryResults: policy.limits?.perRequest?.maxQueryResults,
    maxModels: policy.limits?.quotas?.maxModels,
    maxVectorIndexes: policy.limits?.quotas?.maxVectorIndexes,
    maxApiTokens: policy.limits?.quotas?.maxApiTokens,
    maxUsers: policy.limits?.quotas?.maxUsers,
    maxAgents: policy.limits?.quotas?.maxAgents,
    maxStorageBytes: policy.limits?.quotas?.maxStorageBytes,
    monthlySpendLimit: policy.limits?.budget?.monthlySpendLimit,
  };
}

function buildLimits(form: FormState): QuotaPolicyInput['limits'] {
  const requestWindows = {
    perMinute: toNumber(form.requestsPerMinute),
    perHour: toNumber(form.requestsPerHour),
    perDay: toNumber(form.requestsPerDay),
    perMonth: toNumber(form.requestsPerMonth),
  };

  const tokenWindows = {
    perMinute: toNumber(form.tokensPerMinute),
    perHour: toNumber(form.tokensPerHour),
    perDay: toNumber(form.tokensPerDay),
    perMonth: toNumber(form.tokensPerMonth),
  };

  const perRequest = {
    maxInputTokens: toNumber(form.maxInputTokens),
    maxOutputTokens: toNumber(form.maxOutputTokens),
    maxTotalTokens: toNumber(form.maxTotalTokens),
    maxFileSize: toNumber(form.maxFileSize),
    maxVectorsPerUpsert: toNumber(form.maxVectorsPerUpsert),
    maxQueryResults: toNumber(form.maxQueryResults),
  };

  const quotas = {
    maxModels: toNumber(form.maxModels),
    maxVectorIndexes: toNumber(form.maxVectorIndexes),
    maxApiTokens: toNumber(form.maxApiTokens),
    maxUsers: toNumber(form.maxUsers),
    maxAgents: toNumber(form.maxAgents),
    maxStorageBytes: toNumber(form.maxStorageBytes),
  };

  const limits: QuotaPolicyInput['limits'] = {};

  if (hasValues(requestWindows) || hasValues(tokenWindows)) {
    limits.rateLimit = {};
    if (hasValues(requestWindows)) {
      limits.rateLimit.requests = requestWindows;
    }
    if (hasValues(tokenWindows)) {
      limits.rateLimit.tokens = tokenWindows;
    }
  }

  if (hasValues(perRequest)) {
    limits.perRequest = perRequest;
  }

  if (hasValues(quotas)) {
    limits.quotas = quotas;
  }

  const budget = { monthlySpendLimit: toNumber(form.monthlySpendLimit) };
  if (hasValues(budget)) {
    limits.budget = budget;
  }

  return limits;
}

export default function QuotaManagement({ projectId }: QuotaManagementProps) {
  const tNotifications = useTranslations('notifications');
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [policy, setPolicy] = useState<QuotaPolicy | null>(null);
  const [loadingPolicy, setLoadingPolicy] = useState(false);
  const [formState, setFormState] = useState<FormState>(emptyForm);

  const fixedProjectId = projectId ? String(projectId) : null;

  const fetchProjects = async () => {
    setLoadingProjects(true);
    try {
      const res = await fetch('/api/projects', { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Failed to load projects');
      }
      const data = (await res.json()) as { projects?: Project[] };
      const list = data.projects ?? [];
      setProjects(list);
      if (!selectedProjectId && list.length > 0) {
        setSelectedProjectId(list[0]._id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load projects';
      notifications.show({
        title: tNotifications('errorTitle'),
        message,
        color: 'red',
      });
    } finally {
      setLoadingProjects(false);
    }
  };

  const fetchProjectQuota = async (projectId: string) => {
    setLoadingPolicy(true);
    try {
      const res = await fetch(`/api/quota/policies?projectId=${encodeURIComponent(projectId)}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Failed to load quota');
      }
      const data = (await res.json()) as { policies?: QuotaPolicy[] };
      const policies = data.policies ?? [];
      const selected =
        policies.find((p) => (p.label ?? '').toLowerCase() === 'project quota') ??
        policies[0] ??
        null;
      setPolicy(selected);
      setFormState(selected ? policyToForm(selected) : emptyForm);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load quota';
      notifications.show({
        title: tNotifications('errorTitle'),
        message,
        color: 'red',
      });
      setPolicy(null);
      setFormState(emptyForm);
    } finally {
      setLoadingPolicy(false);
    }
  };

  useEffect(() => {
    if (fixedProjectId) {
      setProjects([]);
      setSelectedProjectId(fixedProjectId);
      setLoadingProjects(false);
      return;
    }

    fetchProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setPolicy(null);
      setFormState(emptyForm);
      return;
    }
    fetchProjectQuota(selectedProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId]);

  const projectOptions = useMemo(
    () =>
      projects.map((p) => ({
        value: p._id,
        label: `${p.name} (${p.key})`,
      })),
    [projects],
  );

  const handleSave = async () => {
    if (!selectedProjectId) {
      return;
    }

    const payload: QuotaPolicyInput = {
      projectId: selectedProjectId,
      scope: 'tenant',
      domain: 'global',
      priority: 100,
      enabled: formState.enabled,
      label: formState.label?.trim() || 'Project quota',
      description: formState.description?.trim() || undefined,
      limits: buildLimits(formState),
    };

    try {
      if (policy?._id) {
        const res = await fetch(
          `/api/quota/policies/${encodeURIComponent(policy._id)}?projectId=${encodeURIComponent(selectedProjectId)}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          },
        );
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(body?.error || 'Failed to save quota');
        }
        setPolicy(body.policy ?? null);
      } else {
        const res = await fetch(
          `/api/quota/policies?projectId=${encodeURIComponent(selectedProjectId)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          },
        );
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(body?.error || 'Failed to create quota');
        }
        setPolicy(body.policy ?? null);
      }

      notifications.show({
        title: tNotifications('successTitle'),
        message: 'Quota saved',
        color: 'green',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save quota';
      notifications.show({
        title: tNotifications('errorTitle'),
        message,
        color: 'red',
      });
    }
  };

  const savingDisabled = loadingProjects || loadingPolicy || !selectedProjectId;

  return (
    <Box p="md">
      <Stack gap="md">
        <Paper withBorder radius="md" p="md">
          <Group justify="space-between" align="flex-end">
            {fixedProjectId ? (
              <div>
                <Text fw={600}>Project quota</Text>
                <Text size="sm" c="dimmed">
                  These limits apply to all usage within this project.
                </Text>
              </div>
            ) : (
              <Select
                label="Project"
                placeholder={loadingProjects ? 'Loading projects…' : 'Select a project'}
                data={projectOptions}
                value={selectedProjectId}
                onChange={setSelectedProjectId}
                disabled={loadingProjects}
                searchable
                w={420}
              />
            )}

            <Button onClick={handleSave} disabled={savingDisabled}>
              Save quota
            </Button>
          </Group>
          {!fixedProjectId ? (
            <Text size="sm" c="dimmed" mt="sm">
              One quota per project. These limits apply to all usage within the selected project.
            </Text>
          ) : null}
        </Paper>

        <Paper withBorder radius="md" p="md">
          <Group justify="space-between" align="flex-end" mb="md">
            <TextInput
              label="Label"
              value={formState.label}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setFormState((s) => ({ ...s, label: value }));
              }}
              w={420}
            />
            <Switch
              label="Enabled"
              checked={formState.enabled}
              onChange={(e) => {
                const checked = e.currentTarget.checked;
                setFormState((s) => ({ ...s, enabled: checked }));
              }}
            />
          </Group>

          <TextInput
            label="Description"
            value={formState.description || ''}
            onChange={(e) => {
              const value = e.currentTarget.value;
              setFormState((s) => ({ ...s, description: value }));
            }}
            mb="md"
          />

          <Stack gap="lg">
            <div>
              <Text fw={600} size="sm" mb="xs">Rate limits</Text>
              <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="md">
                <NumberInput label="Requests / minute" value={toFormValue(formState.requestsPerMinute)} onChange={(v) => setFormState((s) => ({ ...s, requestsPerMinute: toNumber(v) }))} />
                <NumberInput label="Requests / hour" value={toFormValue(formState.requestsPerHour)} onChange={(v) => setFormState((s) => ({ ...s, requestsPerHour: toNumber(v) }))} />
                <NumberInput label="Requests / day" value={toFormValue(formState.requestsPerDay)} onChange={(v) => setFormState((s) => ({ ...s, requestsPerDay: toNumber(v) }))} />
                <NumberInput label="Requests / month" value={toFormValue(formState.requestsPerMonth)} onChange={(v) => setFormState((s) => ({ ...s, requestsPerMonth: toNumber(v) }))} />
                <NumberInput label="Tokens / minute" value={toFormValue(formState.tokensPerMinute)} onChange={(v) => setFormState((s) => ({ ...s, tokensPerMinute: toNumber(v) }))} />
                <NumberInput label="Tokens / hour" value={toFormValue(formState.tokensPerHour)} onChange={(v) => setFormState((s) => ({ ...s, tokensPerHour: toNumber(v) }))} />
                <NumberInput label="Tokens / day" value={toFormValue(formState.tokensPerDay)} onChange={(v) => setFormState((s) => ({ ...s, tokensPerDay: toNumber(v) }))} />
                <NumberInput label="Tokens / month" value={toFormValue(formState.tokensPerMonth)} onChange={(v) => setFormState((s) => ({ ...s, tokensPerMonth: toNumber(v) }))} />
              </SimpleGrid>
            </div>

            <div>
              <Text fw={600} size="sm" mb="xs">Per-request limits</Text>
              <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
                <NumberInput label="Max input tokens" value={toFormValue(formState.maxInputTokens)} onChange={(v) => setFormState((s) => ({ ...s, maxInputTokens: toNumber(v) }))} />
                <NumberInput label="Max output tokens" value={toFormValue(formState.maxOutputTokens)} onChange={(v) => setFormState((s) => ({ ...s, maxOutputTokens: toNumber(v) }))} />
                <NumberInput label="Max total tokens" value={toFormValue(formState.maxTotalTokens)} onChange={(v) => setFormState((s) => ({ ...s, maxTotalTokens: toNumber(v) }))} />
                <NumberInput label="Max file size (bytes)" value={toFormValue(formState.maxFileSize)} onChange={(v) => setFormState((s) => ({ ...s, maxFileSize: toNumber(v) }))} />
                <NumberInput label="Max vectors per upsert" value={toFormValue(formState.maxVectorsPerUpsert)} onChange={(v) => setFormState((s) => ({ ...s, maxVectorsPerUpsert: toNumber(v) }))} />
                <NumberInput label="Max query results" value={toFormValue(formState.maxQueryResults)} onChange={(v) => setFormState((s) => ({ ...s, maxQueryResults: toNumber(v) }))} />
              </SimpleGrid>
            </div>

            <div>
              <Text fw={600} size="sm" mb="xs">Project resource caps</Text>
              <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
                <NumberInput label="Max models" value={toFormValue(formState.maxModels)} onChange={(v) => setFormState((s) => ({ ...s, maxModels: toNumber(v) }))} />
                <NumberInput label="Max vector indexes" value={toFormValue(formState.maxVectorIndexes)} onChange={(v) => setFormState((s) => ({ ...s, maxVectorIndexes: toNumber(v) }))} />
                <NumberInput label="Max API tokens" value={toFormValue(formState.maxApiTokens)} onChange={(v) => setFormState((s) => ({ ...s, maxApiTokens: toNumber(v) }))} />
                <NumberInput label="Max users" value={toFormValue(formState.maxUsers)} onChange={(v) => setFormState((s) => ({ ...s, maxUsers: toNumber(v) }))} />
                <NumberInput label="Max agents" value={toFormValue(formState.maxAgents)} onChange={(v) => setFormState((s) => ({ ...s, maxAgents: toNumber(v) }))} />
                <NumberInput label="Max storage bytes" value={toFormValue(formState.maxStorageBytes)} onChange={(v) => setFormState((s) => ({ ...s, maxStorageBytes: toNumber(v) }))} />
              </SimpleGrid>
            </div>

            <div>
              <Text fw={600} size="sm" mb="xs">Budget</Text>
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                <NumberInput label="Monthly spend limit" value={toFormValue(formState.monthlySpendLimit)} onChange={(v) => setFormState((s) => ({ ...s, monthlySpendLimit: toNumber(v) }))} />
              </SimpleGrid>
            </div>
          </Stack>
        </Paper>
      </Stack>
    </Box>
  );
}

/*
              onChange={(value) =>
                setFormState((prev) => ({ ...prev, requestsPerMinute: toNumber(value) }))
              }
            />
            <NumberInput
              label={t('form.requestsPerHour')}
              value={toFormValue(formState.requestsPerHour)}
              min={0}
              allowDecimal={false}
              onChange={(value) =>
                setFormState((prev) => ({ ...prev, requestsPerHour: toNumber(value) }))
              }
            />
            <NumberInput
              label={t('form.requestsPerDay')}
              value={toFormValue(formState.requestsPerDay)}
              min={0}
              allowDecimal={false}
              onChange={(value) =>
                setFormState((prev) => ({ ...prev, requestsPerDay: toNumber(value) }))
              }
            />
            <NumberInput
              label={t('form.requestsPerMonth')}
              value={toFormValue(formState.requestsPerMonth)}
              min={0}
              allowDecimal={false}
              onChange={(value) =>
                setFormState((prev) => ({ ...prev, requestsPerMonth: toNumber(value) }))
              }
            />
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }}>
            <NumberInput
              label={t('form.tokensPerMinute')}
              value={toFormValue(formState.tokensPerMinute)}
              min={0}
              allowDecimal={false}
              onChange={(value) =>
                setFormState((prev) => ({ ...prev, tokensPerMinute: toNumber(value) }))
              }
            />
            <NumberInput
              label={t('form.tokensPerHour')}
              value={toFormValue(formState.tokensPerHour)}
              min={0}
              allowDecimal={false}
              onChange={(value) =>
                setFormState((prev) => ({ ...prev, tokensPerHour: toNumber(value) }))
              }
            />
            <NumberInput
              label={t('form.tokensPerDay')}
              value={toFormValue(formState.tokensPerDay)}
              min={0}
              allowDecimal={false}
              onChange={(value) =>
                setFormState((prev) => ({ ...prev, tokensPerDay: toNumber(value) }))
              }
            />
            <NumberInput
              label={t('form.tokensPerMonth')}
              value={toFormValue(formState.tokensPerMonth)}
              min={0}
              allowDecimal={false}
              onChange={(value) =>
                setFormState((prev) => ({ ...prev, tokensPerMonth: toNumber(value) }))
              }
            />
          </SimpleGrid>

          <Divider label={t('sections.perRequest')} labelPosition="left" />
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
            <NumberInput
              label={t('form.maxInputTokens')}
              value={toFormValue(formState.maxInputTokens)}
              min={0}
              allowDecimal={false}
              onChange={(value) =>
                setFormState((prev) => ({ ...prev, maxInputTokens: toNumber(value) }))
              }
            />
            <NumberInput
              label={t('form.maxOutputTokens')}
              value={toFormValue(formState.maxOutputTokens)}
              min={0}
              allowDecimal={false}
              onChange={(value) =>
                setFormState((prev) => ({ ...prev, maxOutputTokens: toNumber(value) }))
              }
            />
            <NumberInput
              label={t('form.maxTotalTokens')}
              value={toFormValue(formState.maxTotalTokens)}
              min={0}
              allowDecimal={false}
              onChange={(value) =>
                setFormState((prev) => ({ ...prev, maxTotalTokens: toNumber(value) }))
              }
            />
            <NumberInput
              label={t('form.maxFileSize')}
              value={toFormValue(formState.maxFileSize)}
              min={0}
              allowDecimal={false}
              onChange={(value) =>
                setFormState((prev) => ({ ...prev, maxFileSize: toNumber(value) }))
              }
            />
            <NumberInput
              label={t('form.maxVectorsPerUpsert')}
              value={toFormValue(formState.maxVectorsPerUpsert)}
              min={0}
              allowDecimal={false}
              onChange={(value) =>
                setFormState((prev) => ({ ...prev, maxVectorsPerUpsert: toNumber(value) }))
              }
            />
            <NumberInput
              label={t('form.maxQueryResults')}
              value={toFormValue(formState.maxQueryResults)}
              min={0}
              allowDecimal={false}
              onChange={(value) =>
                setFormState((prev) => ({ ...prev, maxQueryResults: toNumber(value) }))
              }
            />
          </SimpleGrid>

          <Divider label={t('sections.resourceCaps')} labelPosition="left" />
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
            <NumberInput
              label={t('form.maxModels')}
              value={toFormValue(formState.maxModels)}
              min={-1}
              allowDecimal={false}
              onChange={(value) =>
                setFormState((prev) => ({ ...prev, maxModels: toNumber(value) }))
              }
            />
            <NumberInput
              label={t('form.maxVectorIndexes')}
              value={toFormValue(formState.maxVectorIndexes)}
              min={-1}
              allowDecimal={false}
              onChange={(value) =>
                setFormState((prev) => ({ ...prev, maxVectorIndexes: toNumber(value) }))
              }
            />
            <NumberInput
              label={t('form.maxApiTokens')}
              value={toFormValue(formState.maxApiTokens)}
              min={-1}
              allowDecimal={false}
              onChange={(value) =>
                setFormState((prev) => ({ ...prev, maxApiTokens: toNumber(value) }))
              }
            />
            <NumberInput
              label={t('form.maxUsers')}
              value={toFormValue(formState.maxUsers)}
              min={-1}
              allowDecimal={false}
              onChange={(value) =>
                setFormState((prev) => ({ ...prev, maxUsers: toNumber(value) }))
              }
            />
            <NumberInput
              label={t('form.maxAgents')}
              value={toFormValue(formState.maxAgents)}
              min={-1}
              allowDecimal={false}
              onChange={(value) =>
                setFormState((prev) => ({ ...prev, maxAgents: toNumber(value) }))
              }
            />
            <NumberInput
              label={t('form.maxStorageBytes')}
              value={toFormValue(formState.maxStorageBytes)}
              min={-1}
              allowDecimal={false}
              onChange={(value) =>
                setFormState((prev) => ({ ...prev, maxStorageBytes: toNumber(value) }))
              }
            />
          </SimpleGrid>

          <Divider label={t('sections.budget')} labelPosition="left" />
          <NumberInput
            label={t('form.monthlySpendLimit')}
            value={toFormValue(formState.monthlySpendLimit)}
            min={0}
            decimalScale={2}
            onChange={(value) =>
              setFormState((prev) => ({ ...prev, monthlySpendLimit: toNumber(value) }))
            }
          />

          <Group justify="flex-end" mt="sm">
            <Button leftSection={<IconAdjustments size={16} />} onClick={handleSave}>
              {selectedPolicy ? t('actions.saveChanges') : t('actions.create')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title={t('actions.delete')}
      >
        <Stack gap="md">
          <Text size="sm">
            {t('confirmDelete.description', { label: selectedPolicy?.label ?? t('table.untitled') })}
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setDeleteModalOpen(false)}>
              {t('confirmDelete.cancel')}
            </Button>
            <Button color="red" leftSection={<IconTrash size={16} />} onClick={confirmDelete}>
              {t('confirmDelete.confirm')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

*/
