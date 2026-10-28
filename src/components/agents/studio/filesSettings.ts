/**
 * Configure → Files, as pure functions: how an edit lands in the stored
 * `config.attachments`, what the bucket picker offers, and what the section
 * tells the person about where their files will go.
 *
 * Kept apart from the panel so the rules (a bucket is required once files are
 * on, the folder is normalised, an unusable bucket cannot be chosen) are
 * testable without rendering — the server enforces the same ones on save.
 */

import { cleanLanguages, compactOcr, invalidLanguages, ocrIsOn, type OcrSettings } from '@/components/extraction/ocrForm';
import type { IAgentAttachmentsConfig } from '@/lib/database/provider/types.domain';
import {
    normalizeAttachmentsFolder,
    resolveOutputsConfig,
    SESSION_FILE_OUTPUTS_DEFAULTS,
    SESSION_FILE_OUTPUTS_LIMITS,
    SESSION_FILES_DEFAULTS,
    SESSION_FILES_FOLDER_MAX_LENGTH,
} from '@/lib/services/agents/sessionFilesConfig';

/** `config.attachments` as this section edits it (the type carries the section's own fields, `folder` and `attachNewUploads`, too). */
export type AttachmentsSettings = IAgentAttachmentsConfig;

/** Where session files go inside the bucket when the agent does not say. */
export const DEFAULT_FILES_FOLDER = SESSION_FILES_DEFAULTS.folder;

/** The longest folder the server accepts. */
export const MAX_FOLDER_LENGTH = SESSION_FILES_FOLDER_MAX_LENGTH;

/** What the "Allowed file types" field offers; any other MIME type can still be typed. */
export const MIME_TYPE_SUGGESTIONS = [
    'image/*',
    'application/pdf',
    'text/*',
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/json',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;

/** Files are on for this agent. Absent = off. */
export function filesEnabled(value: AttachmentsSettings | undefined): boolean {
    return value?.enabled === true;
}

/** A file uploaded before a message rides along with the next one unless the agent says otherwise. */
export function attachesNewUploads(value: AttachmentsSettings | undefined): boolean {
    return value?.attachNewUploads !== false;
}

/** Drops keys left empty, so an agent that never touched Files saves no `attachments` at all. */
export function compactAttachments(next: AttachmentsSettings): AttachmentsSettings | undefined {
    const entries = Object.entries(next).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0));
    return entries.length > 0 ? (Object.fromEntries(entries) as AttachmentsSettings) : undefined;
}

/** Merges an edit into the stored settings. */
export function patchAttachments(
    current: AttachmentsSettings | undefined,
    patch: Partial<AttachmentsSettings>,
): AttachmentsSettings | undefined {
    return compactAttachments({ ...(current ?? {}), ...patch });
}

/** The agent's own files (`session_files_create`) are on: as the author set it, else on with uploads once a bucket is chosen. */
export function outputsEnabled(value: AttachmentsSettings | undefined): boolean {
    return resolveOutputsConfig(value).enabled;
}

/** Something stores files: uploads or the agent's own files. Only then a bucket and a folder matter. */
export function filesNeedBucket(value: AttachmentsSettings | undefined): boolean {
    return filesEnabled(value) || outputsEnabled(value);
}

/** What the outputs section shows beside each limit: the default and the most the server accepts. */
export const OUTPUTS_LIMITS = {
    maxFilesPerTurn: { default: SESSION_FILE_OUTPUTS_DEFAULTS.maxFilesPerTurn, max: SESSION_FILE_OUTPUTS_LIMITS.maxFilesPerTurn },
    maxFileSizeMb: { default: SESSION_FILE_OUTPUTS_DEFAULTS.maxFileSizeMb, max: SESSION_FILE_OUTPUTS_LIMITS.maxFileSizeMb },
} as const;

/** Merges an edit into `outputs`. The switch is stored as chosen: its default follows the uploads switch, so a value left out would change with it. */
export function patchOutputs(
    current: AttachmentsSettings | undefined,
    patch: Partial<NonNullable<AttachmentsSettings['outputs']>>,
): AttachmentsSettings | undefined {
    const merged: Record<string, unknown> = { ...(current?.outputs ?? {}), ...patch };
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    return patchAttachments(current, { outputs: Object.keys(merged).length > 0 ? merged : undefined });
}

/** OCR for uploads is on (mode auto / always). Absent = off. */
export function ocrEnabled(value: AttachmentsSettings | undefined): boolean {
    return ocrIsOn(value?.ocr);
}

/**
 * Replaces `attachments.ocr` with what the OCR fields hand back (`undefined` = off, the key is dropped), the way
 * `patchOutputs` merges `outputs`. The fields emit the whole setting, so a key the person removed (the page cap) goes
 * with it instead of surviving a merge.
 */
export function patchOcr(
    current: AttachmentsSettings | undefined,
    next: OcrSettings | undefined,
): AttachmentsSettings | undefined {
    const rest: AttachmentsSettings = { ...(current ?? {}) };
    delete rest.ocr;
    return patchAttachments(rest, { ocr: compactOcr(next) });
}

export type OcrIssue = 'model' | 'languages' | 'pages';

/**
 * What the server would refuse in an OCR setting that is on, or null. Whether the model exists in the project is the
 * server's to say (and the model picker shows it as soon as the list is loaded); this only catches what is wrong
 * with the setting itself.
 */
export function ocrIssue(value: AttachmentsSettings | undefined): OcrIssue | null {
    const ocr = value?.ocr;
    if (!ocrIsOn(ocr)) return null;
    if (ocr.modelKey !== undefined && (typeof ocr.modelKey !== 'string' || !ocr.modelKey.trim() || ocr.modelKey.length > 120)) return 'model';
    if (ocr.languages && (ocr.languages.length > 8 || invalidLanguages(cleanLanguages(ocr.languages)).length > 0)) return 'languages';
    if (ocr.maxPages !== undefined && (!Number.isInteger(ocr.maxPages) || ocr.maxPages < 1)) return 'pages';
    return null;
}

export type FolderIssue = 'invalid_chars' | 'dot_dot' | 'too_long';

/** The folder the way the server stores it; empty = the default. */
export function normalizeFolder(raw: string | undefined): string {
    return normalizeAttachmentsFolder(raw).folder || DEFAULT_FILES_FOLDER;
}

/**
 * Why the server would refuse this folder, or null. The server's own check
 * decides; this only says which sentence to show.
 */
export function folderIssue(raw: string | undefined): FolderIssue | null {
    if (!normalizeAttachmentsFolder(raw).error) return null;
    const text = (raw ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
    if (!/^[A-Za-z0-9._\-/]*$/.test(text)) return 'invalid_chars';
    if (text.includes('..') || text.split('/').includes('.')) return 'dot_dot';
    return 'too_long';
}

/** The path the files of one session end up under, for the preview under the folder field. */
export function folderPreview(folder: string | undefined, agentKey: string | undefined): string {
    return `${normalizeFolder(folder)}/${agentKey || '<agentKey>'}/<sessionId>/…`;
}

/** What `GET /api/agents/attachments/buckets` returns per bucket. */
export interface AttachmentBucketOption {
    key: string;
    name: string;
    providerKey: string;
    providerLabel: string;
    driver: string;
    bucketStatus: string;
    providerStatus: string;
    usable: boolean;
    /** The server's sentence for why not (English); `reasonCode` is the stable code behind it. */
    reason?: string;
    reasonCode?: BucketReasonCode;
    /** The bucket's files live on the server's own disk (driver `local-filesystem`). */
    localDisk: boolean;
    /** The server's verdict on whether THIS viewer may name the bucket (write access to it); absent = not asked. */
    canChoose?: boolean;
}

/** Why a bucket cannot take a file — the codes the picker endpoint reports. */
export type BucketReasonCode =
    | 'bucket_missing'
    | 'bucket_disabled'
    | 'provider_missing'
    | 'provider_unassigned'
    | 'provider_inactive'
    | 'provider_invalid';

/** One entry of the picker, with what the dropdown needs beside it. */
export interface BucketPickerItem {
    value: string;
    label: string;
    disabled: boolean;
    /** Why a disabled bucket cannot be chosen. */
    reason?: string;
    localDisk: boolean;
    /** The stored key matches no bucket of the project. */
    missing?: boolean;
}

export interface BucketReasonLabels {
    /** The wording per reason code, in the viewer's language. */
    byCode: Partial<Record<BucketReasonCode, string>>;
    /** For a bucket that cannot be used and says no more. */
    unusable: string;
    /** For a bucket the viewer may look at but not name (no write access to it). */
    cannotChoose?: string;
}

/** Why a bucket cannot be chosen, in the viewer's language; the server's own sentence is the fallback. */
export function bucketUnusableReason(bucket: AttachmentBucketOption, labels: BucketReasonLabels): string | undefined {
    if (bucket.usable) return undefined;
    if (bucket.reasonCode && labels.byCode[bucket.reasonCode]) return labels.byCode[bucket.reasonCode];
    // A server that does not send codes: read the statuses.
    if (bucket.bucketStatus !== 'active') return labels.byCode.bucket_disabled ?? bucket.reason ?? labels.unusable;
    if (bucket.providerStatus === 'disabled' || bucket.providerStatus === 'errored') return labels.byCode.provider_inactive ?? bucket.reason ?? labels.unusable;
    return bucket.reason || labels.unusable;
}

/**
 * The picker's entries. A stored key the project no longer has stays in the
 * list as "<key> (not found)" so the field shows what is stored instead of
 * silently emptying — the person fixes it by choosing another bucket. While
 * the list is still loading (`buckets` null) the stored key shows as it is.
 */
export function bucketPickerItems(
    buckets: AttachmentBucketOption[] | null,
    storedKey: string | undefined,
    labels: BucketReasonLabels & { notFound: (key: string) => string },
): BucketPickerItem[] {
    const items: BucketPickerItem[] = (buckets ?? []).map((bucket) => {
        // The bucket already chosen stays choosable (re-saving it asks nothing more); a different one needs write access to it.
        const blocked = bucket.canChoose === false && bucket.key !== storedKey;
        return {
            value: bucket.key,
            label: bucket.providerLabel ? `${bucket.name} · ${bucket.providerLabel}` : bucket.name,
            disabled: !bucket.usable || blocked,
            reason: bucketUnusableReason(bucket, labels) ?? (blocked ? labels.cannotChoose : undefined),
            localDisk: bucket.localDisk,
        };
    });
    if (storedKey && !items.some((item) => item.value === storedKey)) {
        items.unshift({
            value: storedKey,
            label: buckets ? labels.notFound(storedKey) : storedKey,
            disabled: false,
            localDisk: false,
            ...(buckets ? { missing: true } : {}),
        });
    }
    return items;
}

export type BucketProblem = 'required' | 'not_found' | 'unusable';

/** What is wrong with the chosen bucket, or null. `buckets` null = the list has not loaded, so only "none chosen" is known. */
export function bucketProblem(
    value: AttachmentsSettings | undefined,
    buckets: AttachmentBucketOption[] | null,
): BucketProblem | null {
    if (!filesNeedBucket(value)) return null;
    const key = value?.bucketKey?.trim();
    if (!key) return 'required';
    if (!buckets) return null;
    const bucket = buckets.find((candidate) => candidate.key === key);
    if (!bucket) return 'not_found';
    return bucket.usable ? null : 'unusable';
}

export interface FilesSaveError {
    /** The config field the server reports the same problem under. */
    field: 'attachments.bucketKey' | 'attachments.folder' | 'attachments.ocr';
    code: 'bucket_required' | FolderIssue | 'ocr_model' | 'ocr_languages' | 'ocr_pages';
}

/**
 * What stops the draft from being saved: files switched on (uploads or the agent's own) need a bucket, and
 * the folder has to be one the server accepts. The other bucket problems (gone,
 * disabled) are the server's to report — it knows the provider's state — and
 * come back as errors next to the Save button.
 */
export function filesSaveErrors(value: AttachmentsSettings | undefined): FilesSaveError[] {
    const errors: FilesSaveError[] = [];
    if (bucketProblem(value, null) === 'required') errors.push({ field: 'attachments.bucketKey', code: 'bucket_required' });
    const issue = filesNeedBucket(value) ? folderIssue(value?.folder) : null;
    if (issue) errors.push({ field: 'attachments.folder', code: issue });
    // OCR is read only while uploads are on: a setting left behind on an agent that no longer takes files blocks nothing.
    const ocr = filesEnabled(value) ? ocrIssue(value) : null;
    if (ocr) errors.push({ field: 'attachments.ocr', code: `ocr_${ocr}` });
    return errors;
}

/** The image-bytes budget is stored in bytes and edited in megabytes (decimal, like the file-size limit's MB). */
export const BYTES_PER_MB = 1_000_000;

export function bytesToMb(bytes: number | undefined): number | undefined {
    return typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes / BYTES_PER_MB : undefined;
}

export function mbToBytes(mb: number | string | undefined): number | undefined {
    return typeof mb === 'number' && Number.isFinite(mb) && mb > 0 ? Math.round(mb * BYTES_PER_MB) : undefined;
}

/** The numbers the section shows, with the stored value or the default. */
export function effectiveRetentionDays(value: AttachmentsSettings | undefined): number {
    const days = value?.retentionDays;
    return typeof days === 'number' && Number.isFinite(days) && days > 0 ? days : SESSION_FILES_DEFAULTS.retentionDays;
}
