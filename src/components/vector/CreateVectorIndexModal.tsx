import { useEffect, useMemo, useRef, useState } from 'react';
import {
	Badge,
	Button,
	Card,
	Group,
	Modal,
	NumberInput,
	Select,
	Stack,
	Text,
	TextInput,
	Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCirclePlus } from '@tabler/icons-react';
import type { VectorIndexRecord, VectorProviderView } from '@/lib/services/vector';
import VectorProviderModal from './VectorProviderModal';

const DEFAULT_METRIC_OPTIONS = [
	{ value: 'cosine', label: 'Cosine' },
	{ value: 'dot', label: 'Dot Product' },
	{ value: 'euclidean', label: 'Euclidean' },
];

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
	onProviderCreated?: (provider: VectorProviderView) => void;
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
	onProviderCreated,
	onCreated,
}: CreateVectorIndexModalProps) {
	const [availableProviders, setAvailableProviders] = useState<VectorProviderView[]>(providers);
	const [providerModalOpen, setProviderModalOpen] = useState(false);
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

	const handleProviderCreated = (provider: VectorProviderView) => {
		setAvailableProviders((current) => {
			const next = [...current.filter((item) => item.key !== provider.key), provider];
			next.sort((a, b) => a.label.localeCompare(b.label));
			return next;
		});

		setFieldValue('providerKey', provider.key);
			const capability = resolveAllowedMetrics(provider);
			if (capability && capability.length > 0) {
			const currentMetric = formValues.metric;
			setFieldValue('metric', capability.includes(currentMetric) ? currentMetric : capability[0]);
		}

		onProviderCreated?.(provider);
	};

	const handleSubmit = form.onSubmit(async (values) => {
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
	});

	return (
		<>
			<Modal opened={opened} onClose={onClose} title="Create Vector Index" size="lg">
				<form onSubmit={handleSubmit}>
					<Stack gap="lg">
						<Text size="sm" c="dimmed">
							Vector indexes store embeddings for semantic search and similarity matching. Each index is backed by a vector database provider.
						</Text>

						<Stack gap="sm">
							<Group align="flex-end" gap="xs">
								<Select
									label="Provider"
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
									withAsterisk
									style={{ flex: 1 }}
								/>
								<Button
									variant="light"
									leftSection={<IconCirclePlus size={14} />}
									onClick={() => setProviderModalOpen(true)}
								>
									Provider
								</Button>
							</Group>
							<Text size="xs" c="dimmed">
								Need a new vector provider? Add one without leaving this flow.
							</Text>
						</Stack>

						{availableProviders.length === 0 ? (
							<Card withBorder padding="md">
								<Stack gap="xs">
									<Text size="sm" c="dimmed">
										No vector providers configured yet. Add a provider to continue.
									</Text>
									<Button
										size="sm"
										variant="light"
										leftSection={<IconCirclePlus size={14} />}
										onClick={() => setProviderModalOpen(true)}
									>
										Add provider
									</Button>
								</Stack>
							</Card>
						) : null}

						{selectedProvider && (
							<Card withBorder radius="md" padding="md">
								<Stack gap={4}>
									<Group gap="xs">
										<Text fw={600}>{selectedProvider.label}</Text>
										<Badge color={selectedProvider.status === 'active' ? 'green' : 'yellow'}>
											{selectedProvider.status}
										</Badge>
									</Group>
									{selectedProvider.description && (
										<Text size="sm" c="dimmed">
											{selectedProvider.description}
										</Text>
									)}
									<Text size="xs" c="dimmed">
										Driver: {selectedProvider.driver}
									</Text>
									<Text size="xs" c="dimmed">
										Key: {selectedProvider.key}
									</Text>
								</Stack>
							</Card>
						)}

						<Stack gap="md">
							<Text fw={500}>Index configuration</Text>
							<TextInput
								label="Name"
								placeholder="Knowledge base"
								required
								{...form.getInputProps('name')}
							/>
							<NumberInput
								label="Dimension"
								placeholder="1536"
								required
								{...form.getInputProps('dimension')}
							/>
							<Select
								label="Metric"
								data={metricOptions}
								required
								{...form.getInputProps('metric')}
							/>
							<Textarea
								label="Description"
								placeholder="Optional description stored with the index"
								autosize
								minRows={2}
								{...form.getInputProps('description')}
							/>
						</Stack>

						<Group justify="flex-end">
							<Button variant="default" onClick={onClose}>
								Cancel
							</Button>
							<Button type="submit" loading={submitting} disabled={availableProviders.length === 0}>
								Create Index
							</Button>
						</Group>
					</Stack>
				</form>
			</Modal>

			<VectorProviderModal
				opened={providerModalOpen}
				onClose={() => setProviderModalOpen(false)}
				onCreated={handleProviderCreated}
			/>
		</>
	);
}

