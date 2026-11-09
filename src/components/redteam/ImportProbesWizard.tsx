'use client';

/**
 * Probe import wizard (full screen): File, Map, Configure. The file is read in
 * the browser; only the probe drafts built from it are posted to
 * /api/redteam/custom-probes/import, where each one is validated like a custom
 * probe. A Console export skips the mapping and goes straight to the summary.
 * No dataset ships with Console: this screen only reads what the person uploads.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, FileButton, Group, NumberInput, Radio, Select, Stack, Switch, Table, Text, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconUpload } from '@tabler/icons-react';
import FormShell, { FormSection } from '@/components/common/ui/FormShell';
import { OWASP_LLM_CATEGORIES, OWASP_LLM_LABELS } from '@/lib/services/redteam/owasp';
import { IMPORT_LIMITS } from '@/lib/services/redteam/limits';
import {
  IMPORT_FORMATS,
  ImportError,
  buildImportProbes,
  defaultRowRules,
  detectFormat,
  formatFor,
  hashText,
  isNativeDocument,
  mapRows,
  parseImportFile,
  parseNativeProbes,
  tableForFormat,
  type ColumnMapping,
  type ImportConfig,
  type ImportFormat,
  type ImportPlan,
  type ImportPolarity,
  type ImportProbeDraft,
  type ImportRowRules,
  type ParsedTable,
} from '@/lib/services/redteam/import';
import { previewCell, shouldMaskPreview } from './helpers';

const CUSTOM_FORMAT = 'custom';

const POLARITY_LABEL: Record<ImportPolarity, string> = {
  'harmful-request': 'Harmful requests: a refusal is safe, an answer goes to review',
  'over-refusal': 'Harmless prompts: a refusal is the failure (own rate)',
  'prompt-injection': 'Prompt injections: a planted code word must not appear',
  'jailbreak-template': 'Jailbreak templates: the goal asks for the planted code word',
  'forbidden-strings': 'Forbidden strings: the target repeats the text, which must not appear',
};

const POLARITY_GROUP_TITLE: Record<ImportPolarity, string> = {
  'harmful-request': 'Harmful requests',
  'over-refusal': 'Over-refusal',
  'prompt-injection': 'Prompt injection',
  'jailbreak-template': 'Jailbreak templates',
  'forbidden-strings': 'Forbidden strings',
};

const ALL_POLARITIES = Object.keys(POLARITY_LABEL) as ImportPolarity[];

const SEVERITY_OPTIONS = ['low', 'medium', 'high', 'critical'].map((s) => ({ value: s, label: s }));
const OWASP_OPTIONS = OWASP_LLM_CATEGORIES.map((value) => ({ value, label: OWASP_LLM_LABELS[value] }));

const STEPS = ['File', 'Map', 'Configure'] as const;

/** Picks a likely prompt column of a file with no known layout. */
function guessPromptColumn(columns: string[]): string {
  const lower = columns.map((c) => c.toLowerCase());
  for (const hint of ['prompt', 'text', 'question', 'instruction', 'goal', 'behavior', 'input']) {
    const at = lower.indexOf(hint);
    if (at !== -1) return columns[at]!;
  }
  return columns[0] ?? '';
}

function guessColumn(columns: string[], hints: string[]): string | undefined {
  const lower = columns.map((c) => c.toLowerCase());
  for (const hint of hints) {
    const at = lower.indexOf(hint);
    if (at !== -1) return columns[at];
  }
  return undefined;
}

interface Props {
  opened: boolean;
  onClose: () => void;
  /** Called after a successful import. */
  onImported: (count: number) => void;
}

export default function ImportProbesWizard({ opened, onClose, onImported }: Props) {
  const [step, setStep] = useState(0);
  const [fileName, setFileName] = useState('');
  const [fileText, setFileText] = useState('');
  const [table, setTable] = useState<ParsedTable | null>(null);
  const [nativeDrafts, setNativeDrafts] = useState<ImportProbeDraft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [formatId, setFormatId] = useState<string>(CUSTOM_FORMAT);
  const [mapping, setMapping] = useState<ColumnMapping>({ prompt: '' });
  const [rules, setRules] = useState<ImportRowRules>(() => defaultRowRules(null));
  const [showContent, setShowContent] = useState(false);
  const [polarity, setPolarity] = useState<ImportPolarity>('harmful-request');
  const [grouping, setGrouping] = useState<'per-category' | 'single'>('per-category');
  const [attemptsPerProbe, setAttemptsPerProbe] = useState<number | string>(IMPORT_LIMITS.maxAttemptsPerProbe);
  const [namePrefix, setNamePrefix] = useState('');
  const [owaspByCategory, setOwaspByCategory] = useState<Record<string, string>>({});
  const [severityByCategory, setSeverityByCategory] = useState<Record<string, string>>({});
  const [useJudge, setUseJudge] = useState(false);
  const [goal, setGoal] = useState('');
  const [plantedSystem, setPlantedSystem] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [sourceLicense, setSourceLicense] = useState('');
  const [saving, setSaving] = useState(false);
  const wasOpen = useRef(false);

  // The chosen format as it applies to this file (formatFor), not the bare catalog entry:
  // some layouts adjust polarity, mapping or source to the file they read.
  const [format, setFormat] = useState<ImportFormat | null>(null);

  /** Forget the file and everything read from it. */
  const clearFile = () => {
    setFileName('');
    setFileText('');
    setTable(null);
    setNativeDrafts(null);
    setFormat(null);
    setFormatId(CUSTOM_FORMAT);
    setShowContent(false);
  };

  const reset = () => {
    setStep(0);
    clearFile();
    setError(null);
    setMapping({ prompt: '' });
    setRules(defaultRowRules(null));
    setShowContent(false);
    setPolarity('harmful-request');
    setGrouping('per-category');
    setAttemptsPerProbe(IMPORT_LIMITS.maxAttemptsPerProbe);
    setNamePrefix('');
    setOwaspByCategory({});
    setSeverityByCategory({});
    setUseJudge(false);
    setGoal('');
    setPlantedSystem('');
    setSourceName('');
    setSourceLicense('');
  };

  useEffect(() => {
    if (opened && !wasOpen.current) reset();
    wasOpen.current = opened;
  }, [opened]);

  /** The table the mapping applies to: document formats are turned into rows first. */
  const effective = useMemo<{ table: ParsedTable | null; error: string | null }>(() => {
    if (!table || nativeDrafts) return { table, error: null };
    if (!format) return { table, error: null };
    try {
      return { table: tableForFormat(format, table), error: null };
    } catch (err) {
      return { table: null, error: err instanceof Error ? err.message : 'This file does not match the chosen format.' };
    }
  }, [table, format, nativeDrafts]);

  const columns = effective.table?.columns ?? [];

  const applyFormat = (id: string, tbl: ParsedTable, name: string) => {
    const f = id === CUSTOM_FORMAT ? null : formatFor(id, tbl);
    setFormat(f);
    setFormatId(f ? f.id : CUSTOM_FORMAT);
    // A new file or format starts masked again; the toggle never carries over.
    setShowContent(false);
    let eff = tbl;
    if (f) {
      try {
        eff = tableForFormat(f, tbl);
      } catch {
        eff = tbl;
      }
    }
    const cols = eff.columns;
    if (f) {
      setMapping({ ...f.mapping });
      setPolarity(f.polarity);
      setSourceName(f.source.name);
      setSourceLicense(f.source.license ?? '');
      setNamePrefix(f.source.name);
    } else {
      setMapping({
        prompt: guessPromptColumn(cols),
        category: guessColumn(cols, ['category', 'type', 'label', 'topic']),
        context: undefined,
        id: guessColumn(cols, ['id', 'behaviorid', 'behavior_id']),
      });
      setPolarity('harmful-request');
      setSourceName('');
      setSourceLicense('');
      setNamePrefix(name.replace(/\.[^.]+$/, ''));
    }
    setRules(defaultRowRules(f));
    setGrouping(f && !f.mapping.category ? 'single' : 'per-category');
    setOwaspByCategory({});
    setSeverityByCategory({});
    setUseJudge(false);
  };

  const readFile = async (file: File | null) => {
    if (!file) return;
    setError(null);
    if (file.size > IMPORT_LIMITS.maxFileBytes) {
      // The earlier file is dropped too, so Next never goes on with a file the error is not about.
      clearFile();
      setError(`The file is larger than ${Math.round(IMPORT_LIMITS.maxFileBytes / (1024 * 1024))} MB.`);
      return;
    }
    try {
      const text = await file.text();
      const parsed = parseImportFile(file.name, text);
      setFileName(file.name);
      setFileText(text);
      setTable(parsed);
      if (isNativeDocument(parsed.document)) {
        setNativeDrafts(parseNativeProbes(text));
        setFormat(null);
        setFormatId(CUSTOM_FORMAT);
        setShowContent(false);
        return;
      }
      setNativeDrafts(null);
      const detected = detectFormat(parsed);
      applyFormat(detected?.id ?? CUSTOM_FORMAT, parsed, file.name);
    } catch (err) {
      clearFile();
      setError(err instanceof ImportError || err instanceof Error ? err.message : 'The file could not be read.');
    }
  };

  const mapped = useMemo(() => {
    if (!effective.table || !mapping.prompt || !columns.includes(mapping.prompt)) return null;
    try {
      return mapRows(effective.table, mapping, rules);
    } catch {
      return null;
    }
  }, [effective.table, mapping, rules, columns]);

  // Largest categories first, the order in which the builder keeps them when there are more
  // than an import can create (a stable sort keeps first-seen order on ties).
  const categories = useMemo(() => {
    if (!mapped) return [] as string[];
    if (grouping === 'single') return [''];
    const counts = new Map<string, number>();
    for (const r of mapped.rows) {
      if (!r.prompt.trim()) continue;
      const key = r.category ?? '';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  }, [mapped, grouping]);

  const polarityChoices: ImportPolarity[] = format
    ? [format.polarity, ...(format.polarityChoices ?? []).filter((p) => p !== format.polarity)]
    : ALL_POLARITIES;

  const attemptsNumber = typeof attemptsPerProbe === 'number' ? attemptsPerProbe : NaN;
  const attemptsValid = Number.isInteger(attemptsNumber) && attemptsNumber >= 1 && attemptsNumber <= IMPORT_LIMITS.maxAttemptsPerProbe;

  const plan = useMemo<{ plan: ImportPlan | null; error: string | null }>(() => {
    if (nativeDrafts) return { plan: { probes: nativeDrafts, sampledOut: 0, droppedGroups: [], warnings: [] }, error: null };
    if (step < 2 || !mapped || !attemptsValid) return { plan: null, error: null };
    const config: ImportConfig = {
      polarity,
      grouping,
      attemptsPerProbe: attemptsNumber,
      namePrefix: namePrefix.trim() || 'Imported',
      owaspByCategory: Object.fromEntries(Object.entries(owaspByCategory).filter(([, v]) => v)) as ImportConfig['owaspByCategory'],
      severityByCategory: Object.fromEntries(Object.entries(severityByCategory).filter(([, v]) => v)) as ImportConfig['severityByCategory'],
      useJudge,
      goal: goal.trim() || undefined,
      plantedSystem: plantedSystem.trim() || undefined,
      source: {
        format: format?.id,
        name: sourceName.trim() || format?.source.name || 'Custom import',
        license: sourceLicense.trim() || undefined,
        attribution: format?.source.attribution,
        url: format?.source.url,
        fileName: fileName || undefined,
      },
      seed: hashText(fileText),
    };
    try {
      return { plan: buildImportProbes(mapped, config), error: null };
    } catch (err) {
      return { plan: null, error: err instanceof Error ? err.message : 'The probes could not be built.' };
    }
  }, [
    nativeDrafts, step, mapped, attemptsValid, attemptsNumber, polarity, grouping, namePrefix, owaspByCategory,
    severityByCategory, useJudge, goal, plantedSystem, format, sourceName, sourceLicense, fileName, fileText,
  ]);

  const probes = plan.plan?.probes ?? [];
  const attemptTotal = probes.reduce((n, p) => n + p.attempts.length, 0);
  const lastStep = nativeDrafts ? 2 : step;
  const masked = shouldMaskPreview(format?.sensitive, polarity) && !showContent;

  const canNext =
    step === 0
      ? Boolean(table) && !effective.error
      : step === 1
        ? Boolean(mapped) && (mapped?.stats.usable ?? 0) > 0
        : false;

  const submit = async () => {
    if (probes.length === 0) return;
    setSaving(true);
    try {
      const res = await fetch('/api/redteam/custom-probes/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ probes }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Import failed');
      const count = Array.isArray(data.probes) ? data.probes.length : probes.length;
      notifications.show({ title: 'Probes imported', message: `${count} custom probe${count === 1 ? '' : 's'} created`, color: 'teal' });
      onImported(count);
      onClose();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Import failed', color: 'red' });
    } finally {
      setSaving(false);
    }
  };

  const formatOptions = [
    ...IMPORT_FORMATS.map((f) => ({ value: f.id, label: f.label })),
    { value: CUSTOM_FORMAT, label: 'Custom mapping' },
  ];

  const supportedByPolarity = useMemo(() => {
    const groups = new Map<ImportPolarity, ImportFormat[]>();
    for (const f of IMPORT_FORMATS) groups.set(f.polarity, [...(groups.get(f.polarity) ?? []), f]);
    return [...groups.entries()];
  }, []);

  const summarySource = nativeDrafts ? 'a Console export' : sourceName.trim() || format?.source.name || 'Custom import';

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      title="Import probes from a file"
      subtitle={nativeDrafts ? 'Console export' : `Step ${step + 1} of ${STEPS.length} · ${STEPS[step]}`}
      primaryAction={
        lastStep === 2
          ? {
              label: probes.length > 0 ? `Import ${probes.length} probe${probes.length === 1 ? '' : 's'}` : 'Import',
              loading: saving,
              disabled: probes.length === 0 || Boolean(plan.error),
              onClick: () => { void submit(); },
            }
          : { label: 'Next', disabled: !canNext, onClick: () => setStep((s) => s + 1) }
      }
      secondaryAction={
        step > 0 && !nativeDrafts
          ? { label: 'Back', variant: 'default', onClick: () => setStep((s) => Math.max(0, s - 1)) }
          : undefined
      }
    >
      {step === 0 || nativeDrafts ? (
        <FormSection title="File">
          <Stack gap="md">
            <div
              data-testid="redteam-import-dropzone"
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                void readFile(e.dataTransfer.files?.[0] ?? null);
              }}
              style={{
                border: `1px dashed ${dragOver ? 'var(--mantine-color-teal-6)' : 'var(--mantine-color-default-border)'}`,
                borderRadius: 8,
                padding: 24,
                textAlign: 'center',
              }}
            >
              <Stack gap={6} align="center">
                <IconUpload size={22} />
                <Text size="sm">{fileName ? fileName : 'Drop a file here, or choose one'}</Text>
                <Text size="xs" c="dimmed">
                  CSV, JSONL, JSON or YAML, up to {Math.round(IMPORT_LIMITS.maxFileBytes / (1024 * 1024))} MB. The file is read in your browser.
                </Text>
                <FileButton onChange={(f) => { void readFile(f); }} accept=".csv,.jsonl,.json,.yaml,.yml,.prompt,text/csv,application/json,text/yaml">
                  {(props) => <Button {...props} size="xs" variant="default">Choose file</Button>}
                </FileButton>
              </Stack>
            </div>

            {error ? (
              <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} data-testid="redteam-import-error">{error}</Alert>
            ) : null}

            {nativeDrafts ? (
              <Alert color="teal" variant="light" title="Console export recognised">
                The file holds {nativeDrafts.length} probe{nativeDrafts.length === 1 ? '' : 's'}. Nothing to map: review the summary below and import.
              </Alert>
            ) : table ? (
              <Stack gap="xs">
                <Select
                  label="Format"
                  description={
                    format
                      ? `Detected: ${format.label}`
                      : 'No known layout matched; map the columns yourself in the next step.'
                  }
                  data={formatOptions}
                  value={formatId}
                  allowDeselect={false}
                  searchable
                  onChange={(v) => { if (v && table) applyFormat(v, table, fileName); }}
                />
                {format?.note ? <Text size="xs" c="dimmed">{format.note}</Text> : null}
                {effective.error ? <Text size="xs" c="red">{effective.error}</Text> : null}
                <Text size="xs" c="dimmed">
                  {table.rows.length.toLocaleString('en-US')} row{table.rows.length === 1 ? '' : 's'} read
                  {table.truncatedRows > 0 ? `; ${table.truncatedRows.toLocaleString('en-US')} more past the ${IMPORT_LIMITS.maxRows.toLocaleString('en-US')} row limit were left out` : ''}.
                </Text>
              </Stack>
            ) : null}

            <Text size="xs" c="dimmed">
              Source and licence are stored on each probe. Datasets with no licence or with redistribution limits can be uploaded by you; none ship with Console.
            </Text>
          </Stack>
        </FormSection>
      ) : null}

      {step === 0 && !nativeDrafts ? (
        <FormSection title="Supported formats">
          <Table withTableBorder withColumnBorders fz="xs" data-testid="redteam-import-formats">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Format</Table.Th>
                <Table.Th>File</Table.Th>
                <Table.Th>Licence</Table.Th>
                <Table.Th>Note</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {supportedByPolarity.map(([pol, list]) => (
                <FormatGroupRows key={pol} title={POLARITY_GROUP_TITLE[pol]} formats={list} />
              ))}
              <Table.Tr>
                <Table.Td colSpan={4}>Anything else: choose Custom mapping and pick the columns.</Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </FormSection>
      ) : null}

      {step === 1 && !nativeDrafts ? (
        <>
          <FormSection title="Columns">
            <Stack gap="md">
              <Group grow align="flex-start">
                <Select
                  label="Prompt"
                  required
                  data={columns}
                  value={mapping.prompt || null}
                  allowDeselect={false}
                  searchable
                  onChange={(v) => setMapping((m) => ({ ...m, prompt: v ?? '' }))}
                />
                <Select
                  label="Category"
                  description="One probe per value"
                  data={columns}
                  value={mapping.category ?? null}
                  clearable
                  searchable
                  onChange={(v) => setMapping((m) => ({ ...m, category: v ?? undefined }))}
                />
                <Select
                  label="Context"
                  description="Put before the prompt"
                  data={columns}
                  value={mapping.context ?? null}
                  clearable
                  searchable
                  onChange={(v) => setMapping((m) => ({ ...m, context: v ?? undefined }))}
                />
                <Select
                  label="Id"
                  description="Becomes the attempt id"
                  data={columns}
                  value={mapping.id ?? null}
                  clearable
                  searchable
                  onChange={(v) => setMapping((m) => ({ ...m, id: v ?? undefined }))}
                />
              </Group>
            </Stack>
          </FormSection>

          <FormSection title="Rows">
            <Stack gap="sm">
              <Switch
                label="Drop duplicates"
                checked={rules.dropDuplicates}
                onChange={(e) => { const on = e.currentTarget.checked; setRules((r) => ({ ...r, dropDuplicates: on })); }}
              />
              <Switch
                label="Drop empty rows"
                checked={rules.dropEmpty}
                onChange={(e) => { const on = e.currentTarget.checked; setRules((r) => ({ ...r, dropEmpty: on })); }}
              />
              {(format?.skip ?? []).map((rule) => (
                <Switch
                  key={`${rule.column}:${rule.values.join('|')}`}
                  label={rule.label}
                  checked={rules.skip.some((s) => s.column === rule.column && s.values.join('|') === rule.values.join('|'))}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    setRules((r) => ({
                      ...r,
                      skip: on
                        ? [...r.skip, rule]
                        : r.skip.filter((s) => !(s.column === rule.column && s.values.join('|') === rule.values.join('|'))),
                    }));
                  }}
                />
              ))}
              {mapped ? (
                <Text size="sm" data-testid="redteam-import-stats">
                  {mapped.stats.usable.toLocaleString('en-US')} usable of {mapped.stats.total.toLocaleString('en-US')} rows
                  {mapped.stats.skipped > 0
                    ? ` · skipped ${mapped.stats.skipped.toLocaleString('en-US')} (${mapped.stats.duplicates} duplicate, ${mapped.stats.empty} empty, ${mapped.stats.skippedByRule} by rule, ${mapped.stats.tooLong} too long)`
                    : ''}
                </Text>
              ) : (
                <Text size="sm" c="dimmed">Pick the prompt column to see the counts.</Text>
              )}
            </Stack>
          </FormSection>

          <FormSection title="Preview">
            <Stack gap="sm">
              <Switch
                label="Show content"
                checked={showContent}
                onChange={(e) => setShowContent(e.currentTarget.checked)}
              />
              {masked ? (
                <Text size="xs" c="dimmed">Content is hidden because these rows can be harmful requests or strings. Only lengths are shown.</Text>
              ) : showContent && shouldMaskPreview(format?.sensitive, polarity) ? (
                <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />}>
                  The rows may contain harmful or offensive text. They stay in your browser until you import.
                </Alert>
              ) : null}
              <Table withTableBorder fz="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={60}>Row</Table.Th>
                    <Table.Th w={160}>Category</Table.Th>
                    <Table.Th>Prompt</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {(mapped?.rows ?? []).slice(0, 5).map((r) => (
                    <Table.Tr key={r.line}>
                      <Table.Td>{r.line}</Table.Td>
                      <Table.Td>{r.category ?? '—'}</Table.Td>
                      <Table.Td style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {previewCell(r.context ? `${r.context}\n\n${r.prompt}` : r.prompt, masked)}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                  {(mapped?.rows.length ?? 0) === 0 ? (
                    <Table.Tr><Table.Td colSpan={3}><Text size="xs" c="dimmed">No usable rows.</Text></Table.Td></Table.Tr>
                  ) : null}
                </Table.Tbody>
              </Table>
            </Stack>
          </FormSection>
        </>
      ) : null}

      {lastStep === 2 && !nativeDrafts ? (
        <>
          <FormSection title="What the rows test">
            <Stack gap="md">
              <Radio.Group value={polarity} onChange={(v) => setPolarity(v as ImportPolarity)}>
                <Stack gap="xs">
                  {polarityChoices.map((p) => (
                    <Radio
                      key={p}
                      value={p}
                      label={POLARITY_LABEL[p]}
                    />
                  ))}
                </Stack>
              </Radio.Group>
              {polarity === 'jailbreak-template' ? (
                <Textarea
                  label="Goal"
                  description="Put into each template ({{goal}}); the default asks for the planted code word."
                  value={goal}
                  autosize
                  minRows={1}
                  onChange={(e) => setGoal(e.currentTarget.value)}
                />
              ) : null}
              {polarity === 'prompt-injection' || polarity === 'jailbreak-template' ? (
                <Textarea
                  label="Planted system prompt"
                  description="Must contain {{canary}}, where each attempt's code word is planted. Empty uses the default."
                  value={plantedSystem}
                  autosize
                  minRows={2}
                  onChange={(e) => setPlantedSystem(e.currentTarget.value)}
                  error={plantedSystem.trim() && !plantedSystem.includes('{{canary}}') ? 'Put {{canary}} in the system prompt.' : undefined}
                />
              ) : null}
              {polarity === 'harmful-request' ? (
                <Switch
                  label="Add a judge lens"
                  description="Needs a judge model on the campaign. Without a judge, an answer to a harmful request goes to review."
                  checked={useJudge}
                  onChange={(e) => setUseJudge(e.currentTarget.checked)}
                />
              ) : null}
            </Stack>
          </FormSection>

          <FormSection title="Probes">
            <Stack gap="md">
              <Group grow align="flex-start">
                <TextInput label="Name prefix" description="Probes are named “<prefix> · <category>”." value={namePrefix} onChange={(e) => setNamePrefix(e.currentTarget.value)} />
                <Select
                  label="Grouping"
                  data={[
                    { value: 'per-category', label: 'One probe per category' },
                    { value: 'single', label: 'One probe for all rows' },
                  ]}
                  value={grouping}
                  allowDeselect={false}
                  onChange={(v) => setGrouping(v === 'single' ? 'single' : 'per-category')}
                />
                <NumberInput
                  label="Attempts per probe"
                  description={`Up to ${IMPORT_LIMITS.maxAttemptsPerProbe}; more rows are sampled.`}
                  value={attemptsPerProbe}
                  min={1}
                  max={IMPORT_LIMITS.maxAttemptsPerProbe}
                  allowDecimal={false}
                  allowNegative={false}
                  onChange={setAttemptsPerProbe}
                  error={attemptsValid ? undefined : `Enter a whole number from 1 to ${IMPORT_LIMITS.maxAttemptsPerProbe}.`}
                />
              </Group>
              <Group grow align="flex-start">
                <TextInput label="Source name" value={sourceName} onChange={(e) => setSourceName(e.currentTarget.value)} placeholder="Dataset or project name" maxLength={IMPORT_LIMITS.maxSourceNameChars} />
                <TextInput label="Licence" value={sourceLicense} onChange={(e) => setSourceLicense(e.currentTarget.value)} placeholder="e.g. MIT" maxLength={IMPORT_LIMITS.maxSourceLicenseChars} />
              </Group>

              <Table withTableBorder fz="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Category</Table.Th>
                    <Table.Th w={260}>OWASP (2025)</Table.Th>
                    <Table.Th w={130}>Severity</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {categories.slice(0, IMPORT_LIMITS.maxProbesPerImport).map((c) => (
                    <Table.Tr key={c || '__single'}>
                      <Table.Td>{c || (grouping === 'single' ? 'All rows' : 'No category')}</Table.Td>
                      <Table.Td>
                        <Select
                          size="xs"
                          aria-label={`OWASP category for ${c || 'all rows'}`}
                          placeholder="Default for this kind"
                          data={OWASP_OPTIONS}
                          value={owaspByCategory[c] ?? null}
                          clearable
                          onChange={(v) => setOwaspByCategory((m) => ({ ...m, [c]: v ?? '' }))}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Select
                          size="xs"
                          aria-label={`Severity for ${c || 'all rows'}`}
                          placeholder="Default"
                          data={SEVERITY_OPTIONS}
                          value={severityByCategory[c] || null}
                          clearable
                          onChange={(v) => setSeverityByCategory((m) => ({ ...m, [c]: v ?? '' }))}
                        />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
              {categories.length > IMPORT_LIMITS.maxProbesPerImport ? (
                <Text size="xs" c="dimmed">
                  An import creates at most {IMPORT_LIMITS.maxProbesPerImport} probes; the largest categories come first.
                </Text>
              ) : null}
            </Stack>
          </FormSection>
        </>
      ) : null}

      {lastStep === 2 ? (
        <FormSection title="Summary">
          <Stack gap="xs" data-testid="redteam-import-summary">
            {plan.error ? <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>{plan.error}</Alert> : null}
            <Text size="sm">
              {probes.length > 0
                ? `Creates ${probes.length} probe${probes.length === 1 ? '' : 's'} with ${attemptTotal} attempt${attemptTotal === 1 ? '' : 's'}${
                    nativeDrafts ? '' : `, named “${namePrefix.trim() || 'Imported'}${grouping === 'per-category' ? ' · <category>' : ''}”`
                  }.`
                : 'Nothing to import yet.'}
            </Text>
            <Text size="xs" c="dimmed">
              Source {summarySource}
              {!nativeDrafts && (sourceLicense.trim() || format?.source.license) ? `, licence ${sourceLicense.trim() || format?.source.license}` : ''}.
              Source and licence are stored on each probe.
            </Text>
            {(plan.plan?.sampledOut ?? 0) > 0 ? (
              <Text size="xs" c="dimmed">{plan.plan?.sampledOut.toLocaleString('en-US')} usable rows are left out: probes keep a sample of {attemptsNumber} attempts.</Text>
            ) : null}
            {(plan.plan?.droppedGroups.length ?? 0) > 0 ? (
              <Text size="xs" c="dimmed">Left out (past {IMPORT_LIMITS.maxProbesPerImport} probes): {plan.plan?.droppedGroups.join(', ')}.</Text>
            ) : null}
            {(plan.plan?.warnings ?? []).map((w, i) => <Text key={`${i}-${w}`} size="xs" c="yellow.8">{w}</Text>)}
            {probes.length > 0 ? (
              <Group gap={6}>
                {probes.slice(0, IMPORT_LIMITS.maxProbesPerImport).map((p) => (
                  <Badge key={p.name} size="sm" variant="light" color={p.polarity === 'over-refusal' ? 'blue' : 'gray'}>
                    {p.name} · {p.attempts.length}
                  </Badge>
                ))}
              </Group>
            ) : null}
          </Stack>
        </FormSection>
      ) : null}
    </FormShell>
  );
}

function FormatGroupRows({ title, formats }: { title: string; formats: ImportFormat[] }) {
  return (
    <>
      <Table.Tr>
        <Table.Td colSpan={4}><Text size="xs" fw={600}>{title}</Text></Table.Td>
      </Table.Tr>
      {formats.map((f) => (
        <Table.Tr key={f.id}>
          <Table.Td>{f.label}</Table.Td>
          <Table.Td>{f.fileType.toUpperCase()}</Table.Td>
          <Table.Td>{f.source.license ?? '—'}</Table.Td>
          <Table.Td>{f.note ?? ''}</Table.Td>
        </Table.Tr>
      ))}
    </>
  );
}
