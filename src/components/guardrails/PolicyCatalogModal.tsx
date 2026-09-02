'use client';

/**
 * THE POLICY CATALOG — the screen that opens when someone presses "Add policy".
 *
 * ── THE ONE RULE THIS FILE OBEYS ────────────────────────────────────────────
 * Nothing family-specific is written here. Not a name, not a label, not a
 * description, not an order, not a hook list, not a starting configuration.
 * Every one of those comes from `catalog/families.ts`, and this file only knows
 * how to draw whatever it finds there.
 *
 * That is not tidiness, it is the contract the catalog was built for: adding a
 * tenth family must be ONE entry in `catalog/families.ts` and no UI change at
 * all. The screen it replaced could not make that promise — its picker carried
 * its own nine-row list, which is exactly how the engine ended up shipping four
 * families (regex, secrets, tool access, webhook) that no operator could reach.
 *
 * `guardrail-policy-cards.test.ts` enforces it two ways: the sections are
 * asserted to cover `catalogEntries()` exactly, and the SOURCE of this file is
 * scanned for any family id or family label appearing as a literal. If you find
 * yourself typing one, the catalog is missing a field — add it there.
 *
 * ── WHY THE GROUP HEADINGS ARE THE ONE EXCEPTION ────────────────────────────
 * `PolicyCatalogGroup` is a closed union of FOUR shelves, and the catalog gives
 * them ids and doc comments but no display copy. So the headings live here,
 * typed as a total record: a new shelf is a compile error rather than a blank
 * heading, and an unknown one still renders (its id, title-cased) rather than
 * throwing. A shelf is not a family — a tenth family joins one of these four
 * and this map does not move.
 *
 * ── AND WHY THE ICON REGISTRY IS NOT AN EXCEPTION ───────────────────────────
 * The catalog stores an icon NAME (`shield-lock`), deliberately, so that module
 * stays free of React and can be imported by the server and by a plain unit
 * test. Somebody has to turn a name into a component, and it cannot be a
 * wildcard import: `import * as Icons from '@tabler/icons-react'` pulls several
 * thousand components into the client bundle.
 *
 * So there is a registry keyed by ICON NAME — never by family — and an unknown
 * name falls back to a generic shield instead of rendering nothing. A tenth
 * family therefore appears in this catalog with no edit here whatever icon it
 * names; registering a nicer glyph for it is a later, optional nicety, and the
 * test pins that the fallback works so nobody has to find that out from a
 * blank card.
 *
 * ── WHY FormShell AND NOT Modal ─────────────────────────────────────────────
 * Every create/edit surface in this console is a full-screen overlay; the small
 * Mantine `Modal` is reserved for confirmations. Picking a family is the first
 * step of creating something, so it gets the overlay. The name says "modal"
 * because that is what it is to its caller.
 *
 * ── WHAT THIS COMPONENT MAY NOT IMPORT ──────────────────────────────────────
 * `catalog/*` and `hooks/contract` only. `hooks/legacy` and `hooks/engine` both
 * import the `@/lib/database` barrel, which constructs providers on load; either
 * one in a client bundle is a build failure.
 */

import { useMemo, useState } from 'react';
import { Badge, Group, SimpleGrid, Stack, Text, TextInput, ThemeIcon } from '@mantine/core';
import {
  IconAlertOctagon,
  IconFilterX,
  IconFingerprint,
  IconKey,
  IconPlus,
  IconRegex,
  IconRobot,
  IconSearch,
  IconShieldCheck,
  IconShieldLock,
  IconTool,
  IconWebhook,
} from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import FormShell, { SourceCard } from '@/components/common/ui/FormShell';
import {
  POLICY_CATALOG_GROUPS,
  catalogEntries,
  defaultPolicy,
  searchCatalog,
} from '@/lib/services/guardrail/catalog';
import type {
  AnyPolicyFamilySpec,
  PolicyCatalogGroup,
} from '@/lib/services/guardrail/catalog';
import type { GuardrailPolicy, HookId, PolicyFamily } from '@/lib/services/guardrail/hooks/contract';

// ── icons ───────────────────────────────────────────────────────────────────

/**
 * Icon NAME to component. Keyed by the name the catalog stores, so this map
 * knows nothing about families and a family that renames its icon needs no
 * edit here — only one that introduces a glyph nobody has registered yet, and
 * that one still renders.
 *
 * Explicit named imports rather than a namespace import: the icon package has
 * thousands of components and a wildcard would ship all of them to the browser.
 */
const ICONS: Readonly<Record<string, Icon>> = {
  'alert-octagon': IconAlertOctagon,
  'filter-x': IconFilterX,
  fingerprint: IconFingerprint,
  key: IconKey,
  regex: IconRegex,
  robot: IconRobot,
  'shield-lock': IconShieldLock,
  tool: IconTool,
  webhook: IconWebhook,
};

/** The glyph for an icon name nobody has registered. Generic on purpose: a
 *  recognisable placeholder beats an empty box, and beats a crash. */
export const FALLBACK_POLICY_ICON: Icon = IconShieldCheck;

/** Never `undefined`, never throws. A card with no icon reads as a broken card,
 *  and a family should not be unreachable because of a missing glyph. */
export function policyFamilyIcon(name: string | undefined): Icon {
  if (!name) return FALLBACK_POLICY_ICON;
  return ICONS[name] ?? FALLBACK_POLICY_ICON;
}

/** Whether this icon name has a glyph of its own. Only the test and a future
 *  audit care; the UI is happy with the fallback. */
export function hasRegisteredIcon(name: string | undefined): boolean {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(ICONS, name);
}

// ── the shelves ─────────────────────────────────────────────────────────────

export interface PolicyCatalogGroupMeta {
  label: string;
  /** One line under the heading. It says what the shelf is FOR, in the words an
   *  operator arrives with — they know what they want to stop, not which engine
   *  stops it. */
  description: string;
}

/**
 * The four shelves' display copy, typed as a total record so a fifth shelf is a
 * compile error here rather than a blank heading on the screen.
 *
 * Deliberately keyed by group and not by family: a tenth family joins one of
 * these and changes nothing in this map.
 */
export const POLICY_CATALOG_GROUP_META: Readonly<
  Record<PolicyCatalogGroup, PolicyCatalogGroupMeta>
> = {
  data: {
    label: 'Sensitive data',
    description: 'Something confidential is in the text — who someone is, or how to authenticate as them.',
  },
  content: {
    label: 'Unacceptable content',
    description: 'The text itself is the problem: wording you have banned, harmful material, or an attempt to talk the assistant out of its instructions.',
  },
  access: {
    label: 'What the assistant may do',
    description: 'The assistant is reaching for a tool, a domain or a file it should not. The only shelf that can stop an action before it happens.',
  },
  custom: {
    label: 'Rules you write',
    description: 'Nothing above fits. Describe the rule yourself — as a pattern, as prose, or as your own service.',
  },
};

/** Title-cases an id, for a shelf the map has not been taught yet. */
function humanise(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function catalogGroupMeta(group: PolicyCatalogGroup): PolicyCatalogGroupMeta {
  return (
    POLICY_CATALOG_GROUP_META[group] ?? { label: humanise(String(group)), description: '' }
  );
}

// ── one card ────────────────────────────────────────────────────────────────

/**
 * Everything a catalog card draws, as data.
 *
 * Pulled out of the JSX so the card's content can be asserted in a plain unit
 * test — this repo's tests run in a node environment with nothing to render
 * into, and a card whose copy only exists inside a component is a card nothing
 * can check.
 */
export interface CatalogEntryView {
  family: PolicyFamily;
  label: string;
  description: string;
  /** The catalog's icon name, already resolved to a component. */
  icon: Icon;
  color: string;
  group: PolicyCatalogGroup;
  /** From `POLICY_VALID_HOOKS`, via the spec. Never restated here. */
  hooks: readonly HookId[];
  /** From `STREAM_ELIGIBLE_FAMILIES`, via the spec. NECESSARY, not sufficient:
   *  a stream-safe family still needs a bounded match length from its own
   *  configuration, which is the policy editor's problem, not the catalog's. */
  streamSafe: boolean;
  keywords: readonly string[];
}

export function describeCatalogEntry(spec: AnyPolicyFamilySpec): CatalogEntryView {
  return {
    family: spec.family,
    label: spec.label,
    description: spec.description,
    icon: policyFamilyIcon(spec.icon),
    color: spec.color,
    group: spec.catalog.group,
    hooks: spec.validHooks,
    streamSafe: spec.streamSafe,
    keywords: spec.catalog.keywords,
  };
}

// ── the sections ────────────────────────────────────────────────────────────

export interface PolicyCatalogSection {
  group: PolicyCatalogGroup;
  label: string;
  description: string;
  entries: AnyPolicyFamilySpec[];
}

/**
 * The catalog as the screen shows it: grouped by shelf, shelves in the
 * catalog's own order, entries in the catalog's own order, filtered by the
 * search box.
 *
 * A shelf with no match is DROPPED rather than rendered empty, so a search
 * narrows the page instead of leaving four headings over nothing. An empty
 * result is an empty array, which is what tells the screen to say so.
 */
export function catalogSections(query = ''): PolicyCatalogSection[] {
  const matches = searchCatalog(query);
  const sections: PolicyCatalogSection[] = [];

  for (const group of POLICY_CATALOG_GROUPS) {
    const entries = matches.filter((spec) => spec.catalog.group === group);
    if (entries.length === 0) continue;
    const meta = catalogGroupMeta(group);
    sections.push({ group, label: meta.label, description: meta.description, entries });
  }

  // A shelf the catalog uses but `POLICY_CATALOG_GROUPS` does not list would
  // otherwise vanish silently, taking its families with it. `catalogEntries`
  // already sorts such a group last; this keeps it visible.
  const listed = new Set<PolicyCatalogGroup>(POLICY_CATALOG_GROUPS);
  const strays = matches.filter((spec) => !listed.has(spec.catalog.group));
  for (const stray of strays) {
    const existing = sections.find((section) => section.group === stray.catalog.group);
    if (existing) {
      existing.entries.push(stray);
      continue;
    }
    const meta = catalogGroupMeta(stray.catalog.group);
    sections.push({
      group: stray.catalog.group,
      label: meta.label,
      description: meta.description,
      entries: [stray],
    });
  }

  return sections;
}

// ── the screen ──────────────────────────────────────────────────────────────

export interface PolicyCatalogModalProps {
  opened: boolean;
  onClose: () => void;
  /**
   * A family was picked, and here is the fresh policy `spec.defaults()` made.
   *
   * ITS `id` IS A SEED, NOT A UNIQUE ID. The catalog has no idea what else is
   * on the guardrail, so it derives one from the family name and stops there.
   * The caller owns the policy array, so the caller is what makes the id free
   * — `nextPolicyId` in `GuardrailPolicyCards` is that step. Two policies
   * sharing an id makes a finding untraceable to the rule that raised it, and
   * the server refuses the save.
   *
   * The `spec` comes along so a caller can label the new policy without looking
   * the family up again. WHERE it lands is not passed either way: the policy
   * array is the execution order and `hooks` is the whole of placement, so the
   * caller appends and there is nothing for this screen to choose.
   */
  onSelect: (policy: GuardrailPolicy, spec: AnyPolicyFamilySpec) => void;
}

export default function PolicyCatalogModal({
  opened,
  onClose,
  onSelect,
}: PolicyCatalogModalProps) {
  const [query, setQuery] = useState('');
  const sections = useMemo(() => catalogSections(query), [query]);
  const total = useMemo(() => catalogEntries().length, []);

  const close = () => {
    setQuery('');
    onClose();
  };

  const pick = (spec: AnyPolicyFamilySpec) => {
    const created = defaultPolicy(spec.family);
    // Only for a family the catalog cannot build, which the catalog test
    // forbids. Doing nothing beats handing the caller `undefined` to append.
    if (!created) return;
    setQuery('');
    onSelect(created, spec);
  };

  return (
    <FormShell
      open={opened}
      onClose={close}
      title="Add a policy"
      subtitle="What should this guardrail look for?"
      icon={<IconPlus size={18} />}
      footerStatus={
        query.trim().length > 0
          ? `${sections.reduce((sum, section) => sum + section.entries.length, 0)} of ${total}`
          : undefined
      }
    >
      <Stack gap="lg">
        {/* The catalog searches labels, descriptions AND keywords, so the
            placeholder invites what an operator is actually trying to stop
            rather than the name of a family they have not met yet. */}
        <TextInput
          placeholder="Search — what it detects, or what you would call it"
          leftSection={<IconSearch size={15} />}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />

        {sections.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="xl">
            Nothing matches “{query.trim()}”. Try what it detects rather than what it is called —
            the catalog searches descriptions and keywords too.
          </Text>
        ) : (
          sections.map((section) => (
            <Stack key={section.group} gap="xs">
              <div>
                <Text fw={600} size="sm">
                  {section.label}
                </Text>
                {section.description && (
                  <Text size="xs" c="dimmed" maw={720}>
                    {section.description}
                  </Text>
                )}
              </div>

              <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
                {section.entries.map((spec) => {
                  const view = describeCatalogEntry(spec);
                  const EntryIcon = view.icon;
                  return (
                    <SourceCard
                      key={view.family}
                      selected={false}
                      onClick={() => pick(spec)}
                      icon={
                        <ThemeIcon size={28} radius="sm" variant="light" color={view.color}>
                          <EntryIcon size={16} />
                        </ThemeIcon>
                      }
                      title={view.label}
                      description={
                        <Stack gap={8}>
                          <span>{view.description}</span>
                          <Group gap={4} wrap="wrap">
                            {view.hooks.map((hook) => (
                              <Badge
                                key={hook}
                                size="xs"
                                variant="default"
                                style={{ fontFamily: 'monospace', textTransform: 'none' }}
                              >
                                {hook}
                              </Badge>
                            ))}
                            {view.streamSafe && (
                              <Badge size="xs" variant="light" color="teal">
                                can stream
                              </Badge>
                            )}
                          </Group>
                        </Stack>
                      }
                    />
                  );
                })}
              </SimpleGrid>
            </Stack>
          ))
        )}
      </Stack>
    </FormShell>
  );
}
