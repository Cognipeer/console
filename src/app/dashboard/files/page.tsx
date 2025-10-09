'use client';

import { Group, Stack, Text, Title } from '@mantine/core';
import { useRouter } from 'next/navigation';
import FileBucketManager from '@/components/files/FileBucketManager';

export default function FilesDashboardPage() {
  const router = useRouter();

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>File Buckets</Title>
          <Text size="sm" c="dimmed" mt={4}>
            View and manage storage buckets connected to your tenant.
          </Text>
        </div>
      </Group>

      <FileBucketManager
        onBucketClick={(bucket) => {
          router.push(`/dashboard/files/${encodeURIComponent(bucket.key)}`);
        }}
      />
    </Stack>
  );
}
