'use client';

import { useId } from 'react';
import { NumberInput, Select, SegmentedControl, Stack, Switch, TagsInput, Text } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import {
  cleanLanguages,
  DEFAULT_OCR_LANGUAGES,
  invalidLanguages,
  missingOcrModel,
  ocrIsOn,
  ocrModeOf,
  patchOcr,
  type OcrMode,
  type OcrModelOptions,
  type OcrSettings,
} from './ocrForm';
import { englishOcrText } from './ocrEnglish';
import { useOcrModelOptions } from './useOcrModelOptions';

/** The select cannot hold an empty value, so the local engine is this one. */
const LOCAL_ENGINE = '__local__';

export interface OcrSettingsFieldsProps {
  /** `undefined` / `null` / `mode: 'off'` all show as Off. */
  value: OcrSettings | null | undefined;
  /** Off arrives as `undefined`: a consumer that must clear a stored value sends `null` itself. */
  onChange: (next: OcrSettings | undefined) => void;
  /** Offer "Also read images" (Word / PowerPoint pictures and image files). */
  showImages?: boolean;
  disabled?: boolean;
  /** The models, when the host already loaded them (or a test supplies them); otherwise the fields load their own. */
  models?: OcrModelOptions;
  /** Shown under the model picker instead of the check against the loaded models (a save that was refused). */
  modelError?: string;
  /** Always English: for the pages written in literal English (Knowledge Engine, Crawler). */
  english?: boolean;
}

/**
 * The OCR setting every consumer edits the same way: mode (off / scanned pages / every page), engine (the project's
 * OCR and vision models, or the local CPU engine), languages, a page cap and, where it makes sense, "also read
 * images". Only the mode shows while OCR is off.
 */
export default function OcrSettingsFields({ value, onChange, showImages = false, disabled = false, models, modelError, english = false }: OcrSettingsFieldsProps) {
  const translated = useTranslations('ocrSettings');
  const t = english ? englishOcrText : translated;
  const labelId = useId();
  const mode = ocrModeOf(value);
  const on = ocrIsOn(value);
  const ownModels = useOcrModelOptions(on && models === undefined);
  const options = models ?? ownModels;

  const set = (patch: Partial<OcrSettings>) => onChange(patchOcr(value, patch));
  const languages = on ? value.languages : undefined;
  const badLanguages = invalidLanguages(languages);
  const missing = missingOcrModel(value, options);
  const modelProblem = modelError ?? (missing ? t('engine.missing', { key: missing }) : undefined);

  const engineData = [
    { group: t('engine.local'), items: [{ value: LOCAL_ENGINE, label: t('engine.local') }] },
    ...(options.ocr.length > 0 ? [{ group: t('engine.groupOcr'), items: options.ocr }] : []),
    ...(options.vision.length > 0 ? [{ group: t('engine.groupVision'), items: options.vision }] : []),
  ];
  // A model that is chosen but no longer listed stays visible, with the error beside it.
  if (on && value.modelKey && !engineData.some((g) => g.items.some((item) => item.value === value.modelKey))) {
    engineData.push({ group: t('engine.label'), items: [{ value: value.modelKey, label: value.modelKey }] });
  }

  return (
    <Stack gap="sm">
      <div>
        <Text size="sm" fw={500} id={labelId}>{t('mode.label')}</Text>
        <Text size="xs" c="dimmed" mb={6}>{t('mode.hint')}</Text>
        <SegmentedControl
          size="xs"
          fullWidth
          // A narrow column (the crawler's settings) cannot hold the three labels on one line: they wrap there
          // instead of pushing the last one out of sight.
          styles={{ label: { whiteSpace: 'normal' } }}
          aria-labelledby={labelId}
          disabled={disabled}
          value={mode}
          onChange={(next) => {
            const nextMode = next as OcrMode;
            if (nextMode === 'off') onChange(undefined);
            else set({ mode: nextMode });
          }}
          data={[
            { value: 'off', label: t('mode.off') },
            { value: 'auto', label: t('mode.auto') },
            { value: 'always', label: t('mode.always') },
          ]}
        />
        {on ? <Text size="xs" c="dimmed" mt={6}>{mode === 'always' ? t('mode.alwaysHint') : t('mode.autoHint')}</Text> : null}
      </div>

      {on ? (
        <>
          <Select
            label={t('engine.label')}
            description={t('engine.hint')}
            placeholder={options.loading ? t('engine.loading') : t('engine.placeholder')}
            disabled={disabled}
            allowDeselect={false}
            searchable
            data={engineData}
            value={value.modelKey ?? LOCAL_ENGINE}
            onChange={(next) => set({ modelKey: !next || next === LOCAL_ENGINE ? undefined : next })}
            error={modelProblem}
          />
          {options.failed && !modelProblem ? <Text size="xs" c="orange">{t('engine.failed')}</Text> : null}

          <TagsInput
            label={t('languages.label')}
            description={t('languages.hint')}
            placeholder={t('languages.placeholder')}
            disabled={disabled}
            value={languages && languages.length > 0 ? languages : [...DEFAULT_OCR_LANGUAGES]}
            onChange={(next) => {
              const cleaned = cleanLanguages(next);
              // The default pair is not stored: leaving it as it is keeps the setting short and follows a changed default.
              const isDefault = cleaned.length === DEFAULT_OCR_LANGUAGES.length && cleaned.every((code, i) => code === DEFAULT_OCR_LANGUAGES[i]);
              set({ languages: cleaned.length === 0 || isDefault ? undefined : cleaned });
            }}
            error={badLanguages.length > 0 ? t('languages.invalid', { codes: badLanguages.join(', ') }) : undefined}
          />

          <NumberInput
            label={t('maxPages.label')}
            description={t('maxPages.hint')}
            placeholder={t('maxPages.placeholder')}
            disabled={disabled}
            min={1}
            allowDecimal={false}
            allowNegative={false}
            value={value.maxPages ?? ''}
            onChange={(next) => set({ maxPages: typeof next === 'number' && next > 0 ? next : undefined })}
          />

          {showImages ? (
            <Switch
              label={t('images.label')}
              description={t('images.hint')}
              disabled={disabled}
              checked={value.images === true}
              onChange={(event) => set({ images: event.currentTarget.checked ? true : undefined })}
            />
          ) : null}
        </>
      ) : null}
    </Stack>
  );
}
