'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  CopyButton,
  Group,
  Modal,
  Table,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertCircle,
  IconCheck,
  IconCopy,
  IconEdit,
  IconHistory,
  IconPlayerPlay,
  IconPlayerPause,
  IconRefresh,
  IconSend,
  IconTrash,
  IconWebhook,
} from '@tabler/icons-react';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import FormShell, {
  ChipPicker,
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
  ToggleList,
  ToggleRow,
} from '@/components/common/ui/FormShell';
import { errorMessage } from '@/lib/api/client';
import {
  useDeleteWebhook,
  useRedeliverWebhook,
  useRestartWebhookDeliveries,
  useRotateWebhookSecret,
  useSaveWebhook,
  useSendWebhookTest,
  useSetWebhookStatus,
  useWebhookDeliveries,
  useWebhooks,
  type WebhookSecretEndpoint,
} from '@/lib/api/queries/webhooks';
import { useTranslations } from '@/lib/i18n';
import {
  eventGroups,
  eventLabelKey,
  groupEvents,
  isEventSelected,
  isGroupSelected,
  isValidWebhookUrl,
  parseWebhookCapabilities,
  scopeOf,
  summarizeEvents,
  toggleEvent,
  toggleGroup,
  type WebhookCapabilities,
  type WebhookDeliveryRow,
  type WebhookEndpointRow,
  type WebhookEventType,
} from './webhooksUi';

const formatTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

const NO_EVENTS: WebhookEventType[] = [];

type Editor = { mode: 'create' } | { mode: 'edit'; endpoint: WebhookEndpointRow };
type SecretReveal = { kind: 'created' | 'rotated'; url: string; secret: string };

export default function WebhookManagement() {
  const t = useTranslations('webhooks');
  const tCommon = useTranslations('common');
  const tNotifications = useTranslations('notifications');
  const webhooks = useWebhooks();
  const saveStatus = useSetWebhookStatus();
  const sendTestEvent = useSendWebhookTest();
  const rotateSecret = useRotateWebhookSecret();
  const deleteWebhook = useDeleteWebhook();
  // What the person may do here is the policy engine's answer (the list response), not a guess from a role.
  const capabilities = useMemo<WebhookCapabilities>(
    () => (webhooks.data?.list ? parseWebhookCapabilities(webhooks.data.list) : { manage: true, workspaceScope: false }),
    [webhooks.data],
  );
  const endpoints = useMemo(() => webhooks.data?.list?.endpoints ?? [], [webhooks.data]);
  const catalog = webhooks.data?.catalog ?? NO_EVENTS;
  const loading = webhooks.isFetching;
  const forbidden = webhooks.data?.forbidden ?? false;
  const refetchWebhooks = webhooks.refetch;
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [secret, setSecret] = useState<SecretReveal | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<WebhookEndpointRow | null>(null);
  const [toDelete, setToDelete] = useState<WebhookEndpointRow | null>(null);

  const fail = (message: string) => {
    notifications.show({ title: tNotifications('errorTitle'), message, color: 'red' });
  };

  // A failed read keeps what was shown and says so once per failure.
  const failedAt = webhooks.errorUpdatedAt;
  const loadError = webhooks.error;
  useEffect(() => {
    if (loadError) {
      notifications.show({ title: tNotifications('errorTitle'), message: errorMessage(loadError, t('errors.load')), color: 'red' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedAt]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return endpoints;
    return endpoints.filter((endpoint) =>
      [endpoint.url, endpoint.description, ...endpoint.events].filter(Boolean).some((v) => String(v).toLowerCase().includes(q)));
  }, [endpoints, query]);

  const setStatus = async (endpoint: WebhookEndpointRow, status: 'active' | 'disabled') => {
    try {
      await saveStatus.mutateAsync({ id: endpoint.id, status });
    } catch (error) {
      return fail(errorMessage(error, t('errors.action')));
    }
    notifications.show({ title: tCommon('success'), message: t(status === 'active' ? 'messages.enabled' : 'messages.disabled'), color: 'green' });
  };

  const sendTest = async (endpoint: WebhookEndpointRow) => {
    let delivery: WebhookDeliveryRow;
    try {
      delivery = (await sendTestEvent.mutateAsync(endpoint.id)).delivery;
    } catch (error) {
      return fail(errorMessage(error, t('errors.action')));
    }
    if (delivery.status === 'delivered') {
      notifications.show({ title: tCommon('success'), message: t('messages.testDelivered', { code: delivery.lastStatusCode ?? 200 }), color: 'green' });
    } else {
      fail(t('messages.testFailed', { reason: delivery.lastError || (delivery.lastStatusCode ? `HTTP ${delivery.lastStatusCode}` : '—') }));
    }
  };

  const rotate = async (endpoint: WebhookEndpointRow) => {
    try {
      const rotated = await rotateSecret.mutateAsync(endpoint.id);
      setSecret({ kind: 'rotated', url: endpoint.url, secret: rotated.endpoint.secret ?? '' });
    } catch (error) {
      fail(errorMessage(error, t('errors.action')));
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    try {
      await deleteWebhook.mutateAsync(toDelete.id);
    } catch (error) {
      return fail(errorMessage(error, t('errors.delete')));
    }
    notifications.show({ title: tCommon('success'), message: t('messages.deleted'), color: 'green' });
    setToDelete(null);
  };

  if (forbidden) {
    return (
      <div className="ds-empty" style={{ padding: 48 }}>
        <Text size="sm" c="dimmed">{t('forbidden')}</Text>
      </div>
    );
  }

  const columns: DataGridColumn<WebhookEndpointRow>[] = [
    {
      key: 'url',
      label: t('table.url'),
      render: (endpoint) => (
        <div className="ds-col" style={{ gap: 2, minWidth: 0 }}>
          <span className="ds-mono" style={{ fontSize: 12, fontWeight: 500, wordBreak: 'break-all' }}>{endpoint.url}</span>
          {endpoint.urlRedacted ? <span className="ds-faint" style={{ fontSize: 11 }} data-testid="webhook-url-redacted">{t('table.urlRedacted')}</span> : null}
          {endpoint.description ? <span className="ds-faint" style={{ fontSize: 11 }}>{endpoint.description}</span> : null}
        </div>
      ),
    },
    {
      key: 'events',
      label: t('table.events'),
      render: (endpoint) => {
        const summary = summarizeEvents(endpoint.events);
        return (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {summary.all ? <span className="ds-badge ds-badge-info">{t('table.allEvents')}</span> : null}
            {summary.shown.map((event) => <span key={event} className="ds-badge ds-badge-info ds-mono">{event}</span>)}
            {summary.more > 0 ? <span className="ds-faint" style={{ fontSize: 11 }}>{t('table.moreEvents', { count: summary.more })}</span> : null}
          </div>
        );
      },
    },
    {
      key: 'scope',
      label: t('table.scope'),
      width: 130,
      render: (endpoint) => <span style={{ fontSize: 12 }}>{t(`scope.${scopeOf(endpoint)}`)}</span>,
    },
    {
      key: 'status',
      label: t('table.status'),
      width: 240,
      render: (endpoint) => (
        <div className="ds-col" style={{ gap: 3 }}>
          <span>
            <span className={`ds-badge ${endpoint.status === 'active' ? 'ds-badge-ok' : 'ds-badge-err'}`}>
              <span className="ds-badge-dot" />{t(`status.${endpoint.status}`)}
            </span>
          </span>
          {endpoint.status === 'disabled' && endpoint.disabledReason ? (
            <span className="ds-faint" style={{ fontSize: 11 }}>{t(`reasons.${endpoint.disabledReason}`)}</span>
          ) : null}
          {endpoint.status === 'active' && endpoint.failingSince ? (
            <span className="ds-faint" style={{ fontSize: 11, color: 'var(--ds-warn)' }}>
              {t('status.failing', { time: formatTime(endpoint.failingSince) })}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'created',
      label: t('table.created'),
      width: 150,
      render: (endpoint) => <span className="ds-faint" style={{ fontSize: 12 }}>{endpoint.createdAt ? new Date(endpoint.createdAt).toLocaleDateString() : '—'}</span>,
    },
  ];

  return (
    <>
      <DataGrid<WebhookEndpointRow>
        records={filtered}
        loading={loading}
        rowKey={(endpoint) => endpoint.id}
        columns={columns}
        search={{ value: query, onChange: setQuery, placeholder: t('table.search') }}
        onRefresh={() => void refetchWebhooks()}
        refreshing={loading}
        toolbarRight={capabilities.manage ? (
          <Button color="teal" size="xs" leftSection={<IconWebhook size={13} stroke={1.7} />} onClick={() => setEditor({ mode: 'create' })}>
            {t('actions.create')}
          </Button>
        ) : undefined}
        empty={{
          title: t('table.empty'),
          description: capabilities.manage ? t('table.emptyDescription') : t('table.emptyReadOnly'),
          ...(capabilities.manage
            ? { primaryAction: { label: t('actions.create'), icon: <IconWebhook size={14} stroke={1.7} />, onClick: () => setEditor({ mode: 'create' }) } }
            : {}),
        }}
        footerLeft={t('table.showing', { shown: filtered.length, total: endpoints.length })}
        rowActions={(endpoint) => {
          const deliveries = { id: 'deliveries', label: t('actions.deliveries'), icon: <IconHistory size={14} />, onClick: () => setDeliveriesFor(endpoint) };
          // Read access sees the endpoints and what was sent to them; everything else needs Admin.
          if (!capabilities.manage) return [deliveries];
          return [
            { id: 'edit', label: t('actions.edit'), icon: <IconEdit size={14} />, onClick: () => setEditor({ mode: 'edit', endpoint }) },
            deliveries,
            { id: 'test', label: t('actions.test'), icon: <IconSend size={14} />, onClick: () => void sendTest(endpoint) },
            { id: 'rotate', label: t('actions.rotate'), icon: <IconRefresh size={14} />, onClick: () => void rotate(endpoint) },
            endpoint.status === 'active'
              ? { id: 'disable', label: t('actions.disable'), icon: <IconPlayerPause size={14} />, onClick: () => void setStatus(endpoint, 'disabled') }
              : { id: 'enable', label: t('actions.enable'), icon: <IconPlayerPlay size={14} />, onClick: () => void setStatus(endpoint, 'active') },
            { id: 'delete', label: t('actions.delete'), icon: <IconTrash size={14} />, color: 'red', divider: true, onClick: () => setToDelete(endpoint) },
          ];
        }}
      />

      {editor ? (
        <WebhookForm
          key={editor.mode === 'edit' ? editor.endpoint.id : 'create'}
          editor={editor}
          catalog={catalog}
          canTargetAllProjects={capabilities.workspaceScope}
          onClose={() => setEditor(null)}
          onSaved={(endpoint, revealed) => {
            setEditor(null);
            if (revealed) setSecret({ kind: 'created', url: endpoint.url, secret: revealed });
          }}
        />
      ) : null}

      <SecretReveal reveal={secret} onClose={() => setSecret(null)} />

      {deliveriesFor ? <DeliveriesView endpoint={deliveriesFor} canManage={capabilities.manage} onClose={() => setDeliveriesFor(null)} /> : null}

      <Modal opened={Boolean(toDelete)} onClose={() => setToDelete(null)} title={t('deleteModal.title')} size="md">
        <Text size="sm" mb="md">{t('deleteModal.description', { url: toDelete?.url ?? '' })}</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setToDelete(null)}>{t('deleteModal.cancel')}</Button>
          <Button color="red" onClick={() => void confirmDelete()}>{t('deleteModal.confirm')}</Button>
        </Group>
      </Modal>
    </>
  );
}

// ── Create / edit ──────────────────────────────────────────────────────

function WebhookForm({
  editor,
  catalog,
  canTargetAllProjects,
  onClose,
  onSaved,
}: {
  editor: Editor;
  catalog: WebhookEventType[];
  canTargetAllProjects: boolean;
  onClose: () => void;
  onSaved: (endpoint: WebhookEndpointRow, secret?: string) => void;
}) {
  const t = useTranslations('webhooks');
  const tCommon = useTranslations('common');
  const tNotifications = useTranslations('notifications');
  const editing = editor.mode === 'edit' ? editor.endpoint : null;

  const [url, setUrl] = useState(editing?.url ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [scope, setScope] = useState<'project' | 'all'>(editing ? scopeOf(editing) : 'project');
  const [events, setEvents] = useState<string[]>(editing?.events ?? []);
  const saveWebhook = useSaveWebhook();
  const saving = saveWebhook.isPending;

  const urlOk = isValidWebhookUrl(url);
  const eventsOk = events.length > 0;
  const checklist = [
    { id: 1, label: t('form.url'), done: urlOk },
    { id: 2, label: t('form.eventsSection'), done: eventsOk },
  ];

  const save = async () => {
    try {
      const result = await saveWebhook.mutateAsync(
        editing
          ? { id: editing.id, body: { url: url.trim(), description: description.trim(), events } }
          : {
            body: {
              url: url.trim(),
              ...(description.trim() ? { description: description.trim() } : {}),
              events,
              ...(scope === 'all' ? { projectId: null } : {}),
            },
          },
      );
      notifications.show({ title: tCommon('success'), message: t(editing ? 'messages.updated' : 'messages.created'), color: 'green' });
      const saved = result.endpoint as WebhookSecretEndpoint;
      onSaved(saved, editing ? undefined : saved.secret);
    } catch (error) {
      notifications.show({ title: tNotifications('errorTitle'), message: errorMessage(error, t('errors.save')), color: 'red' });
    }
  };

  const summary = (
    <>
      <SummaryGroup title={editing ? t('form.editTitle') : t('form.createTitle')}>
        <SummaryKV label={t('form.summaryUrl')} value={url.trim() || <span className="ds-faint">—</span>} />
        <SummaryKV label={t('form.summaryScope')} value={t(`scope.${scope}`)} />
        <SummaryKV
          label={t('form.summaryEvents')}
          value={events.length ? events.join(', ') : <span className="ds-faint">{t('form.none')}</span>}
        />
      </SummaryGroup>
      <SummaryGroup title={t('form.preflight')}>
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  const groups = eventGroups(catalog);

  return (
    <FormShell
      open
      onClose={onClose}
      icon={<IconWebhook size={16} />}
      title={editing ? t('form.editTitle') : t('form.createTitle')}
      subtitle={t('form.subtitle')}
      summary={summary}
      footerStatus={t('form.ready', { done: checklist.filter((c) => c.done).length, total: checklist.length })}
      primaryAction={{
        label: editing ? t('form.save') : t('form.create'),
        loading: saving,
        disabled: !urlOk || !eventsOk,
        onClick: () => void save(),
      }}
    >
      <FormSection number={1} title={t('form.endpointSection')} description={t('form.endpointDescription')} done={urlOk}>
        <FormRow cols={1}>
          <FormField label={t('form.url')} required>
            <TextInput
              value={url}
              onChange={(event) => setUrl(event.currentTarget.value)}
              placeholder={t('form.urlPlaceholder')}
              error={url.trim() && !urlOk ? t('form.urlInvalid') : undefined}
            />
          </FormField>
          <FormField label={t('form.description')} optional>
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
              placeholder={t('form.descriptionPlaceholder')}
              autosize
              minRows={1}
              maxRows={4}
              maxLength={500}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection number={2} title={t('form.scopeSection')} description={t('form.scopeDescription')} done>
        {editing || !canTargetAllProjects ? (
          <Text size="sm">{t(`scope.${scope}`)}</Text>
        ) : (
          <ChipPicker<'project' | 'all'>
            options={[
              { value: 'project', label: t('form.scopeProject') },
              { value: 'all', label: t('form.scopeAll') },
            ]}
            value={scope}
            onChange={(next) => setScope(next as 'project' | 'all')}
          />
        )}
      </FormSection>

      <FormSection number={3} title={t('form.eventsSection')} description={t('form.eventsDescription')} done={eventsOk}>
        {groups.map((group) => (
          <div key={group} style={{ marginBottom: 14 }}>
            <ToggleList>
              <ToggleRow
                label={<strong>{t(`groups.${group}`)}</strong>}
                description={t('form.selectGroup')}
                checked={isGroupSelected(events, catalog, group)}
                onChange={() => setEvents((current) => toggleGroup(current, catalog, group))}
              />
              {groupEvents(catalog, group).map((type) => (
                <ToggleRow
                  key={type}
                  label={<span className="ds-mono" style={{ fontSize: 12 }}>{type}</span>}
                  description={t(`events.${eventLabelKey(type)}`)}
                  checked={isEventSelected(events, type)}
                  onChange={() => setEvents((current) => toggleEvent(current, catalog, type))}
                />
              ))}
            </ToggleList>
          </div>
        ))}
      </FormSection>
    </FormShell>
  );
}

// ── One-time secret ────────────────────────────────────────────────────

function SecretReveal({ reveal, onClose }: { reveal: SecretReveal | null; onClose: () => void }) {
  const t = useTranslations('webhooks');
  if (!reveal) return null;
  return (
    <FormShell
      open
      onClose={onClose}
      disableEscape
      icon={<IconWebhook size={16} />}
      title={t(reveal.kind === 'created' ? 'secret.createdTitle' : 'secret.rotatedTitle')}
      subtitle={reveal.url}
      summary={(
        <SummaryGroup title={t('secret.title')}>
          <SummaryKV label={t('table.url')} value={reveal.url} />
        </SummaryGroup>
      )}
      primaryAction={{ label: t('actions.copied'), color: 'teal', onClick: onClose }}
      secondaryAction={{ label: t('actions.close'), onClick: onClose }}
    >
      <FormSection number={1} title={t('secret.warningTitle')} done>
        <Alert icon={<IconAlertCircle size={16} />} color="orange" title={t('secret.warningTitle')}>
          {t('secret.warning')}
        </Alert>
      </FormSection>
      <FormSection number={2} title={t('secret.label')} done>
        <Group gap="xs" wrap="nowrap">
          <Text
            ff="monospace"
            style={{
              flex: 1,
              padding: '8px 12px',
              wordBreak: 'break-all',
              fontSize: 12,
              backgroundColor: 'var(--ds-surface-2, #f5f5f5)',
              borderRadius: 6,
              border: '1px solid var(--ds-border, #e0e0e0)',
            }}
          >
            {reveal.secret}
          </Text>
          <CopyButton value={reveal.secret}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? t('secret.copiedTooltip') : t('secret.copy')}>
                <ActionIcon color={copied ? 'teal' : 'blue'} variant="filled" onClick={copy} size="lg" aria-label={t('secret.copy')}>
                  {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
        </Group>
      </FormSection>
      <FormSection number={3} title={t('secret.usageTitle')} done>
        <Alert color="blue" icon={<IconAlertCircle size={16} />}>{t('secret.usage')}</Alert>
      </FormSection>
    </FormShell>
  );
}

// ── Deliveries ─────────────────────────────────────────────────────────

const DELIVERY_BADGE: Record<WebhookDeliveryRow['status'], string> = {
  pending: 'ds-badge-warn',
  delivered: 'ds-badge-ok',
  failed: 'ds-badge-err',
};

function DeliveriesView({ endpoint, canManage, onClose }: { endpoint: WebhookEndpointRow; canManage: boolean; onClose: () => void }) {
  const t = useTranslations('webhooks');
  const tCommon = useTranslations('common');
  const tNotifications = useTranslations('notifications');
  const deliveries = useWebhookDeliveries(endpoint.id);
  const restart = useRestartWebhookDeliveries(endpoint.id);
  const redeliverWebhook = useRedeliverWebhook();
  const rows = useMemo(() => deliveries.data?.pages.flatMap((page) => page.deliveries) ?? [], [deliveries.data]);
  const hasMore = Boolean(deliveries.hasNextPage);
  const loading = deliveries.isFetching;
  const fetchNextPage = deliveries.fetchNextPage;

  // A failed page says so once per failure.
  const failedAt = deliveries.errorUpdatedAt;
  const loadError = deliveries.error;
  useEffect(() => {
    if (loadError) {
      notifications.show({ title: tNotifications('errorTitle'), message: errorMessage(loadError, t('errors.load')), color: 'red' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedAt]);

  const redeliver = async (delivery: WebhookDeliveryRow) => {
    try {
      await redeliverWebhook.mutateAsync(delivery.id);
    } catch (error) {
      notifications.show({ title: tNotifications('errorTitle'), message: errorMessage(error, t('errors.action')), color: 'red' });
      return;
    }
    notifications.show({ title: tCommon('success'), message: t('messages.redelivering'), color: 'green' });
    void restart();
  };

  return (
    <FormShell
      open
      onClose={onClose}
      icon={<IconHistory size={16} />}
      title={t('deliveries.title')}
      subtitle={endpoint.url}
      primaryAction={{ label: t('actions.refresh'), icon: <IconRefresh size={14} />, loading, onClick: () => void restart() }}
      secondaryAction={{ label: t('actions.close'), onClick: onClose }}
    >
      <FormSection title={t('deliveries.subtitle')}>
        {rows.length === 0 && !loading ? (
          <Text size="sm" c="dimmed">{t('deliveries.empty')}</Text>
        ) : (
          <Table verticalSpacing="xs" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('deliveries.event')}</Table.Th>
                <Table.Th>{t('deliveries.status')}</Table.Th>
                <Table.Th>{t('deliveries.attempts')}</Table.Th>
                <Table.Th>{t('deliveries.lastCode')}</Table.Th>
                <Table.Th>{t('deliveries.time')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((delivery) => (
                <Table.Tr key={delivery.id}>
                  <Table.Td>
                    <div className="ds-col" style={{ gap: 2 }}>
                      <span className="ds-mono" style={{ fontSize: 12 }}>{delivery.eventType}</span>
                      <span className="ds-faint ds-mono" style={{ fontSize: 10 }}>{delivery.eventId}</span>
                    </div>
                  </Table.Td>
                  <Table.Td>
                    <span className={`ds-badge ${DELIVERY_BADGE[delivery.status]}`}>{t(`deliveries.states.${delivery.status}`)}</span>
                    {delivery.status === 'pending' && delivery.nextAttemptAt ? (
                      <div className="ds-faint" style={{ fontSize: 11 }}>{t('deliveries.next', { time: formatTime(delivery.nextAttemptAt) })}</div>
                    ) : null}
                  </Table.Td>
                  <Table.Td>{delivery.attempts}</Table.Td>
                  <Table.Td>
                    <div className="ds-col" style={{ gap: 2 }}>
                      <span style={{ fontSize: 12 }}>{delivery.lastStatusCode ?? '—'}</span>
                      {delivery.lastError ? <span className="ds-faint" style={{ fontSize: 11, maxWidth: 280, wordBreak: 'break-word' }}>{delivery.lastError}</span> : null}
                    </div>
                  </Table.Td>
                  <Table.Td><span className="ds-faint" style={{ fontSize: 12 }}>{formatTime(delivery.deliveredAt ?? delivery.createdAt)}</span></Table.Td>
                  <Table.Td>
                    {canManage && delivery.status !== 'pending' ? (
                      <Button size="xs" variant="subtle" leftSection={<IconSend size={13} />} onClick={() => void redeliver(delivery)}>
                        {t('actions.redeliver')}
                      </Button>
                    ) : null}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        {hasMore ? (
          <Group justify="center" mt="md">
            <Button variant="default" size="xs" loading={loading} onClick={() => void fetchNextPage()}>{t('deliveries.loadMore')}</Button>
          </Group>
        ) : null}
      </FormSection>
    </FormShell>
  );
}
