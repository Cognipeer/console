/**
 * Curated model library + matching / templating helpers.
 *
 * The JSON catalog lives at `src/config/gpu-model-library.json` so admins can
 * extend it without touching code. This module:
 *   - loads + validates the catalog at import time
 *   - filters entries by host accelerator / available VRAM
 *   - renders a runtime's `args` template into a concrete `DeploymentSpec`
 */

import libraryJson from '@/config/gpu-model-library.json';
import type {
  GpuHostAccelerator,
  IGpuHost,
  IGpuSlice,
  LlmDeploymentRuntime,
} from '@/lib/database';

const MIB_PER_GIB = 1024;

type RawLibraryRuntime = {
  image: string;
  args: string[];
  env?: Record<string, string>;
  port: number;
  healthPath: string;
  openaiCompatible: boolean;
  openaiBasePath?: string;
  secretEnv?: string[];
};

type RawLibraryEntry = {
  id: string;
  displayName: string;
  vendor: string;
  license: string;
  modality: 'llm' | 'embedding' | 'stt' | 'tts' | 'ocr';
  tags: string[];
  hfRepo: string | null;
  contextLength?: number;
  dimension?: number;
  languages?: string[];
  requirements: {
    minVramGiB: number;
    recommendedVramGiB: number;
    computeCapability: string;
    quantization: string[];
  };
  supportedPlatforms: GpuHostAccelerator[];
  runtimes: Record<string, RawLibraryRuntime>;
};

interface RawLibrary {
  version: number;
  models: RawLibraryEntry[];
}

const LIBRARY = libraryJson as unknown as RawLibrary;

export type ModelModality = RawLibraryEntry['modality'];

export interface ModelLibraryEntry extends RawLibraryEntry {
  /** Computed: which deployment runtimes from our internal enum this entry exposes. */
  availableRuntimes: LlmDeploymentRuntime[];
}

const RUNTIME_KEY_TO_DEPLOYMENT_RUNTIME: Record<string, LlmDeploymentRuntime> = {
  vllm: 'vllm',
  tgi: 'tgi',
  ollama: 'ollama',
  // Anything else still works, just gets the generic 'custom' bucket.
};

function deriveAvailableRuntimes(raw: RawLibraryEntry): LlmDeploymentRuntime[] {
  return Object.keys(raw.runtimes).map(
    (key) => RUNTIME_KEY_TO_DEPLOYMENT_RUNTIME[key] ?? 'custom',
  );
}

const INDEX: ModelLibraryEntry[] = LIBRARY.models.map((raw) => ({
  ...raw,
  availableRuntimes: deriveAvailableRuntimes(raw),
}));

const BY_ID = new Map(INDEX.map((entry) => [entry.id, entry]));

export interface ModelLibraryFilter {
  modality?: ModelModality;
  accelerator?: GpuHostAccelerator;
  /** Free-text search across id, displayName, tags. */
  q?: string;
  tag?: string;
}

export function listModelLibrary(filter: ModelLibraryFilter = {}): ModelLibraryEntry[] {
  const q = filter.q?.trim().toLowerCase();
  return INDEX.filter((entry) => {
    if (filter.modality && entry.modality !== filter.modality) return false;
    if (filter.accelerator && !entry.supportedPlatforms.includes(filter.accelerator)) return false;
    if (filter.tag && !entry.tags.includes(filter.tag)) return false;
    if (q) {
      const haystack = [
        entry.id,
        entry.displayName,
        entry.vendor,
        entry.modality,
        ...entry.tags,
      ].join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

export function getModelLibraryEntry(id: string): ModelLibraryEntry | null {
  return BY_ID.get(id) ?? null;
}

export type Fit = 'fits' | 'tight' | 'insufficient';

export interface SliceFitResult {
  slice: IGpuSlice;
  fit: Fit;
  effectiveVramMiB: number;
}

export function evaluateSliceFit(
  entry: ModelLibraryEntry,
  slice: IGpuSlice,
): SliceFitResult {
  const minMiB = entry.requirements.minVramGiB * MIB_PER_GIB;
  const recommendedMiB = entry.requirements.recommendedVramGiB * MIB_PER_GIB;
  let fit: Fit = 'insufficient';
  if (slice.memoryMiB >= recommendedMiB) fit = 'fits';
  else if (slice.memoryMiB >= minMiB) fit = 'tight';
  return { slice, fit, effectiveVramMiB: slice.memoryMiB };
}

/**
 * Returns slice candidates for the given model on a given host, sorted best
 * first (fits → tight → insufficient).
 */
export function rankSlicesForModel(
  entry: ModelLibraryEntry,
  host: IGpuHost,
  hostSlices: IGpuSlice[],
): SliceFitResult[] {
  if (!entry.supportedPlatforms.includes(host.accelerator)) return [];
  const FIT_ORDER: Record<Fit, number> = { fits: 0, tight: 1, insufficient: 2 };
  return hostSlices
    .map((slice) => evaluateSliceFit(entry, slice))
    .sort((a, b) => FIT_ORDER[a.fit] - FIT_ORDER[b.fit] || b.effectiveVramMiB - a.effectiveVramMiB);
}

export interface RenderRuntimeArgs {
  /** GPU count visible to this deployment. Used in `{{gpuCount}}` substitution. */
  gpuCount: number;
}

function substituteTemplate(value: string, vars: RenderRuntimeArgs): string {
  return value.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (name === 'gpuCount') return String(vars.gpuCount);
    return `{{${name}}}`;
  });
}

export interface RenderedRuntime {
  runtime: LlmDeploymentRuntime;
  image: string;
  args: string[];
  env: Record<string, string>;
  port: number;
  healthPath: string;
  openaiCompatible: boolean;
  openaiBasePath: string | null;
  secretEnv: string[];
}

export function renderRuntimeForLibraryEntry(
  entry: ModelLibraryEntry,
  runtimeKey: string,
  args: RenderRuntimeArgs,
): RenderedRuntime {
  const raw = entry.runtimes[runtimeKey];
  if (!raw) {
    throw new Error(`Runtime '${runtimeKey}' not available for model '${entry.id}'`);
  }
  return {
    runtime: RUNTIME_KEY_TO_DEPLOYMENT_RUNTIME[runtimeKey] ?? 'custom',
    image: raw.image,
    args: raw.args.map((a) => substituteTemplate(a, args)),
    env: Object.fromEntries(
      Object.entries(raw.env ?? {}).map(([k, v]) => [k, substituteTemplate(v, args)]),
    ),
    port: raw.port,
    healthPath: raw.healthPath,
    openaiCompatible: raw.openaiCompatible,
    openaiBasePath: raw.openaiBasePath ?? null,
    secretEnv: raw.secretEnv ?? [],
  };
}
