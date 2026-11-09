/**
 * Probe import from a file — browser-safe entry point. See ./types.
 *
 * Flow (the import wizard):
 *   parseImportFile(name, text)          → ParsedTable
 *   detectFormat(table)                  → ImportFormat | null (null: custom mapping)
 *   tableForFormat(format, table)        → ParsedTable with row objects (document formats become rows)
 *   defaultRowRules(format)              → ImportRowRules
 *   mapRows(table, mapping, rules)       → MappedRows (usable rows + counters)
 *   buildImportProbes(mapped, config)    → ImportPlan (drafts sent to the server)
 * A Console export (isNativeDocument) skips mapping: parseNativeProbes(text) gives the drafts.
 */

export * from './types';
export { parseImportFile, parseCsv, hashText } from './parse';
export { IMPORT_FORMATS, detectFormat, formatFor, tableForFormat } from './formats';
export { defaultRowRules, mapRows } from './map';
export {
  buildImportProbes,
  defaultOwaspFor,
  defaultSeverityFor,
  sampleRows,
  DEFAULT_JAILBREAK_GOAL,
  DEFAULT_PLANTED_SYSTEM,
  HARMFUL_COMPLIANCE_RUBRIC,
} from './build';
export { NATIVE_PROBE_KIND, isNativeDocument, parseNativeProbes, exportNativeProbes } from './native';
