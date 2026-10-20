import type { ProviderContract } from '../types';
import type { FileProviderRuntime } from '../domains/file';
import { createS3FileRuntime } from './s3/s3FileRuntime';
import { describeS3Location, type S3Credentials, type S3Settings } from './s3/s3Helpers';
import { validateS3Settings } from './s3/s3Validation';

/**
 * Amazon S3. Providers created before `s3-compatible-files` existed may carry a custom endpoint (MinIO, Ceph RGW, ...);
 * they keep every setting they have and run on the same runtime as the S3-compatible driver, so a custom endpoint here
 * gets its fixes too. New S3-compatible stores should use the `s3-compatible-files` driver.
 */
export const AwsS3FileProviderContract: ProviderContract<
  FileProviderRuntime,
  S3Credentials,
  S3Settings
> = {
  id: 'aws-s3-files',
  version: '1.1.0',
  domains: ['file'],
  display: {
    label: 'Amazon S3',
    description: 'Store files in an S3 bucket.',
    icon: 'tabler:brand-aws',
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
        title: 'Bucket configuration',
        fields: [
          {
            name: 'region',
            label: 'AWS region',
            type: 'text',
            placeholder: 'us-east-1',
            description: 'Required for Amazon S3. Optional with a custom endpoint (it defaults to us-east-1).',
            scope: 'settings',
          },
          {
            name: 'bucket',
            label: 'Bucket name',
            type: 'text',
            required: true,
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
            name: 'endpoint',
            label: 'Custom endpoint',
            type: 'text',
            placeholder: 'https://minio.internal:9000',
            description:
              'Optional S3-compatible endpoint (MinIO, Ceph RGW, ...), including http:// or https://. Leave empty for Amazon S3. New S3-compatible stores are better set up with the S3-compatible storage provider.',
            scope: 'settings',
          },
          {
            name: 'usePathStyleEndpoint',
            label: 'Use path-style addressing',
            type: 'switch',
            description:
              'Address buckets as endpoint/bucket/key. Left untouched it is automatic: on when a custom endpoint is set (most S3-compatible stores need it), off for Amazon S3. Change it only for a store with wildcard DNS (off) or to force path-style on Amazon S3 (on).',
            scope: 'settings',
          },
        ],
      },
      {
        title: 'TLS (custom endpoint only)',
        fields: [
          {
            name: 'caCertificate',
            label: 'CA certificate (PEM)',
            type: 'textarea',
            placeholder: '-----BEGIN CERTIFICATE-----',
            description:
              'Only used with a custom endpoint. The certificate (or bundle) that issued the store\'s certificate, for an internal CA. Trusted in addition to the system roots, for this provider only.',
            scope: 'settings',
          },
          {
            name: 'allowInsecureTls',
            label: 'Skip TLS verification',
            type: 'switch',
            defaultValue: false,
            description:
              'Only used with a custom endpoint. Accept any certificate, including self-signed ones. Prefer the CA certificate.',
            scope: 'settings',
          },
        ],
      },
    ],
  },
  validateSettings({ credentials, settings }) {
    validateS3Settings({ credentials, settings, requireEndpoint: false });
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
      requireEndpoint: false,
    });
  },
};
