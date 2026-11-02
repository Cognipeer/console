'use client';

/**
 * The connector parts of the trigger editor that live in the community build: the Test tab of a saved connector
 * trigger (a sample event → dry run → run, through the Run now route). The picker and the subscription status are the
 * Connectors module's (`@/components/enterprise/EnterpriseConnectorTriggerUi`); the filter rows, the dry-run result and
 * the delivery log are the webhook parts, shared.
 */

import { useState } from 'react';
import { Button, Group, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useConnectorTriggerCatalog } from '@/components/enterprise/EnterpriseConnectorTriggerUi';
import { useTranslations } from '@/lib/i18n';
import { DryRunCard, errorMessage, parseJsonObject, type DryRun } from './TriggerWebhookParts';

/** The event types a request may name (the same pattern the server checks). */
const EVENT_TYPE = /^[A-Za-z0-9._:-]{1,64}$/;

export interface ConnectorTestPanelProps {
    agentId: string;
    triggerId: string;
    /** The connector and the package trigger the saved trigger listens to: where the sample event comes from. */
    connectorId: string;
    trigger: string;
}

export function ConnectorTestPanel({ agentId, triggerId, connectorId, trigger }: ConnectorTestPanelProps) {
    const t = useTranslations('agents.triggers');
    const catalog = useConnectorTriggerCatalog();
    const sample = catalog.connectors.find((connector) => connector.id === connectorId)?.triggers.find((item) => item.name === trigger)?.sample ?? null;
    // What was typed; until then the package's sample event shows.
    const [typed, setTyped] = useState<{ event?: string; payload?: string }>({});
    const [result, setResult] = useState<DryRun | null>(null);
    const [busy, setBusy] = useState<'preview' | 'run' | null>(null);
    const eventText = typed.event ?? sample?.type ?? '';
    const payloadText = typed.payload ?? (sample ? JSON.stringify(sample.data, null, 2) : '');
    const payload = payloadText.trim() ? parseJsonObject(payloadText) : undefined;
    const eventInvalid = eventText.trim() !== '' && !EVENT_TYPE.test(eventText.trim());
    const invalid = payload === null || eventInvalid;

    const send = async (dryRun: boolean) => {
        if (invalid) return;
        setBusy(dryRun ? 'preview' : 'run');
        try {
            const res = await fetch(`/api/agents/${agentId}/triggers/${triggerId}/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...(payload ? { payload } : {}),
                    ...(eventText.trim() ? { event: eventText.trim() } : {}),
                    ...(dryRun ? { dry_run: true } : {}),
                }),
            });
            if (!res.ok) throw new Error(await errorMessage(res));
            const data = await res.json() as DryRun & { id?: string };
            if (dryRun) setResult(data);
            else notifications.show({ color: 'teal', message: t('runStarted', { id: data.id ?? '' }) });
        } catch (error) {
            notifications.show({ color: 'red', message: t('runFailed', { message: error instanceof Error ? error.message : String(error) }) });
        } finally {
            setBusy(null);
        }
    };

    return (
        <Stack gap="sm">
            <Text size="sm" c="dimmed">{t('connectorTestHint')}</Text>
            <Group grow align="flex-start">
                <TextInput
                    label={t('connectorTestEvent')}
                    ff="monospace"
                    value={eventText}
                    placeholder={t('connectorTestEventPlaceholder')}
                    error={eventInvalid ? t('connectorTestEventInvalid') : undefined}
                    onChange={(event) => { const next = event.currentTarget.value; setTyped((prev) => ({ ...prev, event: next })); }}
                />
            </Group>
            <Textarea
                label={t('testPayload')}
                description={sample ? undefined : t('connectorTestPayloadHint')}
                ff="monospace"
                autosize
                minRows={8}
                maxRows={24}
                value={payloadText}
                error={payload === null ? t('invalidJson') : undefined}
                onChange={(event) => { const next = event.currentTarget.value; setTyped((prev) => ({ ...prev, payload: next })); }}
            />
            <Group gap="xs">
                <Button size="xs" variant="light" loading={busy === 'preview'} disabled={invalid} onClick={() => void send(true)}>{t('testPreview')}</Button>
                <Button size="xs" color="teal" loading={busy === 'run'} disabled={invalid} onClick={() => void send(false)}>{t('testRun')}</Button>
                <Button size="xs" variant="subtle" color="gray" onClick={() => { setTyped({}); setResult(null); }}>{t('testReset')}</Button>
            </Group>
            {result ? <DryRunCard result={result} /> : null}
        </Stack>
    );
}
