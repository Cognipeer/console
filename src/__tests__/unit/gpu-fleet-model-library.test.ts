/**
 * The catalog is shipped as a static JSON file. These tests guard the
 * filter/match/render contract any UI relies on — they are not "did the
 * file load right" tests; they pin behaviour that consumers depend on.
 */

import { describe, expect, it } from 'vitest';
import {
  evaluateSliceFit,
  getModelLibraryEntry,
  listModelLibrary,
  rankSlicesForModel,
  renderRuntimeForLibraryEntry,
} from '@/lib/services/gpuFleet/modelLibrary';
import type { IGpuHost, IGpuSlice } from '@/lib/database';

const HOST_NVIDIA: IGpuHost = {
  id: 'h1',
  tenantId: 't1',
  name: 'gpu-01',
  provider: 'azure',
  status: 'online',
  accelerator: 'nvidia-gpu',
  gpuFramework: 'cuda',
  serviceAddress: '10.0.0.1',
  terminalEnabled: false,
  agentTokenHash: null,
  agentTokenVersion: 1,
  registrationTokenHash: null,
  registrationTokenExpiresAt: null,
  inventory: null,
  labels: {},
  lastHeartbeatAt: null,
  lastEventSequence: 0,
  agentVersion: null,
  createdBy: 'u1',
};

function slice(memMiB: number, uuid = 's1'): IGpuSlice {
  return {
    uuid,
    tenantId: 't1',
    hostId: 'h1',
    gpuUuid: 'gpu-1',
    migGiId: null,
    migCiId: null,
    kind: 'full-gpu',
    profile: null,
    memoryMiB: memMiB,
    assignedDeploymentId: null,
  };
}

describe('model library', () => {
  it('returns entries for known modalities', () => {
    const llm = listModelLibrary({ modality: 'llm' });
    expect(llm.length).toBeGreaterThan(0);
    expect(llm.every((e) => e.modality === 'llm')).toBe(true);

    const embed = listModelLibrary({ modality: 'embedding' });
    expect(embed.every((e) => e.modality === 'embedding')).toBe(true);
  });

  it('filters by accelerator', () => {
    const apple = listModelLibrary({ accelerator: 'apple-silicon' });
    expect(apple.every((e) => e.supportedPlatforms.includes('apple-silicon'))).toBe(true);
  });

  it('full-text search hits id/displayName/tags', () => {
    const qwen = listModelLibrary({ q: 'qwen' });
    expect(qwen.length).toBeGreaterThan(0);
    const tool = listModelLibrary({ q: 'tool-use' });
    expect(tool.every((e) => e.tags.includes('tool-use'))).toBe(true);
  });

  it('returns null for unknown ids', () => {
    expect(getModelLibraryEntry('does-not-exist')).toBeNull();
  });

  describe('slice-fit ranking', () => {
    it('returns no candidates when host accelerator is incompatible', () => {
      const entry = getModelLibraryEntry('qwen3-32b');
      expect(entry).not.toBeNull();
      // qwen3-32b is NVIDIA-only; we point at an Apple host
      const appleHost: IGpuHost = { ...HOST_NVIDIA, accelerator: 'apple-silicon', gpuFramework: 'metal' };
      expect(rankSlicesForModel(entry!, appleHost, [slice(192 * 1024)])).toEqual([]);
    });

    it('marks fits/tight/insufficient by VRAM threshold', () => {
      // qwen3-32b: min 64 GiB, recommended 80 GiB
      const entry = getModelLibraryEntry('qwen3-32b')!;
      const fits = evaluateSliceFit(entry, slice(96 * 1024));     // > recommended (80)
      const tight = evaluateSliceFit(entry, slice(72 * 1024));    // between min (64) and rec (80)
      const insufficient = evaluateSliceFit(entry, slice(32 * 1024));
      expect(fits.fit).toBe('fits');
      expect(tight.fit).toBe('tight');
      expect(insufficient.fit).toBe('insufficient');
    });

    it('sorts results so fits come before tight come before insufficient', () => {
      const entry = getModelLibraryEntry('qwen3-8b')!;
      const sorted = rankSlicesForModel(entry, HOST_NVIDIA, [
        slice(8 * 1024, 's-small'),
        slice(48 * 1024, 's-fits'),
        slice(20 * 1024, 's-tight'),
      ]);
      expect(sorted.map((r) => r.fit)).toEqual(['fits', 'tight', 'insufficient']);
    });
  });

  describe('runtime template rendering', () => {
    it('substitutes {{gpuCount}} in args', () => {
      const entry = getModelLibraryEntry('qwen3-32b')!;
      const rendered = renderRuntimeForLibraryEntry(entry, 'vllm', { gpuCount: 4 });
      expect(rendered.args).toContain('4');
      // Sanity: the rendered runtime + image agree with the catalog entry
      expect(rendered.image).toBe(entry.runtimes.vllm!.image);
    });

    it('rejects unknown runtime keys for an entry', () => {
      const entry = getModelLibraryEntry('qwen3-32b')!;
      expect(() => renderRuntimeForLibraryEntry(entry, 'tgi', { gpuCount: 1 })).toThrow();
    });
  });
});
