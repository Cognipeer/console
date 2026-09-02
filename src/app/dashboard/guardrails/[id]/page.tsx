'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Center,
  Code,
  Collapse,
  CopyButton,
  Divider,
  Group,
  Loader,
  Menu,
  Modal,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Tabs,
  Text,
  ThemeIcon,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconBolt,
  IconCheck,
  IconChartBar,
  IconChevronDown,
  IconChevronRight,
  IconCode,
  IconCopy,
  IconDots,
  IconInfoCircle,
  IconLayoutGrid,
  IconListCheck,
  IconPlayerPlay,
  IconSettings,
  IconShield,
  IconShieldOff,
  IconTrash,
} from '@tabler/icons-react';
import DetailShell from '@/components/common/ui/DetailShell';
import StatusBadge from '@/components/common/ui/StatusBadge';
import DashboardDateFilter, { useDashboardDateFilterState } from '@/components/layout/DashboardDateFilter';
import GuardrailPolicyCards from '@/components/guardrails/GuardrailPolicyCards';
import GuardrailPolicyDrawer from '@/components/guardrails/GuardrailPolicyDrawer';
import GuardrailHooksMatrix, {
  HOOK_PRESETS,
  describeIssues,
  emptyHooksConfig,
  estimateStreamCost,
  setHookEnabled,
} from '@/components/guardrails/GuardrailHooksMatrix';
import GuardrailDefaultMessages from '@/components/guardrails/GuardrailDefaultMessages';
import GuardrailEvaluatePanel from '@/components/guardrails/GuardrailEvaluatePanel';
import GuardrailEvaluationHistory from '@/components/guardrails/GuardrailEvaluationHistory';
import GuardrailUsagePanel from '@/components/guardrails/GuardrailUsagePanel';
import type { PolicyFieldResources } from '@/components/guardrails/PolicyFieldRenderer';
import { withReferencedKeys } from '@/components/guardrails/policyResources';
// The one home for the three mode words, shared with the hook grid and the list.
import {
  MODE_COPY,
  MODE_VOCABULARY,
} from '@/components/guardrails/guardrailVocabulary';
import type { GuardrailView } from '@/lib/services/guardrail/constants';
import {
  HOOK_IDS,
  readGuardrailMode,
  writeGuardrailMode,
} from '@/lib/services/guardrail/hooks/contract';
import type {
  PolicyFamily,
  GuardrailPolicy,
  GuardrailHooksConfig,
  GuardrailMode,
} from '@/lib/services/guardrail/hooks/contract';
import type { IGuardrailPresetPolicy } from '@/lib/database';

interface ModelOption {
  value: string;
  label: string;
}

/**
 * THE ONE POSTURE CONTROL, and the two columns it writes.
 *
 * `mode` and `enabled` were a Select and a Switch on this page, one above the
 * other, describing the same decision — `toGuardrailMode` opens with
 * `if (!enabled) return 'disabled'`, so a guardrail stored as 'enforce' beside
 * `enabled: false` is not a state, it is a disagreement. Both columns still
 * exist and both are still written; `writeGuardrailMode` is the only thing that
 * assembles the pair, so they can no longer disagree:
 *
 *   Enforce → { mode: 'enforce',  enabled: true  }
 *   Monitor → { mode: 'monitor',  enabled: true  }
 *   Off     → { mode: 'disabled', enabled: false }
 *
 * and `readGuardrailMode({ mode, enabled })` is the fold back, aliases and all.
 *
 * The three words themselves come from `components/guardrails/guardrailVocabulary`,
 * which is where the hook grid and the list read them from too — three screens
 * that each spelled this control their own way is the complaint this pass
 * exists to answer.
 */
const MODE_OPTIONS: ReadonlyArray<{ value: GuardrailMode; label: string }> =
  MODE_VOCABULARY.map(({ value, short }) => ({ value, label: short }));

/** What each posture actually does, in the same words the hook grid uses for
 *  Observe — Monitor IS Observe applied to the whole guardrail. */
const MODE_HINT: Readonly<Record<GuardrailMode, string>> = {
  enforce: MODE_COPY.enforce.hint,
  monitor: MODE_COPY.monitor.hint,
  disabled: MODE_COPY.disabled.hint,
};

/**
 * The tab ids are a URL contract (`?tab=…`), not labels.
 *
 * `api` in particular is READ BACK at mount and is what the create flow and any
 * bookmarked link carry, so its id stays `api` even though the tab is now
 * called Usage — renaming it would silently drop every existing link onto the
 * Dashboard tab.
 */
const TAB_IDS = ['dashboard', 'config', 'hooks', 'test', 'history', 'api'] as const;

type TabId = (typeof TAB_IDS)[number];

/**
 * Retired tab ids, and where they went.
 *
 * `messages` was the Error Messages tab. Its per-reason defaults are now a
 * collapsed panel on the Policies tab and its per-policy half lives on each
 * policy card, so the tab is gone — but `?tab=messages` is in bookmarks, in
 * links this console itself printed, and in support threads. Dropping the id
 * from `TAB_IDS` alone would silently land every one of them on the Dashboard,
 * which is the tab that answers none of the questions they were opened with.
 */
const TAB_ALIASES: Readonly<Record<string, TabId>> = { messages: 'config' };

function resolveTab(param: string | null): TabId {
  if (param === null) return 'dashboard';
  if ((TAB_IDS as readonly string[]).includes(param)) return param as TabId;
  return TAB_ALIASES[param] ?? 'dashboard';
}

/**
 * A brand-new hook configuration: the empty grid.
 *
 * `emptyHooksConfig()` describes the hooks and the streaming defaults, and that
 * is the whole of it — a policy needs no container to be added to, only a place
 * in `hooks.policies`. ONLY THE CREATE PATH: a stored guardrail is never
 * touched on open.
 */
function blankHooksConfig(): GuardrailHooksConfig {
  return emptyHooksConfig();
}

/**
 * Three fields, and `mode` is deliberately not one of them — it lives in its own
 * `useState` beside the hook config because the hooks grid edits it too.
 *
 * WHAT LEFT THIS FORM, AND WHERE IT WENT:
 *   · `action`   — the guardrail-level default action. Nobody sets it any more:
 *     every policy states its own, and `projectHooksToLegacy` (server side, on
 *     every save that carries `hooks`) folds them into the record's `action`
 *     column. See `handleSave`.
 *   · `failMode` — was labelled a DEFAULT for policies that set none, which is
 *     exactly what it is; it belongs on the policy, behind the drawer's
 *     disclosure, and only for the families that can actually fail to run.
 *     `foldFailModes` keeps projecting the column from those policies.
 *   · `enabled`  — absorbed by `mode`. See MODE_OPTIONS.
 */
interface GuardrailFormValues {
  name: string;
  description: string;
  modelKey: string;
}

export default function GuardrailDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const initialTab = resolveTab(tabParam);
  /**
   * The real-time streaming choice made in the create modal, or `null` on an
   * ordinary visit.
   *
   * TRI-STATE on purpose. A create call carries no hook configuration to attach
   * the choice to — see the note on `CreateGuardrailModalProps.onCreated` — so
   * this parameter is the only thing joining the toggle to the config seeded
   * below, and `null` has to mean "nobody just chose", not "chose off". It
   * seeds the first authored config and nothing more; it is never sent to the
   * API.
   */
  const streamParam = searchParams.get('stream');
  const streamPreference: boolean | null =
    streamParam === 'on' ? true : streamParam === 'off' ? false : null;
  const streamOptOut = streamPreference === false;

  const [guardrail, setGuardrail] = useState<GuardrailView | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  /**
   * Option lists for every `reference` field a policy can carry, keyed by
   * RESOURCE and never by family.
   *
   * The per-family editors used to fetch these themselves, one `useEffect` per
   * config section. The generic renderer cannot: it knows a field points at a
   * `pii_policy`, not what a PII policy is or where it lives. So the page —
   * which is the only thing here that may talk to the API — loads all four and
   * hands them down.
   */
  const [resources, setResources] = useState<PolicyFieldResources>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  /**
   * Changes on every successful save. It is what tells the policy grid that
   * nothing on screen is unsaved any more, which is what freezes a policy's id:
   * findings and evaluation-log rows reference it from the moment it is
   * persisted, and a rename orphans every one of them.
   */
  const [savedAt, setSavedAt] = useState(0);
  const [deleteOpen, setDeleteOpen] = useState(false);
  /** The Basic-settings disclosure. Closed on arrival: nothing behind it is a
   *  question a guardrail has to answer to work. */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState<string>(initialTab);
  const [dateFilter, setDateFilter] = useDashboardDateFilterState();

  // policy state managed separately to avoid deep form cloning issues
  const [policy, setPolicy] = useState<IGuardrailPresetPolicy | undefined>(undefined);
  const [customPrompt, setCustomPrompt] = useState('');

  // ── hook plane ──
  const [hooks, setHooks] = useState<GuardrailHooksConfig | null>(null);
  const [hooksVersion, setHooksVersion] = useState(0);
  const [mode, setMode] = useState<GuardrailMode>('enforce');
  /**
   * Whether the operator has touched the hook plane in this session.
   *
   * Load-bearing. A config with `hooksVersion` 0 is DERIVED from the legacy
   * columns and re-derived on every read, so a later fix to the projection
   * reaches it. Sending it back as version 1 on a save that only changed the
   * guardrail's name would freeze that derivation for the row, permanently and
   * invisibly. So the hook blob goes out only when it was actually edited, or
   * when the row was already authored.
   */
  const [hooksDirty, setHooksDirty] = useState(false);
  /**
   * A policy opened from the HOOKS tab.
   *
   * The policy grid owns the drawer for the cards it draws; this is the
   * cross-tab route, because clicking a column header there has to land on the
   * SAME drawer and not a second, subtly different one. The two instances are
   * never open together: this one is only ever set from the Hooks tab, which is
   * unreachable while a drawer is covering the screen.
   */
  const [openPolicyId, setOpenPolicyId] = useState<string | null>(null);

  const updateHooks = (next: GuardrailHooksConfig) => {
    setHooks(next);
    setHooksDirty(true);
  };

  /**
   * The same edit, but derived from whatever the config is at the moment it
   * lands.
   *
   * `applyPolicies` needs the PREVIOUS config to work out which bindings the new
   * policy list requires, and a handler that read `hooks` out of its own closure
   * would compute that against a stale copy. Every route that touches the blob
   * without needing the previous value keeps using `updateHooks`.
   */
  const patchHooks = (patch: (prev: GuardrailHooksConfig) => GuardrailHooksConfig) => {
    setHooks((prev) => patch(prev ?? blankHooksConfig()));
    setHooksDirty(true);
  };

  const hasMounted = useRef(false);

  const form = useForm<GuardrailFormValues>({
    initialValues: {
      name: '',
      description: '',
      modelKey: '',
    },
    validate: {
      name: (v) => (v.trim().length < 2 ? 'Name must be at least 2 characters' : null),
    },
  });

  /**
   * THE ONE DOOR EVERY POLICY EDIT GOES THROUGH, so the policies and the hook
   * BINDINGS cannot drift apart.
   *
   * All five routes land here — the catalog creating a policy, a card's
   * Duplicate, a card's Enable, the drawer's Apply from a card, and the drawer's
   * Apply from the Hooks tab's cross-tab route. That is deliberate: each of
   * them can name a hook, and none of them can see the bindings.
   *
   * The two screens own different halves of one fact: a policy says which hooks
   * it names, the Hooks tab says whether that hook is bound at all. An enabled
   * policy pointing at an unbound hook is the silent no-op this whole plane
   * exists to prevent — `validateGuardrailHooks` refuses to store it, so the
   * guardrail could not even be renamed until someone found the switch — and
   * "I added a policy and nothing happened" is the report it produces. So
   * adding, duplicating or enabling a policy that names a hook switches that
   * binding on.
   *
   * Only ever ON. Turning a binding off is destructive (`setHookEnabled(false)`
   * strips the hook from every policy that names it), so the last policy leaving
   * a hook leaves the binding standing rather than silently rewriting policies
   * the operator did not touch.
   */
  const applyPolicies = (nextPolicies: GuardrailPolicy[]) => {
    patchHooks((prev) => {
      let next: GuardrailHooksConfig = { ...prev, policies: nextPolicies };
      for (const hook of HOOK_IDS) {
        const wanted = nextPolicies.some(
          (policy) => policy.enabled && (policy.hooks ?? []).includes(hook),
        );
        if (wanted && next.bindings?.[hook]?.enabled !== true) {
          next = setHookEnabled(next, hook, true);
        }
      }
      return next;
    });
  };

  /**
   * Whether this save will actually TRANSMIT the hook blob.
   *
   * It is also the save gate's switch. A legacy guardrail nobody has touched
   * sends no `hooks`, so nothing about its derived config can make a save fail
   * — the operator can still rename it, or turn it off, without first being
   * made to fix a configuration they never authored.
   */
  const sendHooks = hooks !== null && (hooksDirty || hooksVersion >= 1);

  /**
   * The client half of `validateGuardrailHooks`. That function lives behind the
   * database barrel and cannot enter a client bundle, so `describeIssues`
   * restates the subset an operator can reach from these screens — every entry
   * has a line-for-line counterpart in the server's validator, including the
   * owner's PII rule (an enabled PII policy must name a policy).
   *
   * One validator for the page, deliberately: the Policies tab and the Hooks tab
   * would otherwise disagree about whether Save is allowed.
   */
  const configIssues = useMemo(
    () => (sendHooks && hooks ? describeIssues(hooks) : []),
    [sendHooks, hooks],
  );
  const saveBlocked = configIssues.length > 0;

  /** The policy the Hooks tab asked to open, if it still exists. */
  const openPolicy = (hooks?.policies ?? []).find((policy) => policy.id === openPolicyId) ?? null;

  /** The tenant's own lists, plus any key these policies point at that is no
   *  longer in them. See `withReferencedKeys`. */
  const policyResources = useMemo(
    () => withReferencedKeys(resources, hooks?.policies ?? []),
    [resources, hooks],
  );

  const activeFamilies: PolicyFamily[] = useMemo(
    () =>
      Array.from(
        new Set((hooks?.policies ?? []).filter((policy) => policy.enabled).map((policy) => policy.family)),
      ),
    [hooks],
  );

  /**
   * `mode` is the third argument for a reason. A monitor-mode guardrail buys no
   * latency at all — `foldStreamSettings` returns PASS_THROUGH rather than
   * holding text back for a verdict it is about to neutralise — and the panel
   * below used to claim a hold-back that was not happening. `gated` is the one
   * honest answer to "is anything actually being withheld today?"; the three
   * latency figures stay HYPOTHETICAL so the "turning it on costs ~N ms" note
   * can still quote them while streaming is off.
   */
  const streamCost = estimateStreamCost(hooks ?? emptyHooksConfig(), 160, mode);

  /**
   * The three resource lists that are not models.
   *
   * Separate from `load()` and never awaited by it: none of them is needed to
   * render the guardrail, they do not change when the id does, and a tenant
   * with no PII service must still get a working screen. Each is independently
   * optional — a failed fetch leaves that resource ABSENT, which the drawer
   * renders as the field's own `emptyHint` rather than as an empty dropdown.
   *
   * Functional updates because `load()` writes `model` into the same state; the
   * two are unordered by design.
   */
  const loadResources = async () => {
    const read = async <T,>(url: string, pick: (data: unknown) => T | undefined) => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return undefined;
        return pick(await res.json());
      } catch {
        return undefined;
      }
    };

    const [piiPolicies, wordLists, providers] = await Promise.all([
      read('/api/pii/policies', (data) =>
        (data as { policies?: Array<{ key: string; name: string; enabled?: boolean; defaultAction?: string }> })
          .policies?.map((policy) => ({
            value: policy.key,
            label: `${policy.name}${policy.enabled === false ? ' (disabled)' : ''}${
              policy.defaultAction ? ` — ${policy.defaultAction}` : ''
            }`,
          })),
      ),
      read('/api/guardrails/word-lists', (data) =>
        (data as { wordLists?: Array<{ key: string; name: string; wordCount?: number }> })
          .wordLists?.map((list) => ({
            value: list.key,
            label:
              typeof list.wordCount === 'number'
                ? `${list.name} (${list.wordCount} words)`
                : list.name,
          })),
      ),
      read('/api/providers', (data) =>
        (data as { providers?: Array<{ key: string; label?: string; driver?: string }> })
          .providers?.map((provider) => ({
            value: provider.key,
            label: provider.label
              ? `${provider.label}${provider.driver ? ` · ${provider.driver}` : ''}`
              : provider.key,
          })),
      ),
    ]);

    setResources((prev) => {
      const next: PolicyFieldResources = { ...prev };
      if (piiPolicies) next.pii_policy = piiPolicies;
      if (wordLists) next.word_list = wordLists;
      if (providers) next.provider = providers;
      return next;
    });
  };

  const load = async () => {
    setLoading(true);
    try {
      const [grRes, modelsRes] = await Promise.all([
        fetch(`/api/guardrails/${params.id}`, { cache: 'no-store' }),
        fetch('/api/models?category=llm', { cache: 'no-store' }),
      ]);

      if (!grRes.ok) {
        if (grRes.status === 404) {
          router.replace('/dashboard/guardrails');
          return;
        }
        throw new Error('Failed to load guardrail');
      }

      const grData = await grRes.json();
      const g: GuardrailView = grData.guardrail;
      setGuardrail(g);

      form.setValues({
        name: g.name,
        description: g.description ?? '',
        modelKey: g.modelKey ?? '',
      });

      setPolicy(g.policy ?? undefined);
      setCustomPrompt(g.customPrompt ?? '');

      /**
       * The record alone cannot answer "what does this guardrail evaluate?".
       * A row written before the hook plane has `hooks` undefined and is LIFTED
       * from its legacy columns at read time by `ensureHooks`, which runs behind
       * the database barrel and so cannot run here. `/compiled` is the endpoint
       * that has already applied it, and it reports `hooksVersion` 0 for a
       * derived config — exactly the distinction this screen has to draw.
       *
       * Fetched after the record because it is keyed by `key`, not by id, and
       * treated as optional: an older API build without the route must still
       * render this page rather than break it.
       */
      let loadedHooks: GuardrailHooksConfig | null = g.hooks ?? null;
      let loadedVersion = g.hooksVersion ?? 0;
      let loadedMode: GuardrailMode | undefined = g.mode;
      const compiledRes = await fetch(
        `/api/guardrails/${encodeURIComponent(g.key)}/compiled`,
        { cache: 'no-store' },
      ).catch(() => null);
      if (compiledRes?.ok) {
        const compiled = (await compiledRes.json()) as {
          hooks?: GuardrailHooksConfig;
          guardrail?: { hooksVersion?: number; mode?: GuardrailMode | null };
        };
        if (compiled.hooks) loadedHooks = compiled.hooks;
        if (typeof compiled.guardrail?.hooksVersion === 'number') {
          loadedVersion = compiled.guardrail.hooksVersion;
        }
        if (compiled.guardrail?.mode) loadedMode = compiled.guardrail.mode;
      }
      /**
       * Apply the create modal's streaming choice to a config nobody has
       * authored yet.
       *
       * Without this the toggle changes nothing. `/compiled` answers for EVERY
       * guardrail that exists — `ensureHooks` lifts one from the legacy columns
       * when none was authored — so `loadedHooks` is never null in practice,
       * the "no hook configuration yet" branch below is effectively
       * unreachable, and that branch used to be the only place the choice was
       * read. A guardrail created with streaming ticked on then arrived
       * carrying `liftLegacyHooks`' `stream: { enabled: false }`, while the
       * modal had just quoted the operator a hold-back window and its latency.
       *
       * Gated on the parameter being PRESENT, not on its absence: seeding on
       * every visit would flip the switch on for every pre-hook-plane guardrail
       * in the fleet and report a hold-back none of them do.
       *
       * Deliberately does NOT mark the config dirty. Arriving on a page must
       * not manufacture unsaved changes, and a version-0 config sent back as
       * authored freezes the legacy projection for the row permanently (see
       * `hooksDirty`). The preference rides along with the first real edit
       * instead — which is also the edit that gives the guardrail a policy on
       * the streaming hook, the thing that makes the setting mean anything.
       */
      if (streamPreference !== null && loadedVersion === 0 && loadedHooks) {
        loadedHooks = {
          ...loadedHooks,
          stream: { ...loadedHooks.stream, enabled: streamPreference },
        };
      }

      setHooks(loadedHooks);
      setHooksVersion(loadedVersion);
      // The engine's own fold over the PAIR, not a second opinion about it:
      // `readGuardrailMode` wraps `toGuardrailMode`, so a row that never wrote
      // the column, one that wrote an alias ('simulate', 'off'), and one that
      // says 'enforce' beside `enabled: false` all read here exactly as the
      // evaluator reads them.
      setMode(readGuardrailMode({ mode: loadedMode, enabled: g.enabled }));
      setHooksDirty(false);

      if (modelsRes.ok) {
        const mData = await modelsRes.json();
        const options: ModelOption[] = (mData.models ?? []).map(
          (m: { key: string; name: string }) => ({ value: m.key, label: m.name }),
        );
        setModels(options);
        // The same list twice, in the two shapes it is asked for: `models` for
        // the components that predate the catalog (the hook presets, the
        // matrix), `resources.model` for every `reference` field that names the
        // `model` resource. One fetch, so they cannot disagree.
        setResources((prev) => ({ ...prev, model: options }));
      }
    } catch (err) {
      console.error('[guardrail-detail]', err);
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to load',
        color: 'red',
      });
    } finally {
      setLoading(false);
      hasMounted.current = true;
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  // Tenant-wide, not per-guardrail: loaded once and left alone. Empty deps on
  // purpose — none of these three lists changes when the id does.
  useEffect(() => {
    void loadResources();
  }, []);

  const handleSave = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;

    // Same list the Policies tab shows inline, checked again here because
    // Save is reachable from four tabs and the server would refuse the whole
    // PATCH — including the name change the operator was actually making.
    if (configIssues.length > 0) {
      setActiveTab('config');
      notifications.show({
        title: 'Cannot save',
        message: `${configIssues[0].policyName}: ${configIssues[0].message}${
          configIssues.length > 1 ? ` (and ${configIssues.length - 1} more)` : ''
        }`,
        color: 'red',
      });
      return;
    }

    setSaving(true);
    try {
      /**
       * WHAT THIS PATCH DELIBERATELY DOES NOT SEND, and why the columns survive.
       *
       * `action` and `failMode` have no control on this screen any more, and
       * omitting them is not the same as clearing them:
       *   · with `hooks` in the body the server RECOMPUTES both from the
       *     policies — `projectLegacyColumns` → `projectHooksToLegacy`, whose
       *     `foldPolicyActions` / `foldFailModes` win over anything the body
       *     carries. That projection is what keeps the `action` column
       *     populated for its readers: the guardrails list and detail screens,
       *     `GET /api/guardrails/:id`, `client-guardrails`, and an older console
       *     binary sharing the tenant database that enforces from it.
       *   · with no `hooks` (a legacy row nobody has touched) the update
       *     receives `undefined` for both, and every provider mixin skips an
       *     undefined field — `if (data.action !== undefined)` — so the stored
       *     value stays exactly as it was.
       *
       * `mode` and `enabled` go together or not at all: `writeGuardrailMode` is
       * the only place the pair is assembled.
       */
      const body: Record<string, unknown> = {
        ...form.values,
        modelKey: form.values.modelKey || undefined,
        ...writeGuardrailMode(mode),
      };

      /**
       * The legacy policy columns are no longer EDITED anywhere on this page —
       * the policy list replaced that editor — but they are still round-tripped
       * verbatim. They remain the source of truth for a row whose hooks have
       * never been authored, and dropping them from the PATCH would be a
       * different write than the one that used to happen here.
       */
      if (guardrail?.type === 'preset') {
        body.policy = policy;
      } else {
        body.customPrompt = customPrompt;
      }

      if (sendHooks) {
        body.hooks = hooks;
        // >= 1 means AUTHORED. Once an operator has edited the grid, the legacy
        // columns stop being the source of truth for this row.
        body.hooksVersion = Math.max(1, hooksVersion);
      }

      const res = await fetch(`/api/guardrails/${params.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          errors?: string[];
        };
        /**
         * `validateGuardrailHooks` returns EVERY problem it found, and the
         * route sends the whole list beside the first one. Reporting only
         * `error` made a configuration with four faults take four save
         * attempts to discover them.
         */
        throw new Error(
          Array.isArray(err.errors) && err.errors.length > 1
            ? err.errors.join(' · ')
            : (err.error ?? 'Failed to save'),
        );
      }

      const data = await res.json();
      const saved: GuardrailView = data.guardrail;
      setGuardrail(saved);

      // Both the API route and the two provider mixins carry a hand-maintained
      // field whitelist. If one of them has not learned about a field, the
      // write is ACCEPTED, the row comes back unchanged, and the screen would
      // happily report success on a setting that was dropped on the floor —
      // which for these two fields means a guardrail that is disarmed, or one
      // that blocks while its operator believes it is only watching.
      const dropped: string[] = [];
      if (sendHooks && (saved.hooksVersion ?? 0) < 1) dropped.push('`hooks`');
      if (saved.mode !== undefined && saved.mode !== mode) dropped.push('`mode`');
      // The other half of the pair, checked separately on purpose: the two are
      // written together and forwarded by different lines of the route, so a
      // route that learned about `mode` and not about `enabled` produces exactly
      // the disagreement `writeGuardrailMode` exists to prevent.
      if (saved.enabled !== (mode !== 'disabled')) dropped.push('`enabled`');

      if (dropped.length > 0) {
        notifications.show({
          title: 'Some settings were not stored',
          message: `The guardrail saved, but the server returned it without ${dropped.join(' and ')}. Check that PATCH /api/guardrails/:id forwards ${dropped.length > 1 ? 'those fields' : 'that field'}.`,
          color: 'red',
          autoClose: false,
        });
      }
      if (sendHooks && (saved.hooksVersion ?? 0) >= 1) {
        setHooksVersion(saved.hooksVersion ?? 1);
        setHooksDirty(false);
      }

      // Everything on screen is persisted now, so no policy id is editable any
      // more — from here a rename would orphan the findings that name it.
      // Deliberately after the `dropped` check: a save the server silently
      // ignored has not persisted anything to freeze.
      if (dropped.length === 0) setSavedAt(Date.now());

      notifications.show({
        title: 'Saved',
        message: 'Guardrail updated successfully',
        color: 'teal',
      });
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to save',
        color: 'red',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/guardrails/${params.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({
        title: 'Deleted',
        message: `"${guardrail?.name}" was deleted`,
        color: 'red',
      });
      router.push('/dashboard/guardrails');
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to delete',
        color: 'red',
      });
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  if (loading) {
    return (
      <Center h={300}>
        <Loader size="sm" />
      </Center>
    );
  }

  if (!guardrail) return null;

  const typeColor = guardrail.type === 'preset' ? 'violet' : 'teal';
  const actionColor = { block: 'red', warn: 'orange', flag: 'blue', redact: 'grape' }[guardrail.action] ?? 'gray';

  const headerActions = (
    <Menu withinPortal position="bottom-end" withArrow>
      <Menu.Target>
        <ActionIcon variant="default" radius="md" size="lg" aria-label="More">
          <IconDots size={15} stroke={1.7} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          color="red"
          leftSection={<IconTrash size={14} />}
          onClick={() => setDeleteOpen(true)}
        >
          Delete guardrail
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );

  return (
    <>
      <DetailShell
        backHref="/dashboard/guardrails"
        backLabel="Back to guardrails"
        icon={
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 10,
              background: 'var(--ds-accent-soft)',
              color: 'var(--ds-accent)',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <IconShield size={22} stroke={1.7} />
          </div>
        }
        title={
          <>
            <h1 className="ds-h2" style={{ margin: 0, whiteSpace: 'nowrap' }}>
              {guardrail.name}
            </h1>
            {/* ONE posture badge where there were three.
                Active/Disabled (from `enabled`), a `monitor` badge (from
                `mode`) and the record's `action` used to sit side by side —
                the first two saying the same thing in two vocabularies, the
                third naming a default nobody sets. The mode is the whole
                answer to "what does this do right now?", and it is the badge
                that changes the moment the control below does. */}
            <StatusBadge
              status={mode === 'enforce' ? 'ok' : mode === 'monitor' ? 'warn' : 'paused'}
              label={MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode}
            />
            <span className="ds-badge ds-badge-info">{guardrail.type}</span>
          </>
        }
        meta={
          <>
            <span className="ds-mono">{guardrail.key}</span>
            {guardrail.modelKey ? (
              <>
                <span className="ds-faint">·</span>
                <span>model: <span className="ds-mono">{guardrail.modelKey}</span></span>
              </>
            ) : null}
            {guardrail.description ? (
              <>
                <span className="ds-faint">·</span>
                <span>{guardrail.description}</span>
              </>
            ) : null}
          </>
        }
        actions={headerActions}
      >

      <Tabs value={activeTab} onChange={(v) => setActiveTab(v ?? 'dashboard')} mt="md">
        <Tabs.List mb="md">
          <Tabs.Tab value="dashboard" leftSection={<IconChartBar size={14} />}>
            Dashboard
          </Tabs.Tab>
          {/* Labelled "Policies" and not "Configuration": the tab IS the policy
              list now, and three of the components on the other tabs send an
              operator here by that name ("Pick a PII policy on the Policies
              tab"). The id stays `config` because it is a URL contract. */}
          <Tabs.Tab
            value="config"
            leftSection={<IconListCheck size={14} />}
            rightSection={
              saveBlocked ? (
                <Badge size="xs" variant="light" color="red">
                  {configIssues.length}
                </Badge>
              ) : null
            }
          >
            Policies
          </Tabs.Tab>
          <Tabs.Tab
            value="hooks"
            leftSection={<IconLayoutGrid size={14} />}
            rightSection={
              hooksDirty ? <Badge size="xs" variant="light" color="orange">edited</Badge> : null
            }
          >
            Hooks
          </Tabs.Tab>
          {/* There is no Error Messages tab any more: per-policy wording lives
              on each policy card, and the reason-class defaults are the
              "Default messages" panel on the Policies tab. `?tab=messages`
              still resolves — see `TAB_ALIASES`. */}
          <Tabs.Tab value="test" leftSection={<IconPlayerPlay size={14} />}>
            Test
          </Tabs.Tab>
          <Tabs.Tab value="history" leftSection={<IconChartBar size={14} />}>
            Evaluation History
          </Tabs.Tab>
          {/* Label only. The id stays `api` because `?tab=api` is a live URL
              contract read back at mount. */}
          <Tabs.Tab value="api" leftSection={<IconCode size={14} />}>
            Usage
          </Tabs.Tab>
        </Tabs.List>

        {/* ── Dashboard tab ── */}
        <Tabs.Panel value="dashboard">
          <Stack gap="md">
            <Group justify="flex-end">
              <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
            </Group>

            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
              <Paper withBorder radius="md" p="md">
                <Text fw={600} mb="sm">Overview</Text>
                <Stack gap="xs">
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" c="dimmed">Key</Text>
                    <Code fz="xs">{guardrail.key}</Code>
                  </Group>
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" c="dimmed">Type</Text>
                    <Badge variant="light" color={typeColor}>{guardrail.type}</Badge>
                  </Group>
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" c="dimmed">Mode</Text>
                    <Badge
                      variant="light"
                      color={mode === 'enforce' ? 'teal' : mode === 'monitor' ? 'orange' : 'gray'}
                    >
                      {MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode}
                    </Badge>
                  </Group>
                  {/* NOT "Default Action" any more, and not a control anywhere:
                      the `action` column is DERIVED from the policies on every
                      save (`projectHooksToLegacy`). It is shown because it is
                      still what an older console binary and the AI App Gateway
                      enforce from, so an operator has to be able to read it —
                      never to set it. */}
                  <Group justify="space-between" wrap="nowrap" align="flex-start">
                    <Tooltip
                      label="Worked out from the policies below and stored on the record, for the integrations that read a single action per guardrail. Change it by changing what a policy does when it finds something."
                      multiline
                      w={300}
                      withArrow
                    >
                      <Text size="sm" c="dimmed" style={{ cursor: 'help' }}>
                        Action (derived)
                      </Text>
                    </Tooltip>
                    <Badge variant="light" color={actionColor}>{guardrail.action}</Badge>
                  </Group>
                </Stack>
              </Paper>

              <Paper withBorder radius="md" p="md">
                <Text fw={600} mb="sm">Main Information</Text>
                <Stack gap="xs">
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" c="dimmed">Name</Text>
                    <Text size="sm" fw={500}>{guardrail.name}</Text>
                  </Group>
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" c="dimmed">Model</Text>
                    <Text size="sm">{guardrail.modelKey || '—'}</Text>
                  </Group>
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" c="dimmed">Created</Text>
                    <Text size="sm">
                      {guardrail.createdAt ? new Date(guardrail.createdAt).toLocaleString() : '—'}
                    </Text>
                  </Group>
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" c="dimmed">Updated</Text>
                    <Text size="sm">
                      {guardrail.updatedAt ? new Date(guardrail.updatedAt).toLocaleString() : '—'}
                    </Text>
                  </Group>
                  <Divider my="xs" />
                  <Text size="xs" c="dimmed">Description</Text>
                  <Text size="sm">{guardrail.description || '—'}</Text>
                </Stack>
              </Paper>
            </SimpleGrid>

            <GuardrailEvaluationHistory
              guardrailId={params.id}
              mode="overview"
              dateFilter={dateFilter}
            />
          </Stack>
        </Tabs.Panel>

        {/* ── Policies tab (id stays `config`: it is a live URL contract) ── */}
        <Tabs.Panel value="config">
          <Stack gap="md">
            {/* Basic settings */}
            <Paper withBorder radius="md" p="md">
              {/* Header idiom matches the policy cards below (icon + title +
                  one-line description at size="sm"). The two used to differ —
                  a bare bold title here, an icon block below — which read as
                  two panels from two different screens stacked in one column. */}
              <Group gap="xs" wrap="nowrap" mb="sm">
                <ThemeIcon size={28} radius="sm" variant="light" color="gray">
                  <IconSettings size={15} />
                </ThemeIcon>
                <div>
                  <Text fw={600} size="sm">Basic settings</Text>
                  <Text size="xs" c="dimmed">
                    What this guardrail is called, and whether it acts on what it finds
                  </Text>
                </div>
              </Group>
              {/*
                TWO DECISIONS. This panel used to ask for six — name,
                description, a default action, a default failure mode, a model
                and an Enabled switch — three of which were not decisions at
                all:

                  · "Default action" named a value policies inherited SILENTLY,
                    which is what made "what does this guardrail do?"
                    unanswerable from the screen. The `action` column is now
                    projected from the policies on save; see `handleSave`.
                  · "Default for policies that cannot run" was `failMode`, which
                    is a per-policy field the drawer already offers — and only
                    for the families that can actually fail to run.
                  · "Enabled" and the hook grid's Mode select were one decision
                    asked twice. See MODE_OPTIONS.
              */}
              <Stack gap="sm">
                <Group align="flex-start" grow wrap="nowrap">
                  <TextInput
                    label="Name"
                    description="Display name for this guardrail"
                    required
                    {...form.getInputProps('name')}
                  />
                  <TextInput
                    label="Description"
                    description="Optional — shown in lists and API responses"
                    placeholder="e.g. Block PII in user messages"
                    {...form.getInputProps('description')}
                  />
                </Group>

                {/* ONE control, writing `mode` AND `enabled` together. */}
                <div>
                  <Text size="sm" fw={500} mb={4}>
                    Mode
                  </Text>
                  <SegmentedControl
                    value={mode}
                    onChange={(v) => setMode(v as GuardrailMode)}
                    data={MODE_OPTIONS.map((option) => ({
                      value: option.value,
                      label: option.label,
                    }))}
                  />
                  <Text size="xs" c="dimmed" mt={6} maw={720}>
                    {MODE_HINT[mode]}
                  </Text>
                </div>

                {/* The record-level model, and the one control on this panel
                    that is not a posture. It is a FALLBACK — the engine reads
                    `policy.modelKey || record.modelKey` — so a policy that pins
                    its own model in the drawer never consults it; it is kept
                    reachable because a `custom` guardrail written before the
                    hook plane runs from this column alone. Collapsed, because
                    it is not a question a new guardrail has to answer. */}
                {guardrail.type === 'custom' && (
                  <div>
                    <UnstyledButton
                      onClick={() => setAdvancedOpen((open) => !open)}
                      aria-expanded={advancedOpen}
                    >
                      <Group gap={4} wrap="nowrap">
                        {advancedOpen ? (
                          <IconChevronDown size={14} />
                        ) : (
                          <IconChevronRight size={14} />
                        )}
                        <Text size="xs" c="dimmed" fw={600}>
                          Advanced
                        </Text>
                      </Group>
                    </UnstyledButton>
                    <Collapse in={advancedOpen}>
                      <Select
                        mt="xs"
                        label="Fallback model"
                        description="Used by any model-backed policy that does not name a model of its own — including the legacy custom prompt on this record."
                        placeholder="Select a model"
                        clearable
                        data={models}
                        value={form.values.modelKey || null}
                        onChange={(v) => form.setFieldValue('modelKey', v ?? '')}
                      />
                    </Collapse>
                  </div>
                )}
              </Stack>
            </Paper>

            {/* ── Default messages ──
                What used to be the Error Messages TAB. It is here, collapsed,
                because it is one layer of a resolution order whose other half
                is now on each policy card: a policy's own message beats these.
                Keeping the reason-class defaults is not optional — they are the
                only place one sentence covers every PII policy at once, however
                many there are and wherever they run. */}
            {hooks !== null && (
              <GuardrailDefaultMessages
                settings={hooks.blockedMessage}
                activeFamilies={activeFamilies}
                policies={hooks.policies ?? []}
                derived={hooksVersion === 0}
                onChange={(blockedMessage) => updateHooks({ ...hooks, blockedMessage })}
                // Someone who followed a `?tab=messages` bookmark came here for
                // this panel and nothing else; landing them on a collapsed
                // header would look like the capability was removed.
                defaultOpen={tabParam === 'messages'}
              />
            )}

            {/* The policy grid. A legacy row arrives here already lifted by
                `/compiled`, so its migrated policies are ordinary cards — each
                carrying a quiet "migrated" badge, above the grid's own note
                that they were derived rather than authored. Never an empty
                screen, and never a save it has to fix first. */}
            {hooks === null ? (
              <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />}>
                <Text size="xs">
                  This guardrail&apos;s hook configuration could not be read, so there is nothing to
                  list. That endpoint (<Code fz="xs">GET /api/guardrails/:key/compiled</Code>) is what
                  translates a pre-hook-plane guardrail into policies; without it the legacy fields
                  still run, they just cannot be shown. Start a configuration from the{' '}
                  <Button
                    variant="subtle"
                    size="compact-xs"
                    onClick={() => setActiveTab('hooks')}
                  >
                    Hooks tab
                  </Button>
                  .
                </Text>
              </Alert>
            ) : (
              <GuardrailPolicyCards
                policies={hooks.policies ?? []}
                bindings={hooks.bindings}
                resources={policyResources}
                // The STORED columns, not form fields: neither is authored on
                // this page any more. They are what a policy that names no
                // action or failure mode of its own inherits today, and they
                // refresh from the server's own projection after every save
                // (`setGuardrail(saved)`), so the inheritance a card reports is
                // the one the engine will apply.
                guardrailAction={guardrail.action}
                guardrailFailMode={guardrail.failMode}
                guardrailMode={mode}
                // So a policy's own Error message block can show what it would
                // inherit — the panel above, then the built-in — instead of
                // claiming the built-in while this workspace has its own voice.
                blockedMessage={hooks.blockedMessage}
                derived={hooksVersion === 0}
                savedSignal={savedAt}
                onChange={applyPolicies}
              />
            )}

            {saveBlocked && (
              <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
                <Text size="xs" fw={600} mb={4}>
                  The server will refuse this configuration
                </Text>
                <Stack gap={2}>
                  {configIssues.map((issue, index) => (
                    <Text key={`${issue.policyId}-${index}`} size="xs">
                      <strong>{issue.policyName}</strong> — {issue.message}
                    </Text>
                  ))}
                </Stack>
              </Alert>
            )}

            <Group justify="flex-end">
              <Button
                loading={saving}
                onClick={handleSave}
                disabled={saveBlocked}
                // The posture this save is about to write, not the one on the
                // stored record: `mode` is the control immediately above it.
                leftSection={mode === 'disabled' ? <IconShieldOff size={16}/> : <IconShield size={16}/>}
              >
                Save Changes
              </Button>
            </Group>
          </Stack>
        </Tabs.Panel>

        {/* ── Hooks tab ── */}
        <Tabs.Panel value="hooks">
          <Stack gap="md">
            {hooks === null ? (
              <Paper withBorder radius="md" p="lg">
                <Stack gap="sm">
                  <Group gap="xs">
                    <IconLayoutGrid size={18} stroke={1.7} />
                    <Text fw={600} size="sm">No hook configuration yet</Text>
                  </Group>
                  <Text size="xs" c="dimmed" maw={720}>
                    This guardrail still runs from the legacy policy columns on its record, which
                    are translated into policies at evaluation time — those columns no longer have an
                    editor of their own. Start from one of the postures below to take control of
                    what runs and where; the translation stops the moment you save.
                  </Text>
                  <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md" mt="xs">
                    {HOOK_PRESETS.map((preset) => (
                      <Card key={preset.id} withBorder padding="sm" radius="md">
                        <Stack gap={6} h="100%" justify="space-between">
                          <div>
                            <Text fw={600} size="sm">{preset.name}</Text>
                            <Text size="xs" c="dimmed" mt={4}>{preset.description}</Text>
                            {preset.requires.map((req) => (
                              <Text key={req} size="xs" c="orange.7" mt={6}>Needs: {req}</Text>
                            ))}
                          </div>
                          <Button
                            size="xs"
                            variant="light"
                            mt="xs"
                            onClick={() => {
                              const built = preset.build(models[0]?.value);
                              updateHooks(
                                streamOptOut
                                  ? { ...built, stream: { ...built.stream, enabled: false } }
                                  : built,
                              );
                            }}
                          >
                            Start from this
                          </Button>
                        </Stack>
                      </Card>
                    ))}
                  </SimpleGrid>
                  <Divider my="xs" />
                  <Group>
                    <Button
                      size="xs"
                      variant="default"
                      onClick={() => {
                        const blank = blankHooksConfig();
                        updateHooks(
                          streamOptOut ? { ...blank, stream: { enabled: false } } : blank,
                        );
                      }}
                    >
                      Start from an empty grid
                    </Button>
                  </Group>
                </Stack>
              </Paper>
            ) : (
              <>
                <GuardrailHooksMatrix
                  guardrailId={params.id}
                  hooks={hooks}
                  onChange={updateHooks}
                  // The SAME state the Mode control on the Policies tab edits.
                  // The grid used to take `mode` and a separate
                  // `guardrailEnabled`, which is the two-columns-one-decision
                  // split arriving as two props; `mode: 'disabled'` is the off
                  // state on both screens now.
                  mode={mode}
                  onModeChange={(m) => setMode(m)}
                  derived={hooksVersion === 0}
                  models={models}
                  /* This grid says WHERE a policy runs; it deliberately no
                     longer edits WHAT one looks for. Both routes below hand
                     that over to the Policies tab, which is the only screen with
                     a per-policy editor — without them, an issue the grid
                     reports (a lifted policy with no model, say) is unfixable
                     from the tab that reports it. */
                  onOpenPolicy={(policyId) => {
                    setActiveTab('config');
                    setOpenPolicyId(policyId);
                  }}
                  onAddPolicy={() => setActiveTab('config')}
                />

                {/* ── Streaming ── */}
                <Paper withBorder radius="md" p="md">
                  <Group justify="space-between" align="flex-start" wrap="nowrap">
                    <Group gap="xs" wrap="nowrap">
                      <IconBolt size={18} stroke={1.7} />
                      <div>
                        <Text fw={600} size="sm">Real-time streaming policies</Text>
                        <Text size="xs" c="dimmed" maw={700}>
                          With this off, a streamed answer is audited only once it has already
                          reached the caller — a credential the model emitted is in their browser
                          before the guardrail ever sees it. With it on, text is withheld behind a
                          release frontier, adjudicated, and only then written to the socket.
                        </Text>
                      </div>
                    </Group>
                    <Switch
                      checked={hooks.stream?.enabled === true}
                      onChange={(e) =>
                        updateHooks({
                          ...hooks,
                          stream: { ...hooks.stream, enabled: e.currentTarget.checked },
                        })
                      }
                    />
                  </Group>

                  {hooksVersion === 0 && hooks.stream?.enabled !== true && (
                    <Alert color="blue" variant="light" mt="sm" icon={<IconBolt size={15} />}>
                      <Text size="xs">
                        This is off because the guardrail was migrated, and the migration preserves
                        exactly what your streams do today. Nothing about your traffic requires it to
                        stay off — turning it on costs roughly{' '}
                        <strong>+{streamCost.addedTtftMs} ms</strong> to the first character and
                        catches what the post-hoc audit can only report.
                      </Text>
                    </Alert>
                  )}

                  {/* `gated` is the honest test, not "is a policy bound?": the
                      engine skips the gate when the hook binding is off, when
                      the guardrail is only monitoring, and — the one that
                      surprises people — when ONE stream-bound policy declares no
                      match bound, which switches real-time enforcement off for
                      every other policy bound there too. `notGatedReason` names
                      whichever applies, by policy. */}
                  {hooks.stream?.enabled === true && !streamCost.gated && (
                    <Alert color="orange" variant="light" mt="sm" icon={<IconAlertTriangle size={15} />}>
                      <Text size="xs">
                        This is on, but nothing is being withheld today.{' '}
                        {streamCost.notGatedReason}
                      </Text>
                    </Alert>
                  )}

                  {hooks.stream?.enabled === true && streamCost.gated && (
                    <Group gap="xl" mt="sm">
                      <div>
                        <Text size="lg" fw={700} lh={1.1}>+{streamCost.addedTtftMs} ms</Text>
                        <Text size="xs" c="dimmed">to the first character, at ~160 chars/s</Text>
                      </div>
                      <div>
                        <Text size="lg" fw={700} lh={1.1}>{streamCost.holdBackChars}</Text>
                        <Text size="xs" c="dimmed">characters withheld</Text>
                      </div>
                      <Text size="xs" c="dimmed" maw={320}>
                        Expand the streaming row above to tune the window and see the estimate at
                        your own generation rate.
                      </Text>
                    </Group>
                  )}
                </Paper>

                <Group justify="flex-end">
                  <Button
                    loading={saving}
                    onClick={handleSave}
                    disabled={saveBlocked}
                    leftSection={<IconLayoutGrid size={16} />}
                  >
                    Save Changes
                  </Button>
                </Group>
              </>
            )}
          </Stack>
        </Tabs.Panel>

        {/* ── Test tab ── */}
        <Tabs.Panel value="test">
          {/* `mode` is advisory only — the panel reads the SAVED config from
              `/compiled`, which is the one the server actually evaluates. It
              is passed so the posture badge is right on first paint instead of
              flashing, not as a source of truth. */}
          <GuardrailEvaluatePanel
            guardrailKey={guardrail.key}
            guardrailName={guardrail.name}
            mode={mode}
          />
        </Tabs.Panel>

        {/* ── Evaluation History tab ── */}
        <Tabs.Panel value="history">
          <GuardrailEvaluationHistory
            guardrailId={params.id}
            mode="logs"
            dateFilter={dateFilter}
          />
        </Tabs.Panel>

        {/* ── Usage tab (id stays `api`: it is a live URL contract) ── */}
        <Tabs.Panel value="api">
          <Stack gap="md">
            {/*
              The RAW stored config, not the lifted one this page holds in
              `hooks`. The panel applies the legacy fail-safe itself and prints
              the "predates the hook plane" note; handing it an already-lifted
              config would hide exactly the fact an integrator needs, which is
              that the two hooks it covers were derived rather than chosen.
            */}
            <GuardrailUsagePanel
              guardrailKey={guardrail.key}
              guardrailName={guardrail.name}
              hooks={guardrail.hooks}
            />

            <Divider />

            {/* Kept from the old tab. It is the only place the record's stored
                shape is visible verbatim, which is what a support conversation
                about "what is actually saved?" needs. */}
            <Paper withBorder radius="md" p="md">
              <Group justify="space-between" mb="xs">
                <Text fw={600}>Configuration JSON</Text>
                <CopyButton value={JSON.stringify(guardrail, null, 2)} timeout={2000}>
                  {({ copied, copy }) => (
                    <Button
                      size="xs"
                      variant="subtle"
                      color={copied ? 'teal' : 'gray'}
                      leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                      onClick={copy}
                    >
                      {copied ? 'Copied' : 'Copy JSON'}
                    </Button>
                  )}
                </CopyButton>
              </Group>
              <Code block fz="xs" style={{ maxHeight: 300, overflow: 'auto' }}>
                {JSON.stringify(guardrail, null, 2)}
              </Code>
            </Paper>
          </Stack>
        </Tabs.Panel>
      </Tabs>
      </DetailShell>

      {/*
        The cross-tab policy drawer.

        The policy grid owns one for the cards it draws; this one exists so a
        column header on the HOOKS tab opens the SAME drawer instead of a
        second, drifting editor. Rendered only when the id still resolves — a
        policy deleted underneath a stale id closes rather than opening on
        nothing — and keyed on it, because the drawer copies the policy into a
        draft on open and would otherwise show one policy's unapplied edits
        against another's name.

        `isNew` is deliberately absent: a policy reachable from the hooks grid
        is one this guardrail already has, so its id is fixed. New policies are
        born in the catalog, on the Policies tab, which tracks that itself.
      */}
      {openPolicy && (
        <GuardrailPolicyDrawer
          key={openPolicy.id}
          opened
          policy={openPolicy}
          bindings={hooks?.bindings}
          resources={policyResources}
          // Stored columns, exactly as the grid passes them. See the note on
          // GuardrailPolicyCards above.
          guardrailAction={guardrail.action}
          guardrailFailMode={guardrail.failMode}
          guardrailMode={mode}
          blockedMessage={hooks?.blockedMessage}
          derived={hooksVersion === 0}
          onApply={(next) =>
            applyPolicies(
              (hooks?.policies ?? []).map((policy) => (policy.id === openPolicy.id ? next : policy)),
            )
          }
          onClose={() => setOpenPolicyId(null)}
        />
      )}

      {/* Delete confirmation */}
      <Modal
        opened={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete guardrail"
        centered
        size="sm"
      >
        <Text size="sm" mb="lg">
          Are you sure you want to delete <strong>{guardrail.name}</strong>? This cannot be undone.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteOpen(false)}>Cancel</Button>
          <Button color="red" loading={deleting} onClick={handleDelete}>Delete</Button>
        </Group>
      </Modal>
    </>
  );
}
