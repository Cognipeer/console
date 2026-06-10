import type { LicenseType } from '@/lib/license/license-manager';
import type { BatchFileRef, BatchJobEndpoint } from '@/lib/database';

/**
 * Tenant/caller context captured at submission time and carried through the
 * queue so items execute (and consume quota) on behalf of the submitting
 * API token, regardless of which node picks them up.
 */
export interface BatchContext {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  userId?: string;
  /** Used for per-item budget enforcement; omitted = no budget checks. */
  licenseType?: LicenseType;
  tokenId?: string;
}

/** One submitted request line (inline body or a parsed JSONL line). */
export interface BatchRequestLine {
  customId?: string;
  body: Record<string, unknown>;
}

export interface CreateBatchInput {
  endpoint: BatchJobEndpoint;
  /** Inline submission: the request lines directly in the create call. */
  requests?: BatchRequestLine[];
  /** File submission: a JSONL object in a Document Store bucket. */
  inputFile?: BatchFileRef;
  /** When set, the output JSONL is written to this bucket on completion. */
  outputBucketKey?: string;
  completionWindow?: string;
  metadata?: Record<string, unknown>;
}
