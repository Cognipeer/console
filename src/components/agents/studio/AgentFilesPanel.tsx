'use client';

/**
 * Files — whether people can attach documents and images to a session, where
 * those files are stored, the limits, and how the agent reads them.
 *
 * It used to be the third block of Execution under the name "Attachments", with
 * the bucket as a free-text box, which is why nobody found it and a typo only
 * failed on the first upload. Files now live in a bucket of the project's
 * Document Store: the picker lists the project's buckets (an unusable one is
 * shown with the reason, not hidden) and a file is not allowed on without one.
 * The server checks the same on save.
 *
 * Settings here are part of the draft config like the rest of Configure, and
 * reach portal users when the agent is published.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
    Alert,
    Badge,
    Button,
    Group,
    Loader,
    NumberInput,
    Select,
    SimpleGrid,
    Stack,
    Switch,
    TagsInput,
    Text,
    TextInput,
} from '@mantine/core';
import type { ComboboxItem, ComboboxLikeRenderOptionInput } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconFolder, IconInfoCircle } from '@tabler/icons-react';
import OcrSettingsFields from '@/components/extraction/OcrSettingsFields';
import { useTranslations } from '@/lib/i18n';
import { FILE_OUTPUT_EXTENSIONS, SESSION_FILES_DEFAULTS } from '@/lib/services/agents/sessionFilesConfig';
import { ConfigBlock } from './ConfigSection';
import {
    attachesNewUploads,
    bucketPickerItems,
    bytesToMb,
    bucketProblem,
    bucketUnusableReason,
    DEFAULT_FILES_FOLDER,
    effectiveRetentionDays,
    filesEnabled,
    filesNeedBucket,
    folderIssue,
    folderPreview,
    MAX_FOLDER_LENGTH,
    MIME_TYPE_SUGGESTIONS,
    mbToBytes,
    normalizeFolder,
    ocrIssue,
    OUTPUTS_LIMITS,
    outputsEnabled,
    patchAttachments,
    patchOcr,
    patchOutputs,
    type AttachmentBucketOption,
    type AttachmentsSettings,
    type BucketPickerItem,
    type BucketReasonLabels,
} from './filesSettings';

/** Where the project's bucket list stands. */
export type BucketsState =
    | { status: 'loading' }
    | { status: 'error' }
    /** The viewer may not list buckets (no access to the Document Store); `message` is the server's explanation. */
    | { status: 'forbidden'; message?: string }
    | { status: 'ready'; buckets: AttachmentBucketOption[] };

export interface AgentFilesPanelViewProps {
    value: AttachmentsSettings | undefined;
    onChange: (next: AttachmentsSettings | undefined) => void;
    /** The agent's key — shown in the path preview. */
    agentKey?: string;
    buckets: BucketsState;
    onRetryBuckets?: () => void;
    /** Show "Choose a bucket" even before the field was touched (a save was refused). */
    showErrors?: boolean;
}

/** The project's buckets for the picker, loaded while files are on (uploads or the agent's own). */
export function useAttachmentBuckets(enabled: boolean): { state: BucketsState; reload: () => void } {
    const [state, setState] = useState<BucketsState>({ status: 'loading' });
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        setState({ status: 'loading' });
        fetch('/api/agents/attachments/buckets', { cache: 'no-store' })
            .then(async (res) => {
                if (res.status === 403) {
                    // Not an outage: the viewer has no access to the Document Store. The server says why.
                    const body = await res.json().catch(() => ({})) as { error?: unknown };
                    if (!cancelled) setState({ status: 'forbidden', ...(typeof body.error === 'string' && body.error ? { message: body.error } : {}) });
                    return;
                }
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json() as { buckets?: AttachmentBucketOption[] };
                if (!cancelled) setState({ status: 'ready', buckets: Array.isArray(data.buckets) ? data.buckets : [] });
            })
            .catch(() => { if (!cancelled) setState({ status: 'error' }); });
        return () => { cancelled = true; };
    }, [enabled, attempt]);

    const reload = useCallback(() => setAttempt((n) => n + 1), []);
    return { state, reload };
}

export default function AgentFilesPanel({
    value,
    onChange,
    agentKey,
    showErrors,
}: Omit<AgentFilesPanelViewProps, 'buckets' | 'onRetryBuckets'>) {
    const { state, reload } = useAttachmentBuckets(filesNeedBucket(value));
    return (
        <AgentFilesPanelView
            value={value}
            onChange={onChange}
            agentKey={agentKey}
            buckets={state}
            onRetryBuckets={reload}
            showErrors={showErrors}
        />
    );
}

export function AgentFilesPanelView({ value, onChange, agentKey, buckets, onRetryBuckets, showErrors }: AgentFilesPanelViewProps) {
    const t = useTranslations('agents.attachments');
    const [bucketTouched, setBucketTouched] = useState(false);
    const current = value ?? {};
    const set = (patch: Partial<AttachmentsSettings>) => onChange(patchAttachments(value, patch));
    const on = filesEnabled(value);
    const writesFiles = outputsEnabled(value);
    const needsBucket = filesNeedBucket(value);

    const list = buckets.status === 'ready' ? buckets.buckets : null;
    const labels: BucketReasonLabels & { notFound: (key: string) => string } = {
        byCode: {
            bucket_missing: t('bucketMissing'),
            bucket_disabled: t('bucketDisabled'),
            provider_missing: t('bucketProviderMissing'),
            provider_unassigned: t('bucketProviderUnassigned'),
            provider_inactive: t('bucketProviderInactive'),
            provider_invalid: t('bucketProviderInvalid'),
        },
        unusable: t('bucketUnusable'),
        cannotChoose: t('bucketCannotChoose'),
        notFound: (key) => t('bucketNotFound', { key }),
    };
    const items = useMemo(
        () => bucketPickerItems(list, current.bucketKey, labels),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [list, current.bucketKey, t],
    );
    const byValue = useMemo(() => new Map(items.map((item) => [item.value, item])), [items]);
    const chosen = current.bucketKey ? list?.find((bucket) => bucket.key === current.bucketKey) : undefined;

    const problem = bucketProblem(value, list);
    const bucketError =
        problem === 'required' ? ((bucketTouched || showErrors) ? t('bucketRequired') : undefined)
            : problem === 'not_found' ? t('bucketNotFoundError')
                : problem === 'unusable' && chosen
                    ? t('bucketUnusableError', { reason: bucketUnusableReason(chosen, labels) ?? t('bucketUnusable') })
                    : undefined;

    const issue = folderIssue(current.folder);
    const folderError =
        issue === 'invalid_chars' ? t('folderInvalidChars')
            : issue === 'dot_dot' ? t('folderDotDot')
                : issue === 'too_long' ? t('folderTooLong', { max: MAX_FOLDER_LENGTH })
                    : undefined;

    const renderBucketOption = ({ option, checked }: ComboboxLikeRenderOptionInput<ComboboxItem>) => {
        const item: BucketPickerItem | undefined = byValue.get(option.value);
        return (
            <Group gap={6} wrap="nowrap" align="flex-start" style={{ flex: 1 }}>
                <IconCheck size={14} style={{ marginTop: 3, flexShrink: 0, opacity: checked ? 1 : 0 }} />
                <div>
                    <Group gap={6} wrap="nowrap">
                        <Text size="sm">{option.label}</Text>
                        {item?.localDisk ? <Badge size="xs" variant="light" color="orange">{t('serverDisk')}</Badge> : null}
                    </Group>
                    {item?.reason ? <Text size="xs" c="red">{item.reason}</Text> : null}
                </div>
            </Group>
        );
    };

    const emptyProject = buckets.status === 'ready' && buckets.buckets.length === 0;
    const summaryDays = effectiveRetentionDays(value);
    const summaryFolder = normalizeFolder(current.folder);

    return (
        <Stack gap="lg">
            <Switch
                label={t('cfgAccept')}
                description={t('cfgAcceptDescription')}
                checked={on}
                onChange={(event) => set({ enabled: event.currentTarget.checked })}
            />

            <ConfigBlock title={t('outputsTitle')}>
                <Stack gap="sm">
                    <Switch
                        label={t('cfgOutputs')}
                        description={t('cfgOutputsDescription', { types: FILE_OUTPUT_EXTENSIONS.map((ext) => `.${ext}`).join(' ') })}
                        checked={writesFiles}
                        onChange={(event) => onChange(patchOutputs(value, { enabled: event.currentTarget.checked }))}
                    />
                    {writesFiles ? (
                        <SimpleGrid cols={{ base: 1, md: 3 }} spacing="sm">
                            <NumberInput
                                label={t('cfgOutputsMaxFiles')}
                                placeholder={String(OUTPUTS_LIMITS.maxFilesPerTurn.default)}
                                min={1}
                                max={OUTPUTS_LIMITS.maxFilesPerTurn.max}
                                allowDecimal={false}
                                value={current.outputs?.maxFilesPerTurn ?? ''}
                                onChange={(v) => onChange(patchOutputs(value, { maxFilesPerTurn: typeof v === 'number' ? v : undefined }))}
                            />
                            <NumberInput
                                label={t('cfgOutputsMaxFileSize')}
                                placeholder={String(OUTPUTS_LIMITS.maxFileSizeMb.default)}
                                min={0.1}
                                max={OUTPUTS_LIMITS.maxFileSizeMb.max}
                                decimalScale={1}
                                value={current.outputs?.maxFileSizeMb ?? ''}
                                onChange={(v) => onChange(patchOutputs(value, { maxFileSizeMb: typeof v === 'number' ? v : undefined }))}
                            />
                        </SimpleGrid>
                    ) : null}
                </Stack>
            </ConfigBlock>

            {needsBucket ? (
                <>
                    <ConfigBlock title={t('storageTitle')} icon={<IconFolder size={14} />}>
                        <Stack gap="sm">
                            {buckets.status === 'error' ? (
                                <Alert variant="light" color="red" icon={<IconAlertTriangle size={16} />} p="sm">
                                    <Group justify="space-between" wrap="nowrap" gap="sm">
                                        <Text size="sm">{t('bucketLoadFailed')}</Text>
                                        {onRetryBuckets ? (
                                            <Button size="compact-xs" variant="light" color="red" onClick={onRetryBuckets}>
                                                {t('bucketRetry')}
                                            </Button>
                                        ) : null}
                                    </Group>
                                </Alert>
                            ) : null}

                            {buckets.status === 'forbidden' ? (
                                <Alert variant="light" color="yellow" icon={<IconInfoCircle size={16} />} p="sm" title={t('bucketForbiddenTitle')} data-testid="buckets-forbidden">
                                    <Text size="sm">{buckets.message ?? t('bucketForbidden')}</Text>
                                </Alert>
                            ) : null}

                            {emptyProject ? (
                                <Alert variant="light" color="yellow" icon={<IconInfoCircle size={16} />} p="sm" title={t('bucketEmptyTitle')}>
                                    <Stack gap="xs">
                                        <Text size="sm">{t('bucketEmptyBody')}</Text>
                                        <Group>
                                            <Button component={Link} href="/dashboard/files" size="compact-sm" variant="light">
                                                {t('bucketEmptyAction')}
                                            </Button>
                                        </Group>
                                    </Stack>
                                </Alert>
                            ) : null}

                            <Select
                                label={t('cfgBucket')}
                                description={t('cfgBucketDescription')}
                                placeholder={buckets.status === 'loading' ? t('bucketLoading') : t('bucketPlaceholder')}
                                searchable
                                nothingFoundMessage={t('bucketNothingFound')}
                                data={items.map(({ value: key, label, disabled }) => ({ value: key, label, disabled }))}
                                value={current.bucketKey ?? null}
                                onChange={(next) => {
                                    setBucketTouched(true);
                                    set({ bucketKey: next ?? undefined });
                                }}
                                renderOption={renderBucketOption}
                                // Without access to the Document Store the saved bucket stays as it is; it cannot be changed from here.
                                disabled={buckets.status === 'forbidden'}
                                rightSection={buckets.status === 'loading' ? <Loader size={14} /> : undefined}
                                error={bucketError}
                                withAsterisk
                                maw={480}
                            />

                            {!emptyProject && buckets.status !== 'forbidden' ? (
                                <Group>
                                    <Button component={Link} href="/dashboard/files" size="compact-xs" variant="subtle" color="gray">
                                        {t('bucketManage')}
                                    </Button>
                                </Group>
                            ) : null}

                            {chosen?.localDisk ? (
                                <Alert variant="light" color="orange" icon={<IconInfoCircle size={16} />} p="sm">
                                    <Text size="xs">{t('serverDiskHint')}</Text>
                                </Alert>
                            ) : null}

                            <TextInput
                                label={t('cfgFolder')}
                                description={t('cfgFolderDescription')}
                                placeholder={DEFAULT_FILES_FOLDER}
                                value={current.folder ?? ''}
                                onChange={(event) => set({ folder: event.currentTarget.value || undefined })}
                                error={folderError}
                                maw={480}
                            />
                            <Text size="xs" c="dimmed" ff="monospace">
                                {t('folderPreview', { path: folderPreview(current.folder, agentKey) })}
                            </Text>
                            {/* Retention applies to every stored file, an agent's own outputs included: it is not an uploads-only limit. */}
                            <NumberInput
                                label={t('cfgRetention')}
                                description={t('cfgRetentionDescription')}
                                placeholder={String(SESSION_FILES_DEFAULTS.retentionDays)}
                                min={1}
                                allowDecimal={false}
                                value={current.retentionDays ?? ''}
                                onChange={(v) => set({ retentionDays: typeof v === 'number' ? v : undefined })}
                                maw={480}
                            />
                        </Stack>
                    </ConfigBlock>

                    {on ? (
                        <>
                            <ConfigBlock title={t('limitsTitle')}>
                                <Stack gap="sm">
                                    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
                                        <NumberInput
                                            label={t('cfgMaxFiles')}
                                            placeholder={String(SESSION_FILES_DEFAULTS.maxFiles)}
                                            min={1}
                                            max={100}
                                            allowDecimal={false}
                                            value={current.maxFiles ?? ''}
                                            onChange={(v) => set({ maxFiles: typeof v === 'number' ? v : undefined })}
                                        />
                                        <NumberInput
                                            label={t('cfgMaxFileSize')}
                                            placeholder={String(SESSION_FILES_DEFAULTS.maxFileSizeMb)}
                                            min={1}
                                            value={current.maxFileSizeMb ?? ''}
                                            onChange={(v) => set({ maxFileSizeMb: typeof v === 'number' ? v : undefined })}
                                        />
                                    </SimpleGrid>
                                    <TagsInput
                                        label={t('cfgMimeTypes')}
                                        description={t('cfgMimeTypesDescription')}
                                        placeholder={(current.allowedMimeTypes?.length ?? 0) === 0 ? t('cfgMimeTypesPlaceholder') : undefined}
                                        data={[...MIME_TYPE_SUGGESTIONS]}
                                        splitChars={[',', ' ']}
                                        acceptValueOnBlur
                                        clearable
                                        value={current.allowedMimeTypes ?? []}
                                        onChange={(allowedMimeTypes) => set({ allowedMimeTypes })}
                                    />
                                </Stack>
                            </ConfigBlock>

                            <ConfigBlock title={t('readingTitle')}>
                                <Stack gap="sm">
                                    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
                                        <NumberInput
                                            label={t('cfgInlineTokens')}
                                            description={t('cfgInlineTokensDescription')}
                                            placeholder={String(SESSION_FILES_DEFAULTS.inlineMaxTokens)}
                                            min={100}
                                            allowDecimal={false}
                                            value={current.inlineMaxTokens ?? ''}
                                            onChange={(v) => set({ inlineMaxTokens: typeof v === 'number' ? v : undefined })}
                                        />
                                        <NumberInput
                                            label={t('cfgReadPage')}
                                            description={t('cfgReadPageDescription')}
                                            placeholder={String(SESSION_FILES_DEFAULTS.readPageChars)}
                                            min={500}
                                            allowDecimal={false}
                                            value={current.readPageChars ?? ''}
                                            onChange={(v) => set({ readPageChars: typeof v === 'number' ? v : undefined })}
                                        />
                                    </SimpleGrid>
                                    <Switch
                                        label={t('cfgAttachNew')}
                                        description={t('cfgAttachNewDescription')}
                                        checked={attachesNewUploads(value)}
                                        onChange={(event) => set({ attachNewUploads: event.currentTarget.checked ? undefined : false })}
                                    />
                                </Stack>
                            </ConfigBlock>

                            <ConfigBlock title={t('ocrTitle')}>
                                <Stack gap="sm">
                                    <Text size="xs" c="dimmed">{t('ocrDescription')}</Text>
                                    <OcrSettingsFields
                                        value={current.ocr}
                                        onChange={(next) => onChange(patchOcr(value, next))}
                                        showImages
                                        modelError={showErrors && ocrIssue(value) === 'model' ? t('ocrModelInvalid') : undefined}
                                    />
                                    {current.ocr && current.ocr.mode !== 'off' && current.ocr.images ? (
                                        <Text size="xs" c="dimmed">{t('ocrImagesNote')}</Text>
                                    ) : null}
                                </Stack>
                            </ConfigBlock>

                            <ConfigBlock title={t('imagesTitle')}>
                                <Stack gap="sm">
                                    <SimpleGrid cols={{ base: 1, md: 3 }} spacing="sm">
                                        <NumberInput
                                            label={t('cfgMaxImages')}
                                            description={t('cfgMaxImagesDescription')}
                                            placeholder={String(SESSION_FILES_DEFAULTS.maxImages)}
                                            min={1}
                                            max={50}
                                            allowDecimal={false}
                                            value={current.maxImages ?? ''}
                                            onChange={(v) => set({ maxImages: typeof v === 'number' ? v : undefined })}
                                        />
                                        <NumberInput
                                            label={t('cfgMaxImageMb')}
                                            description={t('cfgMaxImageMbDescription')}
                                            placeholder={String(SESSION_FILES_DEFAULTS.maxBytes / 1_000_000)}
                                            min={0.1}
                                            max={200}
                                            decimalScale={1}
                                            value={bytesToMb(current.maxBytes) ?? ''}
                                            onChange={(v) => set({ maxBytes: mbToBytes(v) })}
                                        />
                                        <NumberInput
                                            label={t('cfgCarryImages')}
                                            description={t('cfgCarryImagesDescription')}
                                            placeholder={String(SESSION_FILES_DEFAULTS.carryRecentImages)}
                                            min={0}
                                            max={20}
                                            allowDecimal={false}
                                            value={current.carryRecentImages ?? ''}
                                            onChange={(v) => set({ carryRecentImages: typeof v === 'number' ? v : undefined })}
                                        />
                                    </SimpleGrid>
                                </Stack>
                            </ConfigBlock>
                        </>
                    ) : null}

                    <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />} p="sm">
                        <Stack gap={2}>
                            <Text size="xs">
                                {chosen
                                    ? chosen.providerLabel
                                        ? t('summaryOn', { bucket: chosen.name, provider: chosen.providerLabel, folder: summaryFolder, days: summaryDays })
                                        : t('summaryOnNoProvider', { bucket: chosen.name, folder: summaryFolder, days: summaryDays })
                                    : current.bucketKey
                                        ? t('summaryOnNoProvider', { bucket: current.bucketKey, folder: summaryFolder, days: summaryDays })
                                        : t('summaryNoBucket')}
                            </Text>
                            <Text size="xs" c="dimmed">{t('publishNote')}</Text>
                        </Stack>
                    </Alert>
                </>
            ) : null}
        </Stack>
    );
}
