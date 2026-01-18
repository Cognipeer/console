'use client';

import { Group, Stack, Text, Title, Paper, ThemeIcon, SimpleGrid, Badge, Box } from '@mantine/core';
import { IconFolder, IconCloud, IconFiles, IconUpload } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import FileBucketManager from '@/components/files/FileBucketManager';

export default function FilesDashboardPage() {
  const router = useRouter();

  return (
    <Stack gap="lg">
      {/* Header */}
      <Paper
        p="xl"
        radius="lg"
        withBorder
        style={{
          background: 'linear-gradient(135deg, var(--mantine-color-cyan-0) 0%, var(--mantine-color-teal-0) 100%)',
          borderColor: 'var(--mantine-color-cyan-2)',
        }}>
        <Group justify="space-between" align="flex-start">
          <Group gap="md">
            <ThemeIcon
              size={50}
              radius="xl"
              variant="gradient"
              gradient={{ from: 'cyan', to: 'teal', deg: 135 }}>
              <IconFolder size={26} />
            </ThemeIcon>
            <div>
              <Title order={2}>File Buckets</Title>
              <Text size="sm" c="dimmed" mt={4}>
                View and manage storage buckets connected to your tenant.
              </Text>
            </div>
          </Group>
        </Group>
      </Paper>

      {/* Info Cards */}
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Paper withBorder radius="lg" p="lg">
          <Group gap="sm">
            <ThemeIcon size={40} radius="md" variant="light" color="cyan">
              <IconCloud size={20} />
            </ThemeIcon>
            <Stack gap={2}>
              <Text size="sm" fw={600}>Cloud Storage</Text>
              <Text size="xs" c="dimmed">Connect AWS S3, GCS, or Azure Blob</Text>
            </Stack>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg">
          <Group gap="sm">
            <ThemeIcon size={40} radius="md" variant="light" color="teal">
              <IconFiles size={20} />
            </ThemeIcon>
            <Stack gap={2}>
              <Text size="sm" fw={600}>File Management</Text>
              <Text size="xs" c="dimmed">Upload, download, and organize files</Text>
            </Stack>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg">
          <Group gap="sm">
            <ThemeIcon size={40} radius="md" variant="light" color="blue">
              <IconUpload size={20} />
            </ThemeIcon>
            <Stack gap={2}>
              <Text size="sm" fw={600}>Easy Integration</Text>
              <Text size="xs" c="dimmed">Use files in your AI workflows</Text>
            </Stack>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* Bucket Manager */}
      <Paper p="lg" radius="lg" withBorder>
        <Group justify="space-between" mb="md">
          <div>
            <Text fw={600} size="lg">Your Buckets</Text>
            <Text size="sm" c="dimmed">Click on a bucket to browse its contents</Text>
          </div>
        </Group>
        <FileBucketManager
          onBucketClick={(bucket) => {
            router.push(`/dashboard/files/${encodeURIComponent(bucket.key)}`);
          }}
        />
      </Paper>
    </Stack>
  );
}
