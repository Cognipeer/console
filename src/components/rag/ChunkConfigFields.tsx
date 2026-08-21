'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { NumberInput, Select, Slider, TagsInput } from '@mantine/core';
import { ChipPicker, FormField, FormRow, ToggleRow } from '@/components/common/ui/FormShell';
import {
  CHUNK_STRATEGIES,
  CHUNK_STRATEGY_ORDER,
  CONTEXTUAL_HEADER_DEFAULT_CHARS,
  TOKEN_ENCODINGS,
  chunkSizeUnit,
  usesSeparators,
  type ChunkFieldErrors,
  type ChunkFormValues,
} from './ragModuleForm';
import type { RagChunkStrategy } from '@/lib/database';

interface ChatModel {
  key: string;
  name: string;
}

interface ChunkConfigFieldsProps {
  values: ChunkFormValues;
  onChange: (patch: Partial<ChunkFormValues>) => void;
  errors: ChunkFieldErrors;
  /** Shown between the strategy picker and the size fields — the re-index warning. */
  notice?: ReactNode;
}

export default function ChunkConfigFields({
  values,
  onChange,
  errors,
  notice,
}: ChunkConfigFieldsProps) {
  const [chatModels, setChatModels] = useState<ChatModel[]>([]);
  const unit = chunkSizeUnit(values.strategy);

  const loadChatModels = useCallback(async () => {
    try {
      const res = await fetch('/api/models?category=llm', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setChatModels((data.models ?? []).map((m: Record<string, string>) => ({
          key: m.key,
          name: m.name,
        })));
      }
    } catch (err) {
      console.error('Failed to load chat models', err);
    }
  }, []);

  // Only the contextual-header picker needs the chat model list, and most
  // modules never turn it on, so it is fetched on first use rather than on open.
  useEffect(() => {
    if (values.contextualHeaderEnabled && chatModels.length === 0) {
      void loadChatModels();
    }
  }, [values.contextualHeaderEnabled, chatModels.length, loadChatModels]);

  return (
    <>
      <FormField label="Strategy" hint={CHUNK_STRATEGIES[values.strategy].description}>
        <ChipPicker<RagChunkStrategy>
          options={CHUNK_STRATEGY_ORDER.map((strategy) => ({
            value: strategy,
            label: CHUNK_STRATEGIES[strategy].label,
          }))}
          value={values.strategy}
          onChange={(next) => onChange({ strategy: next as RagChunkStrategy })}
        />
      </FormField>

      {notice}

      <FormRow cols={2}>
        <FormField
          label="Chunk size"
          required
          hint={
            values.strategy === 'token'
              ? 'Counted in real tokens of the encoding below, not characters.'
              : 'Counted in characters. Only the token strategy counts real tokens.'
          }
        >
          <NumberInput
            min={50}
            max={100000}
            step={100}
            value={values.chunkSize}
            error={errors.chunkSize}
            onChange={(v) => onChange({ chunkSize: v === '' ? '' : Number(v) })}
          />
        </FormField>
        <FormField
          label="Chunk overlap"
          required
          hint={`Carried into the next chunk, in ${unit}. Must be smaller than the chunk size.`}
        >
          <NumberInput
            min={0}
            max={100000}
            step={50}
            value={values.chunkOverlap}
            error={errors.chunkOverlap}
            onChange={(v) => onChange({ chunkOverlap: v === '' ? '' : Number(v) })}
          />
        </FormField>
      </FormRow>

      {usesSeparators(values.strategy) ? (
        <FormField
          label="Separators"
          hint="Boundary preferences, best first. Use \n for newline, \t for tab."
        >
          <TagsInput
            placeholder="Add separator..."
            value={values.separators}
            onChange={(next) => onChange({ separators: next })}
          />
        </FormField>
      ) : null}

      {values.strategy === 'token' ? (
        <FormField label="Token encoding" hint="The tokenizer chunk size and overlap are measured with.">
          <Select
            data={TOKEN_ENCODINGS}
            allowDeselect={false}
            value={values.encoding}
            onChange={(next) => onChange({ encoding: next ?? 'cl100k_base' })}
          />
        </FormField>
      ) : null}

      {values.strategy === 'semantic' ? (
        <FormField
          label={`Topic-shift threshold — ${values.semanticThreshold.toFixed(2)}`}
          hint="Embedding distance between neighbouring sentences above which a new chunk starts. Higher means fewer, larger chunks."
        >
          <Slider
            min={0.05}
            max={0.95}
            step={0.05}
            marks={[
              { value: 0.05, label: '0.05' },
              { value: 0.35, label: '0.35' },
              { value: 0.95, label: '0.95' },
            ]}
            label={(v) => v.toFixed(2)}
            value={values.semanticThreshold}
            onChange={(v) => onChange({ semanticThreshold: v })}
          />
        </FormField>
      ) : null}

      <FormField
        label="Parent window"
        optional
        hint="Small-to-big retrieval: embed the small chunk, but return this many characters of the original document around it. Leave empty to return the chunk itself."
      >
        <NumberInput
          min={0}
          max={200000}
          step={500}
          placeholder="Off"
          value={values.parentWindowSize}
          error={errors.parentWindowSize}
          onChange={(v) => onChange({ parentWindowSize: v === '' ? '' : Number(v) })}
        />
      </FormField>

      <ToggleRow
        label="Contextual headers"
        description="Prefix every chunk with one model-written sentence situating it in its document. Costs ONE model call PER CHUNK at ingest — a 500-chunk document is 500 calls, every time it is re-indexed."
        checked={values.contextualHeaderEnabled}
        onChange={(checked) => onChange({ contextualHeaderEnabled: checked })}
      />

      {values.contextualHeaderEnabled ? (
        <FormRow cols={2}>
          <FormField label="Header model" optional hint="Falls back to the module's answer model.">
            <Select
              placeholder={chatModels.length === 0 ? 'No chat models found' : 'Use the answer model'}
              data={chatModels.map((m) => ({ value: m.key, label: m.name }))}
              searchable
              clearable
              value={values.contextualHeaderModelKey || null}
              onChange={(next) => onChange({ contextualHeaderModelKey: next ?? '' })}
            />
          </FormField>
          <FormField
            label="Document context"
            optional
            hint={`Characters of the document the model sees while writing each header. Default ${CONTEXTUAL_HEADER_DEFAULT_CHARS.toLocaleString()} — larger means a better header and a bigger bill.`}
          >
            <NumberInput
              min={500}
              max={200000}
              step={1000}
              placeholder={String(CONTEXTUAL_HEADER_DEFAULT_CHARS)}
              value={values.contextualHeaderMaxChars}
              onChange={(v) => onChange({ contextualHeaderMaxChars: v === '' ? '' : Number(v) })}
            />
          </FormField>
        </FormRow>
      ) : null}
    </>
  );
}
