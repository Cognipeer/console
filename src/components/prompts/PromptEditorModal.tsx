'use client';

import { useEffect, useMemo, useState } from 'react';
import { TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconFileText } from '@tabler/icons-react';
import FormShell, {
	Checklist,
	FormField,
	FormRow,
	FormSection,
	SummaryGroup,
	SummaryKV,
} from '@/components/common/ui/FormShell';
import type { PromptView } from '@/lib/services/prompts';
import { useTranslations } from '@/lib/i18n';

type PromptEditorModalProps = {
	opened: boolean;
	onClose: () => void;
	prompt: PromptView | null;
	onSaved: (prompt: PromptView) => void;
};

type FormValues = {
	name: string;
	key: string;
	description: string;
	template: string;
	versionComment: string;
};

export default function PromptEditorModal({
	opened,
	onClose,
	prompt,
	onSaved,
}: PromptEditorModalProps) {
	const [saving, setSaving] = useState(false);
	const t = useTranslations('promptDetail');

	const initialValues = useMemo<FormValues>(() => {
		return {
			name: prompt?.name ?? '',
			key: prompt?.key ?? '',
			description: prompt?.description ?? '',
			template: prompt?.template ?? '',
			versionComment: '',
		};
	}, [prompt]);

	const form = useForm<FormValues>({
		initialValues,
		validate: {
			name: (value) => (value.trim().length === 0 ? t('editor.validation.name') : null),
			template: (value) => (value.trim().length === 0 ? t('editor.validation.template') : null),
		},
	});

	useEffect(() => {
		if (opened) {
			form.setValues(initialValues);
			form.resetDirty(initialValues);
		}
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [opened, prompt]);

	const values = form.values;
	const validName = values.name.trim().length > 0;
	const validTemplate = values.template.trim().length > 0;
	const isEdit = Boolean(prompt);

	const checklist = [
		{ id: 1, label: t('editor.fields.name'), done: validName },
		{ id: 2, label: t('editor.fields.template'), done: validTemplate },
	];

	const handleSubmit = async () => {
		const validation = form.validate();
		if (validation.hasErrors) return;

		setSaving(true);
		try {
			const payload = {
				name: values.name.trim(),
				key: values.key.trim() || undefined,
				description: values.description.trim() || undefined,
				template: values.template,
				versionComment: values.versionComment.trim() || undefined,
			};

			const response = await fetch(prompt ? `/api/prompts/${prompt.id}` : '/api/prompts', {
				method: prompt ? 'PATCH' : 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});

			if (!response.ok) {
				const error = await response.json().catch(() => ({ error: t('editor.notifications.errorMessage') }));
				throw new Error(error.error ?? t('editor.notifications.errorMessage'));
			}

			const data = await response.json();
			notifications.show({
				title: t('editor.notifications.savedTitle'),
				message: t('editor.notifications.savedMessage'),
				color: 'teal',
			});

			onSaved(data.prompt as PromptView);
		} catch (error) {
			notifications.show({
				title: t('editor.notifications.errorTitle'),
				message: error instanceof Error ? error.message : t('editor.notifications.errorMessage'),
				color: 'red',
			});
		} finally {
			setSaving(false);
		}
	};

	const templateLineCount = values.template ? values.template.split('\n').length : 0;
	const templateCharCount = values.template.length;

	const summary = (
		<>
			<SummaryGroup title={isEdit ? t('editor.titleEdit') : t('editor.titleCreate')}>
				<SummaryKV
					label={t('editor.fields.name')}
					value={values.name || <span className="ds-faint">—</span>}
				/>
				{!isEdit ? (
					<SummaryKV
						label={t('editor.fields.key')}
						value={values.key ? <span className="ds-mono">{values.key}</span> : <span className="ds-faint">auto</span>}
						mono
					/>
				) : null}
				<SummaryKV
					label={t('editor.fields.description')}
					value={values.description || <span className="ds-faint">—</span>}
				/>
				<SummaryKV
					label={t('editor.fields.template')}
					value={
						validTemplate ? (
							<span className="ds-faint">{templateLineCount} lines · {templateCharCount} chars</span>
						) : (
							<span className="ds-faint">—</span>
						)
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
			icon={<IconFileText size={16} />}
			title={isEdit ? t('editor.titleEdit') : t('editor.titleCreate')}
			subtitle="Author a prompt template and reuse it across your agents and integrations."
			summary={summary}
			footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
			primaryAction={{
				label: isEdit ? t('editor.actions.save') : t('editor.actions.create'),
				loading: saving,
				disabled: !validName || !validTemplate,
				onClick: () => {
					void handleSubmit();
				},
			}}
			secondaryAction={{
				label: t('editor.actions.cancel'),
				onClick: onClose,
			}}
		>
			<FormSection
				number={1}
				title={t('editor.fields.name')}
				description="How the prompt is identified across the console and the SDK."
				done={validName}
			>
				<FormRow cols={isEdit ? 1 : 2}>
					<FormField label={t('editor.fields.name')} required>
						<TextInput
							placeholder={t('editor.placeholders.name')}
							{...form.getInputProps('name')}
						/>
					</FormField>
					{!isEdit ? (
						<FormField
							label={t('editor.fields.key')}
							hint={t('editor.descriptions.key')}
							optional
						>
							<TextInput
								placeholder={t('editor.placeholders.key')}
								{...form.getInputProps('key')}
							/>
						</FormField>
					) : null}
				</FormRow>
				<FormRow cols={1}>
					<FormField label={t('editor.fields.description')} optional>
						<Textarea
							placeholder={t('editor.placeholders.description')}
							minRows={2}
							autosize
							{...form.getInputProps('description')}
						/>
					</FormField>
				</FormRow>
			</FormSection>

			<FormSection
				number={2}
				title={t('editor.fields.template')}
				description="The body of your prompt. Variables and conditional blocks are supported."
				done={validTemplate}
			>
				<FormRow cols={1}>
					<FormField label={t('editor.fields.template')} required>
						<Textarea
							placeholder={t('editor.placeholders.template')}
							minRows={10}
							autosize
							styles={{ input: { fontFamily: 'monospace', fontSize: 13 } }}
							{...form.getInputProps('template')}
						/>
					</FormField>
				</FormRow>
				<FormRow cols={1}>
					<FormField
						label={t('editor.fields.versionComment')}
						hint={t('editor.descriptions.versionComment')}
						optional
					>
						<Textarea
							placeholder={t('editor.placeholders.versionComment')}
							minRows={2}
							autosize
							{...form.getInputProps('versionComment')}
						/>
					</FormField>
				</FormRow>
			</FormSection>
		</FormShell>
	);
}
