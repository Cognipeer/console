'use client';

import { useMemo, useState } from 'react';
import { NumberInput, Textarea, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconWorld } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  ChipPicker,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
  ToggleList,
  ToggleRow,
} from '@/components/common/ui/FormShell';
import type { CrawlerView } from '@/lib/services/crawler';

type Engine = 'auto' | 'axios' | 'playwright';

const ENGINE_LABEL: Record<Engine, string> = {
  auto: 'Auto',
  axios: 'Axios',
  playwright: 'Playwright',
};

interface CreateCrawlerModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (crawler: CrawlerView) => void;
}

interface FormValues {
  name: string;
  description: string;
  seeds: string;
  engine: Engine;
  autoCrawl: boolean;
  maxDepth: number | '';
  maxPages: number | '';
}

/** Split a free-text blob into a de-duplicated URL list (whitespace/newline separated). */
function parseSeeds(raw: string): string[] {
  const seen = new Set<string>();
  for (const token of raw.split(/[\s\n]+/)) {
    const url = token.trim();
    if (url) seen.add(url);
  }
  return [...seen];
}

export default function CreateCrawlerModal({
  opened,
  onClose,
  onCreated,
}: CreateCrawlerModalProps) {
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<FormValues>({
    initialValues: {
      name: '',
      description: '',
      seeds: '',
      engine: 'auto',
      autoCrawl: false,
      maxDepth: 0,
      maxPages: 50,
    },
    validate: {
      name: (v) => (v.trim().length < 2 ? 'Name is required' : null),
    },
  });

  const seeds = useMemo(() => parseSeeds(form.values.seeds), [form.values.seeds]);

  const handleSubmit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;
    const values = form.getValues();

    setSubmitting(true);
    try {
      const res = await fetch('/api/crawler/crawlers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: values.name.trim(),
          description: values.description.trim() || undefined,
          seeds: seeds.length > 0 ? seeds : undefined,
          engine: values.engine,
          autoCrawl: values.autoCrawl,
          maxDepth: values.maxDepth === '' ? 0 : Number(values.maxDepth),
          maxPages: values.maxPages === '' ? 0 : Number(values.maxPages),
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to create crawler');
      }
      const data = await res.json();
      notifications.show({
        color: 'teal',
        title: 'Crawler created',
        message: `${values.name.trim()} is ready — add URLs or run it now.`,
      });
      form.reset();
      onCreated(data.crawler as CrawlerView);
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Failed to create crawler',
        message: err instanceof Error ? err.message : 'Unexpected error',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const validIdentity = form.values.name.trim().length >= 2;

  const checklist = [
    { id: 1, label: 'Name provided', done: validIdentity },
    { id: 2, label: 'Seed URLs (optional)', done: seeds.length > 0 },
  ];

  const summary = (
    <>
      <SummaryGroup title="Crawler">
        <SummaryKV
          label="Name"
          value={form.values.name.trim() || <span className="ds-faint">—</span>}
        />
        <SummaryKV label="Engine" value={ENGINE_LABEL[form.values.engine]} />
      </SummaryGroup>
      <SummaryGroup title="Scope">
        <SummaryKV
          label="Seed URLs"
          value={seeds.length > 0 ? seeds.length : <span className="ds-faint">none yet</span>}
          mono
        />
        <SummaryKV
          label="Follow links"
          value={form.values.autoCrawl ? `depth ${form.values.maxDepth || 0}` : 'off'}
          mono
        />
        <SummaryKV
          label="Max pages"
          value={form.values.maxPages === '' || form.values.maxPages === 0 ? '∞' : form.values.maxPages}
          mono
        />
      </SummaryGroup>
      <SummaryGroup title="Pre-flight">
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconWorld size={16} />}
      title="Create crawler"
      subtitle="Fetch web pages, convert them to markdown, and optionally feed your knowledge engine."
      summary={summary}
      footerStatus={validIdentity ? 'Ready to create' : 'Name required'}
      primaryAction={{
        label: 'Create crawler',
        icon: <IconCheck size={13} />,
        loading: submitting,
        disabled: !validIdentity,
        onClick: () => {
          void handleSubmit();
        },
      }}
    >
      <FormSection
        number={1}
        title="Identity"
        description="A human-readable name for this crawler."
        done={validIdentity}
      >
        <FormRow cols={1}>
          <FormField label="Name" required>
            <TextInput
              placeholder="e.g. Docs site crawler"
              {...form.getInputProps('name')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label="Description" optional>
            <Textarea
              placeholder="What does this crawler ingest?"
              minRows={2}
              autosize
              {...form.getInputProps('description')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={2}
        title="Seed URLs"
        description="Optional starting URLs. You can also add or paste more later on the detail page."
        done={seeds.length > 0}
      >
        <FormField
          label="URLs"
          optional
          hint={
            seeds.length > 0
              ? `${seeds.length} URL${seeds.length === 1 ? '' : 's'} detected`
              : 'One URL per line.'
          }
        >
          <Textarea
            placeholder={'https://example.com/docs\nhttps://example.com/blog'}
            minRows={3}
            autosize
            {...form.getInputProps('seeds')}
          />
        </FormField>
      </FormSection>

      <FormSection
        number={3}
        title="Crawl behavior"
        description="How pages are fetched and whether the crawler follows links. All of this can be tuned later."
      >
        <FormField
          label="Engine"
          hint="Auto tries fast static fetching first, then falls back to a headless browser for JS-heavy pages."
        >
          <ChipPicker<Engine>
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'axios', label: 'Axios (static)' },
              { value: 'playwright', label: 'Playwright (JS)' },
            ]}
            value={form.values.engine}
            onChange={(v) => form.setFieldValue('engine', v as Engine)}
          />
        </FormField>

        <ToggleList>
          <ToggleRow
            label="Follow links discovered on each page"
            description="Walk in-domain links found on each seed URL, up to the depth below."
            checked={form.values.autoCrawl}
            onChange={(checked) => form.setFieldValue('autoCrawl', checked)}
          />
        </ToggleList>

        <FormRow cols={2}>
          <FormField
            label="Link-follow depth"
            hint="0 = only the seed URLs. Up to 3."
          >
            <NumberInput
              min={0}
              max={3}
              disabled={!form.values.autoCrawl}
              {...form.getInputProps('maxDepth')}
            />
          </FormField>
          <FormField label="Max pages" hint="0 = unlimited.">
            <NumberInput min={0} max={5000} {...form.getInputProps('maxPages')} />
          </FormField>
        </FormRow>
      </FormSection>
    </FormShell>
  );
}
