import type { ProviderContract } from '../types';
import type { FileProviderRuntime } from '../domains/file';
import { createS3FileRuntime } from './s3/s3FileRuntime';
import { describeS3Location, type S3CompatibleSettings, type S3Credentials } from './s3/s3Helpers';
import { validateS3Settings } from './s3/s3Validation';

/**
 * S3-compatible object storage: MinIO, Ceph RGW, SeaweedFS, Garage, Cloudflare R2, Wasabi and the other stores that
 * speak the S3 API at an endpoint of their own. Shares its runtime with the Amazon S3 driver (`aws-s3-files`); what
 * differs is the form (the endpoint is required, path-style addressing is on by default) and that a missing bucket can
 * be created on the first upload.
 */
export const S3CompatibleFileProviderContract: ProviderContract<
  FileProviderRuntime,
  S3Credentials,
  S3CompatibleSettings
> = {
  id: 's3-compatible-files',
  version: '1.0.0',
  domains: ['file'],
  display: {
    label: 'S3-compatible storage',
    description:
      'Store files in a self-hosted or third-party S3-compatible object store (MinIO, Ceph RGW, SeaweedFS, Garage, Cloudflare R2, Wasabi, ...).',
    icon: 'tabler:database',
  },
  capabilities: {
    supportsMarkdownConversion: true,
    supportsBulkListing: true,
  },
  form: {
    sections: [
      {
        title: 'Authentication',
        fields: [
          {
            name: 'accessKeyId',
            label: 'Access key ID',
            type: 'text',
            required: true,
            scope: 'credentials',
          },
          {
            name: 'secretAccessKey',
            label: 'Secret access key',
            type: 'password',
            required: true,
            scope: 'credentials',
          },
          {
            name: 'sessionToken',
            label: 'Session token',
            type: 'password',
            description: 'Optional session token for temporary credentials.',
            scope: 'credentials',
          },
        ],
      },
      {
        title: 'Endpoint',
        fields: [
          {
            name: 'endpoint',
            label: 'Endpoint URL',
            type: 'text',
            required: true,
            placeholder: 'https://minio.internal:9000',
            description:
              'Base URL of the S3 API, including http:// or https:// and the port (MinIO: 9000, not the 9001 web console).',
            scope: 'settings',
          },
          {
            name: 'region',
            label: 'Region',
            type: 'text',
            placeholder: 'us-east-1',
            defaultValue: 'us-east-1',
            description:
              'Signing region. Most self-hosted stores accept the default; Cloudflare R2 uses auto. Use the region your store enforces if it has one.',
            scope: 'settings',
          },
          {
            name: 'usePathStyleEndpoint',
            label: 'Use path-style addressing',
            type: 'switch',
            defaultValue: true,
            description:
              'Address buckets as endpoint/bucket/key. Needed by most self-hosted stores unless they have wildcard DNS for bucket names.',
            scope: 'settings',
          },
        ],
      },
      {
        title: 'Bucket',
        fields: [
          {
            name: 'bucket',
            label: 'Bucket name',
            type: 'text',
            required: true,
            description: 'The name of the bucket only (3-63 characters), without s3:// or a path.',
            scope: 'settings',
          },
          {
            name: 'prefix',
            label: 'Bucket prefix',
            type: 'text',
            placeholder: 'cognipeer-console/files',
            description: 'Optional prefix prepended to all stored objects.',
            scope: 'settings',
          },
          {
            name: 'createBucketIfMissing',
            label: 'Create bucket if missing',
            type: 'switch',
            defaultValue: false,
            description:
              'Create the bucket on the first upload when the store reports it missing (needs the CreateBucket permission). Test connection does the same.',
            scope: 'settings',
          },
        ],
      },
      {
        title: 'TLS',
        fields: [
          {
            name: 'caCertificate',
            label: 'CA certificate (PEM)',
            type: 'textarea',
            placeholder: '-----BEGIN CERTIFICATE-----',
            description:
              'The certificate (or bundle) that issued the store\'s certificate, for an internal CA. Trusted in addition to the system roots, for this provider only. Prefer this over skipping verification.',
            scope: 'settings',
          },
          {
            name: 'allowInsecureTls',
            label: 'Skip TLS verification',
            type: 'switch',
            defaultValue: false,
            description:
              'Accept any certificate, including self-signed ones. Use the CA certificate field instead whenever possible.',
            scope: 'settings',
          },
        ],
      },
    ],
  },
  validateSettings({ credentials, settings }) {
    validateS3Settings({ credentials, settings, requireEndpoint: true });
  },
  describeStorageLocation({ settings, tenantId, providerKey }) {
    return describeS3Location(settings, tenantId, providerKey);
  },
  async createRuntime({ tenantId, providerKey, credentials, settings, logger }) {
    return createS3FileRuntime({
      tenantId,
      providerKey,
      credentials,
      settings,
      logger,
      requireEndpoint: true,
      createBucketIfMissing: settings.createBucketIfMissing === true,
    });
  },
};
