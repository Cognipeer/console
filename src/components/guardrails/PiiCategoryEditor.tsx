'use client';

/**
 * THE REFERENCED PII POLICY, IN THE DRAWER.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * A `pii` guardrail policy points at an `IPiiPolicy` by key, and WHICH
 * CATEGORIES COUNT AS PERSONAL DATA lives on that row. So the operator who
 * opened this drawer to decide "does this catch a TCKN" was shown a picker and
 * a one-line summary, and had to leave, find the policy under Security → PII,
 * read it, and come back. The decision was reachable and the drawer was not
 * where it was made.
 *
 * ── WHAT IT IS ALLOWED TO SAY, AND WHAT IT IS NOT ───────────────────────────
 * The split matters more here than anywhere else in this form, because the two
 * halves live in different places and look like one setting:
 *   · The PII POLICY decides WHAT IS FOUND — the categories, the custom
 *     patterns, and the language scope (`pickActiveBuiltins` filters on
 *     `languages`, and only a category with `categories[id] === true` runs).
 *     That is what this panel edits.
 *   · THE GUARDRAIL POLICY decides WHAT HAPPENS to a match. The PII policy's
 *     own `defaultAction` is NEVER used on this path: `families/pii.ts`
 *     always passes an explicit action (`resolveScanAction`), precisely so a
 *     policy shared by three guardrails cannot decide for all three. This
 *     panel therefore SHOWS that field and refuses to edit it — an operator who
 *     set it here expecting this guardrail to start blocking would be editing a
 *     field this path ignores, and every other consumer of the policy at the
 *     same time.
 *
 * ── IT EDITS SHARED STATE, AND SAYS SO TWICE ────────────────────────────────
 * Every guardrail pointing at this policy changes with it. Silently writing
 * that from a nested drawer would be worse than making the operator navigate,
 * so: the panel names the asset, counts the guardrails that reference it, and
 * SAVES ONLY ON DEMAND. A toggle moves a local draft; nothing reaches
 * `pii_policies` until Save is pressed. Its draft is deliberately NOT part of
 * the drawer's own dirty check — they are two different records with two
 * different Save buttons, and pretending otherwise would let "Apply" on the
 * guardrail imply a write to a shared asset.
 *
 * ── THE CATALOG IS READ, NEVER COPIED ───────────────────────────────────────
 * Labels, descriptions, severities, language scope and mask strategy all come
 * from `services/pii/categories` — the same table the detector compiles. A list
 * hard-coded here is a list that will eventually offer a category the detector
 * dropped. The module is import-safe from a client bundle: its only import is a
 * `import type` of `PiiLanguage`, which is erased.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Stack,
  Switch,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconExternalLink,
  IconInfoCircle,
  IconUsers,
} from '@tabler/icons-react';
import {
  PII_CATEGORIES,
  categoryDescription,
  categoryLabel,
  filterCategoriesByLanguages,
} from '@/lib/services/pii/categories';
import type { PiiCategoryDefinition, PiiMaskStrategy } from '@/lib/services/pii/categories';
import type { PiiAction, PiiLanguage } from '@/lib/services/pii/types';
import { useLocale } from '@/lib/i18n';
import type { PolicyResourceDetailProps } from './PolicyFieldRenderer';

// ── the wire shapes ─────────────────────────────────────────────────────────

/** `PiiServicePolicyView`, as much of it as this panel reads. Declared rather
 *  than imported: the service module reaches `@/lib/database`, and this is a
 *  client component. */
interface PiiPolicyView {
  id: string;
  key: string;
  name: string;
  description?: string;
  enabled: boolean;
  defaultAction: PiiAction;
  categories?: Record<string, boolean>;
  languages?: PiiLanguage[];
  /** Read for display and ECHOED VERBATIM on save — see the note there. The
   *  declared shape is the part this panel renders; a pattern's `pattern` and
   *  `flags` ride along untouched through the JSON round trip. */
  customPatterns?: Array<{
    id: string;
    categoryId: string;
    label: string;
    severity?: 'low' | 'medium' | 'high';
    enabled: boolean;
  }>;
  metadata?: Record<string, unknown>;
}

/** Only the part of a guardrail this panel counts on — a legacy row with no
 *  `hooks` cannot reference a PII policy by key, so it contributes nothing. */
interface GuardrailReferenceRow {
  hooks?: { policies?: Array<{ family?: string; piiPolicyKey?: string }> };
}

// ── pure helpers ────────────────────────────────────────────────────────────

/**
 * Total on purpose: a language added to `PiiLanguage` is a compile error here
 * rather than a heading that reads "de".
 */
const LANGUAGE_LABEL: Readonly<Record<PiiLanguage, string>> = {
  global: 'Every language',
  en: 'English',
  tr: 'Turkish',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  ar: 'Arabic',
  ja: 'Japanese',
  zh: 'Chinese',
};

const SEVERITY_COLOR: Readonly<Record<'low' | 'medium' | 'high', string>> = {
  low: 'gray',
  medium: 'yellow',
  high: 'red',
};

/**
 * What masking does to this category, in words.
 *
 * Per-CATEGORY and therefore worth a row of its own: the mask strategy is the
 * one genuinely per-category answer to "what happens to a match" that the
 * schema actually holds. Exhaustive over `PiiMaskStrategy`, so a new strategy
 * is a compile error rather than a blank line.
 */
export function describeMask(mask: PiiMaskStrategy): string {
  switch (mask.kind) {
    case 'fixed':
      return `masked as ${mask.replacement}`;
    case 'keep-domain':
      return 'masked except the domain';
    case 'keep-last':
      return `masked except the last ${mask.tail}`;
    case 'keep-edges':
      return mask.tail > 0
        ? `masked except the first ${mask.head} and last ${mask.tail}`
        : `masked except the first ${mask.head}`;
  }
}

/** A category runs only when the policy says `true` — a MISSING key is off, not
 *  a default. That is `pickActiveBuiltins` exactly, and the difference matters:
 *  half the catalog ships `defaultEnabled: true` and would draw as on. */
export function categoryIsOn(categories: Record<string, boolean> | undefined, id: string): boolean {
  return categories?.[id] === true;
}

/** How many saved guardrails scan through this key. Counted through the hook
 *  configuration, which is where a `pii` policy's reference lives. */
export function countGuardrailsUsing(
  guardrails: readonly GuardrailReferenceRow[],
  policyKey: string,
): number {
  return guardrails.filter((guardrail) =>
    (guardrail.hooks?.policies ?? []).some(
      (policy) => policy.family === 'pii' && policy.piiPolicyKey === policyKey,
    ),
  ).length;
}

/** The catalog, split into the sections the panel draws: one per language
 *  scope, in catalog order, `global` first because it always applies. */
export function groupCategoriesByScope(
  categories: readonly PiiCategoryDefinition[],
): Array<{ scope: PiiLanguage; categories: PiiCategoryDefinition[] }> {
  const out: Array<{ scope: PiiLanguage; categories: PiiCategoryDefinition[] }> = [];
  for (const category of categories) {
    // A built-in declares one scope in practice; the first is the section it
    // is filed under, and `languages` is still what decides whether it runs.
    const scope = category.languages[0] ?? 'global';
    const section = out.find((candidate) => candidate.scope === scope);
    if (section) section.categories.push(category);
    else out.push({ scope, categories: [category] });
  }
  return out.sort(
    (a, b) => Number(a.scope !== 'global') - Number(b.scope !== 'global'),
  );
}

// ── the panel ───────────────────────────────────────────────────────────────

type LoadState = 'loading' | 'ready' | 'missing' | 'failed';

export default function PiiCategoryEditor({ keys, readOnly }: PolicyResourceDetailProps) {
  // `pii_policy` is a single reference — one key, always. Taking the first
  // rather than assuming exactly one keeps this honest if a family ever points
  // at several: it shows the one it can, instead of throwing.
  const policyKey = keys[0];
  const locale = useLocale();

  const [state, setState] = useState<LoadState>('loading');
  const [policy, setPolicy] = useState<PiiPolicyView | null>(null);
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const [usedBy, setUsedBy] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const res = await fetch('/api/pii/policies', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load PII policies');
      const data = await res.json();
      const rows: PiiPolicyView[] = data?.policies ?? [];
      const found = rows.find((row) => row.key === policyKey) ?? null;
      setPolicy(found);
      setDraft({ ...(found?.categories ?? {}) });
      setState(found ? 'ready' : 'missing');
    } catch {
      // Silent, and deliberately so: this is a detail panel inside a form the
      // operator is in the middle of. A failed read is reported in place (see
      // the 'failed' branch) rather than as a toast over their typing.
      setState('failed');
    }
  }, [policyKey]);

  useEffect(() => {
    void load();
  }, [load]);

  // Secondary and non-blocking: the panel is worth showing without the count,
  // and the sentence it belongs to is written to survive its absence.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/guardrails', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const rows: GuardrailReferenceRow[] = data?.guardrails ?? [];
        if (!cancelled) setUsedBy(countGuardrailsUsing(rows, policyKey));
      } catch {
        // The warning stands without a number.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [policyKey]);

  const stored = policy?.categories;
  const changed = useMemo(() => {
    const ids = new Set([...Object.keys(stored ?? {}), ...Object.keys(draft)]);
    return [...ids].filter((id) => categoryIsOn(stored, id) !== categoryIsOn(draft, id));
  }, [stored, draft]);

  /** The language filter the detector will apply, computed with the detector's
   *  own function so the "not scanned" note cannot disagree with the scan. */
  const inScope = useMemo(
    () => new Set(filterCategoriesByLanguages(policy?.languages).map((category) => category.id)),
    [policy?.languages],
  );

  const sections = useMemo(() => groupCategoriesByScope(PII_CATEGORIES), []);

  const save = async () => {
    if (!policy) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/pii/policies/${policy.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // THE WHOLE POLICY, not just the field that changed, and this is NOT
        // over-posting to be tidied up later. `PATCH /pii/policies/:id` builds
        // its update object with a key for every accepted field and hands it to
        // `$set` — so a field the caller omits arrives as `undefined`, and the
        // Mongo driver is constructed without `ignoreUndefined`, which
        // serialises `undefined` as NULL. A body of `{ categories }` alone
        // would therefore null the policy's name, its languages and its
        // `enabled` flag, and a null `enabled` makes `scanWithPolicy` return no
        // findings at all: every guardrail using this policy would silently
        // stop detecting. Echoing what was loaded is what the policy's own page
        // does, for the same reason.
        body: JSON.stringify({
          name: policy.name,
          description: policy.description,
          enabled: policy.enabled,
          defaultAction: policy.defaultAction,
          categories: draft,
          customPatterns: policy.customPatterns,
          languages: policy.languages,
          ...(policy.metadata ? { metadata: policy.metadata } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Failed to save the PII policy');
      }
      const data = await res.json();
      const saved: PiiPolicyView | undefined = data?.policy;
      if (saved) {
        setPolicy(saved);
        setDraft({ ...(saved.categories ?? {}) });
      }
      notifications.show({
        title: 'PII policy saved',
        message: `“${policy.name}” now scans for ${
          Object.values(draft).filter(Boolean).length
        } categories — everywhere it is used.`,
        color: 'green',
      });
    } catch (error) {
      notifications.show({
        title: 'Could not save the PII policy',
        message: error instanceof Error ? error.message : 'Unknown error',
        color: 'red',
      });
    } finally {
      setSaving(false);
    }
  };

  if (state === 'loading') {
    return (
      <Group gap={8} p="xs">
        <Loader size="xs" />
        <Text size="xs" c="dimmed">
          Reading “{policyKey}”…
        </Text>
      </Group>
    );
  }

  if (state === 'failed') {
    return (
      <Alert color="gray" variant="light" p="xs">
        <Group justify="space-between" wrap="nowrap">
          <Text size="xs">
            The PII policies could not be read, so its categories are not shown here. The
            reference itself is unaffected.
          </Text>
          <Anchor component="button" type="button" size="xs" onClick={() => void load()}>
            Retry
          </Anchor>
        </Group>
      </Alert>
    );
  }

  if (state === 'missing' || !policy) {
    return (
      <Alert color="orange" variant="light" icon={<IconAlertTriangle size={14} />} p="xs">
        <Text size="xs">
          No PII policy with the key “{policyKey}” is visible on this project. It may have been
          deleted or belong elsewhere — this policy would then fail its scan rather than pass
          silently, per its failure mode.
        </Text>
      </Alert>
    );
  }

  return (
    <Card withBorder padding="sm" radius="sm">
      <Stack gap="sm">
        {/* ── whose settings these are ── */}
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <div>
            <Group gap={6}>
              <Text size="sm" fw={600}>
                {policy.name}
              </Text>
              <Badge size="xs" variant="light" color="gray">
                {policy.key}
              </Badge>
              {!policy.enabled && (
                <Badge size="xs" color="red" variant="light">
                  Disabled
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed">
              Scans:{' '}
              {policy.languages && policy.languages.length > 0
                ? policy.languages
                    // The `??` is not dead code the type system can see: this
                    // list arrives as JSON, and a hand-written row may hold a
                    // language the union does not.
                    .map((language) => LANGUAGE_LABEL[language] ?? language)
                    .join(', ')
                : 'every language in the catalog'}
            </Text>
          </div>
          <Anchor
            href={`/dashboard/pii/${policy.id}`}
            target="_blank"
            rel="noreferrer"
            size="xs"
            style={{ whiteSpace: 'nowrap' }}
          >
            <Group gap={4} wrap="nowrap">
              Open policy
              <IconExternalLink size={12} />
            </Group>
          </Anchor>
        </Group>

        <Alert color="blue" variant="light" icon={<IconUsers size={14} />} p="xs">
          <Text size="xs">
            These categories belong to the PII policy, not to this guardrail
            {usedBy === null
              ? '. Every guardrail that scans through it sees the same ones, so a change here changes all of them.'
              : usedBy === 1
                ? '. One saved guardrail scans through it today.'
                : `. ${usedBy} saved guardrails scan through it today, and a change here changes all of them.`}
          </Text>
        </Alert>

        {!policy.enabled && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={14} />} p="xs">
            <Text size="xs">
              This PII policy is switched off. A scan through a disabled policy returns NO findings,
              so this guardrail policy runs, costs a round trip and finds nothing — whatever is
              switched on below.
            </Text>
          </Alert>
        )}

        {/* ── the half this panel must not edit ── */}
        <Alert color="gray" variant="light" icon={<IconInfoCircle size={14} />} p="xs">
          <Text size="xs">
            What HAPPENS to a match is decided above, by this guardrail policy&apos;s action and its
            “How a match is rewritten” setting. The PII policy&apos;s own default action (
            {policy.defaultAction}) is not used on this path — it applies to callers that scan
            through the PII API directly. There is no per-category action in the schema: everything
            switched on here resolves to the same action.
          </Text>
        </Alert>

        {/* ── one row per category ── */}
        {sections.map((section) => (
          <Stack gap={4} key={section.scope}>
            <Text size="xs" fw={600} tt="uppercase" c="dimmed">
              {LANGUAGE_LABEL[section.scope]}
            </Text>
            {section.categories.map((category) => {
              const on = categoryIsOn(draft, category.id);
              const scoped = inScope.has(category.id);
              return (
                <Group key={category.id} gap={8} wrap="nowrap" align="flex-start">
                  <Switch
                    size="xs"
                    mt={2}
                    checked={on}
                    disabled={readOnly || saving}
                    aria-label={categoryLabel(category, locale)}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, [category.id]: event.currentTarget.checked }))
                    }
                  />
                  <div style={{ flex: 1 }}>
                    <Group gap={6}>
                      <Text size="xs" fw={500}>
                        {categoryLabel(category, locale)}
                      </Text>
                      <Badge size="xs" variant="light" color={SEVERITY_COLOR[category.severity]}>
                        {category.severity}
                      </Badge>
                      {on && !scoped && (
                        // Switched on and still inert. Two settings on two
                        // different rows conspire to produce it, which is
                        // exactly the kind of thing nobody finds by reading.
                        <Badge size="xs" variant="light" color="orange">
                          not scanned
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed">
                      {categoryDescription(category, locale)} · {describeMask(category.mask)}
                      {on && !scoped
                        ? ' · outside this policy’s language list, so it never runs'
                        : ''}
                    </Text>
                  </div>
                </Group>
              );
            })}
          </Stack>
        ))}

        {/* Read-only, because a pattern needs a regex editor and a validator,
            and that editor already exists on the policy's own page. Listed
            because they DO produce findings, and a panel claiming to show what
            counts as personal data while hiding them would be wrong. */}
        {policy.customPatterns && policy.customPatterns.length > 0 && (
          <Stack gap={4}>
            <Text size="xs" fw={600} tt="uppercase" c="dimmed">
              Custom patterns
            </Text>
            {policy.customPatterns.map((pattern) => (
              <Group key={pattern.id} gap={6}>
                <Badge
                  size="xs"
                  variant="light"
                  color={pattern.enabled ? SEVERITY_COLOR[pattern.severity ?? 'medium'] : 'gray'}
                >
                  {pattern.enabled ? (pattern.severity ?? 'medium') : 'off'}
                </Badge>
                <Text size="xs">{pattern.label}</Text>
                <Text size="xs" c="dimmed">
                  {pattern.categoryId}
                </Text>
              </Group>
            ))}
            <Text size="xs" c="dimmed">
              Edited on the policy&apos;s own page — a pattern needs its regex checked before it is
              stored.
            </Text>
          </Stack>
        )}

        {/* ── the shared write, on demand ── */}
        {!readOnly && (
          <Group justify="space-between">
            <Text size="xs" c={changed.length > 0 ? 'orange' : 'dimmed'}>
              {changed.length === 0
                ? 'No changes to the PII policy.'
                : `${changed.length} category change${changed.length === 1 ? '' : 's'} not saved yet — “Apply” on this policy does not write them.`}
            </Text>
            <Group gap="xs">
              <Button
                size="compact-xs"
                variant="subtle"
                disabled={changed.length === 0 || saving}
                onClick={() => setDraft({ ...(policy.categories ?? {}) })}
              >
                Revert
              </Button>
              <Button
                size="compact-xs"
                loading={saving}
                disabled={changed.length === 0}
                onClick={() => void save()}
              >
                Save to “{policy.name}”
              </Button>
            </Group>
          </Group>
        )}
      </Stack>
    </Card>
  );
}
