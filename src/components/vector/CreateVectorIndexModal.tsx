'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { NumberInput, Select, Switch, TextInput, Textarea } from '@mantine/core';
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
	createInProvider: boolean;
	externalId: string;
}

export default function CreateVectorIndexModal({
	opened,
	onClose,
	providers,
	onCreated,
}: CreateVectorIndexModalProps) {
	const [availableProviders, setAvailableProviders] = useState<VectorProviderView[]>(providers);
	const [submitting, setSubmitting] = useState(false);
	const [needsManualDetails, setNeedsManualDetails] = useState(false);
	const wasOpenedRef = useRef(false);

	const form = useForm<FormValues>({
		initialValues: {
			name: '',
			dimension: '',
			metric: 'cosine',
			description: '',
			providerKey: providers[0]?.key ?? '',
			createInProvider: true,
			externalId: '',
		},
		validate: {
			name: (value) => (!value ? 'Name is required' : null),
			dimension: (value, values) => {
				if (!values.createInProvider) return null;
				return !value || Number(value) <= 0 ? 'Dimension must be a positive number' : null;
			},
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
				setNeedsManualDetails(false);
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
	const validConfig = formValues.createInProvider
		? Boolean(formValues.dimension && Number(formValues.dimension) > 0 && formValues.metric)
		: !needsManualDetails || Boolean(
			formValues.dimension && Number(formValues.dimension) > 0 && formValues.metric && formValues.externalId,
		);

	const checklist = [
		{ id: 1, label: 'Provider selected', done: validProvider },
		{ id: 2, label: 'Name set', done: validIdentity },
		{
			id: 3,
			label: formValues.createInProvider ? 'Dimension & metric configured' : 'Attach details resolved',
			done: validConfig,
		},
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

		// On the first attach attempt, send only the name and let the server try
		// to read dimension/metric/externalId from the provider — the form's
		// dimension/metric fields default to values the user never chose, so
		// forwarding them here would produce false "mismatch" rejections against
		// whatever the provider actually reports. Only once the server says it
		// couldn't read the index (needsManualDetails) do we forward what the
		// user filled in.
		const sendManualDetails = values.createInProvider || needsManualDetails;

		setSubmitting(true);
		try {
			const response = await fetch('/api/vector/indexes', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					providerKey: values.providerKey,
					name: values.name,
					createInProvider: values.createInProvider,
					dimension: sendManualDetails && values.dimension !== '' ? Number(values.dimension) : undefined,
					metric: sendManualDetails ? (values.metric || undefined) : undefined,
					externalId: needsManualDetails ? (values.externalId || undefined) : undefined,
					metadata: values.description ? { description: values.description } : undefined,
				}),
			});

			if (!response.ok) {
				const errorBody = await response.json().catch(() => ({ error: 'Unknown error' }));
				if (errorBody.code === 'VECTOR_ATTACH_REQUIRES_DETAILS') {
					setNeedsManualDetails(true);
					notifications.show({
						color: 'yellow',
						title: 'Provider details needed',
						message: errorBody.error ?? 'Console could not read this index from the provider. Fill in the external ID, dimension and metric below, then try again.',
						autoClose: 8000,
					});
					return;
				}
				throw new Error(errorBody.error ?? 'Failed to create index');
			}

			const data = await response.json();
			notifications.show({
				color: 'green',
				title: values.createInProvider ? 'Vector index created' : 'Vector index attached',
				message: `${values.name} is ready to use.`,
			});
			onCreated({ index: data.index, provider });
			onClose();
			reset();
			setNeedsManualDetails(false);
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
				description={
					formValues.createInProvider
						? 'Vector dimensionality and similarity metric used by this index.'
						: 'Console will try to read these from the provider. Fill them in only if it can\'t.'
				}
				done={validConfig}
			>
				<FormRow cols={1}>
					<FormField
						label="Create index in provider"
						hint={
							formValues.createInProvider
								? 'Console calls the provider to create a brand-new index. Turn this off to attach one that already exists there.'
								: 'Console will attach an existing index instead of creating one — nothing is created on the provider.'
						}
					>
						<Switch
							checked={formValues.createInProvider}
							onChange={(event) => {
								setFieldValue('createInProvider', event.currentTarget.checked);
								setNeedsManualDetails(false);
							}}
							label={formValues.createInProvider ? 'Create new index' : 'Attach existing index'}
						/>
					</FormField>
				</FormRow>
				<FormRow cols={2}>
					<FormField
						label="Dimension"
						required={formValues.createInProvider || needsManualDetails}
						optional={!formValues.createInProvider && !needsManualDetails}
						hint="Must match the embedding model output size. Leave blank to auto-detect from the provider."
					>
						<NumberInput
							placeholder="1536"
							min={1}
							{...form.getInputProps('dimension')}
						/>
					</FormField>
					<FormField
						label="Metric"
						required={formValues.createInProvider || needsManualDetails}
						optional={!formValues.createInProvider && !needsManualDetails}
					>
						<ChipPicker<MetricValue>
							options={metricOptions.map((opt) => ({ value: opt.value, label: opt.label }))}
							value={formValues.metric}
							onChange={(v) => setFieldValue('metric', v as string)}
						/>
					</FormField>
				</FormRow>
				{!formValues.createInProvider ? (
					<FormRow cols={1}>
						<FormField
							label="External ID on provider"
							optional={!needsManualDetails}
							required={needsManualDetails}
							hint="Only needed if Console can't list this provider's indexes automatically. Leave blank to try the index name."
						>
							<TextInput
								placeholder={formValues.name || 'index-name-on-provider'}
								{...form.getInputProps('externalId')}
							/>
						</FormField>
					</FormRow>
				) : null}
			</FormSection>
		</FormShell>
	);
}
