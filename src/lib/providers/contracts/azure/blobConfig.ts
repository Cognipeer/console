/**
 * Everything the Azure Blob provider reads from its form, validated and normalised: endpoint, credentials of
 * the four authentication methods, Microsoft Entra inputs. Pure functions (no SDK, no network, no app
 * config), so every rule is unit tested on its own.
 *
 * A problem is thrown as `ProviderSettingsError(field, message)` with the form field it belongs to: the save
 * and "Test connection" paths answer it as HTTP 400 `{ error, code, field }`, and a stored row that no
 * longer resolves fails the same way when its runtime is built.
 */

import { ProviderSettingsError } from '@/lib/providers/errors';
import { buildBasePrefix } from './blobKeys';

export const DEFAULT_ENDPOINT_SUFFIX = 'core.windows.net';

export type AuthMethod = 'accountKey' | 'sas' | 'connectionString' | 'entra';
const AUTH_METHODS: readonly AuthMethod[] = ['accountKey', 'sas', 'connectionString', 'entra'];

export interface AzureBlobCredentials {
  accountKey?: string;
  sasToken?: string;
  connectionString?: string;
  clientSecret?: string;
}

export interface AzureBlobSettings {
  accountName?: string;
  endpoint?: string;
  container?: string;
  prefix?: string;
  createContainer?: boolean | string;
  authMethod?: string;
  entraTenantId?: string;
  clientId?: string;
  authorityHost?: string;
  apiVersion?: string;
  caCertificate?: string;
  allowInsecureTls?: boolean;
}

function invalid(field: string, message: string): ProviderSettingsError {
  return new ProviderSettingsError(field, message);
}

/** A trimmed text value; `undefined` for an unset or blank one. Anything but text is a mistake worth naming. */
function textOf(field: string, value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid(field, `${label} must be text.`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function truthy(value: unknown): boolean {
  return value === true || (typeof value === 'string' && ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase()));
}

/* ------------------------------------------------------------------ */
/*  Names                                                             */
/* ------------------------------------------------------------------ */

const ACCOUNT_NAME = /^[a-z0-9]{3,24}$/;
/**
 * 3-63 characters, lowercase letters, digits and single hyphens, alphanumeric at both ends. The
 * special containers (`$root`, `$web`, `$logs`) are deliberately not accepted: their blobs have
 * other semantics (site root, static website) than files this product owns.
 */
const CONTAINER_NAME = /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/;
/** A DNS suffix such as `core.windows.net` or `core.chinacloudapi.cn`; nothing that can carry a path or a port. */
const ENDPOINT_SUFFIX = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function assertAccountName(raw: string | undefined, field = 'accountName', where = 'The storage account name'): string {
  const name = raw?.trim().toLowerCase() ?? '';
  if (!ACCOUNT_NAME.test(name)) {
    throw invalid(field, `${where} must be 3-24 lowercase letters and digits (the account name, not its URL).`);
  }
  return name;
}

export function assertContainerName(raw: string | undefined): string {
  const name = raw?.trim() ?? '';
  if (!name) throw invalid('container', 'Enter the container name.');
  if (!CONTAINER_NAME.test(name)) {
    throw invalid('container', 'The container name must be 3-63 characters: lowercase letters, digits and single hyphens, starting and ending with a letter or digit.');
  }
  return name;
}

/* ------------------------------------------------------------------ */
/*  Endpoint                                                          */
/* ------------------------------------------------------------------ */

export interface BlobEndpointInput {
  accountName?: string;
  /** Full blob service URL: sovereign clouds, Azure Stack Hub, private DNS names, Azurite. */
  endpoint?: string;
  /** DNS suffix used with `accountName` when there is no endpoint. */
  endpointSuffix?: string;
  /** Scheme used with `accountName` when there is no endpoint (a connection string's DefaultEndpointsProtocol). */
  protocol?: 'https' | 'http';
  /** `http:` endpoints are accepted only when the caller says plaintext is tolerable (not SaaS). */
  allowHttp: boolean;
  /** A SAS token or a Microsoft Entra token does not need the account name to sign, so a custom domain may leave it out. */
  accountOptional?: boolean;
  /** The form fields the problems are attributed to (a value that came from a connection string is `connectionString`). */
  fields?: { endpoint?: string; account?: string };
}

export interface BlobEndpoint {
  /** `https://acct.blob.core.windows.net` or, for path-style emulators, `http://127.0.0.1:10000/devstoreaccount1`. */
  serviceUrl: string;
  /** Absent only for a SAS / Entra endpoint whose host does not carry the account (a custom domain). */
  accountName?: string;
  host: string;
  protocol: 'https:' | 'http:';
}

/**
 * Where the blob service lives, from the pieces a user can give. Only a plain origin (plus the
 * single account segment path-style emulators use) is accepted: a query string, a fragment, user
 * info or a deeper path would let a setting smuggle a second request target or a credential
 * into every URL the SDK builds. A host that already names the account (`<account>.blob.<suffix>`) takes
 * no path at all: the first segment of a pasted container URL is a container, never an account.
 */
export function resolveBlobEndpoint(input: BlobEndpointInput): BlobEndpoint {
  const endpointField = input.fields?.endpoint ?? 'endpoint';
  const accountField = input.fields?.account ?? 'accountName';
  const rawEndpoint = input.endpoint?.trim();

  if (!rawEndpoint) {
    const accountName = assertAccountName(input.accountName, accountField);
    const suffix = (input.endpointSuffix?.trim().toLowerCase() || DEFAULT_ENDPOINT_SUFFIX);
    if (!ENDPOINT_SUFFIX.test(suffix)) throw invalid(endpointField, 'The endpoint suffix must be a DNS suffix such as core.windows.net.');
    const host = `${accountName}.blob.${suffix}`;
    if (input.protocol === 'http' && !input.allowHttp) throw invalid(endpointField, 'The endpoint must use https.');
    const scheme = input.protocol === 'http' ? 'http:' : 'https:';
    return { serviceUrl: `${scheme}//${host}`, accountName, host, protocol: scheme };
  }

  let url: URL;
  try {
    // A pasted `myaccount.blob.core.windows.net` (no scheme) is read as https, like the S3 endpoint field.
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawEndpoint) ? rawEndpoint : `https://${rawEndpoint}`);
  } catch {
    throw invalid(endpointField, 'The endpoint is not a valid URL. Use the blob service URL, e.g. https://myaccount.blob.core.windows.net.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && input.allowHttp)) {
    throw invalid(endpointField, 'The endpoint must use https.');
  }
  if (url.username || url.password) throw invalid(endpointField, 'The endpoint must not contain credentials.');
  if (url.search || url.hash) {
    throw invalid(endpointField, 'The endpoint must not contain a query string or fragment. Put a SAS token in the SAS token field.');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  const hostAccount = /^([a-z0-9]{3,24})\.blob\./i.exec(url.hostname)?.[1]?.toLowerCase();
  if (hostAccount && pathname) {
    throw invalid(
      endpointField,
      'The endpoint is the account URL, for example https://myaccount.blob.core.windows.net. Enter the container in the Container field.',
    );
  }
  if (pathname && !/^\/[A-Za-z0-9._-]{1,63}$/.test(pathname)) {
    throw invalid(endpointField, 'The endpoint path must be empty or a single account name (path-style emulators).');
  }

  const pathAccount = pathname ? pathname.slice(1).toLowerCase() : undefined;
  if (pathAccount && !ACCOUNT_NAME.test(pathAccount)) {
    throw invalid(endpointField, 'The endpoint path must be empty or the storage account name (path-style emulators).');
  }
  const named = input.accountName?.trim() || pathAccount || hostAccount;
  let accountName: string | undefined;
  if (named) accountName = assertAccountName(named, accountField);
  else if (!input.accountOptional) throw invalid(accountField, 'Enter the storage account name: it cannot be read from this endpoint.');
  if (pathAccount && accountName && pathAccount !== accountName) {
    throw invalid(accountField, 'The account name does not match the account segment of the endpoint path.');
  }
  return {
    serviceUrl: `${url.protocol}//${url.host}${pathname}`,
    accountName,
    host: url.hostname,
    protocol: url.protocol as 'https:' | 'http:',
  };
}

/* ------------------------------------------------------------------ */
/*  Credentials                                                       */
/* ------------------------------------------------------------------ */

/** Azure account keys are 64 random bytes in base64 (88 characters). */
export function assertAccountKey(raw: string | undefined, field = 'accountKey', where = 'The account key'): string {
  const key = raw?.trim() ?? '';
  if (!key) throw invalid(field, 'Enter the account key: the base64 value from the storage account\'s "Access keys" page.');
  if (key.length < 40 || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
    throw invalid(field, `${where} must be the base64 value from the storage account's "Access keys" page.`);
  }
  return key;
}

export interface SasInfo {
  /**
   * The query string as issued (no leading `?`). Nothing is re-encoded but a literal `=` inside a value, which is
   * written `%3D`: the service reads both the same way, and the SDK cuts a value at its second `=` whenever it
   * rebuilds the query of a container-level request (listing, creating the container).
   */
  token: string;
  expiresAt?: Date;
  permissions?: string;
  /** `c` / `s` for a container or service SAS, undefined for an account SAS (`ss` / `srt` instead). */
  resource?: string;
}

/**
 * The parameters of a SAS query, each split at its first `=`. A `=` inside a value is written `%3D` (the base64
 * padding of a signature that was pasted decoded), and so is a `+` in a signature that carries no escape at all
 * (decoded too: a query reads a bare `+` as a space). A parameter without a value or a name that appears twice is
 * refused: the SDK would send the first as `name=undefined` and reorder the second.
 */
function normalizeSasQuery(query: string, field: string): string {
  const seen = new Set<string>();
  const pairs: string[] = [];
  for (const part of query.split('&')) {
    if (part === '') continue;
    const at = part.indexOf('=');
    if (at <= 0) {
      throw invalid(field, 'The SAS token is malformed: every parameter needs a name and a value (name=value, joined with &).');
    }
    const name = part.slice(0, at);
    if (seen.has(name)) throw invalid(field, `The SAS token repeats the parameter "${name}".`);
    seen.add(name);
    const issued = part.slice(at + 1);
    let value = issued.replace(/=/g, '%3D');
    // judged on the value as it was given: the %3D written just above is not a sign that it was copied encoded
    if (name === 'sig' && !/%[0-9A-Fa-f]{2}/.test(issued)) value = value.replace(/\+/g, '%2B');
    pairs.push(`${name}=${value}`);
  }
  return pairs.join('&');
}

/**
 * A SAS from a token (`sv=...&sig=...`), a `?sv=...` query or a full URL (only the query is used).
 * Rejects what can never work here so the user hears it at once: no signature, a blob-level
 * token, an expired one, a malformed parameter.
 */
export function parseSasToken(raw: string | undefined, now: Date = new Date(), field = 'sasToken'): SasInfo {
  let token = (raw ?? '').trim();
  if (!token) throw invalid(field, 'Enter the SAS token: the query string that starts with sv=, or the full SAS URL.');
  if (/^https?:\/\//i.test(token)) {
    const at = token.indexOf('?');
    if (at === -1) throw invalid(field, 'The SAS URL has no query string. Paste the SAS token (starting with sv=) or the full SAS URL.');
    token = token.slice(at + 1);
  }
  token = normalizeSasQuery(token.replace(/^\?/, '').replace(/\s+/g, '').replace(/#.*$/, ''), field);

  const params = new URLSearchParams(token);
  if (!params.get('sig') || !params.get('sv')) {
    throw invalid(field, 'The SAS token is incomplete: it needs at least sv= and sig=.');
  }
  const resource = params.get('sr') ?? undefined;
  if (resource && !['c', 's'].includes(resource)) {
    throw invalid(field, 'This SAS is scoped to a single blob or snapshot. Generate a container-level or account-level SAS.');
  }
  let expiresAt: Date | undefined;
  const se = params.get('se');
  if (se) {
    const parsed = new Date(se);
    if (!Number.isNaN(parsed.getTime())) {
      expiresAt = parsed;
      if (parsed.getTime() <= now.getTime()) {
        throw invalid(field, `The SAS token expired on ${parsed.toISOString()}.`);
      }
    }
  }
  return { token, expiresAt, permissions: params.get('sp') ?? undefined, resource };
}

export interface ParsedConnectionString {
  accountName?: string;
  accountKey?: string;
  sas?: string;
  blobEndpoint?: string;
  endpointSuffix?: string;
  protocol?: 'https' | 'http';
}

/**
 * `Key=Value;Key=Value` connection strings from the portal. The SDK's own parser interpolates
 * `AccountName` and `EndpointSuffix` into a host name without checking them, so a crafted string
 * can aim the client anywhere; this parser validates each value before it is used.
 * `UseDevelopmentStorage=true` is not supported: the emulator's endpoint has to be written out.
 */
export function parseConnectionString(raw: string | undefined): ParsedConnectionString {
  const field = 'connectionString';
  if (!raw?.trim()) throw invalid(field, 'Enter the connection string from the storage account\'s "Access keys" page.');
  const out: ParsedConnectionString = {};
  for (const part of raw.split(';')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    const key = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1).trim();
    if (!value) continue;
    switch (key) {
      case 'accountname': out.accountName = assertAccountName(value, field, 'AccountName in the connection string'); break;
      case 'accountkey': out.accountKey = assertAccountKey(value, field, 'AccountKey in the connection string'); break;
      case 'sharedaccesssignature': out.sas = value; break;
      case 'blobendpoint': out.blobEndpoint = value; break;
      case 'endpointsuffix': out.endpointSuffix = value; break;
      case 'defaultendpointsprotocol':
        if (value !== 'https' && value !== 'http') throw invalid(field, 'DefaultEndpointsProtocol must be https or http.');
        out.protocol = value;
        break;
      case 'usedevelopmentstorage':
        throw invalid(
          field,
          'UseDevelopmentStorage is not supported. Write the emulator out: BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;AccountName=devstoreaccount1;AccountKey=<key>.',
        );
      default: break;
    }
  }
  if (!out.accountKey && !out.sas) {
    throw invalid(field, 'The connection string has neither AccountKey nor SharedAccessSignature.');
  }
  if (!out.accountName && !out.blobEndpoint) {
    throw invalid(field, 'The connection string has neither AccountName nor BlobEndpoint.');
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Microsoft Entra                                                   */
/* ------------------------------------------------------------------ */

/** The Microsoft Entra authority that matches a sovereign-cloud blob host (override with `authorityHost`). */
export function defaultAuthorityFor(host: string): string {
  if (/\.core\.usgovcloudapi\.net$/i.test(host)) return 'https://login.microsoftonline.us';
  if (/\.core\.chinacloudapi\.cn$/i.test(host)) return 'https://login.chinacloudapi.cn';
  return 'https://login.microsoftonline.com';
}

const TENANT_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9][a-z0-9.-]{0,253})$/i;
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EntraClientSecretInput {
  authorityHost: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/** Checks the service-principal inputs and returns the authority as a bare https origin. */
export function validateClientSecretConfig(cfg: EntraClientSecretInput): { authority: string } {
  if (!TENANT_ID.test(cfg.tenantId.trim())) throw invalid('entraTenantId', 'The Microsoft Entra tenant ID must be a GUID or a verified domain name.');
  if (!CLIENT_ID.test(cfg.clientId.trim())) throw invalid('clientId', 'The application (client) ID must be a GUID.');
  if (cfg.clientSecret.trim().length < 8) throw invalid('clientSecret', 'Enter the client secret value (not the secret ID).');
  let authority: URL;
  try {
    authority = new URL(cfg.authorityHost);
  } catch {
    throw invalid('authorityHost', 'The authority host must be a URL such as https://login.microsoftonline.com.');
  }
  if (authority.protocol !== 'https:' || authority.username || authority.password || authority.search || authority.hash || authority.pathname.replace(/\/+$/, '')) {
    throw invalid('authorityHost', 'The authority host must be a plain https origin such as https://login.microsoftonline.com.');
  }
  return { authority: authority.origin };
}

/* ------------------------------------------------------------------ */
/*  The resolved configuration                                        */
/* ------------------------------------------------------------------ */

export type ResolvedAuth =
  | { method: 'accountKey'; accountKey: string }
  | { method: 'sas'; sas: SasInfo }
  | { method: 'entra'; tenantId: string; clientId: string; clientSecret: string; authority: string };

export interface ResolvedAzureBlobConfig {
  endpoint: BlobEndpoint;
  container: string;
  prefix?: string;
  createContainer: boolean;
  apiVersion?: string;
  auth: ResolvedAuth;
  /** What the user chose (a connection string is reported as the method it contains in `auth`). */
  authMethod: AuthMethod;
  /** The form field the effective endpoint came from, for attributing a refusal of it. */
  endpointField: 'endpoint' | 'connectionString' | 'accountName';
  caCertificate?: string;
  allowInsecureTls: boolean;
}

const API_VERSION = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Everything the runtime needs from the form, validated. A stored credential the chosen method
 * does not use is ignored (editing keeps old secrets, so a record can hold several); a record
 * without `authMethod` (created through the API) is accepted when exactly one credential is set.
 */
export function resolveAzureBlobConfig(
  credentials: AzureBlobCredentials | undefined,
  settings: AzureBlobSettings | undefined,
  env: { allowHttp: boolean },
): ResolvedAzureBlobConfig {
  const creds = (credentials ?? {}) as Record<string, unknown>;
  const set = (settings ?? {}) as Record<string, unknown>;
  const container = assertContainerName(textOf('container', set.container, 'The container name'));

  const connectionString = textOf('connectionString', creds.connectionString, 'The connection string');
  const sasToken = textOf('sasToken', creds.sasToken, 'The SAS token');
  const clientSecret = textOf('clientSecret', creds.clientSecret, 'The client secret');
  const accountKey = textOf('accountKey', creds.accountKey, 'The account key');

  let method = textOf('authMethod', set.authMethod, 'The authentication method') as AuthMethod | undefined;
  if (method && !AUTH_METHODS.includes(method)) {
    throw invalid('authMethod', `Unknown authentication method "${String(method).slice(0, 40)}".`);
  }
  if (!method) {
    const candidates: AuthMethod[] = [];
    if (connectionString) candidates.push('connectionString');
    if (sasToken) candidates.push('sas');
    if (clientSecret) candidates.push('entra');
    if (accountKey) candidates.push('accountKey');
    if (candidates.length === 0) throw invalid('authMethod', 'Provide an account key, SAS token, connection string or service principal.');
    if (candidates.length > 1) throw invalid('authMethod', 'More than one credential is set; choose the authentication method.');
    method = candidates[0];
  }

  const apiVersion = textOf('apiVersion', set.apiVersion, 'The API version');
  if (apiVersion && !API_VERSION.test(apiVersion)) {
    throw invalid('apiVersion', 'The API version must look like 2023-11-03.');
  }
  const prefix = textOf('prefix', set.prefix, 'The blob prefix');
  buildBasePrefix([prefix]);

  let accountName = textOf('accountName', set.accountName, 'The storage account name');
  let endpointText = textOf('endpoint', set.endpoint, 'The endpoint');
  const accountFromSetting = Boolean(accountName);
  const endpointFromSetting = Boolean(endpointText);
  let endpointSuffix: string | undefined;
  let protocol: 'https' | 'http' | undefined;
  let auth: ResolvedAuth;

  switch (method) {
    case 'accountKey':
      auth = { method, accountKey: assertAccountKey(accountKey) };
      break;
    case 'sas':
      auth = { method, sas: parseSasToken(sasToken) };
      break;
    case 'connectionString': {
      const parsed = parseConnectionString(connectionString);
      accountName ??= parsed.accountName;
      endpointText ??= parsed.blobEndpoint;
      endpointSuffix = parsed.endpointSuffix;
      protocol = parsed.protocol;
      auth = parsed.accountKey
        ? { method: 'accountKey', accountKey: parsed.accountKey }
        : { method: 'sas', sas: parseSasToken(parsed.sas, new Date(), 'connectionString') };
      break;
    }
    case 'entra': {
      const tenantId = textOf('entraTenantId', set.entraTenantId, 'The tenant ID');
      const clientId = textOf('clientId', set.clientId, 'The client ID');
      if (!tenantId) throw invalid('entraTenantId', 'Enter the Microsoft Entra directory (tenant) ID.');
      if (!clientId) throw invalid('clientId', 'Enter the application (client) ID.');
      if (!clientSecret) throw invalid('clientSecret', 'Enter the client secret value (not the secret ID).');
      auth = { method, tenantId, clientId, clientSecret, authority: '' };
      break;
    }
    default:
      throw invalid('authMethod', 'Unknown authentication method.');
  }

  const fromConnectionString = method === 'connectionString';
  const endpointField: ResolvedAzureBlobConfig['endpointField'] = endpointFromSetting
    ? 'endpoint'
    : fromConnectionString ? 'connectionString' : 'accountName';
  const endpoint = resolveBlobEndpoint({
    accountName,
    endpoint: endpointText,
    endpointSuffix,
    protocol,
    allowHttp: env.allowHttp,
    accountOptional: auth.method !== 'accountKey',
    fields: {
      endpoint: endpointField,
      account: accountFromSetting || !fromConnectionString ? 'accountName' : 'connectionString',
    },
  });

  if (auth.method === 'entra') {
    // The SDK refuses to send a bearer token over plaintext (measured on 12.33), and it should.
    if (endpoint.protocol !== 'https:') throw invalid(endpointField, 'Microsoft Entra authentication needs an https endpoint.');
    const authorityHost = textOf('authorityHost', set.authorityHost, 'The authority host') ?? defaultAuthorityFor(endpoint.host);
    auth = {
      ...auth,
      authority: validateClientSecretConfig({ authorityHost, tenantId: auth.tenantId, clientId: auth.clientId, clientSecret: auth.clientSecret }).authority,
    };
  }

  return {
    endpoint,
    container,
    prefix,
    createContainer: truthy(set.createContainer),
    apiVersion,
    auth,
    authMethod: method,
    endpointField,
    caCertificate: textOf('caCertificate', set.caCertificate, 'The CA certificate'),
    allowInsecureTls: set.allowInsecureTls === true,
  };
}

/**
 * Every credential value in play, for scrubbing text that is about to leave the runtime: what was stored, and
 * what was read out of a connection string or a SAS URL (the signature in its raw and decoded spelling).
 */
export function secretValues(credentials: AzureBlobCredentials | undefined, config: ResolvedAzureBlobConfig): string[] {
  const found = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim().length >= 8) found.add(value.trim());
  };
  for (const value of Object.values(credentials ?? {})) add(value);
  if (config.auth.method === 'accountKey') add(config.auth.accountKey);
  if (config.auth.method === 'entra') add(config.auth.clientSecret);
  if (config.auth.method === 'sas') {
    add(config.auth.sas.token);
    const raw = /(?:^|&)sig=([^&]*)/.exec(config.auth.sas.token)?.[1];
    add(raw);
    if (raw) {
      try {
        add(decodeURIComponent(raw));
      } catch {
        /* the raw spelling is already in the set */
      }
    }
  }
  return [...found];
}

/* ------------------------------------------------------------------ */
/*  Where the objects live (display only)                             */
/* ------------------------------------------------------------------ */

/**
 * `https://<account>.blob.<suffix>/<container>/<prefix>/<tenantId>/<providerKey>/`, from the settings alone:
 * the endpoint or the account name gives the account URL, otherwise the location starts at the container.
 * A connection string (a credential, never read here) may carry another suffix or protocol, so with that
 * method and no endpoint setting the host is left out rather than guessed. `null` when the settings do not
 * name a usable container or prefix: the provider cannot work, and nothing meaningful is shown.
 */
export function describeAzureBlobLocation(settings: AzureBlobSettings | undefined, tenantId: string, providerKey: string): string | null {
  try {
    const set = (settings ?? {}) as Record<string, unknown>;
    const container = textOf('container', set.container, 'The container name');
    if (!container) return null;
    const basePrefix = buildBasePrefix([textOf('prefix', set.prefix, 'The blob prefix'), tenantId, providerKey]);

    const endpoint = textOf('endpoint', set.endpoint, 'The endpoint');
    const accountName = textOf('accountName', set.accountName, 'The storage account name');
    const method = textOf('authMethod', set.authMethod, 'The authentication method');
    let root: string | undefined;
    if (endpoint) {
      root = resolveBlobEndpoint({ endpoint, accountName, allowHttp: true, accountOptional: true }).serviceUrl;
    } else if (accountName && method !== 'connectionString') {
      root = resolveBlobEndpoint({ accountName, allowHttp: true }).serviceUrl;
    }
    return `${root ? `${root}/` : ''}${container}/${basePrefix}`;
  } catch {
    return null;
  }
}
