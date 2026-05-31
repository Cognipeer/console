/**
 * A "slice" is the unit a deployment binds to. On a GPU without MIG it equals
 * the full physical card; on an A100/H100 with MIG enabled, each MIG instance
 * is its own slice. Modeling them uniformly keeps the deployment scheduler
 * simple.
 */

/** MIG compute/memory profile shorthand, e.g. "1g.10gb", "3g.40gb", "7g.80gb". */
export type MigProfile = string;

export type SliceKind = 'full-gpu' | 'mig';

export interface GpuSliceReport {
  /** Stable ID. For full-GPU slices = GPU UUID. For MIG = MIG instance UUID. */
  uuid: string;
  /** GPU UUID this slice belongs to (parent device). */
  gpuUuid: string;
  /** MIG GPU instance ID (gi). Null for full-GPU slices. */
  migGiId: number | null;
  /** MIG compute instance ID (ci). Null for full-GPU slices. */
  migCiId: number | null;
  kind: SliceKind;
  /** "1g.10gb" for MIG; null for full GPU. */
  profile: MigProfile | null;
  /** Memory available to workloads scheduled on this slice. */
  memoryMiB: number;
}

/**
 * Desired MIG layout for a single physical GPU. Sent from the console to the
 * agent as part of an `apply-mig-profile` command. The agent realises this
 * exactly: existing MIG instances on the GPU are destroyed first.
 */
export interface DesiredMigLayout {
  gpuUuid: string;
  /** Empty array = disable MIG (full GPU). */
  profiles: MigProfile[];
}
