'use client';

import { resolveUpstreamApi, supportsUpstreamApiChoice, type UpstreamApi } from '@/lib/services/models/upstreamApi';
import { useEffect, useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import { Badge, Button, Group, NumberInput, Select, Text } from '@mantine/core';
import ModelFormLayout from '@/components/models/ModelFormLayout';
import {
  FormField,
  FormRow,
  FormSection,
  SliderField,
  SummaryGroup,
  SummaryKV,
  ToggleList,
  ToggleRow,
} from '@/components/common/ui/FormShell';
import {
  CapabilitiesSection,
  GeneralSection,
  LimitsSection,
  PricingSection,
  ProviderSection,
  ReasoningSection,
  RequestParamsSection,
  UpstreamApiSection,
} from '@/components/models/modelFormSections';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconBrain, IconDeviceFloppy, IconShield } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { reasoningFormFromSettings, reasoningSettingsPatch } from '@/components/models/reasoningForm';
import { detectUnsupportedParams as detectForcedParams } from '@/lib/providers/unsupportedParams';
import { useConfirmKeyChange } from '@/components/common/confirm/useConfirmKeyChange';
import { PROVIDER_DEFINITIONS } from '@/lib/services/models/providerCatalog';
import {
  detectUnsupportedParams,
  formatRequestDefaults,
  parseRequestDefaults,
  toStringArray,
  validateRequestDefaults,
} from '@/components/models/requestParams';
import {
  getDefaultModelOutputModalities,
  type ModelInputModality,
} from '@/lib/services/models/modelCapabilities';
import {
  inferredInputModalities,
  inputModalitiesPayload,
  isMultimodalFor,
  shownInputModalities,
  storedInputModalities,
} from '@/components/models/inputModalities';
import ModelGuardrailModal from '@/components/models/ModelGuardrailModal';
import type { GuardrailBindingRow } from '@/components/guardrails/GuardrailBindingList';


interface ModelProviderOption {
  key: string;
  label: string;
  status: string;
  driver: string;
}

interface ModelPricing {
  currency?: string;
  inputTokenPer1M: number;
  outputTokenPer1M: number;
  cachedTokenPer1M?: number;
}

interface SemanticCacheConfig {
  enabled: boolean;
  vectorProviderKey: string;
  vectorIndexKey: string;
  embeddingModelKey: string;
  similarityThreshold: number;
  ttlSeconds: number;
  maxCacheSize?: number;
}

interface ModelDetailDto {
  _id: string;
  name: string;
  description?: string;
  key: string;
  provider?: string;
  providerKey: string;
  providerDriver?: string;
  category: 'llm' | 'embedding' | 'rerank' | 'stt' | 'tts' | 'ocr' | 'image' | 'moderation' | 'decision';
  modelId: string;
  isMultimodal?: boolean;
  supportsToolCalls?: boolean;
  capabilities?: {
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsReasoning?: boolean;
    supportsStructuredOutputs?: boolean;
  };
  pricing: ModelPricing;
  settings: Record<string, unknown>;
  semanticCache?: SemanticCacheConfig;
  /**
   * Multi-guardrail binding. Its PRESENCE (not its length) is what says the
   * model is on the list rather than the two deprecated slots — an explicitly
   * empty array is an operator saying "bound to nothing", which the resolver
   * honours literally instead of falling back to the keys below.
   */
  guardrails?: GuardrailBindingRow[];
  /** @deprecated Read only to tell a legacy-bound model from an unbound one. */
  inputGuardrailKey?: string;
  /** @deprecated See `inputGuardrailKey`. */
  outputGuardrailKey?: string;
  metadata?: Record<string, unknown>;
}

/** `GET /api/guardrails`, narrowed to what naming an attached binding needs. */
interface GuardrailOption {
  key: string;
  name: string;
  type: 'preset' | 'custom';
  action: string;
  enabled?: boolean;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

interface FormValues {
  name: string;
  description?: string;
  key: string;
  providerKey: string;
  modelId: string;
  pricing: {
    currency: string;
    inputTokenPer1M: number;
    outputTokenPer1M: number;
    cachedTokenPer1M: number;
  };
  settings: Record<string, unknown>;
  isMultimodal: boolean;
  supportsToolCalls: boolean;
  contextWindow: number | '';
  maxOutputTokens: number | '';
  supportsReasoning: boolean;
  supportsStructuredOutputs: boolean;
  semanticCacheEnabled: boolean;
  semanticCacheVectorProviderKey: string;
  semanticCacheVectorIndexKey: string;
  semanticCacheEmbeddingModelKey: string;
  semanticCacheSimilarityThreshold: number;
  semanticCacheTtlSeconds: number;
}

interface VectorProviderOption {
  key: string;
  label: string;
}

interface VectorIndexOption {
  key: string;
  name: string;
}

interface EmbeddingModelOption {
  key: string;
  name: string;
}

interface EditModelModalProps {
  /** Model to edit; the overlay is closed when null. */
  modelId: string | null;
  opened: boolean;
  onClose: () => void;
  /** Called after a successful save (the caller refreshes its list / detail). */
  onSaved: () => void;
  /** Open scrolled to this section with its first control focused (a shortcut from the model page). */
  initialSection?: 'reasoning';
}

export default function EditModelModal({ modelId: editModelId, opened, onClose, onSaved, initialSection }: EditModelModalProps) {
  const t = useTranslations('modelEdit');
  const tWizard = useTranslations('modelWizard');
  const tNouns = useTranslations('common.confirm.nouns');
  const confirmKeyChange = useConfirmKeyChange();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [, setRefreshing] = useState(false);
  const [model, setModel] = useState<ModelDetailDto | null>(null);
  const [modelProviders, setModelProviders] = useState<ModelProviderOption[]>([]);
  const [vectorProviders, setVectorProviders] = useState<VectorProviderOption[]>([]);
  const [vectorIndexes, setVectorIndexes] = useState<VectorIndexOption[]>([]);
  const [embeddingModels, setEmbeddingModels] = useState<EmbeddingModelOption[]>([]);
  const [guardrails, setGuardrails] = useState<GuardrailOption[]>([]);
  const [guardrailModalOpen, setGuardrailModalOpen] = useState(false);
  // Held as text so a half-typed JSON object doesn't get thrown away on rerender.
  const [requestDefaultsText, setRequestDefaultsText] = useState('');
  // Dirty tracking: a snapshot of every editable value right after each load.
  const [loadVersion, setLoadVersion] = useState(0);
  const [baseline, setBaseline] = useState<string | null>(null);
  // What the model can be sent, when someone set it; null = detected from the model id.
  const [inputModalities, setInputModalities] = useState<ModelInputModality[] | null>(null);

  const form = useForm<FormValues>({
    initialValues: {
      name: '',
      description: '',
      key: '',
      providerKey: '',
      modelId: '',
      pricing: {
        currency: 'USD',
        inputTokenPer1M: 0,
        outputTokenPer1M: 0,
        cachedTokenPer1M: 0,
      },
      settings: {},
      isMultimodal: false,
      supportsToolCalls: false,
      contextWindow: '',
      maxOutputTokens: '',
      supportsReasoning: false,
      supportsStructuredOutputs: false,
      semanticCacheEnabled: false,
      semanticCacheVectorProviderKey: '',
      semanticCacheVectorIndexKey: '',
      semanticCacheEmbeddingModelKey: '',
      semanticCacheSimilarityThreshold: 0.92,
      semanticCacheTtlSeconds: 3600,
    },
    validate: {
      name: (value) => (!value ? tWizard('validation.name') : null),
      modelId: (value) => (!value ? tWizard('validation.modelId') : null),
    },
  });

  const snapshot = JSON.stringify([form.values, requestDefaultsText, inputModalities]);
  useEffect(() => {
    if (loadVersion > 0) setBaseline(snapshot);
    // The baseline is the state right after a load, not after every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadVersion]);
  const dirty = baseline !== null && baseline !== snapshot;

  const selectedProvider = useMemo(
    () =>
      modelProviders.find((candidate) => candidate.key === form.values.providerKey) ?? null,
    [form.values.providerKey, modelProviders],
  );

  // What the model id is known to accept — the boxes start from it until someone ticks one.
  const inferredModalities = useMemo(
    () => inferredInputModalities(model?.category ?? 'llm', form.values.modelId, Boolean(model?.isMultimodal)),
    [model?.category, model?.isMultimodal, form.values.modelId],
  );

  /**
   * Guardrail keys attached today, whichever generation the row is on.
   *
   * Only the KEYS: which hooks each one covers is a question with a right
   * answer (the guardrail's own declaration, the surface, whether streaming is
   * enabled) and it is answered in one place — `GuardrailBindingList`, inside
   * the editor below. A second, hand-rolled answer on this card is how a screen
   * ends up telling an operator a guardrail runs somewhere it does not.
   */
  const attachedGuardrailKeys = useMemo(() => {
    if (!model) return [];
    if (Array.isArray(model.guardrails)) {
      return model.guardrails.map((binding) => binding.key);
    }
    return [model.inputGuardrailKey, model.outputGuardrailKey].filter(
      (key, index, all): key is string =>
        Boolean(key) && all.indexOf(key) === index,
    );
  }, [model]);


  const providerDefinition = useMemo(
    () =>
      PROVIDER_DEFINITIONS.find(
        (candidate) => candidate.id === selectedProvider?.driver,
      ) ?? null,
    [selectedProvider?.driver],
  );

  // Same registry the gateway consults at call time, so the form shows exactly
  // what will be dropped rather than a description of it.
  const autoDropped = useMemo(
    () => (form.values.settings.autoDropUnsupportedParams === false
      ? { params: [] as string[], reason: undefined as string | undefined }
      : detectUnsupportedParams(selectedProvider?.driver, form.values.modelId)),
    [
      selectedProvider?.driver,
      form.values.modelId,
      form.values.settings.autoDropUnsupportedParams,
    ],
  );

  const loadVectorIndexes = useCallback(async (providerKey: string) => {
    if (!providerKey) {
      setVectorIndexes([]);
      return;
    }
    try {
      const res = await fetch(`/api/vector/indexes?providerKey=${encodeURIComponent(providerKey)}`);
      if (res.ok) {
        const data = await res.json();
        setVectorIndexes(
          (data.indexes ?? []).map((idx: { key: string; name: string }) => ({
            key: idx.key,
            name: idx.name,
          })),
        );
      }
    } catch {
      setVectorIndexes([]);
    }
  }, []);

  const loadModel = async (silenceNotification = false) => {
    const modelId = editModelId;
    if (!modelId) return;

    setRefreshing(!loading);
    try {
      const [modelResponse, providerResponse, vectorProviderResponse, embeddingModelsResponse, guardrailsResponse] = await Promise.all([
        fetch(`/api/models/${modelId}`),
        fetch('/api/models/providers'),
        fetch('/api/vector/providers'),
        fetch('/api/models?category=embedding'),
        // Unfiltered on purpose: a guardrail disabled AFTER it was bound still
        // has to resolve to its name here, or an attached binding renders as
        // "unknown" and reads as deleted when it is merely switched off.
        fetch('/api/guardrails'),
      ]);

      if (!modelResponse.ok) {
        throw new Error('failed');
      }

      const modelData = await modelResponse.json();
      const nextModel: ModelDetailDto = modelData.model;
      setModel(nextModel);

      const settings = { ...nextModel.settings };
      setRequestDefaultsText(formatRequestDefaults(settings.requestDefaults));
      setInputModalities(storedInputModalities(nextModel.metadata, nextModel));

      const cache = nextModel.semanticCache;

      form.setValues({
        name: nextModel.name,
        description: nextModel.description,
        key: nextModel.key,
        providerKey: nextModel.providerKey || '',
        modelId: nextModel.modelId,
        pricing: {
          currency: nextModel.pricing.currency || 'USD',
          inputTokenPer1M: nextModel.pricing.inputTokenPer1M,
          outputTokenPer1M: nextModel.pricing.outputTokenPer1M,
          cachedTokenPer1M: nextModel.pricing.cachedTokenPer1M || 0,
        },
        settings,
        isMultimodal: Boolean(nextModel.isMultimodal),
        supportsToolCalls: Boolean(nextModel.supportsToolCalls),
        contextWindow: nextModel.capabilities?.contextWindow ?? '',
        maxOutputTokens: nextModel.capabilities?.maxOutputTokens ?? '',
        supportsReasoning: Boolean(nextModel.capabilities?.supportsReasoning),
        supportsStructuredOutputs: Boolean(
          nextModel.capabilities?.supportsStructuredOutputs,
        ),
        semanticCacheEnabled: Boolean(cache?.enabled),
        semanticCacheVectorProviderKey: cache?.vectorProviderKey || '',
        semanticCacheVectorIndexKey: cache?.vectorIndexKey || '',
        semanticCacheEmbeddingModelKey: cache?.embeddingModelKey || '',
        semanticCacheSimilarityThreshold: cache?.similarityThreshold ?? 0.92,
        semanticCacheTtlSeconds: cache?.ttlSeconds ?? 3600,
      });
      setLoadVersion((v) => v + 1);

      if (providerResponse.ok) {
        const providerData = await providerResponse.json();
        const rawProviders = providerData.providers ?? [];
        setModelProviders(
          rawProviders.map((p: Record<string, string>) => ({
            key: p.key,
            label: p.label || p.key,
            status: p.status || 'active',
            driver: p.driver || '',
          }))
        );
      }

      if (vectorProviderResponse.ok) {
        const vpData = await vectorProviderResponse.json();
        setVectorProviders(
          (vpData.providers ?? []).map((p: { key: string; label: string }) => ({
            key: p.key,
            label: p.label,
          })),
        );
      }

      if (embeddingModelsResponse.ok) {
        const emData = await embeddingModelsResponse.json();
        setEmbeddingModels(
          (emData.models ?? []).map((m: { key: string; name: string }) => ({
            key: m.key,
            name: m.name,
          })),
        );
      }

      if (guardrailsResponse.ok) {
        const gData = await guardrailsResponse.json();
        setGuardrails(
          (gData.guardrails ?? []).map(
            (g: {
              key: string;
              name: string;
              type: 'preset' | 'custom';
              action: string;
              enabled?: boolean;
            }) => ({
              key: g.key,
              name: g.name,
              type: g.type,
              action: g.action,
              enabled: g.enabled,
            }),
          ),
        );
      }

      // Load vector indexes for current provider if set
      if (cache?.vectorProviderKey) {
        await loadVectorIndexes(cache.vectorProviderKey);
      }

      if (!silenceNotification) {
        notifications.show({
          title: t('notifications.loadedTitle'),
          message: t('notifications.loadedMessage'),
          color: 'teal',
        });
      }
    } catch (error) {
      console.error('Failed to load model', error);
      notifications.show({
        title: t('notifications.errorTitle'),
        message: t('notifications.errorMessage'),
        color: 'red',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!opened || !editModelId) return;
    setLoading(true);
    setModel(null);
    setBaseline(null);
    void loadModel(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, editModelId]);

  const handleSubmit = async (values: FormValues) => {
    if (!model || saving) return;

    const validation = form.validate();
    if (validation.hasErrors) {
      return;
    }

    // The JSON editor lives outside the Mantine form, so it has to be checked
    // here. Without this, a typo fell through to `parseRequestDefaults` returning
    // undefined, which the payload below turns into `null` — i.e. a delete — and
    // the save reported success while wiping the stored defaults.
    const requestDefaultsError = validateRequestDefaults(requestDefaultsText);
    if (requestDefaultsError) {
      notifications.show({
        color: 'red',
        message: `Extra request body: ${requestDefaultsError}`,
        title: 'Cannot save',
      });
      return;
    }
    if (
      values.contextWindow !== ''
      && values.maxOutputTokens !== ''
      && values.maxOutputTokens > values.contextWindow
    ) {
      notifications.show({
        title: t('notifications.errorTitle'),
        message: tWizard('validation.maxOutputTokens'),
        color: 'red',
      });
      return;
    }

    // Agents, replica pools and routing bind models by key: warn before a rename breaks them.
    // Busy from the usage lookup on: the button shows progress and a second
    // click cannot queue a second rename dialog.
    setSaving(true);
    let proceed = false;
    try {
      proceed = await confirmKeyChange({
        type: 'model',
        id: String(model._id),
        noun: tNouns('model'),
        originalKey: model.key,
        nextKey: values.key,
      });
    } finally {
      if (!proceed) setSaving(false);
    }
    if (!proceed) return;

    try {
      const response = await fetch(`/api/models/${model._id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: values.name,
          description: values.description,
          key: values.key,
          providerKey: values.providerKey || undefined,
          modelId: values.modelId,
          pricing: values.pricing,
          settings: {
            ...values.settings,
            // `null` clears the key server-side, so emptying the editor removes
            // the defaults rather than persisting an empty object. Reached only
            // when the text is genuinely empty — invalid JSON is rejected above.
            requestDefaults: requestDefaultsText.trim()
              ? parseRequestDefaults(requestDefaultsText) ?? null
              : null,
            unsupportedParams: toStringArray(values.settings.unsupportedParams).length
              ? toStringArray(values.settings.unsupportedParams)
              : null,
            // `null` removes the key: "Not set" must stop sending anything.
            ...(model.category === 'llm'
              ? reasoningSettingsPatch(reasoningFormFromSettings(values.settings), null, values.settings)
              : {}),
          },
          isMultimodal: isMultimodalFor(shownInputModalities(inputModalities, inferredModalities)),
          supportsToolCalls: values.supportsToolCalls,
          capabilities: {
            ...(values.contextWindow !== ''
              ? { contextWindow: values.contextWindow }
              : {}),
            ...(values.maxOutputTokens !== ''
              ? { maxOutputTokens: values.maxOutputTokens }
              : {}),
            // Only an explicit choice is stored. Writing the category default
            // back here pinned every edited model to "text only" whether or not
            // it ever took images.
            ...inputModalitiesPayload(inputModalities),
            outputModalities: getDefaultModelOutputModalities(model.category),
            supportsReasoning: values.supportsReasoning,
            supportsStructuredOutputs: values.supportsStructuredOutputs,
            supportsToolCalls: values.supportsToolCalls,
          },
          semanticCache: {
            enabled: values.semanticCacheEnabled,
            vectorProviderKey: values.semanticCacheVectorProviderKey,
            vectorIndexKey: values.semanticCacheVectorIndexKey,
            embeddingModelKey: values.semanticCacheEmbeddingModelKey,
            similarityThreshold: values.semanticCacheSimilarityThreshold,
            ttlSeconds: values.semanticCacheTtlSeconds,
          },
          // No guardrail field of any kind. The bindings are written by the
          // editor overlay (which sends `guardrails`, and lets the API derive
          // the two deprecated columns from it); resending the legacy keys from
          // here would either be a stale echo of columns the API now owns, or —
          // on a model whose bindings moved into the list — the exact write the
          // API rejects with "send the full `guardrails` array instead". An
          // update that omits them leaves both columns untouched.
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update model');
      }

      notifications.show({
        title: t('notifications.savedTitle'),
        message: t('notifications.savedMessage'),
        color: 'teal',
      });

      onSaved();
      onClose();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : t('notifications.errorMessage');
      notifications.show({
        title: t('notifications.errorTitle'),
        message: errorMessage,
        color: 'red',
      });
    } finally {
      setSaving(false);
    }
  };

  // Nothing to show until the model is loaded; the overlay opens fully populated.
  if (!opened || loading || !model) return null;

  const isLlm = model.category === 'llm';
  const validIdentity = Boolean(form.values.name && form.values.modelId);
  const sectionNumber = (() => {
    let n = 0;
    return () => ++n;
  })();
  const setPrice = (path: string) => (value: string | number) => form.setFieldValue(path, Number(value) || 0);
  const patchSettings = (patch: Record<string, unknown>) =>
    form.setFieldValue('settings', { ...form.values.settings, ...patch });

  return (
    <>
      <ModelFormLayout
        open
        onClose={onClose}
        icon={<IconBrain size={16} />}
        title={t('title', { name: model.name })}
        subtitle={t('subtitle')}
        dirty={dirty}
        footerStatus={model.key}
        summary={
          <>
            <SummaryGroup title="Model">
              <SummaryKV label="Name" value={form.values.name || '—'} />
              <SummaryKV label="Key" value={form.values.key || '—'} mono />
              <SummaryKV label="Category" value={model.category} />
              <SummaryKV label="Provider" value={selectedProvider?.label ?? (form.values.providerKey || '—')} />
              <SummaryKV label="Model ID" value={form.values.modelId || '—'} mono />
            </SummaryGroup>
            <SummaryGroup title="Pricing">
              <SummaryKV
                label="Input / 1M"
                value={`${form.values.pricing.inputTokenPer1M} ${form.values.pricing.currency || 'USD'}`}
                mono
              />
              <SummaryKV
                label="Output / 1M"
                value={`${form.values.pricing.outputTokenPer1M} ${form.values.pricing.currency || 'USD'}`}
                mono
              />
            </SummaryGroup>
            {isLlm ? (
              <SummaryGroup title="Attached">
                <SummaryKV label="Guardrails" value={String(attachedGuardrailKeys.length)} />
                <SummaryKV
                  label="Semantic cache"
                  value={form.values.semanticCacheEnabled ? 'on' : <span className="ds-faint">off</span>}
                />
              </SummaryGroup>
            ) : null}
          </>
        }
        primaryAction={{
          label: t('actions.save'),
          icon: <IconDeviceFloppy size={13} />,
          loading: saving,
          disabled: !dirty,
          onClick: () => void form.onSubmit(handleSubmit)(),
        }}
      >
        <GeneralSection
          number={sectionNumber()}
          done={Boolean(form.values.name)}
          nameProps={{
            ...form.getInputProps('name'),
            onChange: (event: { currentTarget: { value: string } }) => {
              form.setFieldValue('name', event.currentTarget.value);
              if (!model.key || form.values.key === slugify(model.name)) {
                form.setFieldValue('key', slugify(event.currentTarget.value));
              }
            },
          }}
          keyProps={{
            value: form.values.key,
            onChange: (event: { currentTarget: { value: string } }) =>
              form.setFieldValue('key', slugify(event.currentTarget.value)),
          }}
          descriptionProps={form.getInputProps('description')}
          namePlaceholder={tWizard('fields.name.placeholder')}
          keyPlaceholder={tWizard('fields.key.placeholder')}
          descriptionPlaceholder={tWizard('fields.description.placeholder')}
        />

        <ProviderSection
          number={sectionNumber()}
          done={Boolean(form.values.providerKey && form.values.modelId)}
          providers={modelProviders}
          providerKey={form.values.providerKey}
          onProviderChange={(key) => form.setFieldValue('providerKey', key)}
          modelIdProps={form.getInputProps('modelId')}
          modelIdPlaceholder={providerDefinition?.modelIdHint || tWizard('fields.modelId.placeholder')}
        />

        <CapabilitiesSection
          number={sectionNumber()}
          toolCalls={{
            label: tWizard('fields.supportsToolCalls.label'),
            description: tWizard('fields.supportsToolCalls.description'),
            checked: form.values.supportsToolCalls,
            onChange: (v) => form.setFieldValue('supportsToolCalls', v),
          }}
          reasoning={{
            label: tWizard('fields.supportsReasoning.label'),
            description: tWizard('fields.supportsReasoning.description'),
            checked: form.values.supportsReasoning,
            onChange: (v) => form.setFieldValue('supportsReasoning', v),
          }}
          structuredOutputs={{
            label: tWizard('fields.supportsStructuredOutputs.label'),
            description: tWizard('fields.supportsStructuredOutputs.description'),
            checked: form.values.supportsStructuredOutputs,
            onChange: (v) => form.setFieldValue('supportsStructuredOutputs', v),
          }}
          modalities={{
            label: tWizard('fields.inputModalities.label'),
            hint: tWizard('fields.inputModalities.description'),
            value: inputModalities,
            inferred: inferredModalities,
            onChange: setInputModalities,
          }}
        />

        <PricingSection
          number={sectionNumber()}
          done={validIdentity}
          description="Per-million-token pricing for accounting and routing decisions."
          modelId={form.values.modelId}
          currencyProps={{
            value: form.values.pricing.currency,
            onChange: (event: { currentTarget: { value: string } }) =>
              form.setFieldValue('pricing.currency', event.currentTarget.value.toUpperCase().slice(0, 8)),
          }}
          inputProps={{ value: form.values.pricing.inputTokenPer1M, onChange: setPrice('pricing.inputTokenPer1M') }}
          outputProps={{ value: form.values.pricing.outputTokenPer1M, onChange: setPrice('pricing.outputTokenPer1M') }}
          cachedProps={{ value: form.values.pricing.cachedTokenPer1M, onChange: setPrice('pricing.cachedTokenPer1M') }}
          onApplyCatalog={(pricing) => {
            form.setFieldValue('pricing.inputTokenPer1M', pricing.inputTokenPer1M);
            form.setFieldValue('pricing.outputTokenPer1M', pricing.outputTokenPer1M);
            form.setFieldValue('pricing.cachedTokenPer1M', pricing.cachedTokenPer1M);
          }}
        />

        <LimitsSection
          number={sectionNumber()}
          contextWindow={{
            label: tWizard('fields.contextWindow.label'),
            hint: tWizard('fields.contextWindow.description'),
            props: form.getInputProps('contextWindow'),
          }}
          maxOutputTokens={{
            label: tWizard('fields.maxOutputTokens.label'),
            hint: tWizard('fields.maxOutputTokens.description'),
            props: form.getInputProps('maxOutputTokens'),
          }}
          maxTokens={{
            label: tWizard('fields.runtimeMaxTokens.label'),
            hint: tWizard('fields.runtimeMaxTokens.description'),
            props: form.getInputProps('settings.maxTokens'),
          }}
        />

        {isLlm ? (
          <ReasoningSection
            number={sectionNumber()}
            driver={selectedProvider?.driver}
            modelId={form.values.modelId ?? undefined}
            settings={form.values.settings}
            focusOnMount={initialSection === 'reasoning'}
            value={reasoningFormFromSettings(form.values.settings)}
            onChange={(patch) => {
              const next = { ...reasoningFormFromSettings(form.values.settings), ...patch };
              const { reasoning, returnReasoning } = reasoningSettingsPatch(next, undefined, form.values.settings);
              const settings = { ...form.values.settings };
              if (reasoning) settings.reasoning = reasoning; else delete settings.reasoning;
              if (returnReasoning === false) settings.returnReasoning = false; else delete settings.returnReasoning;
              form.setFieldValue('settings', settings);
            }}
            forcedNoneWithTools={Boolean(
              detectForcedParams(selectedProvider?.driver, form.values.modelId, true).forced?.reasoning_effort,
            )}
          />
        ) : null}

        {isLlm && supportsUpstreamApiChoice(selectedProvider?.driver) ? (
          <UpstreamApiSection
            number={sectionNumber()}
            value={resolveUpstreamApi(form.values.settings)}
            onChange={(next) => {
              const settings = { ...form.values.settings };
              if (next === 'responses') settings.upstreamApi = 'responses'; else delete settings.upstreamApi;
              form.setFieldValue('settings', settings);
            }}
          />
        ) : null}

        {isLlm ? (
          <RequestParamsSection
            number={sectionNumber()}
            autoDropped={autoDropped}
            autoDrop={{
              checked: form.values.settings.autoDropUnsupportedParams !== false,
              onChange: (checked) => patchSettings({ autoDropUnsupportedParams: checked }),
            }}
            unsupportedProps={{
              value: toStringArray(form.values.settings.unsupportedParams),
              onChange: (value: string[]) => patchSettings({ unsupportedParams: value }),
            }}
            requestDefaultsProps={{
              value: requestDefaultsText,
              onChange: (value: string) => setRequestDefaultsText(value),
              error: validateRequestDefaults(requestDefaultsText),
            }}
            passthrough={{
              checked: Boolean(form.values.settings.allowUnknownPassthrough),
              onChange: (checked) => patchSettings({ allowUnknownPassthrough: checked }),
            }}
          />
        ) : null}

        {isLlm ? (
          <FormSection
            number={sectionNumber()}
            title={t('sections.semanticCache')}
            description={t('semanticCache.description')}
            done={form.values.semanticCacheEnabled}
          >
            <ToggleList>
              <ToggleRow
                label={t('semanticCache.enabled')}
                checked={form.values.semanticCacheEnabled}
                onChange={(v) => form.setFieldValue('semanticCacheEnabled', v)}
              />
            </ToggleList>
            {form.values.semanticCacheEnabled ? (
              <>
                <FormRow cols={2}>
                  <FormField label={t('semanticCache.vectorProviderKey')}>
                    {vectorProviders.length > 0 ? (
                      <Select
                        placeholder={t('semanticCache.vectorProviderKeyPlaceholder')}
                        data={vectorProviders.map((p) => ({ value: p.key, label: p.label }))}
                        value={form.values.semanticCacheVectorProviderKey}
                        onChange={(val) => {
                          form.setFieldValue('semanticCacheVectorProviderKey', val || '');
                          form.setFieldValue('semanticCacheVectorIndexKey', '');
                          if (val) {
                            void loadVectorIndexes(val);
                          } else {
                            setVectorIndexes([]);
                          }
                        }}
                      />
                    ) : (
                      <Text size="sm" c="dimmed">{t('semanticCache.noVectorProviders')}</Text>
                    )}
                  </FormField>
                  <FormField label={t('semanticCache.vectorIndexKey')}>
                    {!form.values.semanticCacheVectorProviderKey ? (
                      <Text size="sm" c="dimmed">—</Text>
                    ) : vectorIndexes.length > 0 ? (
                      <Select
                        placeholder={t('semanticCache.vectorIndexKeyPlaceholder')}
                        data={vectorIndexes.map((idx) => ({ value: idx.key, label: idx.name }))}
                        value={form.values.semanticCacheVectorIndexKey}
                        onChange={(val) => form.setFieldValue('semanticCacheVectorIndexKey', val || '')}
                      />
                    ) : (
                      <Text size="sm" c="dimmed">{t('semanticCache.noVectorIndexes')}</Text>
                    )}
                  </FormField>
                </FormRow>
                <FormRow cols={1}>
                  <FormField label={t('semanticCache.embeddingModelKey')}>
                    {embeddingModels.length > 0 ? (
                      <Select
                        placeholder={t('semanticCache.embeddingModelKeyPlaceholder')}
                        data={embeddingModels.map((m) => ({ value: m.key, label: m.name }))}
                        value={form.values.semanticCacheEmbeddingModelKey}
                        onChange={(val) => form.setFieldValue('semanticCacheEmbeddingModelKey', val || '')}
                      />
                    ) : (
                      <Text size="sm" c="dimmed">{t('semanticCache.noEmbeddingModels')}</Text>
                    )}
                  </FormField>
                </FormRow>
                <FormRow cols={2}>
                  <FormField
                    label={t('semanticCache.similarityThreshold')}
                    hint={t('semanticCache.similarityThresholdDescription')}
                  >
                    <SliderField
                      min={0.5}
                      max={1}
                      step={0.01}
                      value={form.values.semanticCacheSimilarityThreshold}
                      onChange={(val) => form.setFieldValue('semanticCacheSimilarityThreshold', val)}
                      formatValue={(v) => v.toFixed(2)}
                    />
                  </FormField>
                  <FormField label={t('semanticCache.ttlSeconds')} hint={t('semanticCache.ttlSecondsDescription')}>
                    <NumberInput
                      min={0}
                      value={form.values.semanticCacheTtlSeconds}
                      onChange={(val) => form.setFieldValue('semanticCacheTtlSeconds', Number(val) || 0)}
                    />
                  </FormField>
                </FormRow>
              </>
            ) : null}
          </FormSection>
        ) : null}

        {/*
          * Guardrails: the binding LIST is edited by `ModelGuardrailModal`, the
          * same overlay the models list opens, so there is one editor and one
          * place where per-hook warnings are worded. This section only says
          * what is attached and opens it.
          */}
        {isLlm ? (
          <FormSection
            number={sectionNumber()}
            title="Guardrails"
            description="Safety checks on every request: the prompt before the model sees it, the answer before it reaches the caller, and while it streams."
            done={attachedGuardrailKeys.length > 0}
          >
            <Group justify="space-between" align="center" wrap="nowrap">
              <Text size="sm" c="dimmed">
                Each guardrail covers the hooks you tick. Bindings are saved by the overlay, separately from the rest of this form.
              </Text>
              <Button
                variant="light"
                size="xs"
                leftSection={<IconShield size={14} />}
                onClick={() => setGuardrailModalOpen(true)}
                style={{ flexShrink: 0 }}
              >
                {attachedGuardrailKeys.length > 0 ? 'Edit bindings' : 'Attach a guardrail'}
              </Button>
            </Group>
            {attachedGuardrailKeys.length === 0 ? (
              guardrails.length === 0 ? (
                <Text size="sm" c="dimmed">
                  No guardrails defined yet.{' '}
                  <Link href="/dashboard/guardrails" style={{ color: 'var(--mantine-color-teal-6)' }}>
                    Create one first.
                  </Link>
                </Text>
              ) : (
                <Text size="sm" c="dimmed">
                  No guardrails attached — every request to this model passes unchecked.
                </Text>
              )
            ) : (
              <Group gap="xs">
                {attachedGuardrailKeys.map((key) => {
                  const guardrail = guardrails.find((candidate) => candidate.key === key);
                  return (
                    <Badge
                      key={key}
                      variant="light"
                      // A bound key with no guardrail behind it stays visible and
                      // flagged: it was deleted or belongs to another project.
                      color={!guardrail ? 'red' : guardrail.enabled === false ? 'gray' : 'teal'}
                    >
                      {guardrail
                        ? `${guardrail.name}${guardrail.enabled === false ? ' · disabled' : ''}`
                        : `${key} · unknown key`}
                    </Badge>
                  );
                })}
              </Group>
            )}
          </FormSection>
        ) : null}
      </ModelFormLayout>

      {/* Mounted unconditionally so the overlay owns its own load (list-vs-legacy bindings). */}
      <ModelGuardrailModal
        opened={guardrailModalOpen}
        modelId={model._id}
        modelName={model.name}
        initialInputGuardrailKey={model.inputGuardrailKey}
        initialOutputGuardrailKey={model.outputGuardrailKey}
        onClose={() => setGuardrailModalOpen(false)}
        onSaved={(bindings) => {
          // Reflect the save locally: a reload would throw away unsaved fields.
          setModel((current) => (current ? { ...current, guardrails: bindings } : current));
        }}
      />
    </>
  );
}
