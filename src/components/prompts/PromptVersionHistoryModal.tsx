'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconRestore } from '@tabler/icons-react';
import type { PromptView, PromptVersionView } from '@/lib/services/prompts';

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
  const [versions, setVersions] = useState<PromptVersionView[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<PromptVersionView | null>(null);

  const loadVersions = useCallback(async () => {
    if (!prompt) return;
    
    setLoading(true);
    try {
      const response = await fetch(`/api/prompts/${prompt.id}/versions`, { cache: 'no-store' });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Failed to load versions' }));
        throw new Error(error.error ?? 'Failed to load versions');
      }
      const data = await response.json();
      setVersions((data.versions ?? []) as PromptVersionView[]);
      
      // Select the latest version by default
      const latestVersion = (data.versions ?? []).find((v: PromptVersionView) => v.isLatest);
      if (latestVersion) {
        setSelectedVersion(latestVersion);
      } else if ((data.versions ?? []).length > 0) {
        setSelectedVersion(data.versions[0]);
      }
    } catch (error) {
      console.error(error);
      notifications.show({
        title: 'Unable to load versions',
        message: error instanceof Error ? error.message : 'Unexpected error',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  }, [prompt]);

  useEffect(() => {
    if (opened && prompt) {
      void loadVersions();
    } else {
      setVersions([]);
      setSelectedVersion(null);
    }
  }, [opened, prompt, loadVersions]);

  const handleRestoreVersion = async (version: PromptVersionView) => {
    if (!prompt || version.isLatest) return;
    
    setRestoring(version.id);
    try {
      const response = await fetch(`/api/prompts/${prompt.id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId: version.id }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Failed to restore version' }));
        throw new Error(error.error ?? 'Failed to restore version');
      }

      notifications.show({
        title: 'Version restored',
        message: `Restored to version ${version.version}`,
        color: 'teal',
      });

      // Reload versions to update isLatest flags
      await loadVersions();
      onVersionRestored?.();
    } catch (error) {
      notifications.show({
        title: 'Unable to restore version',
        message: error instanceof Error ? error.message : 'Unexpected error',
        color: 'red',
      });
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`Version History - ${prompt?.name ?? 'Prompt'}`}
      size="xl"
      centered
    >
      {loading ? (
        <Center py="xl">
          <Loader size="md" />
        </Center>
      ) : versions.length === 0 ? (
        <Center py="xl" c="dimmed">
          No version history available.
        </Center>
      ) : (
        <Group align="flex-start" gap="md" style={{ minHeight: 400 }}>
          {/* Version list */}
          <Paper withBorder p="xs" style={{ width: 200, flexShrink: 0 }}>
            <Text size="sm" fw={600} mb="xs">Versions</Text>
            <ScrollArea h={350}>
              <Stack gap="xs">
                {versions.map((version) => (
                  <Paper
                    key={version.id}
                    withBorder
                    p="xs"
                    style={{ 
                      cursor: 'pointer',
                      backgroundColor: selectedVersion?.id === version.id 
                        ? 'var(--mantine-color-blue-light)' 
                        : undefined,
                    }}
                    onClick={() => setSelectedVersion(version)}
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
                  </Paper>
                ))}
              </Stack>
            </ScrollArea>
          </Paper>

          {/* Version details */}
          <Stack style={{ flex: 1 }} gap="md">
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

                <div>
                  <Text size="sm" fw={500} mb={4}>Template</Text>
                  <Textarea
                    value={selectedVersion.template}
                    readOnly
                    autosize
                    minRows={6}
                    maxRows={12}
                    styles={{
                      input: {
                        fontFamily: 'monospace',
                        fontSize: '0.85rem',
                      },
                    }}
                  />
                </div>
              </>
            ) : (
              <Center py="xl" c="dimmed">
                Select a version to view details
              </Center>
            )}
          </Stack>
        </Group>
      )}

      <Group justify="flex-end" mt="md">
        <Button variant="subtle" onClick={onClose}>
          Close
        </Button>
      </Group>
    </Modal>
  );
}
