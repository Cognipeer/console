/**
 * Public types for the Traffic Snapshots service.
 *
 * A "snapshot" samples production traffic — gateway model-usage logs or agent
 * tracing sessions — into an evaluation dataset. Sampling is deterministic
 * (hash of the row's stable id), and EVERY string that enters a dataset item
 * passes through the log-redaction scrubber AND the PII anonymization
 * pipeline; creation refuses to run without anonymization options.
 */

import type { AnonymizeOptions } from '@/lib/services/pii/anonymize';
import type { IEvaluationDatasetItem } from '@/lib/database';
// Coordinated contract: these fields/types land in evaluation/types.ts via a
// concurrent integration (DatasetItem.tools / toolResults, ExpectedOutput
// .toolCalls). Type-only import — erased at runtime.
import type { EvalToolDefinition } from '@/lib/services/evaluation/types';

export type SnapshotSource = 'gateway' | 'tracing';

export interface SnapshotContext {
  tenantDbName: string;
  tenantId: string;
  /** undefined = tenant-wide scope. */
  projectId?: string;
  /** User the created dataset is attributed to. */
  userId?: string;
}

export interface SnapshotFilters {
  from?: Date;
  to?: Date;
  /** Gateway source only: restrict to one Model Hub model key. */
  modelKey?: string;
  /** Tracing source only: exact agent name. */
  agentName?: string;
  status?: 'success' | 'error';
  /** Deterministic sampling percentage, 1..100 (default 100). */
  samplePct?: number;
  /** Max dataset items to create (hard cap 1000). */
  limit?: number;
}

export interface SnapshotParams {
  source: SnapshotSource;
  filters?: SnapshotFilters;
}

export interface SnapshotBreakdownEntry {
  /** Model key (gateway) or agent name (tracing). */
  key: string;
  matching: number;
  sampled: number;
}

export interface SnapshotPreview {
  source: SnapshotSource;
  /** Rows/sessions passing the filters within the scanned window. */
  matching: number;
  /** Of those, how many the deterministic sample selects. */
  sampled: number;
  /**
   * Lower-bound estimate of items the create call would produce
   * (sampled ∧ limit, counting one per row/session). Tracing sessions with
   * tool actions emit up to MAX_ITEMS_PER_SESSION items each at create time
   * (still capped by `limit`), and the preview deliberately never loads
   * tracing events to refine this — the created dataset's
   * `counts.itemsPerSession` records the actual ratio.
   */
  wouldCreate: number;
  /** Rows/sessions examined; equals `matching` unless the scan cap hit. */
  scanned: number;
  /** True when the scan cap stopped enumeration early — counts are partial. */
  scanCapped: boolean;
  samplePct: number;
  limit: number;
  breakdown: SnapshotBreakdownEntry[];
}

export interface SnapshotSkipCounts {
  /** Payload persisted truncated / not parseable as JSON. */
  truncatedPayload: number;
  /** providerRequest carried no usable messages array. */
  missingMessages: number;
  /** Tracing session had no reconstructable message content. */
  unmappable: number;
  /** Sampled rows (gateway) / items (tracing — a session emits several)
   *  dropped because the dataset hit its payload byte budget (Mongo documents
   *  cap at 16MB — the budget stops well before that). */
  sizeCapped: number;
}

/** What kind of content the tracing mapper found in a session's events. */
export type TracingSessionShape = 'message-sections' | 'none';

export interface TracingShapeReport {
  /** Sections with kind==='message' carrying role + string content. */
  messageSections: number;
  /** Sessions whose events had no reconstructable messages. */
  noContent: number;
  /** messageSections / (messageSections + noContent), 0..1. */
  mappableFraction: number;
}

export interface CreateSnapshotParams extends SnapshotParams {
  name: string;
  description?: string;
  /** REQUIRED — creation refuses to run without a valid anonymization gate. */
  anonymize: AnonymizeOptions;
}

export interface CreateSnapshotResult {
  dataset: { id: string; key: string; name: string };
  source: SnapshotSource;
  matching: number;
  sampled: number;
  created: number;
  skipped: SnapshotSkipCounts;
  /** Total PII findings replaced across all persisted strings. */
  piiFindings: number;
  /** Tracing source only: what event shapes were found. */
  tracingShapes?: TracingShapeReport;
}

/**
 * Dataset item as persisted: the DB item shape plus the coordinated tool
 * fields (kept even where the evaluation runner does not consume them yet —
 * they ride along in the dataset document).
 */
export interface SnapshotDatasetItem extends IEvaluationDatasetItem {
  tools?: EvalToolDefinition[];
  toolResults?: Record<string, unknown>;
}
