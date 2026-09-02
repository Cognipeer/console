'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Group, Modal, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconEdit,
  IconEye,
  IconListDetails,
  IconPlayerPlay,
  IconPlus,
  IconShield,
  IconShieldOff,
  IconTrash,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useTableControls } from '@/components/common/ui/useTableControls';
import StatusBadge from '@/components/common/ui/StatusBadge';
import CreateGuardrailModal from '@/components/guardrails/CreateGuardrailModal';
import WordListsManager from '@/components/guardrails/WordListsManager';
// The one home for the three mode words, shared with the detail page and the
// hook grid.
import { MODE_COPY } from '@/components/guardrails/guardrailVocabulary';
import type { GuardrailView } from '@/lib/services/guardrail/constants';
import {
  readGuardrailMode,
  toggleGuardrailFields,
  type GuardrailMode,
} from '@/lib/services/guardrail/hooks/contract';

interface ModelOption {
  value: string;
  label: string;
}

const ACTION_LABELS: Record<string, string> = {
  block: 'Block',
  warn: 'Warn',
  flag: 'Flag',
  redact: 'Redact',
};

const ACTION_BADGE: Record<string, string> = {
  block: 'ds-badge-err',
  warn: 'ds-badge-warn',
  flag: 'ds-badge-info',
  // Matches the detail page, which colours redact `grape`. The two screens
  // showing one action in two colours is how a reader stops trusting either.
  redact: 'ds-badge-grape',
};

/**
 * `mode` is absent on every row written before the hook plane, and the engine
 * derives it from `enabled`. Deriving it identically here is what stops the
 * list from showing 'enforce' beside a guardrail the evaluator is treating as
 * disabled.
 *
 * THE ENGINE'S OWN FOLD, not a fourth hand-rolled copy of it. This was a local
 * ternary that missed the 'simulate' alias, so a row written by the enforcement
 * plane displayed 'enforce' on this screen while the evaluator ran it in
 * monitor — the exact disagreement the comment above says it prevents.
 * `readGuardrailMode` wraps `toGuardrailMode`, which the engine, the detail
 * page and `client-guardrails` all fold through.
 */
function effectiveMode(g: GuardrailView): GuardrailMode {
  return readGuardrailMode({ mode: g.mode, enabled: g.enabled });
}

/**
 * What this list can HONESTLY say about a row's policies.
 *
 * A guardrail written before the hook plane stores no `hooks` at all: the
 * engine lifts one from its legacy policy columns on every read
 * (`ensureHooks`), and that lift lives behind the database barrel, so it cannot
 * run in a browser. Re-implementing it here to produce a number would be a
 * second copy of the migration, drifting from the first the day either changes.
 *
 * So a count is reported only for a config someone AUTHORED (`hooksVersion >=
 * 1`), and a derived row says `derived` instead of a figure this page guessed.
 * `ensureHooks` applies the same fail-safe — a version marker with no usable
 * `policies` array is treated as absent rather than trusted.
 */
function policySummary(g: GuardrailView): {
  authored: boolean;
  enabled: number;
  total: number;
} {
  const policies = Array.isArray(g.hooks?.policies) ? g.hooks.policies : [];
  return {
    authored: (g.hooksVersion ?? 0) >= 1 && Array.isArray(g.hooks?.policies),
    enabled: policies.filter((c) => c.enabled).length,
    total: policies.length,
  };
}

export default function GuardrailsPage() {
  const router = useRouter();
  const [guardrails, setGuardrails] = useState<GuardrailView[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [wordListsOpen, setWordListsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GuardrailView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [actionFilter, setActionFilter] = useState('all');
  const [enabledFilter, setEnabledFilter] = useState('all');

  const loadGuardrails = async () => {
    setRefreshing(true);
    try {
      const [grRes, modelsRes] = await Promise.all([
        fetch('/api/guardrails', { cache: 'no-store' }),
        fetch('/api/models?category=llm', { cache: 'no-store' }),
      ]);
      if (grRes.ok) {
        const data = await grRes.json();
        setGuardrails(data.guardrails ?? []);
      }
      if (modelsRes.ok) {
        const data = await modelsRes.json();
        setModels(
          (data.models ?? []).map((m: { key: string; name: string }) => ({
            value: m.key,
            label: m.name,
          })),
        );
      }
    } catch (err) {
      console.error('Failed to load guardrails', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadGuardrails();
  }, []);

  /**
   * Pause / resume. The OTHER writer of the mode pair, and the one the first
   * cut of this simplification missed.
   *
   * WRITES `IGuardrail.enabled` on pause and BOTH columns on resume, via
   * `toggleGuardrailFields` — see the long note on it in `hooks/contract`, which
   * is where the asymmetry is argued. In short: this row used to send
   * `{ enabled: !g.enabled }` alone, both provider mixins skip an absent field,
   * so `mode` kept whatever it already said — and resuming a guardrail that had
   * been set to Off on the detail page stored `{ mode: 'disabled', enabled: true }`,
   * which this list drew as a green "Active" badge on a guardrail the evaluator
   * skips entirely.
   *
   * Pausing deliberately leaves `mode` alone so a watching guardrail still
   * remembers it was watching; `enabled: false` already forces every reader to
   * 'disabled', so nothing can act on the leftover word. That memory is what
   * stops a resume from promoting a monitor guardrail into one that blocks live
   * traffic.
   */
  const handleToggleEnabled = async (g: GuardrailView) => {
    const fields = toggleGuardrailFields({ mode: g.mode, enabled: g.enabled });
    // What the row will resolve to once the write lands — `readGuardrailMode`
    // over the record as patched, so the toast names the posture the evaluator
    // will actually use rather than the field that happened to be sent.
    const next = readGuardrailMode({ mode: g.mode, enabled: g.enabled, ...fields });
    try {
      const res = await fetch(`/api/guardrails/${g.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      if (!res.ok) throw new Error('Failed to update guardrail');
      // Reports the mode it actually moved to. Resuming a paused monitor
      // guardrail says "monitoring", because "enabled" would let an operator
      // believe traffic is being blocked when it is only being recorded.
      notifications.show({
        title:
          next === 'disabled'
            ? 'Guardrail turned off'
            : `Guardrail set to ${MODE_COPY[next].short.toLowerCase()}`,
        message:
          next === 'disabled'
            ? `"${g.name}" is off and evaluates nothing.`
            : next === 'monitor'
              ? `"${g.name}" is recording findings without blocking.`
              : `"${g.name}" is blocking on a finding.`,
        color: next === 'disabled' ? 'orange' : 'teal',
      });
      await loadGuardrails();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to update',
        color: 'red',
      });
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/guardrails/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({
        title: 'Guardrail deleted',
        message: `"${deleteTarget.name}" was deleted`,
        color: 'red',
      });
      setDeleteTarget(null);
      await loadGuardrails();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to delete',
        color: 'red',
      });
    } finally {
      setDeleting(false);
    }
  };

  const filtered = useMemo(() => {
    return guardrails.filter((g) => {
      if (typeFilter !== 'all' && g.type !== typeFilter) return false;
      if (actionFilter !== 'all' && g.action !== actionFilter) return false;
      // Filtered on the RESOLVED posture, not the raw column: a row stored
      // `mode: 'disabled'` beside `enabled: true` is one the evaluator skips,
      // so listing it under "enabled" would hide the only guardrail an operator
      // is looking for.
      if (enabledFilter === 'enabled' && effectiveMode(g) === 'disabled') return false;
      if (enabledFilter === 'disabled' && effectiveMode(g) !== 'disabled') return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !g.name.toLowerCase().includes(q) &&
          !g.key.toLowerCase().includes(q) &&
          !(g.description ?? '').toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [guardrails, query, typeFilter, actionFilter, enabledFilter]);

  const grCtl = useTableControls(filtered, {
    filterKey: `${query}|${typeFilter}|${actionFilter}|${enabledFilter}`,
  });

  const total = guardrails.length;
  // Counts what actually runs. See the filter above.
  const enabled = guardrails.filter((g) => effectiveMode(g) !== 'disabled').length;
  const blockCount = guardrails.filter((g) => g.action === 'block').length;
  // Worth its own tile: a fleet in monitor mode looks identical to an enforcing
  // one on every other number here, and "we thought it was blocking" is the
  // expensive version of that confusion.
  const monitorCount = guardrails.filter((g) => effectiveMode(g) === 'monitor').length;

  const modelLabel = (key?: string) => {
    if (!key) return '—';
    return models.find((m) => m.value === key)?.label ?? key;
  };

  const columns: DataGridColumn<GuardrailView>[] = [
    {
      key: 'name',
      label: 'Name',
      render: (g) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--ds-text)',
              opacity: effectiveMode(g) === 'disabled' ? 0.6 : 1,
            }}
          >
            {g.name}
          </span>
          {g.description ? (
            <span className="ds-faint" style={{ fontSize: 11.5, maxWidth: 320 }}>
              {g.description.length > 60
                ? `${g.description.slice(0, 60)}…`
                : g.description}
            </span>
          ) : (
            <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
              {g.key}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'type',
      label: 'Type',
      render: (g) => (
        <span className={`ds-badge ${g.type === 'preset' ? 'ds-badge-info' : 'ds-badge-teal'}`}>
          {g.type === 'preset' ? 'Preset' : 'Custom'}
        </span>
      ),
    },
    {
      key: 'action',
      label: 'Action',
      render: (g) => (
        <span className={`ds-badge ${ACTION_BADGE[g.action] ?? ''}`}>
          {ACTION_LABELS[g.action] ?? g.action}
        </span>
      ),
    },
    {
      key: 'model',
      label: 'Model',
      render: (g) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
          {modelLabel(g.modelKey)}
        </span>
      ),
    },
    {
      /**
       * The count answers the question the Mode column raises. "Monitor" tells
       * you this guardrail is not blocking; the policy count tells you whether
       * it is looking at anything at all — an authored config with no enabled
       * policy is a guardrail that exists, reads as active, and evaluates
       * nothing. That state was previously invisible until you opened the row.
       */
      key: 'policies',
      label: 'Policies',
      width: 96,
      render: (g) => {
        const s = policySummary(g);

        if (!s.authored) {
          return (
            <span
              className="ds-badge"
              title="Configured before the hook plane. Its policies are derived from the legacy policy columns every time it runs, so there is no stored list to count — open the guardrail to see what it evaluates."
            >
              derived
            </span>
          );
        }

        if (s.enabled === 0) {
          return (
            <span
              className="ds-badge ds-badge-warn"
              title={
                s.total === 0
                  ? 'This guardrail has an authored configuration with no policies in it. It evaluates nothing.'
                  : `All ${s.total} policies are switched off. This guardrail evaluates nothing.`
              }
            >
              none
            </span>
          );
        }

        return (
          <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>
              {s.enabled}
            </span>
            {s.total > s.enabled && (
              <span
                className="ds-faint"
                style={{ fontSize: 11.5 }}
                title={`${s.total - s.enabled} more policy${s.total - s.enabled === 1 ? ' is' : 's are'} configured but switched off.`}
              >
                +{s.total - s.enabled} off
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: 'mode',
      label: 'Mode',
      render: (g) => {
        const m = effectiveMode(g);
        return (
          <span
            className={`ds-badge ${
              m === 'enforce' ? 'ds-badge-ok' : m === 'monitor' ? 'ds-badge-warn' : ''
            }`}
            title={
              m === 'monitor'
                ? 'Every policy runs and every finding is recorded, but the verdict is neutralised before it reaches the caller — nothing is blocked or redacted.'
                : m === 'enforce'
                  ? 'Verdicts take effect: a blocking finding stops the request, a redacting one rewrites it.'
                  : 'Skipped entirely during evaluation.'
            }
          >
            {m}
          </span>
        );
      },
    },
    {
      key: 'status',
      label: 'Status',
      // Derived from the SAME fold as the Mode column beside it. Reading
      // `enabled` here drew a green "Active" badge next to a Mode cell reading
      // "disabled" on any row whose two columns disagreed — the two halves of
      // one decision contradicting each other on one line.
      render: (g) => (
        <StatusBadge status={effectiveMode(g) === 'disabled' ? 'paused' : 'active'} />
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Guardrails"
        title="Guardrails"
        subtitle="Safety policies applied to model inputs, outputs and tool calls. Block, redact, or flag traffic that matches a policy."
        actions={
          <Group gap="xs">
            <Button
              variant="default"
              size="sm"
              leftSection={<IconListDetails size={14} stroke={1.7} />}
              onClick={() => setWordListsOpen(true)}
            >
              Word lists
            </Button>
            <Button
              color="teal"
              size="sm"
              leftSection={<IconPlus size={14} stroke={1.7} />}
              onClick={() => setCreateModalOpen(true)}
            >
              New guardrail
            </Button>
          </Group>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label="Total guardrails"
          icon={<IconShield size={14} stroke={1.7} />}
          value={total}
        />
        <StatTile label="Enabled" value={enabled} />
        <StatTile label="Monitor only" value={monitorCount} />
        <StatTile label="Blocking" value={blockCount} />
      </div>

      <DataGrid<GuardrailView>
        records={grCtl.records}
        loading={loading}
        rowKey={(g) => g.id}
        onRowClick={(g) => router.push(`/dashboard/guardrails/${g.id}`)}
        columns={columns}
        pagination={grCtl.pagination}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Filter by name, key, or description…',
        }}
        filters={[
          {
            value: typeFilter,
            onChange: setTypeFilter,
            ariaLabel: 'Filter by type',
            width: 140,
            options: [
              { value: 'all', label: 'All types' },
              { value: 'preset', label: 'Preset' },
              { value: 'custom', label: 'Custom' },
            ],
          },
          {
            value: actionFilter,
            onChange: setActionFilter,
            ariaLabel: 'Filter by action',
            width: 140,
            options: [
              { value: 'all', label: 'All actions' },
              { value: 'block', label: 'Block' },
              { value: 'redact', label: 'Redact' },
              { value: 'flag', label: 'Flag' },
              // Kept as a FILTER even though new guardrails can no longer be
              // created with it: stored rows say 'warn', and a filter that
              // cannot reach them would make those rows unfindable.
              { value: 'warn', label: 'Warn (legacy)' },
            ],
          },
          {
            value: enabledFilter,
            onChange: setEnabledFilter,
            ariaLabel: 'Filter by enabled state',
            width: 140,
            options: [
              { value: 'all', label: 'All statuses' },
              { value: 'enabled', label: 'Enabled' },
              { value: 'disabled', label: 'Disabled' },
            ],
          },
        ]}
        onRefresh={loadGuardrails}
        refreshing={refreshing}
        empty={{
          icon: <IconShield size={26} stroke={1.7} />,
          title: 'No guardrails yet',
          description:
            'Create your first guardrail to scan model inputs and outputs for PII, prompt injection, or custom policies.',
          primaryAction: {
            label: 'Create guardrail',
            icon: <IconPlus size={14} stroke={1.7} />,
            onClick: () => setCreateModalOpen(true),
          },
        }}
        footerLeft={`Showing ${grCtl.records.length} of ${filtered.length} guardrails`}
        rowActions={(g) => [
          {
            id: 'view',
            label: 'View',
            icon: <IconEye size={14} />,
            onClick: () => router.push(`/dashboard/guardrails/${g.id}`),
          },
          {
            id: 'edit',
            label: 'Edit',
            icon: <IconEdit size={14} />,
            onClick: () => router.push(`/dashboard/guardrails/${g.id}`),
          },
          {
            id: 'toggle',
            label: effectiveMode(g) === 'disabled' ? 'Turn on' : 'Turn off',
            icon:
              effectiveMode(g) === 'disabled' ? (
                <IconPlayerPlay size={14} />
              ) : (
                <IconShieldOff size={14} />
              ),
            onClick: () => void handleToggleEnabled(g),
          },
          { divider: true },
          {
            id: 'delete',
            label: 'Delete',
            icon: <IconTrash size={14} />,
            color: 'red',
            onClick: () => setDeleteTarget(g),
          },
        ]}
      />

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete guardrail"
        centered
        size="sm"
      >
        <Text size="sm" mb="lg">
          Delete guardrail <strong>{deleteTarget?.name}</strong>? Models that
          reference this guardrail will no longer apply it. This action cannot be
          undone.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteTarget(null)}>
            Cancel
          </Button>
          <Button color="red" loading={deleting} onClick={confirmDelete}>
            Delete
          </Button>
        </Group>
      </Modal>

      <WordListsManager opened={wordListsOpen} onClose={() => setWordListsOpen(false)} />

      <CreateGuardrailModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onCreated={(g, { streamingEnabled }) => {
          void loadGuardrails();
          // Straight to the Hooks tab: a brand-new guardrail has no policies of
          // its own yet, and that is the one screen that can give it some.
          //
          // The streaming choice is spelled out in BOTH directions, never left
          // to the absence of a parameter. A create call carries no hook
          // configuration to attach it to (see `onCreated` on the modal), so
          // this URL is the only thing connecting the toggle to the config the
          // detail page seeds — and "on" is the DEFAULT, so encoding it as a
          // missing parameter made it indistinguishable from an ordinary visit
          // to a guardrail nobody just created. The detail page could then only
          // honour the opt-out, which left the toggle's own default doing
          // nothing at all.
          const stream = streamingEnabled ? '&stream=on' : '&stream=off';
          router.push(`/dashboard/guardrails/${g.id}?tab=hooks${stream}`);
        }}
      />
    </PageContainer>
  );
}
