'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  NumberInput,
  Select,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconBroadcast, IconCheck, IconCopy } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';

export interface RealtimeModelView {
  _id: string;
  key: string;
  name: string;
  description?: string;
  status: 'active' | 'disabled';
  chatModelKey: string;
  instructions?: string;
  temperature?: number;
  maxOutputTokens?: number;
  sttModelKey?: string;
  inputAudioFormat?: string;
  ttsModelKey?: string;
  voice?: string;
  ttsFormat?: string;
  turnSilenceMs?: number;
  turnSilenceThreshold?: number;
  greeting?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface ModelOption {
  key: string;
  name: string;
  category: string;
}

interface RealtimeModelFormModalProps {
  opened: boolean;
  /** When set, the modal edits this realtime model instead of creating one. */
  model?: RealtimeModelView | null;
  onClose: () => void;
  onSaved: (model: RealtimeModelView) => void;
}

interface FormValues {
  name: string;
  key: string;
  description: string;
  chatModelKey: string;
  instructions: string;
  temperature: number | '';
  maxOutputTokens: number | '';
  sttModelKey: string;
  ttsModelKey: string;
  voice: string;
  ttsFormat: string;
  greeting: string;
  turnSilenceMs: number | '';
  turnSilenceThreshold: number | '';
}

const TTS_FORMATS = [
  { value: 'mp3', label: 'MP3' },
  { value: 'wav', label: 'WAV' },
  { value: 'pcm', label: 'PCM' },
];

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export default function RealtimeModelFormModal({
  opened,
  model,
  onClose,
  onSaved,
}: RealtimeModelFormModalProps) {
  const isEdit = Boolean(model);
  const [allModels, setAllModels] = useState<ModelOption[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [keyTouched, setKeyTouched] = useState(false);

  const form = useForm<FormValues>({
    initialValues: {
      name: '',
      key: '',
      description: '',
      chatModelKey: '',
      instructions: '',
      temperature: '',
      maxOutputTokens: '',
      sttModelKey: '',
      ttsModelKey: '',
      voice: '',
      ttsFormat: 'mp3',
      greeting: '',
      turnSilenceMs: 700,
      turnSilenceThreshold: 0.015,
    },
    validate: {
      name: (v) => (!v.trim() ? 'Name is required' : null),
      key: (v) =>
        !v.trim()
          ? 'Key is required'
          : !/^[a-z0-9][a-z0-9-_]*$/.test(v)
            ? 'Lowercase letters, digits, dashes and underscores only'
            : null,
      chatModelKey: (v) => (!v ? 'Chat model is required' : null),
    },
  });

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch('/api/models', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setAllModels(
          (data.models ?? []).map((m: Record<string, string>) => ({
            key: m.key,
            name: m.name,
            category: m.category,
          })),
        );
      }
    } catch (err) {
      console.error('Failed to load models', err);
    }
  }, []);

  useEffect(() => {
    if (!opened) return;
    void loadModels();
    setKeyTouched(false);
    if (model) {
      form.setValues({
        name: model.name ?? '',
        key: model.key ?? '',
        description: model.description ?? '',
        chatModelKey: model.chatModelKey ?? '',
        instructions: model.instructions ?? '',
        temperature: typeof model.temperature === 'number' ? model.temperature : '',
        maxOutputTokens:
          typeof model.maxOutputTokens === 'number' ? model.maxOutputTokens : '',
        sttModelKey: model.sttModelKey ?? '',
        ttsModelKey: model.ttsModelKey ?? '',
        voice: model.voice ?? '',
        ttsFormat: model.ttsFormat ?? 'mp3',
        greeting: model.greeting ?? '',
        turnSilenceMs:
          typeof model.turnSilenceMs === 'number' ? model.turnSilenceMs : 700,
        turnSilenceThreshold:
          typeof model.turnSilenceThreshold === 'number'
            ? model.turnSilenceThreshold
            : 0.015,
      });
    } else {
      form.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, model]);

  const llmModels = useMemo(
    () => allModels.filter((m) => m.category === 'llm'),
    [allModels],
  );
  const sttModels = useMemo(
    () => allModels.filter((m) => m.category === 'stt'),
    [allModels],
  );
  const ttsModels = useMemo(
    () => allModels.filter((m) => m.category === 'tts'),
    [allModels],
  );

  const handleNameChange = (value: string) => {
    form.setFieldValue('name', value);
    if (!isEdit && !keyTouched) {
      form.setFieldValue('key', slugify(value));
    }
  };

  const handleSubmit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;
    const values = form.getValues();

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        name: values.name.trim(),
        description: values.description.trim() || undefined,
        chatModelKey: values.chatModelKey,
        instructions: values.instructions.trim() || undefined,
        temperature: values.temperature === '' ? undefined : Number(values.temperature),
        maxOutputTokens:
          values.maxOutputTokens === '' ? undefined : Number(values.maxOutputTokens),
        sttModelKey: values.sttModelKey || undefined,
        ttsModelKey: values.ttsModelKey || undefined,
        voice: values.voice.trim() || undefined,
        ttsFormat: values.ttsModelKey ? values.ttsFormat : undefined,
        greeting: values.greeting.trim() || undefined,
        turnSilenceMs:
          values.turnSilenceMs === '' ? undefined : Number(values.turnSilenceMs),
        turnSilenceThreshold:
          values.turnSilenceThreshold === ''
            ? undefined
            : Number(values.turnSilenceThreshold),
      };
      if (!isEdit) body.key = values.key.trim();

      const res = await fetch(
        isEdit
          ? `/api/realtime/models/${encodeURIComponent(model!._id)}`
          : '/api/realtime/models',
        {
          method: isEdit ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? `Failed to ${isEdit ? 'update' : 'create'} realtime model`);
      }
      const data = await res.json();
      notifications.show({
        color: 'green',
        title: isEdit ? 'Realtime model updated' : 'Realtime model created',
        message: `${values.name} ${isEdit ? 'has been saved.' : 'is ready to use.'}`,
      });
      form.reset();
      onSaved(data.model as RealtimeModelView);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: isEdit ? 'Failed to update realtime model' : 'Failed to create realtime model',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const twimlSnippet = useMemo(() => {
    if (!isEdit) return '';
    const host = typeof window !== 'undefined' ? window.location.host : 'HOST';
    return `<Connect><Stream url="wss://${host}/api/client/v1/realtime/twilio?api_key=YOUR_API_KEY&model=${model?.key ?? ''}"/></Connect>`;
  }, [isEdit, model]);

  const copyTwiml = async () => {
    try {
      await navigator.clipboard.writeText(twimlSnippet);
      notifications.show({
        color: 'green',
        title: 'Copied',
        message: 'TwiML snippet copied to clipboard.',
      });
    } catch {
      notifications.show({
        color: 'red',
        title: 'Copy failed',
        message: 'Unable to access the clipboard.',
      });
    }
  };

  const selectedChatModel = useMemo(
    () => llmModels.find((m) => m.key === form.values.chatModelKey),
    [llmModels, form.values.chatModelKey],
  );

  const validIdentity = Boolean(form.values.name.trim() && form.values.key.trim());
  const validChatModel = Boolean(form.values.chatModelKey);

  const checklist = [
    { id: 1, label: 'Name and key provided', done: validIdentity },
    { id: 2, label: 'Chat model selected', done: validChatModel },
  ];

  const summary = (
    <>
      <SummaryGroup title="Realtime model">
        <SummaryKV
          label="Name"
          value={form.values.name || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label="Key"
          value={form.values.key || <span className="ds-faint">—</span>}
          mono
        />
      </SummaryGroup>
      <SummaryGroup title="Pipeline">
        <SummaryKV
          label="Chat model"
          value={selectedChatModel?.name || form.values.chatModelKey || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label="STT"
          value={form.values.sttModelKey || <span className="ds-faint">—</span>}
          mono
        />
        <SummaryKV
          label="TTS"
          value={form.values.ttsModelKey || <span className="ds-faint">—</span>}
          mono
        />
      </SummaryGroup>
      <SummaryGroup title="Pre-flight">
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  const canSubmit = validIdentity && validChatModel;

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconBroadcast size={16} />}
      title={isEdit ? 'Edit realtime model' : 'Create realtime model'}
      subtitle="Configure the chat model, voice pipeline, and telephony behavior for realtime sessions."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: isEdit ? 'Save changes' : 'Create realtime model',
        icon: <IconCheck size={13} />,
        loading: submitting,
        disabled: !canSubmit,
        onClick: () => {
          void handleSubmit();
        },
      }}
    >
      <FormSection
        number={1}
        title="Identity"
        description="A human-readable name and the key clients use to select this model."
        done={validIdentity}
      >
        <FormRow cols={2}>
          <FormField label="Name" required>
            <TextInput
              placeholder="Support voice agent"
              value={form.values.name}
              error={form.errors.name}
              onChange={(e) => handleNameChange(e.currentTarget.value)}
            />
          </FormField>
          <FormField
            label="Key"
            required
            hint={isEdit ? 'The key cannot be changed after creation.' : 'Used in API calls (?model=KEY).'}
          >
            <TextInput
              placeholder="support-voice-agent"
              readOnly={isEdit}
              disabled={isEdit}
              value={form.values.key}
              error={form.errors.key}
              onChange={(e) => {
                setKeyTouched(true);
                form.setFieldValue('key', e.currentTarget.value);
              }}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label="Description" optional>
            <Textarea
              placeholder="What is this realtime model used for?"
              minRows={2}
              autosize
              {...form.getInputProps('description')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={2}
        title="Chat model"
        description="The LLM that generates responses, plus its generation parameters."
        done={validChatModel}
      >
        <FormField label="Chat model" required hint="Pick a model with category “llm”.">
          <Select
            placeholder="Select a chat model"
            data={llmModels.map((m) => ({ value: m.key, label: m.name }))}
            searchable
            {...form.getInputProps('chatModelKey')}
          />
        </FormField>
        <FormField label="Instructions" optional hint="System prompt applied to every session.">
          <Textarea
            minRows={4}
            autosize
            placeholder="You are a helpful voice assistant…"
            {...form.getInputProps('instructions')}
          />
        </FormField>
        <FormRow cols={2}>
          <FormField label="Temperature" optional>
            <NumberInput
              min={0}
              max={2}
              step={0.1}
              decimalScale={2}
              placeholder="Model default"
              {...form.getInputProps('temperature')}
            />
          </FormField>
          <FormField label="Max output tokens" optional>
            <NumberInput
              min={1}
              step={64}
              placeholder="Model default"
              {...form.getInputProps('maxOutputTokens')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={3}
        title="Voice pipeline"
        description="Optional speech-to-text and text-to-speech models for audio sessions."
      >
        <FormField
          label="Transcription model (STT)"
          optional
          hint="Pick a model with category “stt”. Leave empty for text-only sessions."
        >
          <Select
            placeholder="No transcription"
            data={sttModels.map((m) => ({ value: m.key, label: m.name }))}
            searchable
            clearable
            value={form.values.sttModelKey || null}
            onChange={(v) => form.setFieldValue('sttModelKey', v ?? '')}
          />
        </FormField>
        <FormField
          label="Speech model (TTS)"
          optional
          hint="Pick a model with category “tts”. Leave empty for text-only responses."
        >
          <Select
            placeholder="No speech output"
            data={ttsModels.map((m) => ({ value: m.key, label: m.name }))}
            searchable
            clearable
            value={form.values.ttsModelKey || null}
            onChange={(v) => form.setFieldValue('ttsModelKey', v ?? '')}
          />
        </FormField>
        {form.values.ttsModelKey ? (
          <FormRow cols={2}>
            <FormField label="Voice" optional hint="Provider-specific voice name.">
              <TextInput placeholder="alloy" {...form.getInputProps('voice')} />
            </FormField>
            <FormField label="Audio format" optional>
              <Select data={TTS_FORMATS} {...form.getInputProps('ttsFormat')} />
            </FormField>
          </FormRow>
        ) : null}
      </FormSection>

      <FormSection
        number={4}
        title="Telephony"
        description="Behavior for Twilio media-stream calls: greeting and turn detection."
      >
        <FormField label="Greeting" optional hint="Spoken to the caller as soon as the call connects.">
          <Textarea
            minRows={2}
            autosize
            placeholder="Hi! How can I help you today?"
            {...form.getInputProps('greeting')}
          />
        </FormField>
        <FormRow cols={2}>
          <FormField
            label="Turn silence (ms)"
            optional
            hint="Silence duration that ends the caller's turn."
          >
            <NumberInput min={0} step={50} {...form.getInputProps('turnSilenceMs')} />
          </FormField>
          <FormField
            label="Silence threshold"
            optional
            hint="Audio energy below this counts as silence."
          >
            <NumberInput
              min={0}
              max={1}
              step={0.005}
              decimalScale={4}
              {...form.getInputProps('turnSilenceThreshold')}
            />
          </FormField>
        </FormRow>

        {isEdit ? (
          <FormField
            label="Twilio TwiML snippet"
            hint="Point a Twilio Voice webhook at TwiML containing this <Connect> block."
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
              }}
            >
              <pre
                className="ds-mono"
                style={{
                  flex: 1,
                  margin: 0,
                  padding: '10px 12px',
                  fontSize: 11.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  background: 'var(--ds-surface-code)',
                  color: 'var(--ds-surface-code-text)',
                  borderRadius: 'var(--ds-r-sm)',
                  border: '1px solid var(--ds-border-soft)',
                }}
              >
                {twimlSnippet}
              </pre>
              <Button
                variant="default"
                size="xs"
                leftSection={<IconCopy size={13} />}
                onClick={() => {
                  void copyTwiml();
                }}
              >
                Copy
              </Button>
            </div>
          </FormField>
        ) : null}
      </FormSection>
    </FormShell>
  );
}
