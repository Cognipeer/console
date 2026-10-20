import { ProviderSettingsError } from '../errors';
import type { ProviderContract } from '../types';
import type { FileProviderRuntime } from '../domains/file';
import { validateStorageTlsSettings } from '@/lib/security/storageTransport';
import { assertProviderUrlAllowed } from '@/lib/services/providers/providerEndpointGuard';
import {
  describeAzureBlobLocation,
  resolveAzureBlobConfig,
  type AzureBlobCredentials,
  type AzureBlobSettings,
} from './azure/blobConfig';
import { createAzureBlobRuntime } from './azure/blobRuntime';

/**
 * Azure Blob Storage (also Azurite, Azure Stack Hub and the sovereign clouds).
 *
 * One container holds the files of every tenant and provider, each under `<prefix>/<tenantId>/<providerKey>/`.
 * Four ways to sign in: account key, SAS token, connection string and a Microsoft Entra service principal. The
 * secrets are the four `credentials` fields and nothing else; the rest of the form is settings.
 *
 * The SDK (`@azure/storage-blob`) is loaded on the first runtime, not with this module: the registry is imported
 * by every process, whether or not anyone configured an Azure provider.
 */
export const AzureBlobFileProviderContract: ProviderContract<
  FileProviderRuntime,
  AzureBlobCredentials,
  AzureBlobSettings
> = {
  id: 'azure-blob-files',
  version: '1.0.0',
  domains: ['file'],
  display: {
    label: 'Azure Blob Storage',
    description: 'Store files in an Azure Blob Storage container.',
    icon: 'tabler:brand-azure',
  },
  capabilities: {
    supportsMarkdownConversion: true,
    supportsBulkListing: true,
    local: false,
    shared: true,
  },
  form: {
    sections: [
      {
        title: 'Storage account',
        fields: [
          {
            name: 'accountName',
            label: 'Account name',
            type: 'text',
            placeholder: 'mystorageaccount',
            description:
              'The storage account (3-24 lowercase letters and digits). Optional when the blob endpoint or the connection string names the account.',
            scope: 'settings',
          },
          {
            name: 'container',
            label: 'Container',
            type: 'text',
            required: true,
            placeholder: 'cognipeer-files',
            description: 'The container that holds the files (3-63 characters: lowercase letters, digits and hyphens).',
            scope: 'settings',
          },
          {
            name: 'prefix',
            label: 'Blob prefix',
            type: 'text',
            placeholder: 'cognipeer-console/files',
            description: 'Optional prefix prepended to all stored blobs.',
            scope: 'settings',
          },
          {
            name: 'createContainer',
            label: 'Create container if missing',
            type: 'switch',
            defaultValue: false,
            description:
              'Create the container on the first upload when it is missing. Needs a credential that may create containers (an account key, an account-level SAS or a role on the account); a container SAS cannot. Test connection does the same.',
            scope: 'settings',
          },
        ],
      },
      {
        title: 'Authentication',
        description: 'Only the fields of the selected method are shown and used.',
        fields: [
          {
            name: 'authMethod',
            label: 'Method',
            type: 'select',
            defaultValue: 'accountKey',
            options: [
              { label: 'Account key', value: 'accountKey' },
              { label: 'SAS token', value: 'sas' },
              { label: 'Connection string', value: 'connectionString' },
              { label: 'Microsoft Entra ID', value: 'entra' },
            ],
            scope: 'settings',
          },
          {
            name: 'accountKey',
            label: 'Account key',
            type: 'password',
            required: true,
            description: 'Access key 1 or 2 of the storage account.',
            scope: 'credentials',
            visibleWhen: { field: 'authMethod', equals: 'accountKey' },
          },
          {
            name: 'sasToken',
            label: 'SAS token',
            type: 'password',
            required: true,
            description:
              'A SAS token or URL for the container or the account. It needs the read, add, create, write and delete permissions; list is needed to import existing files.',
            scope: 'credentials',
            visibleWhen: { field: 'authMethod', equals: 'sas' },
          },
          {
            name: 'connectionString',
            label: 'Connection string',
            type: 'password',
            required: true,
            description: 'The connection string of the storage account. It holds an account key or a SAS token.',
            scope: 'credentials',
            visibleWhen: { field: 'authMethod', equals: 'connectionString' },
          },
          {
            name: 'entraTenantId',
            label: 'Tenant ID',
            type: 'text',
            required: true,
            description: 'The Microsoft Entra directory (tenant) ID: a GUID or a verified domain name.',
            scope: 'settings',
            visibleWhen: { field: 'authMethod', equals: 'entra' },
          },
          {
            name: 'clientId',
            label: 'Client ID',
            type: 'text',
            required: true,
            description: 'The application (client) ID of the app registration, a GUID.',
            scope: 'settings',
            visibleWhen: { field: 'authMethod', equals: 'entra' },
          },
          {
            name: 'clientSecret',
            label: 'Client secret',
            type: 'password',
            required: true,
            description:
              'The secret value, not the secret ID. The service principal needs the "Storage Blob Data Contributor" role on the container.',
            scope: 'credentials',
            visibleWhen: { field: 'authMethod', equals: 'entra' },
          },
        ],
      },
      {
        title: 'Advanced',
        fields: [
          {
            name: 'endpoint',
            label: 'Blob endpoint',
            type: 'text',
            placeholder: 'https://mystorageaccount.blob.core.windows.net',
            description:
              'Leave empty for Azure public cloud. For a sovereign cloud, Azure Stack Hub, a private endpoint or Azurite (http://127.0.0.1:10000/devstoreaccount1); plain http is for self-hosted installations only.',
            scope: 'settings',
          },
          {
            name: 'authorityHost',
            label: 'Authority host',
            type: 'text',
            placeholder: 'https://login.microsoftonline.com',
            description:
              'The Microsoft Entra authority. Leave empty to follow the endpoint (the US Government and China clouds are recognised).',
            scope: 'settings',
            visibleWhen: { field: 'authMethod', equals: 'entra' },
          },
          {
            name: 'apiVersion',
            label: 'API version',
            type: 'text',
            placeholder: '2023-11-03',
            description:
              'Overrides the service version the client sends (YYYY-MM-DD). Only for Azure Stack Hub or an emulator that is behind the public service.',
            scope: 'settings',
          },
          {
            name: 'caCertificate',
            label: 'CA certificate (PEM)',
            type: 'textarea',
            placeholder: '-----BEGIN CERTIFICATE-----',
            description:
              "The certificate (or bundle) that issued the endpoint's certificate, for an internal CA. Trusted in addition to the system roots, for this provider only. Prefer this over skipping verification.",
            scope: 'settings',
          },
          {
            name: 'allowInsecureTls',
            label: 'Skip TLS verification',
            type: 'switch',
            defaultValue: false,
            description:
              'Accept any certificate, including self-signed ones. Self-hosted installations only; use the CA certificate field instead whenever possible.',
            scope: 'settings',
          },
        ],
      },
    ],
  },
  async validateSettings({ credentials, settings, isOnPrem }) {
    const config = resolveAzureBlobConfig(credentials, settings, { allowHttp: isOnPrem });
    if (settings?.createContainer !== undefined && settings.createContainer !== null && typeof settings.createContainer !== 'boolean') {
      throw new ProviderSettingsError('createContainer', 'Create container if missing must be true or false.');
    }
    validateStorageTlsSettings({
      caCertificate: settings?.caCertificate,
      allowInsecureTls: settings?.allowInsecureTls,
      isOnPrem,
    });
    // The generic check of a file provider reads the `endpoint` and `authorityHost` fields; the endpoint a
    // connection string names and the authority an endpoint implies are vetted here, with the same rules.
    await assertProviderUrlAllowed(config.endpointField, config.endpoint.serviceUrl);
    if (config.auth.method === 'entra') await assertProviderUrlAllowed('authorityHost', config.auth.authority);
  },
  describeStorageLocation({ settings, tenantId, providerKey }) {
    return describeAzureBlobLocation(settings, tenantId, providerKey);
  },
  createRuntime(context) {
    return createAzureBlobRuntime(context);
  },
};
