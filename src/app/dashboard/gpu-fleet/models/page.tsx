'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBoxModel, IconInfoCircle, IconRocket, IconSearch } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import { GpuFleetApi } from '../_lib/api';
import type { ModelLibraryEntry } from '../_lib/types';

const MODALITIES = [
  { value: 'all', label: 'All' },
  { value: 'llm', label: 'LLM' },
  { value: 'embedding', label: 'Embedding' },
  { value: 'stt', label: 'STT' },
  { value: 'tts', label: 'TTS' },
  { value: 'ocr', label: 'OCR' },
];

const ACCELERATORS = [
  { value: 'all', label: 'All' },
  { value: 'nvidia-gpu', label: 'NVIDIA' },
  { value: 'apple-silicon', label: 'Apple' },
  { value: 'cpu', label: 'CPU' },
];

export default function GpuFleetModelsPage() {
  const [entries, setEntries] = useState<ModelLibraryEntry[]>([]);
  const [modality, setModality] = useState('all');
  const [accelerator, setAccelerator] = useState('all');
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await GpuFleetApi.listModelLibrary<{ entries: ModelLibraryEntry[] }>({
        modality: modality === 'all' ? undefined : modality,
        accelerator: accelerator === 'all' ? undefined : accelerator,
        q: q.trim() || undefined,
      });
      setEntries(data.entries);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Failed to load library',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, [modality, accelerator, q]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 200);
    return () => clearTimeout(id);
  }, [load]);

  const grouped = useMemo(() => {
    const buckets: Record<string, ModelLibraryEntry[]> = {};
    for (const entry of entries) {
      (buckets[entry.modality] ??= []).push(entry);
    }
    return buckets;
  }, [entries]);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · GPU Fleet · Model Marketplace"
        title="Pick a model to deploy"
        subtitle="Curated catalog with runtime templates. Hardware-compatible models for the selected filter are highlighted."
      />

      <Alert mb="md" color="blue" icon={<IconInfoCircle size={16} />}>
        <Text size="sm">
          This page is a catalog browser. Deploying needs a host context, so you cannot deploy directly from here.
          Once you have picked a model:
        </Text>
        <Text size="sm" mt={4}>
          • <strong>Single host</strong> — open a host from the Overview → <strong>Deploy model</strong>.
          {' '}<br />
          • <strong>Multiple hosts</strong> (load-balanced) — go to <strong>Pools → Bulk deploy</strong>.
        </Text>
        <Group mt="xs">
          <Button
            size="xs"
            variant="default"
            component={Link}
            href="/dashboard/gpu-fleet/pools"
            leftSection={<IconRocket size={14} />}
          >
            Open bulk deploy
          </Button>
        </Group>
      </Alert>

      <Card withBorder mb="md">
        <Group gap="md">
          <TextInput
            placeholder="Search Qwen, Whisper, BGE…"
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            leftSection={<IconSearch size={14} />}
            w={280}
          />
          <Stack gap={4}>
            <Text size="xs" c="dimmed">Modality</Text>
            <SegmentedControl value={modality} onChange={setModality} data={MODALITIES} size="xs" />
          </Stack>
          <Stack gap={4}>
            <Text size="xs" c="dimmed">Accelerator</Text>
            <SegmentedControl value={accelerator} onChange={setAccelerator} data={ACCELERATORS} size="xs" />
          </Stack>
        </Group>
      </Card>

      {Object.keys(grouped).length === 0 ? (
        <Card withBorder>
          <Text c="dimmed" size="sm">No matches. Try clearing the filters.</Text>
        </Card>
      ) : (
        Object.entries(grouped).map(([modalityKey, list]) => (
          <Stack key={modalityKey} mb="lg" gap="xs">
            <Title order={5} tt="uppercase">{modalityKey} ({list.length})</Title>
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
              {list.map((entry) => (
                <ModelCard key={entry.id} entry={entry} />
              ))}
            </SimpleGrid>
          </Stack>
        ))
      )}
    </PageContainer>
  );
}

function ModelCard({ entry }: { entry: ModelLibraryEntry }) {
  return (
    <Card withBorder padding="md" radius="md">
      <Stack gap={6}>
        <Group justify="space-between" align="flex-start">
          <Group gap="xs">
            <IconBoxModel size={18} />
            <Text fw={600}>{entry.displayName}</Text>
          </Group>
          <Badge color="gray" variant="light" size="xs">{entry.vendor}</Badge>
        </Group>
        <Group gap={4}>
          {entry.tags.slice(0, 4).map((tag) => (
            <Badge key={tag} variant="dot" size="xs" color="blue">{tag}</Badge>
          ))}
        </Group>
        <Text size="xs" c="dimmed">
          VRAM ≥ {entry.requirements.minVramGiB} GiB
          {' · '}
          recommended {entry.requirements.recommendedVramGiB} GiB
          {' · '}
          compute {entry.requirements.computeCapability}
        </Text>
        <Group gap={4}>
          {entry.supportedPlatforms.map((p) => (
            <Badge key={p} size="xs" variant="outline">{p}</Badge>
          ))}
        </Group>
        <Group gap={4}>
          {entry.availableRuntimes.map((r) => (
            <Badge key={r} size="xs" color="teal" variant="light">{r}</Badge>
          ))}
        </Group>
        <Text size="xs" c="dimmed">
          HF: <code>{entry.hfRepo ?? '—'}</code>
        </Text>
      </Stack>
    </Card>
  );
}
