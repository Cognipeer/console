import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, NumberInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconBolt, IconBrain } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import {
  getDefaultModelOutputModalities,
  type ModelInputModality,
} from '@/lib/services/models/modelCapabilities';
import {
  inferredInputModalities,
  inputModalitiesPayload,
  isMultimodalFor,
  shownInputModalities,
} from '@/components/models/inputModalities';
import {
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
import ModelFormLayout from './ModelFormLayout';
import {
  CapabilitiesSection,
  GeneralSection,
  LimitsSection,
  PricingSection,
  ProviderSection,
  ReasoningSection,
  RequestParamsSection,
} from './modelFormSections';
import {
  detectUnsupportedParams,
  parseRequestDefaults,
  validateRequestDefaults,
} from '@/components/models/requestParams';
import { EMPTY_REASONING_FORM, reasoningSettingsPatch, type ReasoningFormValue } from '@/components/models/reasoningForm';
import { detectUnsupportedParams as detectForcedParams } from '@/lib/providers/unsupportedParams';
import type { ModelProviderView } from '@/lib/services/models/types';
import type { IModel } from '@/lib/database';

const DEFAULT_PRICING = {
  currency: 'USD',
  inputTokenPer1M: 0,
  outputTokenPer1M: 0,
  cachedTokenPer1M: 0,
};

const CAPABILITY_KEYS = {
  categories: 'model.categories',
  toolCalls: 'model.supports.tool_calls',
} as const;

type ModelCategory = 'llm' | 'embedding' | 'rerank' | 'stt' | 'tts' | 'ocr' | 'image' | 'moderation' | 'decision';

const ALL_CATEGORIES: ReadonlyArray<{ value: ModelCategory; label: string }> = [
  { value: 'llm', label: 'LLM' },
  { value: 'embedding', label: 'Embedding' },
  { value: 'rerank', label: 'Rerank' },
  { value: 'stt', label: 'Speech-to-Text' },
  { value: 'tts', label: 'Text-to-Speech' },
  { value: 'ocr', label: 'OCR' },
  { value: 'image', label: 'Image Generation' },
  { value: 'moderation', label: 'Moderation' },
  { value: 'decision', label: 'Decision' },
];

/**
 * Categories whose models are addressed by tokens in and tokens out, and are
 * therefore the only ones the capability block below describes. A TTS voice has
 * no context window; an embedding model calls no tools. Showing those controls
 * for every category was asking an operator to answer questions that have no
 * answer, and storing whatever they picked.
 */
const CAPABILITY_CATEGORIES: ReadonlyArray<ModelCategory> = ['llm'];

type OcrMode = 'native' | 'vlm';
type DecisionMode = 'structured' | 'native';

type CreateModelModalProps = {
  opened: boolean;
  onClose: () => void;
  providers: ModelProviderView[];
  /** Pre-selects this category when the modal opens (e.g. from a type-filtered list). */
  defaultCategory?: ModelCategory;
  onCreated: (options: { model: IModel; provider: ModelProviderView }) => void;
  /** Opens the "Add provider" flow when no provider is available for this project. */
  onAddProvider?: () => void;
};

interface FormValues {
  providerKey: string;
  name: string;
  key: string;
  description: string;
  category: ModelCategory;
  modelId: string;
  /** An explicit choice of what the model can be sent; null = detected from the model id. */
  inputModalities: ModelInputModality[] | null;
  supportsToolCalls: boolean;
  capabilities: {
    contextWindow: number | '';
    maxOutputTokens: number | '';
    supportsReasoning: boolean;
    supportsStructuredOutputs: boolean;
  };
  pricing: {
    currency: string;
    inputTokenPer1M: number | '';
    outputTokenPer1M: number | '';
    cachedTokenPer1M: number | '';
    inputSecondPer1K: number | '';
    inputCharacterPer1M: number | '';
    pagePer1K: number | '';
    imagePer1K: number | '';
  };
  reasoning: ReasoningFormValue;
  settings: {
    temperature: number | '';
    maxTokens: number | '';
    unsupportedParams: string[];
    autoDropUnsupportedParams: boolean;
    requestDefaults: string;
    allowUnknownPassthrough: boolean;
  };
  ocr: {
    mode: OcrMode;
    prompt: string;
  };
  decision: {
    mode: DecisionMode;
    supportsImage: boolean;
  };
}

function toNumber(value: number | '' | undefined): number | undefined {
  if (value === '' || value === undefined) return undefined;
  if (Number.isNaN(value)) return undefined;
  return value;
}

function resolveProviderCategories(provider?: ModelProviderView): ModelCategory[] {
  const raw = provider?.driverCapabilities?.[CAPABILITY_KEYS.categories];
  if (!Array.isArray(raw)) return ['llm', 'embedding'];
  return raw.filter((item): item is ModelCategory =>
    ALL_CATEGORIES.some((c) => c.value === item),
  );
}

function resolveOcrModes(provider?: ModelProviderView): OcrMode[] {
  const raw = provider?.driverCapabilities?.['ocr.modes'];
  if (Array.isArray(raw)) {
    const modes = raw.filter((m): m is OcrMode => m === 'native' || m === 'vlm');
    if (modes.length > 0) return modes;
  }
  return ['vlm'];
}

function providerSupportsToolCalls(provider?: ModelProviderView) {
  return Boolean(provider?.driverCapabilities?.[CAPABILITY_KEYS.toolCalls]);
}

const isLlmCategory = (category: ModelCategory) => CAPABILITY_CATEGORIES.includes(category);
const definedOnly = (patch: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));

export default function CreateModelModal({
  opened,
  onClose,
  providers,
  defaultCategory,
  onCreated,
  onAddProvider,
}: CreateModelModalProps) {
  const tWizard = useTranslations('modelWizard');
  const [availableProviders, setAvailableProviders] =
    useState<ModelProviderView[]>(providers);
  const [submitting, setSubmitting] = useState(false);
  const wasOpenedRef = useRef(false);

  const form = useForm<FormValues>({
    initialValues: {
      providerKey: providers[0]?.key ?? '',
      name: '',
      key: '',
      description: '',
      category: 'llm',
      modelId: '',
      inputModalities: null,
      // Capabilities default ON: nearly every current chat model does all of
      // this, and an operator who knows their model does not is one toggle away
      // from saying so. Defaulting them off had the opposite failure mode —
      // a model quietly advertised as unable to call tools.
      supportsToolCalls: true,
      capabilities: {
        contextWindow: '',
        maxOutputTokens: '',
        supportsReasoning: true,
        supportsStructuredOutputs: true,
      },
      pricing: {
        currency: DEFAULT_PRICING.currency,
        inputTokenPer1M: DEFAULT_PRICING.inputTokenPer1M,
        outputTokenPer1M: DEFAULT_PRICING.outputTokenPer1M,
        cachedTokenPer1M: DEFAULT_PRICING.cachedTokenPer1M,
        inputSecondPer1K: '',
        inputCharacterPer1M: '',
        pagePer1K: '',
        imagePer1K: '',
      },
      reasoning: { ...EMPTY_REASONING_FORM },
      settings: {
        temperature: '',
        maxTokens: '',
        unsupportedParams: [],
        autoDropUnsupportedParams: true,
        requestDefaults: '',
        allowUnknownPassthrough: false,
      },
      ocr: {
        mode: 'vlm',
        prompt: '',
      },
      decision: {
        mode: 'structured' as DecisionMode,
        supportsImage: false,
      },
    },
    validate: {
      settings: {
        requestDefaults: validateRequestDefaults,
      },
      providerKey: (value) => (!value ? 'Select a provider' : null),
      name: (value) => (!value ? 'Name is required' : null),
      modelId: (value) => (!value ? 'Model ID is required' : null),
      pricing: {
        inputTokenPer1M: (value: number | '') =>
          value === '' || value < 0 ? 'Must be a non-negative number' : null,
        outputTokenPer1M: (value: number | '') =>
          value === '' || value < 0 ? 'Must be a non-negative number' : null,
        cachedTokenPer1M: (value: number | '') =>
          value === '' || value < 0 ? 'Must be a non-negative number' : null,
      },
    },
  });

  const { values: formValues, setFieldValue, reset } = form;

  useEffect(() => {
    setAvailableProviders(providers);
    if (providers.length === 0) return;
    const currentKey = form.getValues().providerKey;
    const hasCurrentProvider = providers.some(
      (provider) => provider.key === currentKey,
    );
    if (!currentKey || !hasCurrentProvider) {
      setFieldValue('providerKey', providers[0].key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers]);

  useEffect(() => {
    if (!opened) {
      if (wasOpenedRef.current) {
        reset();
        const firstKey = providers[0]?.key ?? '';
        if (firstKey) setFieldValue('providerKey', firstKey);
        wasOpenedRef.current = false;
      }
    } else {
      wasOpenedRef.current = true;
      // Honour the category the user was filtering by, when the provider supports it.
      if (defaultCategory) {
        setFieldValue('category', defaultCategory);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, providers]);

  const selectedProvider = useMemo(
    () =>
      availableProviders.find((provider) => provider.key === formValues.providerKey),
    [availableProviders, formValues.providerKey],
  );

  // What the model id is known to accept. Every driver can be told that a model
  // takes images — a driver's own "multimodal" capability describes what the
  // driver itself can discover, not what the operator's model can read — so the
  // boxes are never limited by the provider.
  const inferredModalities = useMemo(
    () => inferredInputModalities(formValues.category, formValues.modelId),
    [formValues.category, formValues.modelId],
  );
  const effectiveModalities = shownInputModalities(formValues.inputModalities, inferredModalities);

  // Same registry the gateway consults at call time, so the form shows exactly
  // what will be dropped rather than a description of it.
  const autoDropped = useMemo(
    () => (formValues.settings.autoDropUnsupportedParams
      ? detectUnsupportedParams(selectedProvider?.driver, formValues.modelId)
      : { params: [] as string[], reason: undefined as string | undefined }),
    [selectedProvider?.driver, formValues.modelId, formValues.settings.autoDropUnsupportedParams],
  );

  const allowedCategories = useMemo(
    () => resolveProviderCategories(selectedProvider),
    [selectedProvider],
  );

  const allowedOcrModes = useMemo(
    () => resolveOcrModes(selectedProvider),
    [selectedProvider],
  );

  // Structured needs a chat model on the provider; native needs the provider's own
  // decision endpoint (decision.native). A provider can offer either or both.
  const allowedDecisionModes = useMemo((): DecisionMode[] => {
    const modes: DecisionMode[] = [];
    if (resolveProviderCategories(selectedProvider).includes('llm')) modes.push('structured');
    if (selectedProvider?.driverCapabilities?.['decision.native'] === true) modes.push('native');
    return modes.length > 0 ? modes : ['structured'];
  }, [selectedProvider]);

  useEffect(() => {
    if (formValues.category !== 'decision') return;
    if (!allowedDecisionModes.includes(formValues.decision.mode)) {
      setFieldValue('decision.mode', allowedDecisionModes[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedDecisionModes, formValues.category]);

  useEffect(() => {
    if (formValues.category !== 'ocr') return;
    if (!allowedOcrModes.includes(formValues.ocr.mode)) {
      setFieldValue('ocr.mode', allowedOcrModes[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedOcrModes, formValues.category]);

  useEffect(() => {
    if (!selectedProvider) return;

    const categories = resolveProviderCategories(selectedProvider);
    if (categories.length && !categories.includes(formValues.category)) {
      setFieldValue('category', categories[0]);
    }

    // Clamp DOWN only. This effect used to depend on the toggle values
    // themselves and re-assert the provider's capability whenever they
    // differed, so unchecking "Supports tool calls" snapped straight back and
    // the control was unusable. A provider that cannot do something still wins
    // — that is not the operator's call — but within what it can do, the
    // operator's choice stands.
    if (!providerSupportsToolCalls(selectedProvider)) {
      setFieldValue('supportsToolCalls', false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProvider, formValues.category]);

  const validProvider = Boolean(formValues.providerKey);
  const validIdentity = Boolean(formValues.name && formValues.modelId);
  const validPricing =
    formValues.pricing.inputTokenPer1M !== '' &&
    formValues.pricing.outputTokenPer1M !== '';

  const checklist = [
    { id: 1, label: 'Provider selected', done: validProvider },
    { id: 2, label: 'Display name and Model ID set', done: validIdentity },
    { id: 3, label: 'Pricing configured', done: validPricing },
    {
      id: 4,
      label: 'Category chosen',
      done: Boolean(formValues.category),
    },
  ];

  const submit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;
    const values = form.getValues();
    const contextWindow = toNumber(values.capabilities.contextWindow);
    const maxOutputTokens = toNumber(values.capabilities.maxOutputTokens);
    if (
      contextWindow !== undefined
      && maxOutputTokens !== undefined
      && maxOutputTokens > contextWindow
    ) {
      notifications.show({
        color: 'red',
        title: tWizard('notifications.errorTitle'),
        message: tWizard('validation.maxOutputTokens'),
      });
      return;
    }

    const provider = availableProviders.find(
      (item) => item.key === values.providerKey,
    );
    if (!provider) {
      notifications.show({
        color: 'red',
        title: 'Provider not found',
        message: 'Select a valid provider before creating a model.',
      });
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerKey: values.providerKey,
          name: values.name,
          key: values.key,
          description: values.description,
          category: values.category,
          modelId: values.modelId,
          isMultimodal: CAPABILITY_CATEGORIES.includes(values.category)
            ? isMultimodalFor(effectiveModalities)
            : false,
          supportsToolCalls: values.supportsToolCalls,
          capabilities: {
            ...(contextWindow !== undefined ? { contextWindow } : {}),
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
            // Only a choice someone made is stored; otherwise the model id decides.
            ...(CAPABILITY_CATEGORIES.includes(values.category) ? inputModalitiesPayload(values.inputModalities) : {}),
            outputModalities: getDefaultModelOutputModalities(values.category),
            supportsReasoning: values.capabilities.supportsReasoning,
            supportsStructuredOutputs: values.capabilities.supportsStructuredOutputs,
            supportsToolCalls: values.supportsToolCalls,
          },
          pricing: {
            currency: values.pricing.currency || DEFAULT_PRICING.currency,
            inputTokenPer1M: Number(values.pricing.inputTokenPer1M ?? 0),
            outputTokenPer1M: Number(values.pricing.outputTokenPer1M ?? 0),
            cachedTokenPer1M: Number(values.pricing.cachedTokenPer1M ?? 0),
            ...(toNumber(values.pricing.inputSecondPer1K) !== undefined
              ? { inputSecondPer1K: toNumber(values.pricing.inputSecondPer1K) }
              : {}),
            ...(toNumber(values.pricing.inputCharacterPer1M) !== undefined
              ? { inputCharacterPer1M: toNumber(values.pricing.inputCharacterPer1M) }
              : {}),
            ...(toNumber(values.pricing.pagePer1K) !== undefined
              ? { pagePer1K: toNumber(values.pricing.pagePer1K) }
              : {}),
            ...(toNumber(values.pricing.imagePer1K) !== undefined
              ? { imagePer1K: toNumber(values.pricing.imagePer1K) }
              : {}),
          },
          settings: {
            ...(toNumber(values.settings.temperature) !== undefined
              ? { temperature: toNumber(values.settings.temperature) }
              : {}),
            ...(toNumber(values.settings.maxTokens) !== undefined
              ? { maxTokens: toNumber(values.settings.maxTokens) }
              : {}),
            ...(values.settings.unsupportedParams.length
              ? { unsupportedParams: values.settings.unsupportedParams }
              : {}),
            // Only persisted when switched off — detection is the default.
            ...(values.settings.autoDropUnsupportedParams === false
              ? { autoDropUnsupportedParams: false }
              : {}),
            ...(parseRequestDefaults(values.settings.requestDefaults)
              ? { requestDefaults: parseRequestDefaults(values.settings.requestDefaults) }
              : {}),
            ...(values.settings.allowUnknownPassthrough
              ? { allowUnknownPassthrough: true }
              : {}),
            ...(isLlmCategory(values.category) ? definedOnly(reasoningSettingsPatch(values.reasoning, undefined)) : {}),
            // P1 decision models are always served by the structured-output emulator
            // over the chat model named below; `native` is reserved for later phases.
            ...(values.category === 'decision'
              ? { decision: { mode: values.decision.mode, supports: { image: values.decision.supportsImage } } }
              : {}),
            ...(values.category === 'ocr'
              ? {
                  ocr: {
                    mode: values.ocr.mode,
                    ...(values.ocr.prompt.trim()
                      ? { prompt: values.ocr.prompt.trim() }
                      : {}),
                  },
                }
              : {}),
          },
        }),
      });

      if (!response.ok) {
        const error = await response
          .json()
          .catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to create model');
      }

      const data = await response.json();
      notifications.show({
        color: 'green',
        title: 'Model created',
        message: `${values.name} is ready to use.`,
      });
      onCreated({ model: data.model, provider });
      onClose();
      reset();
    } catch (error: unknown) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to create model',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const summary = (
    <>
      <SummaryGroup title="Provider">
        {selectedProvider ? (
          <>
            <SummaryKV label="Name" value={selectedProvider.label} />
            <SummaryKV label="Driver" value={selectedProvider.driver} mono />
            <SummaryKV label="Status" value={selectedProvider.status} />
          </>
        ) : (
          <SummaryKV label="—" value="Select a provider" />
        )}
      </SummaryGroup>

      <SummaryGroup title="Model">
        <SummaryKV
          label="Display name"
          value={formValues.name || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label="Model ID"
          value={formValues.modelId || <span className="ds-faint">—</span>}
          mono
        />
        <SummaryKV label="Category" value={formValues.category} />
        <SummaryKV
          label="Capabilities"
          value={
            [
              formValues.supportsToolCalls ? tWizard('review.capabilityTags.tools') : null,
              CAPABILITY_CATEGORIES.includes(formValues.category) && effectiveModalities.includes('image') ? tWizard('review.capabilityTags.vision') : null,
              formValues.capabilities.supportsReasoning
                ? tWizard('review.capabilityTags.reasoning')
                : null,
              formValues.capabilities.supportsStructuredOutputs
                ? tWizard('review.capabilityTags.structuredOutput')
                : null,
            ]
              .filter(Boolean)
              .join(' · ') || '—'
          }
        />
      </SummaryGroup>

      <SummaryGroup title="Pricing">
        <SummaryKV
          label="Input / 1M"
          value={`${formValues.pricing.inputTokenPer1M || 0} ${formValues.pricing.currency || 'USD'}`}
          mono
        />
        <SummaryKV
          label="Output / 1M"
          value={`${formValues.pricing.outputTokenPer1M || 0} ${formValues.pricing.currency || 'USD'}`}
          mono
        />
        {formValues.pricing.cachedTokenPer1M ? (
          <SummaryKV
            label="Cached / 1M"
            value={`${formValues.pricing.cachedTokenPer1M} ${formValues.pricing.currency || 'USD'}`}
            mono
          />
        ) : null}
      </SummaryGroup>

      <SummaryGroup title="Pre-flight">
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  const noProviders = availableProviders.length === 0;
  const dirty = opened && Boolean(formValues.name || formValues.key || formValues.modelId);
  const canSubmit = !noProviders && validProvider && validIdentity && validPricing;
  const isLlm = CAPABILITY_CATEGORIES.includes(formValues.category);
  let sectionCounter = 0;
  const sectionNumber = () => ++sectionCounter;

  return (
    <ModelFormLayout
      open={opened}
      dirty={dirty}
      onClose={onClose}
      icon={<IconBrain size={16} />}
      title="Deploy model"
      subtitle="Add a new inference endpoint backed by a configured provider."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: 'Create model',
        icon: <IconBolt size={13} />,
        loading: submitting,
        disabled: !canSubmit,
        onClick: submit,
      }}
    >
      <GeneralSection<ModelCategory>
        number={sectionNumber()}
        done={validIdentity}
        nameProps={form.getInputProps('name')}
        keyProps={form.getInputProps('key')}
        keyHint="Leave blank to generate from the display name."
        descriptionProps={form.getInputProps('description')}
        category={{
          options: ALL_CATEGORIES.filter((opt) => allowedCategories.includes(opt.value)),
          value: formValues.category,
          onChange: (v) => setFieldValue('category', v),
        }}
      />

      <ProviderSection
        number={sectionNumber()}
        done={validProvider && Boolean(formValues.modelId)}
        providers={availableProviders.map((p) => ({
          key: p.key,
          label: p.label,
          status: p.status,
          driver: p.driver,
          description: p.description,
        }))}
        providerKey={formValues.providerKey}
        onProviderChange={(key) => setFieldValue('providerKey', key)}
        modelIdProps={form.getInputProps('modelId')}
        emptyState={
          <div className="ds-card ds-card-pad" style={{ background: 'var(--ds-surface-1)' }}>
            <span className="ds-muted" style={{ fontSize: 13 }}>
              No model providers are available in this project yet. Add one for
              this project, or assign an existing tenant provider to it from the
              project&apos;s Providers tab.
            </span>
            {onAddProvider ? (
              <div style={{ marginTop: 12 }}>
                <Button
                  size="xs"
                  color="teal"
                  onClick={() => {
                    onClose();
                    onAddProvider();
                  }}
                >
                  Add provider
                </Button>
              </div>
            ) : null}
          </div>
        }
      />

      {isLlm && (
        <CapabilitiesSection
          number={sectionNumber()}
          toolCalls={{
            label: 'Supports tool calls',
            description: 'Allow the model to invoke registered tools via function calling.',
            checked: formValues.supportsToolCalls,
            disabled: !providerSupportsToolCalls(selectedProvider),
            onChange: (v) => setFieldValue('supportsToolCalls', v),
          }}
          reasoning={{
            label: tWizard('fields.supportsReasoning.label'),
            description: tWizard('fields.supportsReasoning.description'),
            checked: formValues.capabilities.supportsReasoning,
            onChange: (v) => setFieldValue('capabilities.supportsReasoning', v),
          }}
          structuredOutputs={{
            label: tWizard('fields.supportsStructuredOutputs.label'),
            description: tWizard('fields.supportsStructuredOutputs.description'),
            checked: formValues.capabilities.supportsStructuredOutputs,
            onChange: (v) => setFieldValue('capabilities.supportsStructuredOutputs', v),
          }}
          modalities={{
            label: tWizard('fields.inputModalities.label'),
            hint: tWizard('fields.inputModalities.description'),
            value: formValues.inputModalities,
            inferred: inferredModalities,
            onChange: (next) => setFieldValue('inputModalities', next),
          }}
        />
      )}

      {formValues.category === 'ocr' && (
        <FormSection
          number={sectionNumber()}
          title="OCR mode"
          description="Choose between a dedicated OCR provider (native) or a vision-capable chat model (VLM)."
          done={Boolean(formValues.ocr.mode)}
        >
          <FormRow cols={1}>
            <FormField label="Invocation mode">
              <ChipPicker<OcrMode>
                options={(
                  [
                    { value: 'native' as const, label: 'Native OCR' },
                    { value: 'vlm' as const, label: 'Vision LLM' },
                  ] satisfies Array<{ value: OcrMode; label: string }>
                ).filter((opt) => allowedOcrModes.includes(opt.value))}
                value={formValues.ocr.mode}
                onChange={(v) => setFieldValue('ocr.mode', v as OcrMode)}
              />
            </FormField>
          </FormRow>
          {formValues.ocr.mode === 'vlm' && (
            <FormRow cols={1}>
              <FormField
                label="Extraction prompt"
                optional
                hint="Override the default OCR prompt sent to the VLM."
              >
                <Textarea
                  autosize
                  minRows={3}
                  placeholder="Leave blank to use the default OCR prompt."
                  {...form.getInputProps('ocr.prompt')}
                />
              </FormField>
            </FormRow>
          )}
        </FormSection>
      )}

      {formValues.category === 'decision' && (
        <FormSection
          number={sectionNumber()}
          title={tWizard('decision.title')}
          description={tWizard('decision.description')}
          done
        >
          <FormRow cols={1}>
            <FormField label={tWizard('decision.mode.label')}>
              <ChipPicker<DecisionMode>
                options={(
                  [
                    { value: 'structured' as const, label: tWizard('decision.mode.structured') },
                    { value: 'native' as const, label: tWizard('decision.mode.native') },
                  ] satisfies Array<{ value: DecisionMode; label: string }>
                ).filter((opt) => allowedDecisionModes.includes(opt.value))}
                value={formValues.decision.mode}
                onChange={(v) => setFieldValue('decision.mode', v as DecisionMode)}
              />
            </FormField>
          </FormRow>
          <ToggleList>
            <ToggleRow
              label={tWizard('decision.acceptsImage.label')}
              description={tWizard('decision.acceptsImage.description')}
              checked={formValues.decision.supportsImage}
              onChange={(v) => setFieldValue('decision.supportsImage', v)}
            />
          </ToggleList>
        </FormSection>
      )}

      <PricingSection
        number={sectionNumber()}
        done={validPricing}
        description={
          formValues.category === 'stt'
            ? 'Per-1000-second pricing for transcription input.'
            : formValues.category === 'tts'
              ? 'Per-1,000,000-character pricing for synthesized speech input.'
              : formValues.category === 'ocr'
                ? 'Per-1000-page pricing for OCR. Token fields apply when the VLM mode is used.'
                : formValues.category === 'image'
                  ? 'Per-1000-image pricing. Token fields apply to the models that also bill the prompt.'
                  : 'Per-million-token pricing for accounting and routing decisions.'
        }
        modelId={formValues.modelId}
        currencyProps={form.getInputProps('pricing.currency')}
        inputProps={form.getInputProps('pricing.inputTokenPer1M')}
        outputProps={form.getInputProps('pricing.outputTokenPer1M')}
        cachedProps={form.getInputProps('pricing.cachedTokenPer1M')}
        onApplyCatalog={(pricing) => {
          setFieldValue('pricing.inputTokenPer1M', pricing.inputTokenPer1M);
          setFieldValue('pricing.outputTokenPer1M', pricing.outputTokenPer1M);
          setFieldValue('pricing.cachedTokenPer1M', pricing.cachedTokenPer1M);
        }}
      >
        {formValues.category === 'stt' && (
          <FormRow cols={2}>
            <FormField label="Audio input · per 1K seconds" optional>
              <NumberInput
                min={0}
                decimalScale={4}
                placeholder="e.g., 6.00"
                {...form.getInputProps('pricing.inputSecondPer1K')}
              />
            </FormField>
            <FormField label=" " optional>
              <span />
            </FormField>
          </FormRow>
        )}
        {formValues.category === 'tts' && (
          <FormRow cols={2}>
            <FormField label="Input · per 1M characters" optional>
              <NumberInput
                min={0}
                decimalScale={4}
                placeholder="e.g., 15.00"
                {...form.getInputProps('pricing.inputCharacterPer1M')}
              />
            </FormField>
            <FormField label=" " optional>
              <span />
            </FormField>
          </FormRow>
        )}
        {formValues.category === 'image' && (
          <FormRow cols={2}>
            <FormField label="Images · per 1K" optional>
              <NumberInput
                min={0}
                decimalScale={4}
                placeholder="e.g., 40.00"
                {...form.getInputProps('pricing.imagePer1K')}
              />
            </FormField>
            <FormField label=" " optional>
              <span />
            </FormField>
          </FormRow>
        )}
        {formValues.category === 'ocr' && (
          <FormRow cols={2}>
            <FormField label="Pages · per 1K" optional>
              <NumberInput
                min={0}
                decimalScale={4}
                placeholder="e.g., 1.50"
                {...form.getInputProps('pricing.pagePer1K')}
              />
            </FormField>
            <FormField label=" " optional>
              <span />
            </FormField>
          </FormRow>
        )}
      </PricingSection>

      <LimitsSection
        number={sectionNumber()}
        contextWindow={
          isLlm
            ? {
                label: tWizard('fields.contextWindow.label'),
                hint: tWizard('fields.contextWindow.description'),
                placeholder: tWizard('fields.contextWindow.placeholder'),
                props: form.getInputProps('capabilities.contextWindow'),
              }
            : undefined
        }
        maxOutputTokens={
          isLlm
            ? {
                label: tWizard('fields.maxOutputTokens.label'),
                hint: tWizard('fields.maxOutputTokens.description'),
                placeholder: tWizard('fields.maxOutputTokens.placeholder'),
                props: form.getInputProps('capabilities.maxOutputTokens'),
              }
            : undefined
        }
        maxTokens={{ props: form.getInputProps('settings.maxTokens') }}
        temperatureProps={form.getInputProps('settings.temperature')}
      />

      {isLlm ? (
        <ReasoningSection
          number={sectionNumber()}
          driver={selectedProvider?.driver}
          value={formValues.reasoning}
          onChange={(patch) => setFieldValue('reasoning', { ...formValues.reasoning, ...patch })}
          forcedNoneWithTools={Boolean(
            detectForcedParams(selectedProvider?.driver, formValues.modelId, true).forced?.reasoning_effort,
          )}
        />
      ) : null}

      <RequestParamsSection
        number={sectionNumber()}
        autoDropped={autoDropped}
        autoDrop={{
          checked: formValues.settings.autoDropUnsupportedParams,
          onChange: (checked) => setFieldValue('settings.autoDropUnsupportedParams', checked),
        }}
        unsupportedProps={form.getInputProps('settings.unsupportedParams')}
        requestDefaultsProps={form.getInputProps('settings.requestDefaults')}
        passthrough={{
          checked: formValues.settings.allowUnknownPassthrough,
          onChange: (checked) => setFieldValue('settings.allowUnknownPassthrough', checked),
        }}
      />
    </ModelFormLayout>
  );
}
