'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, Group, Modal, Stack, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
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

	const handleSubmit = async (values: FormValues) => {
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

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={prompt ? t('editor.titleEdit') : t('editor.titleCreate')}
			size="lg"
			centered
		>
			<form onSubmit={form.onSubmit(handleSubmit)}>
				<Stack gap="md">
					<TextInput
						label={t('editor.fields.name')}
						placeholder={t('editor.placeholders.name')}
						required
						{...form.getInputProps('name')}
					/>

					{!prompt && (
						<TextInput
							label={t('editor.fields.key')}
							placeholder={t('editor.placeholders.key')}
							description={t('editor.descriptions.key')}
							{...form.getInputProps('key')}
						/>
					)}

					<Textarea
						label={t('editor.fields.description')}
						placeholder={t('editor.placeholders.description')}
						minRows={2}
						autosize
						{...form.getInputProps('description')}
					/>

					<Textarea
						label={t('editor.fields.template')}
						placeholder={t('editor.placeholders.template')}
						minRows={8}
						autosize
						required
						styles={{ input: { fontFamily: 'monospace', fontSize: 13 } }}
						{...form.getInputProps('template')}
					/>

					<Textarea
						label={t('editor.fields.versionComment')}
						description={t('editor.descriptions.versionComment')}
						placeholder={t('editor.placeholders.versionComment')}
						minRows={2}
						autosize
						{...form.getInputProps('versionComment')}
					/>

					<Group justify="flex-end">
						<Button variant="default" onClick={onClose}>
							{t('editor.actions.cancel')}
						</Button>
						<Button type="submit" loading={saving}>
							{prompt ? t('editor.actions.save') : t('editor.actions.create')}
						</Button>
					</Group>
				</Stack>
			</form>
		</Modal>
	);
}

