'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Group,
  Modal,
  ScrollArea,
  Select,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconRestore } from '@tabler/icons-react';
import { errorMessage } from '@/lib/api/client';
import {
  useComparePromptVersions,
  usePromptDeploymentAction,
  usePromptDeployments,
  usePromptVersionHistory,
  useRestorePromptVersion,
} from '@/lib/api/queries/promptVersions';
import EmptyState from '@/components/common/EmptyState';
import LoadingState from '@/components/common/LoadingState';
import SectionCard from '@/components/common/SectionCard';
import classes from './PromptVersionHistoryModal.module.css';
import type {
  PromptCompareView,
  PromptEnvironment,
  PromptView,
  PromptVersionView,
} from '@/lib/services/prompts';

type PromptVersionHistoryModalProps = {
  opened: boolean;
  onClose: () => void;
  prompt: PromptView | null;
  onVersionRestored?: () => void;
};

function formatDate(value?: string | Date) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export default function PromptVersionHistoryModal({
  opened,
  onClose,
  prompt,
  onVersionRestored,
}: PromptVersionHistoryModalProps) {
  const [selectedVersion, setSelectedVersion] = useState<PromptVersionView | null>(null);
  const [selectedEnvironment, setSelectedEnvironment] = useState<PromptEnvironment>('dev');
  const [deployNote, setDeployNote] = useState('');
  const [compareWithVersionId, setCompareWithVersionId] = useState<string | null>(null);
  const [comparison, setComparison] = useState<PromptCompareView | null>(null);

  const active = opened && Boolean(prompt);
  const versionsQuery = usePromptVersionHistory(prompt?.id, active);
  const deploymentsQuery = usePromptDeployments(prompt?.id, active);
  const restoreVersion = useRestorePromptVersion(prompt?.id);
  const deploymentAction = usePromptDeploymentAction(prompt?.id);
  const compareVersions = useComparePromptVersions(prompt?.id);

  // Closed, the modal shows nothing of the prompt it last held.
  const versions = useMemo(() => (active ? versionsQuery.data ?? [] : []), [active, versionsQuery.data]);
  const deployments = active ? deploymentsQuery.data?.deployments ?? {} : {};
  const deploymentHistory = active ? deploymentsQuery.data?.history ?? [] : [];
  const loading = active && versionsQuery.isFetching;
  const restoring = restoreVersion.isPending ? restoreVersion.variables ?? null : null;
  const deployingAction = deploymentAction.isPending
    ? `${deploymentAction.variables?.action}-${deploymentAction.variables?.environment}`
    : null;
  const comparing = compareVersions.isPending;

  // Every time the versions land (opening, after a restore or a deployment): the latest one is selected, a comparison is dropped.
  const versionsUpdatedAt = versionsQuery.dataUpdatedAt;
  useEffect(() => {
    if (!active || !versionsUpdatedAt) return;
    const list = versionsQuery.data ?? [];
    setCompareWithVersionId(null);
    setComparison(null);
    const latestVersion = list.find((version) => version.isLatest);
    if (latestVersion) setSelectedVersion(latestVersion);
    else if (list.length > 0) setSelectedVersion(list[0]!);
    // `versionsUpdatedAt` is the signal: an answer equal to the last one still resets the selection
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, versionsUpdatedAt]);

  useEffect(() => {
    if (active) return;
    setSelectedVersion(null);
    setDeployNote('');
    setCompareWithVersionId(null);
    setComparison(null);
  }, [active]);

  const handleRestoreVersion = async (version: PromptVersionView) => {
    if (!prompt || version.isLatest) return;

    try {
      await restoreVersion.mutateAsync(version.id);

      notifications.show({
        title: 'Version restored',
        message: `Restored to version ${version.version}`,
        color: 'teal',
      });

      onVersionRestored?.();
    } catch (error) {
      notifications.show({
        title: 'Unable to restore version',
        message: errorMessage(error, 'Unexpected error'),
        color: 'red',
      });
    }
  };

  const handleDeploymentAction = async (
    action: 'promote' | 'plan' | 'activate' | 'rollback',
  ) => {
    if (!prompt) return;
    if (!selectedEnvironment) return;

    if (action === 'promote' && !selectedVersion) {
      notifications.show({
        title: 'Select a version',
        message: 'Choose a version before promoting.',
        color: 'yellow',
      });
      return;
    }

    try {
      await deploymentAction.mutateAsync({
        action,
        environment: selectedEnvironment,
        versionId: action === 'promote' ? selectedVersion?.id : undefined,
        note: deployNote.trim() || undefined,
      });

      notifications.show({
        title: 'Deployment updated',
        message: `${action} completed for ${selectedEnvironment}.`,
        color: 'teal',
      });
    } catch (error) {
      notifications.show({
        title: 'Deployment action failed',
        message: errorMessage(error, 'Unexpected error'),
        color: 'red',
      });
    }
  };

  const handleCompareVersions = async () => {
    if (!prompt || !selectedVersion || !compareWithVersionId) return;

    try {
      setComparison(await compareVersions.mutateAsync({ fromVersionId: selectedVersion.id, toVersionId: compareWithVersionId }));
    } catch (error) {
      notifications.show({
        title: 'Compare failed',
        message: errorMessage(error, 'Unexpected error'),
        color: 'red',
      });
    }
  };

  const selectedEnvironmentState = deployments[selectedEnvironment];

  const templateDiffPreview = (comparison?.templateDiff ?? [])
    .map((line) => {
      if (line.type === 'added') return `+ ${line.line}`;
      if (line.type === 'removed') return `- ${line.line}`;
      return `  ${line.line}`;
    })
    .join('\n');

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`Version History - ${prompt?.name ?? 'Prompt'}`}
      size="xl"
      centered
    >
      {loading ? (
        <LoadingState label="Loading version history..." minHeight={240} size="md" />
      ) : versions.length === 0 ? (
        <EmptyState title="No version history available" description="Save and publish prompt changes to create the first version record." minHeight={240} />
      ) : (
        <div className={classes.shell}>
          {/* Version list */}
          <SectionCard p="xs" className={classes.sidebar}>
            <Text size="sm" fw={600} mb="xs">Versions</Text>
            <ScrollArea className={classes.versionList}>
              <Stack gap="xs">
                {versions.map((version) => (
                  <SectionCard
                    key={version.id}
                    p="xs"
                    className={`${classes.versionCard} ${selectedVersion?.id === version.id ? classes.versionCardSelected : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Select version ${version.version}`}
                    onClick={() => setSelectedVersion(version)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedVersion(version);
                      }
                    }}
                  >
                    <Group justify="space-between" gap="xs">
                      <Text size="sm" fw={500}>v{version.version}</Text>
                      {version.isLatest && (
                        <Badge size="xs" color="green" variant="light">
                          Latest
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed">
                      {formatDate(version.createdAt)}
                    </Text>
                    {version.comment && (
                      <Text size="xs" c="dimmed" lineClamp={1} mt={2}>
                        {version.comment}
                      </Text>
                    )}
                  </SectionCard>
                ))}
              </Stack>
            </ScrollArea>
          </SectionCard>

          {/* Version details */}
          <Stack className={classes.detailColumn} gap="md">
            {selectedVersion ? (
              <>
                <Group justify="space-between">
                  <div>
                    <Text fw={600}>Version {selectedVersion.version}</Text>
                    <Text size="sm" c="dimmed">
                      Created: {formatDate(selectedVersion.createdAt)}
                    </Text>
                  </div>
                  {selectedVersion.isLatest ? (
                    <Badge color="green" leftSection={<IconCheck size={12} />}>
                      Current Version
                    </Badge>
                  ) : (
                    <Button
                      size="xs"
                      variant="light"
                      leftSection={<IconRestore size={14} />}
                      loading={restoring === selectedVersion.id}
                      onClick={() => handleRestoreVersion(selectedVersion)}
                    >
                      Set as Latest
                    </Button>
                  )}
                </Group>

                <div>
                  <Text size="sm" fw={500} mb={4}>Name</Text>
                  <Text size="sm">{selectedVersion.name}</Text>
                </div>

                {selectedVersion.description && (
                  <div>
                    <Text size="sm" fw={500} mb={4}>Description</Text>
                    <Text size="sm" c="dimmed">{selectedVersion.description}</Text>
                  </div>
                )}

                {selectedVersion.comment && (
                  <div>
                    <Text size="sm" fw={500} mb={4}>Comment</Text>
                    <Text size="sm" c="dimmed">{selectedVersion.comment}</Text>
                  </div>
                )}

                <div>
                  <Text size="sm" fw={500} mb={4}>Template</Text>
                  <Textarea
                    value={selectedVersion.template}
                    readOnly
                    autosize
                    minRows={6}
                    maxRows={12}
                    classNames={{ input: classes.templateInput }}
                  />
                </div>

                <SectionCard p="sm">
                  <Stack gap="sm">
                    <Text size="sm" fw={600}>Deployment Flow</Text>
                    <Group grow>
                      <Select
                        label="Environment"
                        value={selectedEnvironment}
                        onChange={(value) => setSelectedEnvironment((value as PromptEnvironment) ?? 'dev')}
                        data={[
                          { value: 'dev', label: 'dev' },
                          { value: 'staging', label: 'staging' },
                          { value: 'prod', label: 'prod' },
                        ]}
                      />
                    </Group>

                    {selectedEnvironmentState ? (
                      <Group gap="xs">
                        <Badge variant="light" color={selectedEnvironmentState.rolloutStatus === 'active' ? 'green' : 'yellow'}>
                          {selectedEnvironmentState.rolloutStatus}
                        </Badge>
                        <Badge variant="light" color="blue">
                          v{selectedEnvironmentState.version}
                        </Badge>
                        {selectedEnvironmentState.rollbackVersion ? (
                          <Badge variant="light" color="orange">
                            rollback → v{selectedEnvironmentState.rollbackVersion}
                          </Badge>
                        ) : null}
                      </Group>
                    ) : (
                      <Text size="xs" c="dimmed">No deployment yet for this environment.</Text>
                    )}

                    <Textarea
                      label="Deployment note"
                      placeholder="Optional note"
                      value={deployNote}
                      onChange={(event) => setDeployNote(event.currentTarget.value)}
                      minRows={2}
                      maxRows={3}
                      autosize
                    />

                    <Group wrap="wrap" gap="xs">
                      <Button
                        size="xs"
                        variant="light"
                        loading={deployingAction === `promote-${selectedEnvironment}`}
                        onClick={() => handleDeploymentAction('promote')}
                      >
                        Promote
                      </Button>
                      <Button
                        size="xs"
                        variant="light"
                        loading={deployingAction === `plan-${selectedEnvironment}`}
                        onClick={() => handleDeploymentAction('plan')}
                      >
                        Plan
                      </Button>
                      <Button
                        size="xs"
                        color="green"
                        variant="light"
                        loading={deployingAction === `activate-${selectedEnvironment}`}
                        onClick={() => handleDeploymentAction('activate')}
                      >
                        Activate
                      </Button>
                      <Button
                        size="xs"
                        color="orange"
                        variant="light"
                        loading={deployingAction === `rollback-${selectedEnvironment}`}
                        onClick={() => handleDeploymentAction('rollback')}
                      >
                        Rollback
                      </Button>
                    </Group>
                  </Stack>
                </SectionCard>

                <SectionCard p="sm">
                  <Stack gap="sm">
                    <Text size="sm" fw={600}>Version Compare</Text>
                    <Group align="flex-end">
                      <Select
                        className={classes.compareSelect}
                        label="Compare with"
                        value={compareWithVersionId}
                        onChange={setCompareWithVersionId}
                        data={versions
                          .filter((version) => version.id !== selectedVersion.id)
                          .map((version) => ({
                            value: version.id,
                            label: `v${version.version} · ${formatDate(version.createdAt)}`,
                          }))}
                        placeholder="Select another version"
                      />
                      <Button
                        size="xs"
                        variant="light"
                        loading={comparing}
                        disabled={!compareWithVersionId}
                        onClick={handleCompareVersions}
                      >
                        Compare
                      </Button>
                    </Group>

                    {comparison ? (
                      <Stack gap="xs">
                        <Group gap="xs">
                          <Badge variant="light" color="indigo">
                            v{comparison.fromVersion.version} ↔ v{comparison.toVersion.version}
                          </Badge>
                          <Badge variant="light" color="teal">
                            Deploy events: {comparison.deploymentHistory.length}
                          </Badge>
                          <Badge variant="light" color="blue">
                            Comments: {comparison.comments.length}
                          </Badge>
                        </Group>

                        <Textarea
                          label="Template diff"
                          value={templateDiffPreview}
                          readOnly
                          minRows={6}
                          maxRows={10}
                          autosize
                          classNames={{ input: classes.diffInput }}
                        />

                        <Text size="xs" fw={600}>Deploy history</Text>
                        {comparison.deploymentHistory.length > 0 ? (
                          <Stack gap={4}>
                            {comparison.deploymentHistory.slice(0, 5).map((event) => (
                              <Text key={event.id} size="xs" c="dimmed">
                                {event.environment} · {event.action} · v{event.version} · {formatDate(event.createdAt)}
                              </Text>
                            ))}
                          </Stack>
                        ) : (
                          <Text size="xs" c="dimmed">No deployment history for selected versions.</Text>
                        )}

                        <Text size="xs" fw={600}>Comments</Text>
                        {comparison.comments.length > 0 ? (
                          <Stack gap={4}>
                            {comparison.comments.slice(0, 5).map((comment) => (
                              <Text key={comment.id} size="xs" c="dimmed" lineClamp={1}>
                                {comment.createdByName || 'User'}: {comment.content}
                              </Text>
                            ))}
                          </Stack>
                        ) : (
                          <Text size="xs" c="dimmed">No comments for selected versions.</Text>
                        )}
                      </Stack>
                    ) : null}
                  </Stack>
                </SectionCard>
              </>
            ) : (
              <EmptyState title="Select a version" description="Choose a version from the left to review template content, deployment state, and version diffs." minHeight={240} />
            )}

            {deploymentHistory.length > 0 ? (
              <SectionCard p="sm">
                <Stack gap={6}>
                  <Text size="sm" fw={600}>Recent Deployment History</Text>
                  {deploymentHistory.slice(0, 8).map((event) => (
                    <Text key={event.id} size="xs" c="dimmed">
                      {event.environment} · {event.action} · v{event.version} · {formatDate(event.createdAt)}
                    </Text>
                  ))}
                </Stack>
              </SectionCard>
            ) : null}
          </Stack>
        </div>
      )}

      <Group justify="flex-end" mt="md">
        <Button variant="subtle" onClick={onClose}>
          Close
        </Button>
      </Group>
    </Modal>
  );
}
