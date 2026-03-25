'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Badge,
  Box,
  Button,
  Center,
  Code,
  CopyButton,
  Divider,
  Group,
  Loader,
  Paper,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import PageHeader from '@/components/layout/PageHeader';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconBan,
  IconBook,
  IconCheck,
  IconCloud,
  IconCode,
  IconCopy,
  IconFileText,
  IconFiles,
  IconFolder,
  IconRefresh,
  IconTag,
} from '@tabler/icons-react';
import FileObjectManager from '@/components/files/FileObjectManager';
import type { FileBucketView } from '@/lib/services/files';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';

// ── helpers ──────────────────────────────────────────────────────────────────

function safeString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

// ── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({ bucket }: { bucket: FileBucketView }) {
  const providerLabel = safeString(bucket.provider?.label);
  const providerDriver = safeString(bucket.provider?.driver);

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 2, sm: 4 }}>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Status</Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.5rem' }}
                c={bucket.status === 'active' ? 'teal' : 'gray'} tt="capitalize">
                {bucket.status}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color={bucket.status === 'active' ? 'teal' : 'gray'}>
              {bucket.status === 'active' ? <IconCheck size={24} /> : <IconBan size={24} />}
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Provider</Text>
              <Text fw={700} size="sm" style={{ paddingTop: '0.5rem' }}>{providerLabel ?? '—'}</Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="cyan"><IconCloud size={24} /></ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Driver</Text>
              <Text fw={700} size="sm" style={{ paddingTop: '0.5rem' }} tt="uppercase">{providerDriver ?? '—'}</Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="blue"><IconCloud size={24} /></ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Prefix</Text>
              <Text fw={600} size="sm" style={{ paddingTop: '0.5rem' }}>{bucket.prefix ?? '(root)'}</Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="orange"><IconTag size={24} /></ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* Details card */}
      <Paper withBorder radius="lg" p="lg">
        <Stack gap="sm">
          <Group gap="sm">
            <ThemeIcon size={28} radius="md" variant="light" color="cyan">
              <IconFileText size={14} />
            </ThemeIcon>
            <Text fw={600} size="sm">Bucket Details</Text>
          </Group>
          <Divider />
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <Group gap="xs">
              <Text size="xs" c="dimmed" w={80}>Key:</Text>
              <Code fz="xs">{bucket.key}</Code>
            </Group>
            <Group gap="xs">
              <Text size="xs" c="dimmed" w={80}>Provider:</Text>
              <Text size="xs">{providerLabel ?? '—'}</Text>
            </Group>
            <Group gap="xs">
              <Text size="xs" c="dimmed" w={80}>Driver:</Text>
              <Badge size="xs" variant="light" color="blue" tt="uppercase">{providerDriver ?? '—'}</Badge>
            </Group>
            <Group gap="xs">
              <Text size="xs" c="dimmed" w={80}>Status:</Text>
              <Badge size="xs" color={bucket.status === 'active' ? 'teal' : 'gray'}>{bucket.status}</Badge>
            </Group>
            <Group gap="xs">
              <Text size="xs" c="dimmed" w={80}>Prefix:</Text>
              <Code fz="xs">{bucket.prefix ?? '(root)'}</Code>
            </Group>
            {bucket.createdAt ? (
              <Group gap="xs">
                <Text size="xs" c="dimmed" w={80}>Created:</Text>
                <Text size="xs">{new Date(bucket.createdAt).toLocaleDateString()}</Text>
              </Group>
            ) : null}
          </SimpleGrid>
          {safeString(bucket.description) ? (
            <>
              <Divider />
              <Text size="sm">{bucket.description}</Text>
            </>
          ) : null}
          {bucket.metadata && Object.keys(bucket.metadata).length > 0 ? (
            <>
              <Divider />
              <Text size="xs" c="dimmed" fw={600} tt="uppercase">Metadata</Text>
              <Code block fz="xs">{JSON.stringify(bucket.metadata, null, 2)}</Code>
            </>
          ) : null}
        </Stack>
      </Paper>
    </Stack>
  );
}

// ── Usage Tab ─────────────────────────────────────────────────────────────────

function UsageTab({ bucket }: { bucket: FileBucketView }) {
  const curlListFiles = `curl -X GET "https://your-cognipeer-host/api/client/v1/files/buckets/${bucket.key}/objects?limit=50" \\
  -H "Authorization: Bearer YOUR_API_TOKEN"`;

  const curlUpload = `curl -X POST "https://your-cognipeer-host/api/client/v1/files/buckets/${bucket.key}/objects" \\
  -H "Authorization: Bearer YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "fileName": "my-document.pdf",
    "contentType": "application/pdf",
    "data": "<data:application/pdf;base64,...>",
    "convertToMarkdown": true,
    "bucketKey": "${bucket.key}"
  }'`;

  const curlListBuckets = `curl -X GET "https://your-cognipeer-host/api/client/v1/files/buckets" \\
  -H "Authorization: Bearer YOUR_API_TOKEN"`;

  const sdkTypeScript = `import { ConsoleClient } from '@cognipeer/console-sdk';
import { readFileSync } from 'fs';

const client = new ConsoleClient({
  apiKey: 'YOUR_API_TOKEN',
  baseURL: 'https://your-cognipeer-host',
});

// List all buckets
const { buckets } = await client.files.buckets.list();
console.log(\`Found \${buckets.length} buckets\`);

// List files in "${bucket.key}"
const { files, count } = await client.files.list('${bucket.key}', {
  limit: 50,
});
console.log(\`\${count} files in bucket\`);

// Upload a file
const data = readFileSync('./my-document.pdf').toString('base64');
const { file } = await client.files.upload('${bucket.key}', {
  fileName: 'my-document.pdf',
  contentType: 'application/pdf',
  data: \`data:application/pdf;base64,\${data}\`,
  convertToMarkdown: true,
  bucketKey: '${bucket.key}',
});
console.log(\`Uploaded: \${file.key} (\${file.size} bytes)\`);`;

  const sdkPython = `import httpx, base64

BASE_URL = "https://your-cognipeer-host"
API_TOKEN = "YOUR_API_TOKEN"
headers = {"Authorization": f"Bearer {API_TOKEN}"}

# List all buckets
resp = httpx.get(f"{BASE_URL}/api/client/v1/files/buckets", headers=headers)
buckets = resp.json()["buckets"]
print(f"Found {len(buckets)} buckets")

# List files in "${bucket.key}"
resp = httpx.get(
    f"{BASE_URL}/api/client/v1/files/buckets/${bucket.key}/objects",
    headers=headers,
    params={"limit": 50},
)
result = resp.json()
for f in result.get("files", []):
    print(f"  {f['name']}  {f['size']} bytes  markdown={f['markdownStatus']}")

# Upload a file
with open("my-document.pdf", "rb") as fh:
    b64 = base64.b64encode(fh.read()).decode()

resp = httpx.post(
    f"{BASE_URL}/api/client/v1/files/buckets/${bucket.key}/objects",
    headers=headers,
    json={
        "fileName": "my-document.pdf",
        "contentType": "application/pdf",
        "data": f"data:application/pdf;base64,{b64}",
        "convertToMarkdown": True,
        "bucketKey": "${bucket.key}",
    },
)
file = resp.json()["file"]
print(f"Uploaded: {file['key']} ({file['size']} bytes)")`;

  return (
    <Stack gap="md">
      {/* Bucket key */}
      <Paper withBorder radius="md" p="md">
        <Text fw={600} mb="xs">Bucket Key</Text>
        <Group gap="sm">
          <Code fz="sm" style={{ flex: 1 }}>{bucket.key}</Code>
          <CopyButton value={bucket.key} timeout={2000}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                <Button size="xs" variant={copied ? 'filled' : 'light'}
                  color={copied ? 'teal' : 'blue'}
                  leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                  onClick={copy}
                >
                  {copied ? 'Copied' : 'Copy key'}
                </Button>
              </Tooltip>
            )}
          </CopyButton>
        </Group>
      </Paper>

      {/* cURL — list files */}
      <Paper withBorder radius="md" p="md">
        <Text fw={600} mb="xs">cURL — List Files</Text>
        <Text size="xs" c="dimmed" mb="sm">
          Replace <Code fz="xs">YOUR_API_TOKEN</Code> with a valid API token from Settings.
        </Text>
        <Box style={{ position: 'relative' }}>
          <CopyButton value={curlListFiles} timeout={2000}>
            {({ copied, copy }) => (
              <Button size="xs" variant={copied ? 'filled' : 'outline'} color={copied ? 'teal' : 'gray'}
                leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}
                onClick={copy}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
          <Code block fz="xs">{curlListFiles}</Code>
        </Box>
      </Paper>

      {/* cURL — upload */}
      <Paper withBorder radius="md" p="md">
        <Text fw={600} mb="xs">cURL — Upload File</Text>
        <Text size="xs" c="dimmed" mb="sm">
          Provide a data-URL (<Code fz="xs">data:&lt;mime&gt;;base64,...</Code>) in the <Code fz="xs">data</Code> field.
        </Text>
        <Box style={{ position: 'relative' }}>
          <CopyButton value={curlUpload} timeout={2000}>
            {({ copied, copy }) => (
              <Button size="xs" variant={copied ? 'filled' : 'outline'} color={copied ? 'teal' : 'gray'}
                leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}
                onClick={copy}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
          <Code block fz="xs">{curlUpload}</Code>
        </Box>
      </Paper>

      {/* cURL — list buckets */}
      <Paper withBorder radius="md" p="md">
        <Text fw={600} mb="xs">cURL — List Buckets</Text>
        <Box style={{ position: 'relative' }}>
          <CopyButton value={curlListBuckets} timeout={2000}>
            {({ copied, copy }) => (
              <Button size="xs" variant={copied ? 'filled' : 'outline'} color={copied ? 'teal' : 'gray'}
                leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}
                onClick={copy}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
          <Code block fz="xs">{curlListBuckets}</Code>
        </Box>
      </Paper>

      <Divider label="SDK Examples" labelPosition="center" />

      {/* TypeScript SDK */}
      <Paper withBorder radius="md" p="md">
        <Group justify="space-between" mb="xs">
          <Text fw={600}>TypeScript / Node.js SDK</Text>
          <Badge size="sm" variant="light" color="blue">@cognipeer/console-sdk</Badge>
        </Group>
        <Text size="xs" c="dimmed" mb="sm">
          Install: <Code fz="xs">npm install @cognipeer/console-sdk</Code>
        </Text>
        <Box style={{ position: 'relative' }}>
          <CopyButton value={sdkTypeScript} timeout={2000}>
            {({ copied, copy }) => (
              <Button size="xs" variant={copied ? 'filled' : 'outline'} color={copied ? 'teal' : 'gray'}
                leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}
                onClick={copy}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
          <Code block fz="xs" style={{ maxHeight: 360, overflow: 'auto' }}>{sdkTypeScript}</Code>
        </Box>
      </Paper>

      {/* Python */}
      <Paper withBorder radius="md" p="md">
        <Group justify="space-between" mb="xs">
          <Text fw={600}>Python</Text>
          <Badge size="sm" variant="light" color="yellow">httpx</Badge>
        </Group>
        <Text size="xs" c="dimmed" mb="sm">
          Install: <Code fz="xs">pip install httpx</Code>
        </Text>
        <Box style={{ position: 'relative' }}>
          <CopyButton value={sdkPython} timeout={2000}>
            {({ copied, copy }) => (
              <Button size="xs" variant={copied ? 'filled' : 'outline'} color={copied ? 'teal' : 'gray'}
                leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}
                onClick={copy}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
          <Code block fz="xs" style={{ maxHeight: 400, overflow: 'auto' }}>{sdkPython}</Code>
        </Box>
      </Paper>

      {/* Response format */}
      <Paper withBorder radius="md" p="md">
        <Text fw={600} mb="xs">Upload Response Format</Text>
        <Code block fz="xs">{`{
  "file": {
    "key": "${bucket.prefix ?? ''}my-document.pdf",
    "name": "my-document.pdf",
    "size": 1234567,
    "contentType": "application/pdf",
    "bucketKey": "${bucket.key}",
    "markdownStatus": "pending",
    "createdAt": "2025-02-19T10:30:00.000Z"
  }
}`}</Code>
      </Paper>
    </Stack>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FileBucketDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { openDocs } = useDocsDrawer();
  const bucketKeyParam = params.bucketKey;
  const bucketKey = useMemo(
    () => (Array.isArray(bucketKeyParam) ? bucketKeyParam[0] : bucketKeyParam) ?? '',
    [bucketKeyParam],
  );

  const [bucket, setBucket] = useState<FileBucketView | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('overview');

  const loadBucket = useCallback(async (isRefresh = false) => {
    if (!bucketKey) {
      setBucket(null);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const response = await fetch(`/api/files/buckets/${encodeURIComponent(bucketKey)}`, {
        cache: 'no-store',
      });

      if (!response.ok) {
        if (response.status === 404) {
          notifications.show({
            color: 'red',
            title: 'Bucket not found',
            message: 'The requested bucket is no longer available.',
          });
          router.push('/dashboard/files');
          return;
        }
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to load bucket');
      }

      const data = await response.json();
      setBucket((data.bucket as FileBucketView | null) ?? null);
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to load bucket',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [bucketKey, router]);

  useEffect(() => { void loadBucket(false); }, [loadBucket]);

  if (loading) {
    return (
      <Center py="xl"><Loader size="sm" /></Center>
    );
  }

  if (!bucket) {
    return (
      <Center py="xl">
        <Stack gap="sm" align="center">
          <Text c="dimmed">Bucket not found.</Text>
          <Button leftSection={<IconArrowLeft size={16} />} onClick={() => router.push('/dashboard/files')}>
            Back to buckets
          </Button>
        </Stack>
      </Center>
    );
  }

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconFolder size={18} />}
        title={bucket.name}
        subtitle={`Bucket key: ${bucket.key}`}
        actions={
          <>
            <Badge color={bucket.status === 'active' ? 'green' : 'yellow'}>{bucket.status}</Badge>
            <Button variant="default" size="xs" leftSection={<IconArrowLeft size={14} />}
              onClick={() => router.push('/dashboard/files')}>
              Back
            </Button>
            <Button onClick={() => openDocs('api-files')} variant="light" size="xs"
              leftSection={<IconBook size={14} />}>
              Docs
            </Button>
            <Button variant="light" size="xs" leftSection={<IconRefresh size={14} />}
              onClick={() => void loadBucket(true)} loading={refreshing}>
              Refresh
            </Button>
          </>
        }
      />

      <Tabs value={activeTab} onChange={(v) => setActiveTab(v ?? 'overview')}>
        <Tabs.List mb="md">
          <Tabs.Tab value="overview" leftSection={<IconFolder size={14} />}>
            Overview
          </Tabs.Tab>
          <Tabs.Tab value="files" leftSection={<IconFiles size={14} />}>
            Files
          </Tabs.Tab>
          <Tabs.Tab value="usage" leftSection={<IconCode size={14} />}>
            Usage
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="overview">
          <OverviewTab bucket={bucket} />
        </Tabs.Panel>

        <Tabs.Panel value="files">
          <FileObjectManager bucket={bucket} />
        </Tabs.Panel>

        <Tabs.Panel value="usage">
          <UsageTab bucket={bucket} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
