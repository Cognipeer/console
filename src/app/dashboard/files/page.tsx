'use client';

import { Group, Stack, Text, Paper, ThemeIcon, SimpleGrid } from '@mantine/core';
import { IconFolder, IconCloud, IconFiles, IconUpload } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import FileBucketManager from '@/components/files/FileBucketManager';
import PageHeader from '@/components/layout/PageHeader';

export default function FilesDashboardPage() {
  const router = useRouter();

  return (
    <Stack gap="md">
      {/* Header */}
      <PageHeader
        icon={<IconFolder size={18} />}
        title="File Buckets"
        subtitle="View and manage storage buckets connected to your tenant."
      />

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
            <ThemeIcon size={40} radius="md" variant="light" color="teal">
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
