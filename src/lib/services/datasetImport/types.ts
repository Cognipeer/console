/**
 * Public types for the External Eval-Import service.
 *
 * An "import" turns a log export from an external LLM stack — OpenAI
 * fine-tune / Stored Completions JSONL, request/response pair logs from
 * gateways, AWS Bedrock model-invocation logs, Langfuse generation
 * observations, or arbitrary gateway/APIM wrappers with an embedded chat
 * body — into an evaluation dataset, behind the SAME mandatory anonymization
 * gate as Traffic Snapshots: EVERY string that enters a dataset item passes
 * through the log-redaction scrubber AND the PII anonymization pipeline, and
 * creation refuses to run without anonymization options.
 *
 * Imported data is for evaluation ONLY: the import path never writes
 * usage_daily / cost rows — measured costs come later from eval replay.
 */

import type { AnonymizeOptions } from '@/lib/services/pii/anonymize';
import type { EvalMessage, EvalToolDefinition, ExpectedToolCall } from '@/lib/services/evaluation/types';

/** Wire ids of the supported export formats (pinned API contract). */
export const IMPORT_FORMATS = [
  'openai-chat-jsonl',
  'openai-pair-jsonl',
  'bedrock-invocation-jsonl',
  'langfuse-generations',
  'embedded-chat-json',
] as const;

export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/** Expectations recovered from the export (recorded answer / tool calls). */
export interface ParsedImportExpected {
  /** Recorded assistant answer (trailing assistant message / response body). */
  reference?: string;
  /** Recorded tool calls (argsMatch 'subset' — recorded args are a floor). */
  toolCalls?: ExpectedToolCall[];
}

/** One dataset-item candidate parsed out of the export, BEFORE anonymization. */
export interface ParsedImportItem {
  input: EvalMessage[];
  tools?: EvalToolDefinition[];
  expected?: ParsedImportExpected;
  /** Model id recorded next to the exchange (provenance tag only). */
  sourceModel?: string;
}

/**
 * Per-reason skip counters:
 *   unparseable      — line/record failed JSON.parse
 *   missingMessages  — record carried no usable messages for its format
 *   emptyInput       — record mapped to an empty input conversation
 *   overLimit        — records beyond MAX_IMPORT_ITEMS (parsing stopped)
 */
export type ImportSkipCounts = Record<string, number>;

export interface ParseImportResult {
  items: ParsedImportItem[];
  skipped: ImportSkipCounts;
}

export interface DatasetImportContext {
  tenantDbName: string;
  tenantId: string;
  /** undefined = tenant-wide scope. */
  projectId?: string;
  /** User the created dataset is attributed to. */
  userId?: string;
}

export interface CreateImportedDatasetParams {
  name: string;
  /** Raw export content (JSONL or JSON), capped at MAX_IMPORT_BYTES. */
  content: string;
  format: ImportFormat;
  /** Free-text provenance label ("prod gateway 2026-08", …). */
  sourceLabel?: string;
  /** REQUIRED — creation refuses to run without a valid anonymization gate. */
  anonymize: AnonymizeOptions;
}

export interface CreateImportedDatasetResult {
  datasetId: string;
  datasetKey: string;
  name: string;
  created: number;
  skipped: ImportSkipCounts;
  /** Total PII findings replaced across all persisted strings. */
  piiFindings: number;
}
