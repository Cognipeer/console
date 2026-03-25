import Link from 'next/link';
import { Button, Paper, Stack } from '@mantine/core';
import { IconExternalLink, IconBook } from '@tabler/icons-react';
import { resolveSdkDoc } from '@/lib/docs/sdkDocs';
import PageHeader from '@/components/layout/PageHeader';

type DocsPageProps = {
  searchParams?: Promise<{ doc?: string }>;
};

export default async function DashboardDocsPage({ searchParams }: DocsPageProps) {
  const resolvedParams = await searchParams;
  const doc = resolveSdkDoc(resolvedParams?.doc);

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconBook size={18} />}
        title="Documentation"
        subtitle={doc.title}
        actions={
          <Button
            component={Link}
            href={doc.url}
            target="_blank"
            rel="noreferrer"
            variant="light"
            size="xs"
            leftSection={<IconExternalLink size={14} />}
          >
            Open in new tab
          </Button>
        }
      />

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
