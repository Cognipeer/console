import Link from 'next/link';
import { Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { IconExternalLink, IconBook } from '@tabler/icons-react';
import { resolveSdkDoc } from '@/lib/docs/sdkDocs';

type DocsPageProps = {
  searchParams?: Promise<{ doc?: string }>;
};

export default async function DashboardDocsPage({ searchParams }: DocsPageProps) {
  const resolvedParams = await searchParams;
  const doc = resolveSdkDoc(resolvedParams?.doc);

  return (
    <Stack gap="lg">
      <Paper withBorder radius="lg" p="xl" style={{
        background:
          'linear-gradient(135deg, var(--mantine-color-teal-0) 0%, var(--mantine-color-cyan-0) 100%)',
        borderColor: 'var(--mantine-color-teal-2)',
      }}>
        <Group justify="space-between" align="flex-start">
          <div>
            <Group gap="sm" align="center">
              <IconBook size={18} />
              <Title order={2}>Documentation</Title>
            </Group>
            <Text size="sm" c="dimmed" mt={6}>
              {doc.title}
            </Text>
          </div>

          <Button
            component={Link}
            href={doc.url}
            target="_blank"
            rel="noreferrer"
            variant="light"
            leftSection={<IconExternalLink size={16} />}
          >
            Open in new tab
          </Button>
        </Group>
      </Paper>

      <Paper withBorder radius="lg" p={0} style={{ overflow: 'hidden' }}>
        <iframe
          title={doc.title}
          src={doc.url}
          style={{ width: '100%', height: '75vh', border: 0 }}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      </Paper>
    </Stack>
  );
}
