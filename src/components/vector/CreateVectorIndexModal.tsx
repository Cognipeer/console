'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { NumberInput, Select, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconDatabase, IconPlus } from '@tabler/icons-react';
import FormShell, {
	Checklist,
	ChipPicker,
	FormField,
	FormRow,
	FormSection,
	SummaryGroup,
	SummaryKV,
} from '@/components/common/ui/FormShell';
import type { VectorIndexRecord, VectorProviderView } from '@/lib/services/vector';

const DEFAULT_METRIC_OPTIONS = [
	{ value: 'cosine', label: 'Cosine' },
	{ value: 'dot', label: 'Dot Product' },
	{ value: 'euclidean', label: 'Euclidean' },
];

type MetricValue = 'cosine' | 'dot' | 'euclidean' | string;

function resolveAllowedMetrics(provider?: VectorProviderView | null): string[] | null {
	const raw = provider?.driverCapabilities?.['vector.metrics'];
	if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) {
		return raw as string[];
	}
	return null;
}

interface CreateVectorIndexModalProps {
	opened: boolean;
	onClose: () => void;
	providers: VectorProviderView[];
	onCreated: (options: { index: VectorIndexRecord; provider: VectorProviderView }) => void;
}

interface FormValues {
	name: string;
	dimension: number | '';
	metric: string;
	description: string;
	providerKey: string;
}

export default function CreateVectorIndexModal({
	opened,
	onClose,
	providers,
	onCreated,
}: CreateVectorIndexModalProps) {
	const [availableProviders, setAvailableProviders] = useState<VectorProviderView[]>(providers);
	const [submitting, setSubmitting] = useState(false);
	const wasOpenedRef = useRef(false);

	const form = useForm<FormValues>({
		initialValues: {
			name: '',
			dimension: '',
			metric: 'cosine',
			description: '',
			providerKey: providers[0]?.key ?? '',
		},
		validate: {
			name: (value) => (!value ? 'Name is required' : null),
			dimension: (value) =>
				!value || Number(value) <= 0 ? 'Dimension must be a positive number' : null,
			providerKey: (value) => (!value ? 'Select a provider' : null),
		},
	});

	const { values: formValues, setFieldValue, reset } = form;

	useEffect(() => {
		setAvailableProviders(providers);
		if (providers.length === 0) {
			return;
		}

		const currentKey = formValues.providerKey;
		const hasCurrentProvider = providers.some((provider) => provider.key === currentKey);
		if (!currentKey || !hasCurrentProvider) {
			setFieldValue('providerKey', providers[0].key);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [providers, formValues.providerKey]);

	useEffect(() => {
		if (!opened) {
			if (wasOpenedRef.current) {
				reset();
				setAvailableProviders(providers);
				setFieldValue('providerKey', providers[0]?.key ?? '');
				wasOpenedRef.current = false;
			}
		} else {
			wasOpenedRef.current = true;
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [opened, providers]);

	const providerOptions = useMemo(
		() =>
			availableProviders.map((provider) => ({
				value: provider.key,
				label: provider.label,
				disabled: provider.status === 'disabled',
			})),
		[availableProviders],
	);

	const selectedProvider = useMemo(
		() =>
			availableProviders.find((provider) => provider.key === formValues.providerKey) ?? null,
		[availableProviders, formValues.providerKey],
	);

	const allowedMetrics = useMemo(() => resolveAllowedMetrics(selectedProvider), [selectedProvider]);

	const metricOptions = useMemo(() => {
		if (allowedMetrics && allowedMetrics.length > 0) {
			return DEFAULT_METRIC_OPTIONS.filter((option) => allowedMetrics.includes(option.value));
		}
		return DEFAULT_METRIC_OPTIONS;
	}, [allowedMetrics]);

	useEffect(() => {
		if (allowedMetrics && allowedMetrics.length > 0) {
			if (!allowedMetrics.includes(formValues.metric)) {
				setFieldValue('metric', allowedMetrics[0]);
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [allowedMetrics, formValues.metric]);

	const validProvider = Boolean(formValues.providerKey);
	const validIdentity = Boolean(formValues.name);
	const validConfig = Boolean(formValues.dimension && Number(formValues.dimension) > 0 && formValues.metric);

	const checklist = [
		{ id: 1, label: 'Provider selected', done: validProvider },
		{ id: 2, label: 'Name set', done: validIdentity },
		{ id: 3, label: 'Dimension & metric configured', done: validConfig },
	];

	const submit = async () => {
		const validation = form.validate();
		if (validation.hasErrors) return;
		const values = form.getValues();

		if (!values.providerKey) {
			form.validateField('providerKey');
			return;
		}

		const provider = availableProviders.find((item) => item.key === values.providerKey);
		if (!provider) {
			notifications.show({
				color: 'red',
				title: 'Provider not found',
				message: 'Select a valid provider before creating an index.',
			});
			return;
		}

		setSubmitting(true);
		try {
			const response = await fetch('/api/vector/indexes', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					providerKey: values.providerKey,
					name: values.name,
					dimension: Number(values.dimension),
					metric: values.metric,
					metadata: values.description ? { description: values.description } : undefined,
				}),
			});

			if (!response.ok) {
				const error = await response.json().catch(() => ({ error: 'Unknown error' }));
				throw new Error(error.error ?? 'Failed to create index');
			}

			const data = await response.json();
			notifications.show({
				color: 'green',
				title: 'Vector index created',
				message: `${values.name} is ready to use.`,
			});
			onCreated({ index: data.index, provider });
			onClose();
			reset();
		} catch (error: unknown) {
			console.error(error);
			notifications.show({
				color: 'red',
				title: 'Unable to create index',
				message: error instanceof Error ? error.message : 'Unexpected error',
			});
		} finally {
			setSubmitting(false);
		}
	};

	const noProviders = availableProviders.length === 0;
	const canSubmit = !noProviders && validProvider && validIdentity && validConfig;

	const summary = (
		<>
			<SummaryGroup title="Provider">
				{selectedProvider ? (
					<>
						<SummaryKV label="Name" value={selectedProvider.label} />
						<SummaryKV label="Driver" value={selectedProvider.driver} mono />
						<SummaryKV label="Status" value={selectedProvider.status} />
					</>
				) : (
					<SummaryKV label="—" value="Select a provider" />
				)}
			</SummaryGroup>

			<SummaryGroup title="Index">
				<SummaryKV
					label="Name"
					value={formValues.name || <span className="ds-faint">—</span>}
				/>
				<SummaryKV
					label="Dimension"
					value={formValues.dimension ? String(formValues.dimension) : <span className="ds-faint">—</span>}
					mono
				/>
				<SummaryKV label="Metric" value={formValues.metric || '—'} />
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
			icon={<IconDatabase size={16} />}
			title="Create vector index"
			subtitle="Add a new embeddings index for semantic search and similarity matching."
			summary={summary}
			footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
			primaryAction={{
				label: 'Create index',
				icon: <IconPlus size={13} />,
				loading: submitting,
				disabled: !canSubmit,
				onClick: submit,
			}}
		>
			<FormSection
				number={1}
				title="Provider"
				description="Pick the vector database that will host this index."
				done={validProvider}
			>
				{noProviders ? (
					<div
						className="ds-card ds-card-pad"
						style={{ background: 'var(--ds-surface-1)' }}
					>
						<span className="ds-muted" style={{ fontSize: 13 }}>
							No vector providers configured yet. Ask a tenant admin to add one in Tenant Settings.
						</span>
					</div>
				) : (
					<>
						<FormField label="Provider" required>
							<Select
								placeholder="Select a vector provider"
								data={providerOptions}
								value={formValues.providerKey}
								onChange={(value) => {
									const nextKey = value ?? '';
									setFieldValue('providerKey', nextKey);
									const nextProvider = availableProviders.find((item) => item.key === nextKey);
									const capability = resolveAllowedMetrics(nextProvider);
									if (capability && capability.length > 0) {
										const currentMetric = formValues.metric;
										setFieldValue('metric', capability.includes(currentMetric) ? currentMetric : capability[0]);
									}
								}}
								searchable
							/>
						</FormField>
						{selectedProvider ? (
							<div
								className="ds-card ds-card-pad-sm"
								style={{ marginTop: 12, background: 'var(--ds-surface-1)' }}
							>
								<div className="ds-row ds-gap-sm" style={{ marginBottom: 4 }}>
									<span style={{ fontWeight: 600 }}>{selectedProvider.label}</span>
									<span
										className={`ds-badge ${selectedProvider.status === 'active' ? 'ds-badge-ok' : 'ds-badge-warn'}`}
									>
										{selectedProvider.status}
									</span>
								</div>
								{selectedProvider.description ? (
									<div
										className="ds-muted"
										style={{ fontSize: 12, marginBottom: 4 }}
									>
										{selectedProvider.description}
									</div>
								) : null}
								<div className="ds-faint" style={{ fontSize: 11.5 }}>
									driver: <span className="ds-mono">{selectedProvider.driver}</span>{' '}
									· key: <span className="ds-mono">{selectedProvider.key}</span>
								</div>
							</div>
						) : null}
					</>
				)}
			</FormSection>

			<FormSection
				number={2}
				title="Identity"
				description="How this index is identified across the console and API."
				done={validIdentity}
			>
				<FormRow cols={1}>
					<FormField label="Name" required>
						<TextInput
							placeholder="Knowledge base"
							{...form.getInputProps('name')}
						/>
					</FormField>
				</FormRow>
				<FormRow cols={1}>
					<FormField label="Description" optional>
						<Textarea
							placeholder="Optional description stored with the index"
							autosize
							minRows={2}
							{...form.getInputProps('description')}
						/>
					</FormField>
				</FormRow>
			</FormSection>

			<FormSection
				number={3}
				title="Configuration"
				description="Vector dimensionality and similarity metric used by this index."
				done={validConfig}
			>
				<FormRow cols={2}>
					<FormField label="Dimension" required hint="Must match the embedding model output size.">
						<NumberInput
							placeholder="1536"
							min={1}
							{...form.getInputProps('dimension')}
						/>
					</FormField>
					<FormField label="Metric" required>
						<ChipPicker<MetricValue>
							options={metricOptions.map((opt) => ({ value: opt.value, label: opt.label }))}
							value={formValues.metric}
							onChange={(v) => setFieldValue('metric', v as string)}
						/>
					</FormField>
				</FormRow>
			</FormSection>
		</FormShell>
	);
}
