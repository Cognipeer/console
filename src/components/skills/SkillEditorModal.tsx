'use client';

/**
 * Full-screen skill editor — FormShell, not a small centered Modal (per the
 * project convention: every create/edit screen is a full overlay; a small
 * Modal is for a confirm dialog only). A skill's `body` is often long enough
 * that a cramped dialog would make it unpleasant to write.
 */

import { useEffect, useMemo, useState } from 'react';
import { Select, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBulb } from '@tabler/icons-react';
import FormShell, {
    Checklist,
    FormField,
    FormRow,
    FormSection,
    SummaryGroup,
    SummaryKV,
} from '@/components/common/ui/FormShell';
import type { SkillView } from './types';

interface SkillEditorModalProps {
    opened: boolean;
    onClose: () => void;
    skill: SkillView | null;
    onSaved: (skill: SkillView) => void;
}

interface FormValues {
    key: string;
    title: string;
    header: string;
    body: string;
    minModelTier: 'any' | 'small' | 'large';
    status: 'active' | 'inactive';
}

export default function SkillEditorModal({ opened, onClose, skill, onSaved }: SkillEditorModalProps) {
    const [saving, setSaving] = useState(false);
    const isEdit = Boolean(skill);

    const initialValues = useMemo<FormValues>(() => ({
        key: skill?.key ?? '',
        title: skill?.title ?? '',
        header: skill?.header ?? '',
        body: skill?.body ?? '',
        minModelTier: skill?.minModelTier ?? 'any',
        status: skill?.status ?? 'active',
    }), [skill]);

    const [values, setValues] = useState<FormValues>(initialValues);

    useEffect(() => {
        if (opened) setValues(initialValues);
    }, [opened, initialValues]);

    const validTitle = values.title.trim().length > 0;
    const validHeader = values.header.trim().length > 0;
    const validBody = values.body.trim().length > 0;

    const checklist = [
        { id: 1, label: 'Title', done: validTitle },
        { id: 2, label: 'Header (the catalog line)', done: validHeader },
        { id: 3, label: 'Instructions', done: validBody },
    ];

    const handleSubmit = async () => {
        if (!validTitle || !validHeader || !validBody) return;
        setSaving(true);
        try {
            const payload = {
                key: values.key.trim() || undefined,
                title: values.title.trim(),
                header: values.header.trim(),
                body: values.body,
                minModelTier: values.minModelTier === 'any' ? null : values.minModelTier,
                status: values.status,
            };
            const res = await fetch(skill ? `/api/skills/${skill._id}` : '/api/skills', {
                method: skill ? 'PATCH' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const error = await res.json().catch(() => ({ error: 'Failed to save skill' }));
                throw new Error(error.error ?? 'Failed to save skill');
            }
            const data = await res.json();
            notifications.show({
                title: isEdit ? 'Skill saved' : 'Skill created',
                message: `"${data.skill.title}" is ready to attach to an agent`,
                color: 'teal',
            });
            onSaved(data.skill as SkillView);
        } catch (error) {
            notifications.show({
                title: 'Save failed',
                message: error instanceof Error ? error.message : String(error),
                color: 'red',
            });
        } finally {
            setSaving(false);
        }
    };

    const bodyChars = values.body.length;

    const summary = (
        <>
            <SummaryGroup title={isEdit ? 'Edit skill' : 'New skill'}>
                <SummaryKV label="Title" value={values.title || <span className="ds-faint">—</span>} />
                {!isEdit ? (
                    <SummaryKV
                        label="Key"
                        value={values.key ? <span className="ds-mono">{values.key}</span> : <span className="ds-faint">auto</span>}
                        mono
                    />
                ) : null}
                <SummaryKV label="Header" value={values.header || <span className="ds-faint">—</span>} />
                <SummaryKV
                    label="Instructions"
                    value={validBody ? <span className="ds-faint">{bodyChars} chars</span> : <span className="ds-faint">—</span>}
                />
                <SummaryKV label="Model tier" value={values.minModelTier === 'any' ? 'Any' : values.minModelTier} />
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
            icon={<IconBulb size={16} />}
            title={isEdit ? 'Edit skill' : 'New skill'}
            subtitle="A capability an agent can discover and open on demand — the header is always visible to the model, the body only once it opens the skill."
            summary={summary}
            footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
            primaryAction={{
                label: isEdit ? 'Save' : 'Create',
                loading: saving,
                disabled: !validTitle || !validHeader || !validBody,
                onClick: () => void handleSubmit(),
            }}
            secondaryAction={{ label: 'Cancel', onClick: onClose }}
        >
            <FormSection
                number={1}
                title="Identity"
                description="How this skill is named and discovered."
                done={validTitle}
            >
                <FormRow cols={isEdit ? 1 : 2}>
                    <FormField label="Title" required>
                        <TextInput
                            placeholder="Atlassian triage"
                            value={values.title}
                            onChange={(event) => setValues((v) => ({ ...v, title: event.currentTarget.value }))}
                        />
                    </FormField>
                    {!isEdit ? (
                        <FormField label="Key" hint="Referenced from an agent's Skills tab. Leave blank to derive it from the title." optional>
                            <TextInput
                                placeholder="atlassian-triage"
                                value={values.key}
                                onChange={(event) => setValues((v) => ({ ...v, key: event.currentTarget.value }))}
                            />
                        </FormField>
                    ) : null}
                </FormRow>
                <FormRow cols={1}>
                    <FormField
                        label="Header"
                        required
                        hint="One line: what it does and when to use it. This is the only thing the model sees before opening the skill — write it like a tool description."
                    >
                        <Textarea
                            placeholder="Investigates a Jira ticket against Confluence docs and application logs, and drafts a root-cause summary. Use for incident/bug tickets."
                            minRows={2}
                            autosize
                            value={values.header}
                            onChange={(event) => setValues((v) => ({ ...v, header: event.currentTarget.value }))}
                        />
                    </FormField>
                </FormRow>
                <FormRow cols={2}>
                    <FormField label="Model tier" hint="Hide this skill from a small/fast model — see agent-sdk's minModelTier." optional>
                        <Select
                            data={[
                                { value: 'any', label: 'Any model' },
                                { value: 'large', label: 'Large models only' },
                                { value: 'small', label: 'Small models only' },
                            ]}
                            value={values.minModelTier}
                            onChange={(next) => setValues((v) => ({ ...v, minModelTier: (next as FormValues['minModelTier']) ?? 'any' }))}
                            allowDeselect={false}
                        />
                    </FormField>
                    {isEdit ? (
                        <FormField label="Status" optional>
                            <Select
                                data={[
                                    { value: 'active', label: 'Active' },
                                    { value: 'inactive', label: 'Inactive — hidden from every agent' },
                                ]}
                                value={values.status}
                                onChange={(next) => setValues((v) => ({ ...v, status: (next as FormValues['status']) ?? 'active' }))}
                                allowDeselect={false}
                            />
                        </FormField>
                    ) : null}
                </FormRow>
            </FormSection>

            <FormSection
                number={2}
                title="Instructions"
                description="Disclosed to the model only after it opens this skill — write it like a focused system-prompt fragment, not documentation for a human."
                done={validBody}
            >
                <FormRow cols={1}>
                    <FormField label="Body" required>
                        <Textarea
                            placeholder={'## Steps\n1. Pull the ticket...\n2. Search Confluence for...\n3. Draft a summary with...'}
                            minRows={16}
                            maxRows={36}
                            autosize
                            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13 } }}
                            value={values.body}
                            onChange={(event) => setValues((v) => ({ ...v, body: event.currentTarget.value }))}
                        />
                    </FormField>
                </FormRow>
            </FormSection>
        </FormShell>
    );
}
