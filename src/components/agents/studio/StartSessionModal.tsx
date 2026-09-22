'use client';

/**
 * Start a session — name it and give it context up front.
 *
 * Context entered here is stored on the session and merged UNDER every turn's
 * own runtime context (see `executePlaygroundChatLocal`), which is what makes
 * it a *session* property rather than something retyped per message: the
 * headers a downstream tool needs, or the variables a prompt declares, are
 * almost always constant for the whole conversation.
 */

import { useEffect, useMemo, useState } from 'react';
import { Select, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconMessageCircle } from '@tabler/icons-react';
import FormShell, {
    Checklist,
    FormField,
    FormRow,
    FormSection,
    SummaryGroup,
    SummaryKV,
} from '@/components/common/ui/FormShell';

export interface StartSessionModalProps {
    opened: boolean;
    onClose: () => void;
    agentId: string;
    agentName: string;
    versions: Array<{ version: number }>;
    publishedVersion?: number | null;
    /** Connected agents have no versions to pin. */
    isConnected?: boolean;
    onStarted: (sessionId: string, pinnedVersion: string) => void;
}

const CONTEXT_PLACEHOLDER = `{
  "metadata": {
    "customer": "Acme",
    "locale": "tr-TR"
  },
  "headers": {
    "x-tenant-region": "eu"
  }
}`;

export default function StartSessionModal({
    opened,
    onClose,
    agentId,
    agentName,
    versions,
    publishedVersion,
    isConnected,
    onStarted,
}: StartSessionModalProps) {
    const [name, setName] = useState('');
    const [contextJson, setContextJson] = useState('');
    const [version, setVersion] = useState('');
    const [starting, setStarting] = useState(false);

    useEffect(() => {
        if (!opened) return;
        setName('');
        setContextJson('');
        setVersion('');
    }, [opened]);

    const parsedContext = useMemo(() => {
        if (!contextJson.trim()) return { ok: true as const, value: undefined };
        try {
            const parsed = JSON.parse(contextJson);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return { ok: false as const, error: 'Context must be a JSON object' };
            }
            return { ok: true as const, value: parsed as Record<string, unknown> };
        } catch (error) {
            return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
        }
    }, [contextJson]);

    const contextValid = parsedContext.ok;

    const checklist = [
        { id: 1, label: 'Name (optional — the first message names it otherwise)', done: true },
        { id: 2, label: 'Context is valid JSON', done: contextValid },
    ];

    const start = async () => {
        if (!contextValid) return;
        setStarting(true);
        try {
            const res = await fetch(`/api/agents/${agentId}/sessions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: name.trim() || undefined,
                    ...(parsedContext.ok && parsedContext.value ? { context: parsedContext.value } : {}),
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || 'Failed to start session');
            }
            const data = await res.json();
            onStarted(String(data.session._id), version);
        } catch (error) {
            notifications.show({
                title: 'Could not start the session',
                message: error instanceof Error ? error.message : String(error),
                color: 'red',
            });
            setStarting(false);
        }
    };

    const summary = (
        <>
            <SummaryGroup title="New session">
                <SummaryKV label="Agent" value={agentName} />
                <SummaryKV label="Name" value={name || <span className="ds-faint">auto from first message</span>} />
                <SummaryKV
                    label="Runs"
                    value={version ? `v${version}` : <span className="ds-faint">draft config</span>}
                />
                <SummaryKV
                    label="Context"
                    value={
                        contextJson.trim()
                            ? contextValid
                                ? <span className="ds-faint">{Object.keys((parsedContext.ok && parsedContext.value) || {}).length} key(s)</span>
                                : <span style={{ color: 'var(--mantine-color-red-6)' }}>invalid</span>
                            : <span className="ds-faint">none</span>
                    }
                />
            </SummaryGroup>
            <SummaryGroup title="Pre-flight">
                <Checklist items={checklist} />
            </SummaryGroup>
        </>
    );

    return (
        <FormShell
            open={opened}
            onClose={onClose}
            icon={<IconMessageCircle size={16} />}
            title="Start a session"
            subtitle="A session keeps its own transcript, tool calls and token usage — come back to it any time."
            summary={summary}
            footerStatus={contextValid ? 'Ready' : 'Context is not valid JSON'}
            primaryAction={{
                label: 'Start session',
                loading: starting,
                disabled: !contextValid,
                onClick: () => void start(),
            }}
            secondaryAction={{ label: 'Cancel', onClick: onClose }}
        >
            <FormSection
                number={1}
                title="Session"
                description="What this conversation is for."
                done
            >
                <FormRow cols={isConnected ? 1 : 2}>
                    <FormField label="Name" optional hint="Left blank, the first message becomes the name.">
                        <TextInput
                            placeholder="Refund policy walkthrough"
                            value={name}
                            onChange={(event) => setName(event.currentTarget.value)}
                        />
                    </FormField>
                    {!isConnected ? (
                        <FormField
                            label="Run against"
                            optional
                            hint="Pin a published version to test a frozen snapshot instead of the current draft."
                        >
                            <Select
                                data={[
                                    { value: '', label: 'Draft (current config)' },
                                    ...versions.map((v) => ({
                                        value: String(v.version),
                                        label: `v${v.version}${v.version === publishedVersion ? ' · published' : ''}`,
                                    })),
                                ]}
                                value={version}
                                onChange={(next) => setVersion(next ?? '')}
                                allowDeselect={false}
                            />
                        </FormField>
                    ) : null}
                </FormRow>
            </FormSection>

            <FormSection
                number={2}
                title="Context"
                description="Applied to every turn in this session. A per-message context still overrides it."
                done={contextValid}
            >
                <FormRow cols={1}>
                    <FormField
                        label="Runtime context"
                        optional
                        hint="`metadata` fills the prompt's {{variables}}; `headers` are offered to downstream tools, MCP servers and connected agents (subject to each one's own passthrough policy)."
                    >
                        <Textarea
                            placeholder={CONTEXT_PLACEHOLDER}
                            minRows={10}
                            maxRows={20}
                            autosize
                            error={!contextValid && 'error' in parsedContext ? parsedContext.error : undefined}
                            value={contextJson}
                            onChange={(event) => setContextJson(event.currentTarget.value)}
                            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
                        />
                    </FormField>
                </FormRow>
            </FormSection>
        </FormShell>
    );
}
