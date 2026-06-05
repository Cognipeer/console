import Link from 'next/link';
import { Button } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import { resolveSdkDoc } from '@/lib/docs/sdkDocs';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';

type DocsPageProps = {
  searchParams?: Promise<{ doc?: string }>;
};

export default async function DashboardDocsPage({ searchParams }: DocsPageProps) {
  const resolvedParams = await searchParams;
  const doc = resolveSdkDoc(resolvedParams?.doc);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Learn · Documentation"
        title="Documentation"
        subtitle={doc.title}
        actions={
          <Button
            component={Link}
            href={doc.url}
            target="_blank"
            rel="noreferrer"
            variant="default"
            size="sm"
            leftSection={<IconExternalLink size={14} stroke={1.7} />}
          >
            Open in new tab
          </Button>
        }
      />

      <div
        className="ds-card"
        style={{ overflow: 'hidden', padding: 0 }}
      >
        <iframe
          title={doc.title}
          src={doc.url}
          style={{ width: '100%', height: '75vh', border: 0, display: 'block' }}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      </div>
    </PageContainer>
  );
}
