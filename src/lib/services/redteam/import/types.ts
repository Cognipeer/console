/**
 * Probe import from a file (CSV, JSONL, JSON, YAML).
 *
 * The file is read in the browser: this module parses it, recognises known
 * dataset layouts, maps rows to attempts and builds custom probe drafts. Only
 * the drafts reach the server (POST /api/redteam/custom-probes/import), where
 * they are validated like any custom probe. Nothing here may use Node APIs.
 *
 * No dataset ships with Console. A format entry only describes a layout and
 * the source and licence to record on the probes made from it.
 */

import type { IRedTeamCustomAttempt, IRedTeamCustomDetectors, IRedTeamProbeSource } from '@/lib/database';
import type { OwaspLlmCategory, Severity } from '../types';

export type ImportFileType = 'csv' | 'jsonl' | 'json' | 'yaml';

/**
 * What the imported rows test; it decides the attempts' shape and detectors.
 * - `harmful-request`: a refusal is the safe outcome; an answer is for review
 *   (or the judge decides when the campaign has a judge model).
 * - `over-refusal`: the prompts are harmless; a refusal fails (own rate).
 * - `prompt-injection`: the row is an injection; a code word planted in the
 *   system prompt must never appear.
 * - `jailbreak-template`: the row wraps a goal (`{{goal}}`, `{{ prompt }}` or
 *   appended); the goal asks for the planted code word.
 * - `forbidden-strings`: the target is asked to repeat the string; the string
 *   must never appear.
 */
export type ImportPolarity =
  | 'harmful-request'
  | 'over-refusal'
  | 'prompt-injection'
  | 'jailbreak-template'
  | 'forbidden-strings';

export class ImportError extends Error {}

/** A file read into rows. */
export interface ParsedTable {
  fileName: string;
  fileType: ImportFileType;
  /** Column names in first-seen order (CSV header; union of keys of JSON/JSONL/YAML row objects). */
  columns: string[];
  /** Row objects. Values are strings for CSV; any JSON value otherwise. */
  rows: Array<Record<string, unknown>>;
  /** Rows past IMPORT_LIMITS.maxRows that were not read. */
  truncatedRows: number;
  /** The parsed document when the file is not a list of row objects (garak payloads, PyRIT YAML, native export). */
  document?: unknown;
}

export interface ColumnMapping {
  /** Required: the column with the prompt (or template, or forbidden string). */
  prompt: string;
  category?: string;
  /** Text put before the prompt with a blank line between (HarmBench ContextString). */
  context?: string;
  /** Row id; used as the attempt id when it fits ATTEMPT_ID_PATTERN. */
  id?: string;
}

export interface RowSkipRule {
  column: string;
  /** Rows whose value equals one of these (trimmed, case-insensitive) are skipped. */
  values: string[];
  /** Shown next to the switch, e.g. "Skip FunctionalCategory = copyright". */
  label: string;
}

export interface ImportRowRules {
  dropDuplicates: boolean;
  dropEmpty: boolean;
  /** Skip rules in force (a format's rules are on by default). */
  skip: RowSkipRule[];
}

/** One usable row after mapping and rules. */
export interface ImportRow {
  /** 1-based position of the row among the parsed rows. */
  line: number;
  id?: string;
  prompt: string;
  category?: string;
  context?: string;
  /** Scripted turns (promptfoo nested arrays); `prompt` is then the turns joined by a newline. */
  turns?: string[];
}

export interface ImportStats {
  total: number;
  usable: number;
  /** duplicates + empty + skippedByRule + tooLong */
  skipped: number;
  duplicates: number;
  empty: number;
  skippedByRule: number;
  /** Prompt (with its context) longer than CUSTOM_PROBE_LIMITS.maxTurnChars. */
  tooLong: number;
}

export interface MappedRows {
  rows: ImportRow[];
  stats: ImportStats;
}

export interface ImportFormatSource {
  name: string;
  license?: string;
  url?: string;
  attribution?: string;
}

/** A known dataset layout. */
export interface ImportFormat {
  id: string;
  label: string;
  fileType: ImportFileType;
  /** What the rows test by default. */
  polarity: ImportPolarity;
  /** Other polarities the person may pick for this file (OR-Bench: over-refusal or harmful-request). */
  polarityChoices?: ImportPolarity[];
  source: ImportFormatSource;
  /** Default column mapping (after tableForFormat for document formats). */
  mapping: ColumnMapping;
  /** Skip rules offered for this format, on by default. */
  skip?: RowSkipRule[];
  /** One line shown under the detected format. */
  note?: string;
  /** Rows are harmful requests or strings: previews start masked. */
  sensitive: boolean;
}

export interface ImportConfig {
  polarity: ImportPolarity;
  /** One probe per category value, or one probe for every row. */
  grouping: 'per-category' | 'single';
  /** At most IMPORT_LIMITS.maxAttemptsPerProbe; more rows are sampled with `seed`. */
  attemptsPerProbe: number;
  /** Probe names are "<namePrefix> · <category>" (or just the prefix for a single probe). */
  namePrefix: string;
  /** OWASP key per category; a missing one gets defaultOwaspFor. The single-probe group uses key ''. */
  owaspByCategory: Record<string, OwaspLlmCategory>;
  /** Severity per category; a missing one gets defaultSeverityFor. */
  severityByCategory: Record<string, Severity>;
  /** Add the preset judge lens of the polarity (the campaign then needs a judge model). */
  useJudge: boolean;
  /** jailbreak-template: the goal put into each template (default DEFAULT_JAILBREAK_GOAL). */
  goal?: string;
  /** prompt-injection and jailbreak-template: planted system prompt containing {{canary}} (default DEFAULT_PLANTED_SYSTEM). */
  plantedSystem?: string;
  source: IRedTeamProbeSource;
  /** Sampling seed; the UI passes hashText(fileText) so one file always gives one sample. */
  seed: number;
}

/** One probe to create: the body POST /api/redteam/custom-probes/import takes in `probes`. */
export interface ImportProbeDraft {
  name: string;
  description: string;
  family: string;
  category: OwaspLlmCategory;
  severity: Severity;
  polarity: 'attack' | 'over-refusal';
  attempts: IRedTeamCustomAttempt[];
  detectors: IRedTeamCustomDetectors;
  source: IRedTeamProbeSource;
}

export interface ImportPlan {
  probes: ImportProbeDraft[];
  /** Usable rows left out because a probe was capped at attemptsPerProbe. */
  sampledOut: number;
  /** Category groups past IMPORT_LIMITS.maxProbesPerImport that were left out. */
  droppedGroups: string[];
  warnings: string[];
}

/** A probe in the Console export format (YAML or JSON; see native.ts). */
export interface NativeProbe {
  name: string;
  description?: string;
  family?: string;
  category: string;
  severity: Severity;
  polarity?: 'attack' | 'over-refusal';
  attempts: IRedTeamCustomAttempt[];
  detectors: IRedTeamCustomDetectors;
  source?: IRedTeamProbeSource;
  /** Kept for the record when a clone is exported; an import never sets lineage from it. */
  clonedFrom?: { probeKey: string; version: number };
}
