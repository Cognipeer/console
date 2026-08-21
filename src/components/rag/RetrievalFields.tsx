'use client';

import { NumberInput, Slider } from '@mantine/core';
import { ChipPicker, FormField, FormRow, ToggleRow } from '@/components/common/ui/FormShell';
import type { HybridMode, RetrievalFormValues } from './ragModuleForm';

interface RetrievalFieldsProps {
  values: RetrievalFormValues;
  onChange: (patch: Partial<RetrievalFormValues>) => void;
  /** False when the module's vector provider has no keyword index to combine with. */
  hybridSupported: boolean;
  /** Provider label used in the "why is this disabled" line. */
  providerLabel?: string;
}

export default function RetrievalFields({
  values,
  onChange,
  hybridSupported,
  providerLabel,
}: RetrievalFieldsProps) {
  return (
    <>
      <ToggleRow
        label="Hybrid retrieval"
        description={
          hybridSupported
            ? 'Run keyword search alongside the vector search and merge the two rankings. Pure vector search misses exact terms — error codes, SKUs, acronyms, proper nouns — because they carry little semantic signal.'
            : `${providerLabel ?? 'This vector provider'} has no keyword index to combine with, so hybrid retrieval is unavailable for this module. Point the module at a provider whose store supports it to turn this on.`
        }
        checked={values.hybridEnabled && hybridSupported}
        disabled={!hybridSupported}
        onChange={(checked) => onChange({ hybridEnabled: checked })}
      />

      {hybridSupported && values.hybridEnabled ? (
        <>
          <FormField
            label="Merge mode"
            hint={
              values.hybridMode === 'rrf'
                ? 'Reciprocal rank fusion: combines the two rankings by position, ignoring the raw scores.'
                : 'Weighted: blends the two scores directly, so both have to be on comparable scales.'
            }
          >
            <ChipPicker<HybridMode>
              options={[
                { value: 'rrf', label: 'Reciprocal rank fusion' },
                { value: 'weighted', label: 'Weighted' },
              ]}
              value={values.hybridMode}
              onChange={(next) => onChange({ hybridMode: next as HybridMode })}
            />
          </FormField>

          <FormRow cols={2}>
            {values.hybridMode === 'weighted' ? (
              <FormField
                label={`Dense weight — ${values.hybridAlpha.toFixed(2)}`}
                hint="1 is pure vector search, 0 is pure keyword."
              >
                <Slider
                  min={0}
                  max={1}
                  step={0.05}
                  marks={[
                    { value: 0, label: 'keyword' },
                    { value: 0.5, label: '0.5' },
                    { value: 1, label: 'vector' },
                  ]}
                  label={(v) => v.toFixed(2)}
                  value={values.hybridAlpha}
                  onChange={(v) => onChange({ hybridAlpha: v })}
                />
              </FormField>
            ) : (
              <FormField
                label="Rank constant"
                hint="How steeply rank position is discounted. Default 60; lower favours the top few results more heavily."
              >
                <NumberInput
                  min={1}
                  max={1000}
                  step={10}
                  value={values.hybridK}
                  onChange={(v) => onChange({ hybridK: v === '' ? '' : Number(v) })}
                />
              </FormField>
            )}
          </FormRow>
        </>
      ) : null}

      <ToggleRow
        label="Isolate by module"
        description="AND this module's marker into every query, so an index shared with another module cannot leak between them. Turn it OFF for an index someone else's pipeline populated — those vectors carry no marker and every query would return nothing."
        checked={values.isolateByModule}
        onChange={(checked) => onChange({ isolateByModule: checked })}
      />
    </>
  );
}
