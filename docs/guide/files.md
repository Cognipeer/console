# Files

The Document Store keeps files in **buckets**. A bucket belongs to one project and stores its files on a **file provider**: S3-compatible storage (MinIO, Ceph, SeaweedFS, Garage, Cloudflare R2, Backblaze B2 and others), Amazon S3, Azure Blob Storage, MongoDB GridFS, or the server's own disk. Agents keep their [session files](/guide/session-files) in buckets, uploaded documents can get a Markdown copy for the Knowledge Engine, and your own code reaches the same buckets through the [Files API](/api/files).

Operators work with buckets under **Data → Document Store**. The providers behind them are set up under **Admin → Providers**.

## How it fits together

| Piece | What it is |
|-------|------------|
| **File provider** | A saved connection to a store: the driver, its credentials (stored encrypted) and its settings. A provider is assigned to the projects that may use it. |
| **Bucket** | A named place for files inside one project: a permanent key, a name, a description and a prefix inside the provider. |
| **File** | An object in the provider plus a record in the console (name, size, content type, checksum, Markdown status). |

A file is written to

```text
<provider prefix>/<tenant id>/<provider key>/<bucket prefix>/<file key>
```

The tenant id and the provider key are always part of the path, so tenants and providers that share one store never see each other's objects. The provider prefix is optional (the **Bucket prefix** or **Blob prefix** setting of the provider). The bucket prefix defaults to the bucket's key; clear it to keep the files at the root of the provider's folder. It cannot be changed once the bucket has files. The Create bucket screen shows the full path before you save, and the bucket's **Settings** tab shows it under **Storage**.

Two buckets of a tenant that end up in the same folder of the same provider share objects. Importing from storage and deleting a bucket together with its files are refused for such a bucket (`409 storage_location_shared`), so give every bucket its own prefix.

## The Document Store

### Buckets

![The Document Store bucket list](/screenshots/files/01-files-list.png)

The list opens with four tiles, **Buckets**, **Active**, **Disabled** and **Stored files** (with the size across all buckets), above a table with the columns **Bucket**, **Provider**, **Files**, **Size**, **Status**, **Updated** and a row menu. Search finds buckets by name, key or description; the provider and status filters narrow the list.

The provider cell shows the provider's name, its driver, and the result of its **last** connection test: *Connected*, *Test failed*, *Not tested yet*, *Built-in* (the local disk) or *Disabled*. The chip is read from the stored result, so opening the list never calls the provider. A provider with a problem links to its page.

The row menu offers **Open bucket**, **Bucket settings**, **Enable** or **Disable**, and **Delete bucket…** (**Delete again…** for a bucket whose deletion stopped with an error). A disabled bucket keeps its files readable and accepts nothing new.

When no file provider exists yet, the page says so and offers **Add a file provider**; a user who cannot manage providers is asked to contact an administrator.

### Creating a bucket

![Create bucket](/screenshots/files/06-create-bucket.png)

**Create bucket** opens a full-screen form:

1. **Storage provider**: pick a card. Only providers that are switched on can be chosen. The local-disk card carries a warning, because files on the server's disk are not shared between replicas.
2. **Bucket**: a **Name**, a **Key** and an optional **Description**. The key is made from the name and can be edited: lowercase letters, numbers, hyphens and underscores, up to 64 characters. It is what the API and the SDK use, it is unique within the project, and it cannot be changed later.
3. **Location**: the **Prefix inside the provider**. Left empty, the key is used. **Files will be stored at** previews the resulting path.
4. **Status**: leave **Active** on, or turn it off to create the bucket disabled.

### The bucket page

![A bucket's Files tab](/screenshots/files/02-bucket-files.png)

A bucket opens on its **Files** tab. The page has three tabs, **Files**, **Settings** and **API**, and its address keeps your place (tab, folder, search, filters and the open file), so Back, a reload and a shared link land where you were. The header shows the file count and total size, with **Refresh**, **Upload** and a **More actions** menu (**Import from storage…**, **Enable** or **Disable**, **Delete bucket…**).

On the **Files** tab:

- Keys that contain `/` appear as **folders**. Open a folder to see its files and sub-folders; the breadcrumb starts at **Bucket root**. A search or a type filter lists every match below the current folder as one flat list.
- The toolbar searches file names and filters by type (*All types*, *PDF*, *Image*, *Text*, *Office document*, *Other*). The **Show** filter separates *Session files* (files attached to agent sessions) from *Other files*.
- The columns are **Name**, **Size**, **Type**, **Markdown copy** (*Ready*, *Converting…*, *Failed* or *Not converted*), **Modified** and a row menu with **Download original**, **Download Markdown**, **Copy key** and **Delete…**.
- Select files to **Download as .zip** (up to 50 files at a time) or **Delete…** them.
- The list loads 50 files at a time; **Load more** adds the next page.
- Session files show the session they belong to, when they expire and who uploaded them, and they follow the session's permissions (see [Session files](#session-files)).

Banners above the list explain a bucket that is disabled (files can be browsed and downloaded, but not uploaded, imported or deleted until it is enabled), that is being deleted, or whose deletion stopped (**Deleting this bucket did not finish**, with the reason, **Try again** and **Keep the bucket**).

Reading needs **Read** on the Files service; everything that changes a file or a bucket needs **Write**. A user with read access only sees the data without the action buttons. See [Authorization](/guide/authorization).

### Uploading files

![Upload files](/screenshots/files/03-upload.png)

**Upload** opens a full-screen form with a drop zone and a queue.

- Drop files or **Browse files**. The zone states the effective limits: the largest file, the allowed types and the storage left in the project. Up to 20 files are queued at once; folders cannot be uploaded, so add the files inside them.
- Two files upload at a time. Each row shows its progress, and a failed file can be retried on its own. A file can be renamed until it is sent.
- **Folder** names the destination folder inside the bucket (leave it empty for the bucket root; use `/` to nest, for example `reports/2026`). Each file is stored under a generated unique key, so nothing is overwritten; the name you give is kept for display and download.
- **Convert to Markdown** is on by default. See [Markdown copies](#markdown-copies). An **Advanced** section lets you set the content type, for a single file only.
- A summary lists the checks before you press **Upload**: files selected, a valid folder, every file within the size limit, every file with an allowed type.

Closing the form while files are still uploading asks before it cancels them; files that already finished stay in the bucket.

### The file drawer

![The file drawer](/screenshots/files/04-file-drawer.png)

Selecting a file opens a drawer on the right (the address gains `?file=<key>`, so the link can be shared). It has three tabs:

- **Preview** shows images (PNG, JPEG, GIF, WebP), PDFs, and plain text, Markdown, CSV and JSON files, up to 10 MB. Other types and larger files offer **Download** instead.
- **Markdown** shows the Markdown copy, with **Copy Markdown** and **Download Markdown**, or the conversion state and the actions to convert.
- **Details** lists the name, the key, the size, the content type, the SHA-256 checksum, the **Origin** (*Upload*, *Agent output* or *Imported from storage*), who uploaded the file and when it was created and last updated, followed by ready-to-use API snippets for downloading and deleting the file.

The drawer's actions are **Download**, **Download Markdown**, **Copy key** and **Delete…**. Deleting removes the stored object together with its Markdown copy.

### Bucket settings

![Bucket settings](/screenshots/files/05-bucket-settings.png)

The **Settings** tab holds four cards:

- **General**: the name (up to 120 characters), the description (up to 1000 characters) and the status.
- **Storage**: the provider and its last test result, **Test now** (owners and admins), the **Prefix inside the provider**, the **Location in the storage** and the bucket key. The prefix is editable only while the bucket has no files; afterwards it is shown as fixed, because changing it would leave the files behind in the old location (an update through the API answers `409 prefix_locked`).
- **Usage**: the bucket's file count and stored size, the largest file one upload may carry, and how much of the project's storage and file-count limits is used.
- **Danger zone**: delete the bucket (see below).

The **API** tab shows the base URL, the bucket key and the `Authorization` header, then ready-made samples for cURL, the TypeScript SDK (`@cognipeer/console-sdk`) and Python, filled in with the bucket's key: list files, list a folder, upload, upload into a folder, download and delete.

### Importing from storage

A bucket filled from outside the console lists nothing until it is imported. **Import from storage…** (in the bucket's **More actions** menu, and on an empty bucket) scans the bucket's location in the provider and registers the objects it finds as files.

- It reads the provider's listing, one page of up to 200 objects per request, and shows the counts **Scanned**, **Imported** and **Skipped**. It can be stopped and continued.
- It never changes or deletes an object. Objects that already have a file record are skipped, as are the Markdown copies of known files, the connection-test folder and keys the console cannot address safely.
- Imported files have the origin *Imported from storage* and no Markdown copy; convert one from its drawer when you need it.
- It needs permission to list the store (`ListBucket` on S3, the `l` permission on an Azure SAS).
- It is refused with `storage_location_shared` when another bucket uses the same folder of the provider, and with a quota message when the project would pass its file or storage limit.

### Deleting files and buckets

**Delete…** on files asks for confirmation and removes each object and its Markdown copy from the provider. Deleting several files reports which ones could not be deleted. An object that is already gone from the provider does not stop the delete.

**Delete bucket…** asks what happens to the files:

- **Delete the bucket and its files** switches the bucket off and removes everything in the background: each file's object and Markdown copy (four at a time), then its record, then the bucket. The bucket shows *Deleting…* meanwhile. If something cannot be deleted, the run stops, the bucket stays (disabled) with the reason, and **Delete again…** continues where it stopped; what was removed stays removed. A deletion still running after five minutes may have been lost (the job waits in the server's memory queue, and a restart empties it; when the console starts it queues the deletion again for every bucket still marked as being deleted, up to 100 per start, so a restart seldom leaves a bucket in that state), so the bucket then offers **Delete again**; a large bucket can legitimately take longer, and asking again is harmless. If asking again is refused because another bucket keeps files in the same folder (`409 storage_location_shared`), the dialog asks what becomes of the files after all, and **Delete the bucket only** is the way out: it removes the bucket and leaves its files where they are (a run that is in fact still going ends after the page of files it is working on).
- **Delete the bucket only** removes the bucket and leaves its files where they are: the objects stay in the provider and their records stay behind, so they keep counting toward the project's storage.

A bucket cannot be deleted or disabled while an agent keeps its session files in it (`409 bucket_in_use`, with the agents named). It cannot be deleted together with its files while a Knowledge Engine module keeps the sources of its documents there (`409 bucket_in_use`, with the modules named): re-indexing reads the originals and the extracted text back from the bucket, so delete the module first, or choose **Delete the bucket only**. And it cannot be deleted with its files when another bucket shares its folder (`409 storage_location_shared`).

### Markdown copies

A Markdown copy is a text version of a document that the Knowledge Engine can ingest. The original is never changed.

- On upload, **Convert to Markdown** hands the file to a background job; the file's row shows *Converting…* and updates by itself. The Document Store never waits for the converter.
- Conversion applies to files whose name ends in `.pdf`, `.doc`, `.docx`, `.pptx`, `.xlsx`, `.xls`, `.epub`, `.msg`, `.html`, `.htm`, `.xml`, `.rss`, `.atom`, `.txt`, `.csv`, `.json`, `.yaml`, `.yml` or `.ipynb`, up to the upload size limit. Images, audio, archives and Markdown files themselves are not converted (*Not converted*).
- The copy sits next to its original with the extension replaced (`notes.txt` becomes `notes.md`). A copy never replaces another file: if that name is taken it is stored as `notes.txt.md`, and if both are taken the conversion is marked *Failed* with the reason.
- A document that unpacks to more than 100 MB, or is made of more than 5000 parts, is not opened and ends as *Failed*.
- A failed conversion shows its reason in the drawer; **Retry conversion** (or **Convert to Markdown** / **Convert again**) queues it once more. A copy made by an earlier conversion stays downloadable when a later one fails or is skipped. A conversion that stays *Converting…* for more than five minutes offers **Convert again**, because the job may have been lost when the server restarted.
- Conversion runs on the `files` queue. Without Redis the queue lives in memory and a restart drops waiting jobs; with Redis configured the jobs survive. See [Cluster](/guide/cluster).

## Storage providers

Add a provider on the **Providers** page (**Admin → Providers**, **Add provider**) and pick the driver card. The form lists the driver's fields, a **Connection test** section and a **Pre-flight** checklist. A provider is assigned to projects in the form or right after it is created; a bucket can use only providers that are assigned to its project. The provider's **Key** is unique in the organization, across every kind of provider, and it names the provider's folder in the store, so it has to be one name: not `.` or `..`, and with no `/`, `\` or control character (a new key that breaks this is refused for every kind of provider).

| Driver | Catalog name | Use it when |
|--------|--------------|-------------|
| `s3-compatible-files` | S3-compatible storage | You run MinIO, Ceph RGW, SeaweedFS or Garage, or use Cloudflare R2, Backblaze B2, Wasabi or another store with an S3 API at its own endpoint |
| `aws-s3-files` | Amazon S3 | You use Amazon S3 |
| `azure-blob-files` | Azure Blob Storage | You use Azure Blob Storage, a sovereign cloud, Azure Stack Hub or Azurite |
| `mongodb-gridfs-files` | MongoDB GridFS | There is no object store, but there is a MongoDB |
| `local-filesystem` | Local filesystem | A single node or development; a fresh install already has one |

Credentials are stored encrypted and are never shown again. When you edit a provider, a stored secret shows **Stored — leave blank to keep**: leave the field empty to keep it, or type a new value to replace it. Settings and credentials are checked when the provider is saved and when it is tested; a refused value comes back with the field to change.

### S3-compatible storage

![The S3-compatible provider form](/screenshots/files/07-provider-s3-compatible.png)

| Field | Required | Notes |
|-------|----------|-------|
| **Access key ID**, **Secret access key** | Yes | Without spaces or line breaks. |
| **Session token** | No | For temporary credentials. |
| **Endpoint URL** | Yes | The base URL of the S3 API, with `http://` or `https://` and the port, for example `https://minio.internal:9000`. No user name, password, query string or fragment. A path is kept for gateways that serve S3 under one. MinIO listens for the API on 9000; 9001 is its web console. |
| **Region** | No | The signing region. Defaults to `us-east-1`. Use the region your store enforces, `auto` for Cloudflare R2. |
| **Use path-style addressing** | No | On by default. See below. |
| **Bucket name** | Yes | The bucket name only, 3 to 63 characters: no `s3://`, slashes, spaces or URL characters. |
| **Bucket prefix** | No | A folder inside the bucket for everything this provider stores. |
| **Create bucket if missing** | No | Off by default. Creates the bucket on the first upload (and during **Test connection**) when the store says it does not exist. Needs the `CreateBucket` permission and is never attempted after an access-denied answer. |
| **CA certificate (PEM)** | No | For a store whose certificate was issued by an internal CA. |
| **Skip TLS verification** | No | Accepts any certificate, including a self-signed one. Off by default; the CA certificate is the better choice. |

**Path-style or virtual-hosted.** With path-style addressing the bucket is part of the path (`https://minio.example.com:9000/archive/...`). Virtual-hosted style puts it in the host name (`https://archive.minio.example.com/...`) and needs wildcard DNS and a certificate for it. Most self-hosted stores need path-style, so it is on by default; switch it off only for a store that has wildcard DNS for bucket names. If a host name such as `bucket.host` cannot be resolved, the error message suggests turning path-style on.

**TLS.** Use `https://` whenever the store offers it: with `http://` the requests and the data travel unencrypted. To trust a private CA, paste the certificate that issued the store's certificate (a bundle with several certificates is fine, up to 64 KiB and 50 certificates; text that contains a private key is rejected) into **CA certificate (PEM)**. It is trusted in addition to the system roots, for this provider only. **Skip TLS verification** accepts any certificate. It is available on every deployment, it suits test setups, and the address rules under [Which endpoints a provider may use](#which-endpoints-a-provider-may-use) still apply to the store. Only the boolean `true` switches verification off; a value of another type (the text `"true"`, say) is refused when the provider is saved. The CA certificate keeps verification on and is the better choice everywhere.

**Older stores and request checksums.** Recent AWS SDK releases add a CRC32 integrity checksum to every upload and announce large bodies with `Expect: 100-continue`. Stores that predate those features answer 501 or reject the signature. For a provider with a custom endpoint the console therefore sends checksums only where the S3 API requires them, never sends `Expect: 100-continue`, makes at most two attempts per request, and uses a 10 second connect and a 120 second socket timeout. Amazon S3 itself, without an endpoint, keeps the SDK defaults.

**Permissions.** The credentials need `PutObject`, `GetObject`, `DeleteObject` and `ListBucket` on the bucket (and `CreateBucket` when **Create bucket if missing** is on). Everything the provider writes, including the connection-test object, sits under the provider's own folder (see the path above), so a policy can be limited to that folder.

**Notes for common stores.** The values below are typical; your installation may differ, so check the store's documentation.

| Store | Endpoint | Region | Notes |
|-------|----------|--------|-------|
| MinIO | `https://host:9000` (the S3 API port) | `us-east-1` unless the server sets another | Behind a reverse proxy, forward the `Host` header unchanged (nginx: `proxy_set_header Host $http_host;`) and raise the body limit (`client_max_body_size`). |
| Ceph RGW | The URL of the gateway or the proxy in front of it | The zonegroup name if the gateway enforces one | Keep path-style on unless the gateway has wildcard DNS (`rgw_dns_name`). |
| SeaweedFS | The S3 gateway, for example `http://host:8333` | Any value, such as `us-east-1` | Keep path-style addressing on. |
| Garage | The S3 API address, for example `http://host:3900` | The `s3_region` of Garage's configuration (often `garage`) | A wrong region comes back as "The server expects region …". |
| Cloudflare R2 | `https://<account id>.r2.cloudflarestorage.com` (EU jurisdiction: `https://<account id>.eu.r2.cloudflarestorage.com`) | `auto` | Use the S3 credentials of an R2 API token that can read and write the bucket. |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com`, as shown on the bucket's page | The region in the endpoint, for example `us-west-004` | Use an application key: its key ID is the access key ID and the application key is the secret. The key must be allowed on the bucket. |
| Wasabi | `https://s3.<region>.wasabisys.com` | The same region | |

**Names and metadata in any language.** Object metadata is stored with the object in a form that survives HTTP headers (RFC 2047 encoded words), so values in any language round-trip. An object keeps about 2 KB of metadata (the S3 limit); entries that do not fit are left out of the object and logged, never a reason to refuse the upload, and the file's record in the console always keeps all of it.

### Amazon S3

The Amazon S3 form has the fields **Access key ID**, **Secret access key**, an optional **Session token**, **AWS region** (required), **Bucket name**, **Bucket prefix**, an optional **Custom endpoint**, **Use path-style addressing** (automatic: on when a custom endpoint is set, off for Amazon S3), and the TLS fields **CA certificate (PEM)** and **Skip TLS verification**, which apply to a custom endpoint only.

Providers created before the S3-compatible driver existed may carry a custom endpoint (MinIO, Ceph and similar). They keep every setting they have and run on the same code as the S3-compatible driver, so they get the same fixes: friendly error messages, the checksum handling above, the TLS options, and the region becoming optional when an endpoint is set. New stores with their own endpoint are better set up with **S3-compatible storage**.

A least-privilege policy for a provider that writes under `console/` of the bucket `company-files`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::company-files",
      "Condition": { "StringLike": { "s3:prefix": ["console/*"] } }
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::company-files/console/*"
    }
  ]
}
```

### Azure Blob Storage

![The Azure Blob Storage provider form](/screenshots/files/08-provider-azure-blob.png)

One container holds the files of every tenant and provider, each under its own folder (see the path above).

| Field | Required | Notes |
|-------|----------|-------|
| **Account name** | Depends | The storage account: 3 to 24 lowercase letters and digits. Optional when the blob endpoint or the connection string names the account. |
| **Container** | Yes | 3 to 63 characters: lowercase letters, digits and single hyphens, starting and ending with a letter or digit. The special `$root`, `$web` and `$logs` containers cannot be used. |
| **Blob prefix** | No | A folder inside the container for everything this provider stores. |
| **Create container if missing** | No | Off by default. Creates the container on the first upload and during **Test connection**. It needs an account key, an account-level SAS, or a role on the account; a container-level SAS cannot create a container. |
| **Method** | Yes | How to sign in: **Account key** (default), **SAS token**, **Connection string** or **Microsoft Entra ID**. Only the fields of the chosen method are shown. |
| **Blob endpoint** | No | Leave empty for the Azure public cloud (`https://<account>.blob.core.windows.net`). See below. |
| **Authority host** | No | Entra only. The sign-in authority; empty follows the endpoint. |
| **API version** | No | `YYYY-MM-DD`. Overrides the service version the client sends; for Azure Stack Hub or an emulator that is behind the public service. |
| **CA certificate (PEM)**, **Skip TLS verification** | No | As for S3. They apply to the blob endpoint and to the Entra authority. |

**Sign-in methods.**

| Method | What to paste | Notes |
|--------|---------------|-------|
| **Account key** | Access key 1 or 2 of the storage account (88 characters, base64) from **Security + networking → Access keys**. | Refused by accounts that have shared-key access switched off; the error then suggests a SAS or Entra ID. |
| **SAS token** | The token (it starts with `sv=`, with or without a leading `?`) or the full SAS URL, for a container or for the account. | It must contain `sv` and `sig`, must not be expired, and must not be scoped to one blob or snapshot. See the permissions below. A SAS expires: create a new one and replace it before then. |
| **Connection string** | The connection string from the **Access keys** page. | It must hold an account key or a SAS, and an account name or a `BlobEndpoint`. `UseDevelopmentStorage=true` is not supported; write the emulator's endpoint out. The console reads the string with its own parser and checks every value. |
| **Microsoft Entra ID** | **Tenant ID** (a GUID or a verified domain), **Client ID** (the application ID, a GUID) and the **Client secret** *value* (not the secret ID). | A service principal with the **Storage Blob Data Contributor** role on the container or the account. The blob endpoint and the authority host must be `https://`; a provider that uses this method with an `http://` endpoint is refused when it is saved. Managed identities and certificates are not offered; use a service principal with a client secret. |

**SAS permissions.** A SAS needs read (`r`), add (`a`), create (`c`), write (`w`) and delete (`d`). Listing (`l`) is needed to import existing files and for the first step of **Test connection**; uploads, downloads and deletes work without it, and a test with a list-less SAS still tries the write, read and delete steps. An account-level SAS must allow the Blob service and the service, container and object resource types.

**Endpoints.** Leave **Blob endpoint** empty for the Azure public cloud. Otherwise enter the blob service URL:

- a sovereign cloud: `https://<account>.blob.core.usgovcloudapi.net` or `https://<account>.blob.core.chinacloudapi.cn` (Entra then signs in at `login.microsoftonline.us` or `login.chinacloudapi.cn` unless you set **Authority host**);
- Azure Stack Hub or a custom domain (an account name may then be needed to sign);
- a private endpoint, which keeps the standard host name and resolves it to a private address (on the hosted service the operator opens that network first, see [Which endpoints a provider may use](#which-endpoints-a-provider-may-use));
- Azurite, for example `http://127.0.0.1:10000/devstoreaccount1`.

A value without a scheme is read as `https://`. The endpoint takes no credentials, query string or fragment. A host that already carries the account takes no path; for emulators with the account in the path, the account name must match it. Plain `http://` is accepted on every deployment, except with Microsoft Entra ID, which needs https; the address rules under [Which endpoints a provider may use](#which-endpoints-a-provider-may-use) apply to it.

### MongoDB GridFS

Files go into MongoDB GridFS (`<bucket>.files` and `<bucket>.chunks`), isolated per tenant and provider by file name prefix. It works with any MongoDB, the Community edition included, and needs no extra service or volume.

| Field | Notes |
|-------|-------|
| **Connection URI** | Optional. Empty reuses the console's own `MONGODB_URI` and requires `DB_PROVIDER=mongodb`; the app's own connection is not subject to the endpoint policy. Required when the console runs on SQLite. |
| **Database** | Defaults to `cognipeer_files`, or the console's main database when `MONGODB_SINGLE_DATABASE` is on. |
| **GridFS bucket name** | Defaults to `files`. |
| **Chunk size (bytes)** | Defaults to 255 KiB. |

A connection URI entered in the form is read with the MongoDB driver's own parser and every host in it (the seed list and a proxy) is checked against the endpoint policy: a public host passes, and a private one passes on a self-hosted install or inside a network the operator has opened for your organization (see [Which endpoints a provider may use](#which-endpoints-a-provider-may-use)). On the hosted service the rest of the URI is held to these rules:

- `mongodb+srv://` URIs are accepted. Console resolves the SRV record when the provider is saved or tested and checks every host in it like any other host; a record that cannot be resolved refuses the URI. Local sockets are refused, because their host cannot be checked in advance; list the hosts in a `mongodb://` URI.
- `tlsCAFile`, `tlsCertificateKeyFile` and `tlsCRLFile` are refused, because they name files on the server's disk. Self-hosted installations can use them.
- Certificate verification can be turned off with the options `tlsInsecure`, `tlsAllowInvalidCertificates` and `tlsAllowInvalidHostnames`. They are the provider's own choice on every deployment, like **Skip TLS verification** for the storage endpoints, and the hosts in the URI are held to the same address rules either way. GridFS has no **CA certificate (PEM)** field.
- The sign-in method must take its credentials from the URI: `DEFAULT`, `SCRAM-SHA-1`, `SCRAM-SHA-256` and `PLAIN` do, and so does `MONGODB-AWS` when the access key and the secret are written in the URI. `MONGODB-OIDC`, `GSSAPI`, `MONGODB-X509` and the `ENVIRONMENT` and `TOKEN_RESOURCE` properties make the driver sign in with the identity of the server, and are refused. Self-hosted installations can use them unless private networks are blocked explicitly.
- On a self-hosted install the socket rule applies only when private networks are blocked explicitly, and only then is the SRV record of a `mongodb+srv://` URI looked up and checked.

File traffic grows the database and its backups; for large volumes point the provider at a dedicated MongoDB. On managed Cosmos DB (MongoDB API) prefer S3-compatible storage, because GridFS is request-unit heavy there.

### Local filesystem

Stores files under **Base directory** (default `DATA_DIR/files`), optionally inside a **Subdirectory**, then `<tenant id>/<provider key>/`. Use it on a single node or for development. In Kubernetes it needs a persistent volume, and because the files stay on one server it does not suit a deployment with several replicas. It has no connection to test, and the bucket screens show its location as *This server's disk*.

| Field | Notes |
|-------|-------|
| **Base directory** | Optional; empty uses `DATA_DIR/files`. It names a directory of the server that runs the console, so it can be set only on a self-hosted install (`DEPLOYMENT_MODE=onprem`) and only by an owner or an admin. Through the API that is the person the call acts for: the token's owner, or the user a delegating token acts for. Anywhere else it is refused with `400 provider_settings_invalid` and the field `basePath`. |
| **Subdirectory** | Optional. A relative folder inside the base directory: no `..`, no leading `/` or `\` and no drive letter, or it is refused (`400 provider_settings_invalid`, field `subdirectory`). The rule is applied again when a stored provider is used, so a provider saved earlier with a subdirectory that breaks it (`/files`, say) answers `502 storage_failure` naming the field until it is edited. |

## Which endpoints a provider may use

A file provider connects from the console server to the endpoint you enter. Where that endpoint may be depends on the deployment mode, `DEPLOYMENT_MODE` (see [Configuration](/guide/configuration#deployment-mode)).

| | Hosted (`saas`) | Self-hosted (`onprem`) |
|---|---|---|
| Public host names and addresses | Allowed | Allowed |
| Private and carrier-grade NAT addresses, and names such as `*.local` and `*.internal` | Refused, unless the operator has opened the network for your organization | Allowed by default |
| Loopback, link-local and cloud-metadata addresses, and `localhost` | Refused; no setting opens them | Allowed by default |
| **Skip TLS verification** (S3-compatible storage, Amazon S3 with a custom endpoint, Azure Blob; for GridFS the URI options `tlsInsecure`, `tlsAllowInvalidCertificates` and `tlsAllowInvalidHostnames`) | Allowed | Allowed |
| Plain `http://` (S3-compatible storage, Amazon S3 with a custom endpoint, Azure Blob; not with Microsoft Entra ID) | Allowed | Allowed |
| `mongodb+srv://` in a GridFS connection URI | Allowed when every host in the SRV record passes the checks above | Allowed |
| Local sockets in a GridFS connection URI | Refused | Allowed unless private networks are blocked explicitly |
| Certificate files (`tlsCAFile`, `tlsCertificateKeyFile`, `tlsCRLFile`) in a GridFS connection URI | Refused | Allowed |
| A sign-in method of a GridFS connection URI that uses the identity of the server (`MONGODB-OIDC`, `GSSAPI`, `MONGODB-X509`, `MONGODB-AWS` without a key in the URI) | Refused | Allowed unless private networks are blocked explicitly |

A self-hosted install can switch the private-network block on for providers with `OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK=true`; its address rows then read like the hosted column, and `OUTBOUND_HTTP_ALLOWED_HOSTS` lists the hosts that stay allowed. The block is not a switch on the hosted service: it is always in force there, and the allow-list does not apply.

**Private networks.** A store on a private address of your own network, such as a MinIO or Ceph cluster, an Azure private endpoint or a MongoDB used for GridFS, is reachable on the hosted service through a network the operator has opened for your organization (a VPN or a peering that the operator has set up, with the ranges listed in `PROVIDER_PRIVATE_NETWORKS`). The operator needs your workspace slug (**Admin → License**) and the address ranges of your endpoints. No range opens loopback, link-local or cloud-metadata addresses, or the console's own addresses. See [Private networks on SaaS](/guide/providers#private-networks-on-saas) for the procedure and the complete list.

**Skip TLS verification** and plain `http://` are the provider's own choice on every deployment, and the address rules above apply to them either way: on the hosted service a store with a skipped certificate check or on plain http still has to be on a public address or inside an opened network. With `http://` the requests and the data travel unencrypted, and a skipped check accepts any certificate, so prefer an `https://` endpoint and **CA certificate (PEM)**. Microsoft Entra ID needs https: a provider that uses it with an `http://` endpoint is refused when it is saved.

The check runs when a provider is saved, when it is tested, and each time the console builds its storage client. The client's connections are checked as well when they are opened, so a host name that starts to resolve to a private address after the check is refused too. A refused endpoint answers `400` with `code: "provider_endpoint_not_allowed"` and the name of the field; for a provider that is already stored, file calls answer `502 storage_failure` with the same message and field.

::: warning
A console that uses MongoDB and is installed on your own infrastructure defaults to `saas` mode, which refuses private endpoints. Set `DEPLOYMENT_MODE=onprem` to use storage on your internal network (MinIO on a private address, Azurite) and to use certificate files in a GridFS URI. SQLite installations default to `onprem`.

On MongoDB the mode also sets the default of `MONGODB_SINGLE_DATABASE` (`true` in `onprem`). An installation that already keeps its organizations in per-tenant databases (`tenant_<slug>`) must set `MONGODB_SINGLE_DATABASE=false` together with `DEPLOYMENT_MODE=onprem`, or the console looks for that data in the main database. See [Deployment mode](/guide/configuration#deployment-mode).
:::

## Testing a connection

**Test connection** in the provider form checks the values as they stand, **without saving anything**. A saved provider can also be re-tested from the bucket's **Settings** tab (**Test now**, owners and admins); that result is kept and feeds the health chip in the bucket list. A failed test never blocks saving.

S3-compatible, Amazon S3 and Azure Blob providers run four steps. After a failed **List** or **Write test object** no step follows (and a step that did not run is not listed), except that an Azure list refused only for want of the list permission does not stop the write steps. After a failed **Read back** the **Delete** step still runs, so the test object does not stay behind:

| Step | What it does | What it needs |
|------|--------------|---------------|
| **List** | Lists at most one object under the provider's folder. Proves the endpoint, the credentials and the bucket or container. With **Create bucket if missing** on, an S3-compatible or Amazon S3 bucket that does not exist is created here. On Azure Blob nothing is created here: with **Create container if missing** on, a missing container does not fail this step, which says that the container is created on the first upload (the next step); with it off, a missing container fails this step. | `ListBucket`; an Azure SAS with `l` |
| **Write test object** | Writes a small text file under `.cognipeer-connection-test/` in the provider's folder, named with non-ASCII characters on purpose so the header encoding is exercised. With **Create container if missing** on, an Azure container that does not exist is created here, by the upload. | `PutObject`; an Azure SAS with `c` and `w` |
| **Read back** | Reads the object and compares it with what was written. | `GetObject`; an Azure SAS with `r` |
| **Delete** | Removes the object. | `DeleteObject`; an Azure SAS with `d` |

If only the delete fails, the test still passes and says that deleting files needs that permission; the object stays under `.cognipeer-connection-test/`. GridFS answers with a single listing, and the local filesystem has nothing to test.

A test has a hard time limit of 10 seconds. A failed connection is a normal answer (`ok: false` with the step that failed), not an error. Messages are cleaned of credential values and cut to 300 characters. A setting the driver refuses, or an endpoint the policy refuses, is reported before anything is dialled, next to the field to change.

## Limits

| Limit | Value |
|-------|-------|
| Largest file per upload | 50 MB (`FILE_UPLOAD_MAX_MB`). The Upload screen and `GET /files/limits` show the effective value, which is also bounded by the project's per-request quota. |
| Allowed file types | Any (`FILE_UPLOAD_ALLOWED_MIME_TYPES` is a comma-separated allow-list; `image/*` works). A type outside it is refused with `415 content_type_not_allowed`. |
| Upload request body | The file as base64 plus 64 KiB. A larger body is refused as `413 file_too_large` before it is read. |
| Largest object the server reads at once | The larger of twice the upload limit and 100 MB. Download, preview and zip refuse a larger object with `413 object_too_large`. Imported objects can be any size. |
| Preview | 10 MB; images, PDF and text types |
| Download as .zip | 50 files, 200 MB of originals |
| Listing | 50 files per page |
| Import | 200 objects per request by default, 500 at most |
| Bucket | Name 120 characters, description 1000, prefix 200, key 64 |
| Folder or key hint | 512 characters; no `.` or `..` segments, no control characters, no unpaired surrogates |
| Generated key name | At most 200 bytes of UTF-8 for the name part of a key the console generates: a longer file name is shortened before the unique part, and an extension is kept up to 32 bytes. A key you name yourself is judged by the store (a part over 255 bytes is refused on MinIO and on a local disk) and answers `400 invalid_request`. |
| Object name | Counted by the store with the provider's folders in front of the key: 1024 bytes on Amazon S3, 1024 characters and 254 path segments on Azure Blob |

Project quotas (storage bytes, number of files, request and upload rate) come from the project's quota policies and are refused with `429`. The bucket's **Usage** card shows where the project stands. Each bucket's provider can have its own policy.

## Resilience

A provider's storage client is created once per tenant and provider, kept in the [runtime pool](/guide/core-runtime-pool) and rebuilt when the credentials or settings change. Calls to the store are retried when they fail for a transient reason (a timeout, a network error, a 5xx or 429 answer) and, per tenant and provider, a store that keeps failing is paused for a short time (by default after 5 failed calls, for 30 seconds): calls then answer `503 storage_unavailable` instead of piling up. Answers that would fail the same way again are not retried and do not count against the store: a missing bucket or file, wrong credentials, a refused setting, a file that is too large. See [Resilience](/guide/core-resilience).

## Troubleshooting

| You see | What it usually means | What to do |
|---------|----------------------|-----------|
| *Connection refused by host* | Wrong port, or the service is not running. Inside Docker or Kubernetes `localhost` is the console's own container. | Use the S3 API port (MinIO: 9000, not 9001) and an address the console can reach. |
| *answered HTTP 200 but not with an S3 bucket listing* | The endpoint is a web console or a proxy page. | Check the URL and port, and that no proxy rewrites the reply. |
| *The server expects region "x"* | The store enforces a region. | Put that value in **Region**. |
| *The secret access key is wrong, or the region or path-style setting does not match the server* | Signature mismatch. Behind a proxy, a rewritten `Host` header causes it too. | Re-enter the key; check region and path-style; forward `Host` unchanged. |
| *Bucket "x" is missing on host* | The bucket does not exist. | Create it, or turn on **Create bucket if missing**. |
| *Access denied on bucket "x"* | The credentials are accepted but lack a permission. | Grant `PutObject`, `GetObject`, `DeleteObject` and `ListBucket`. |
| *The TLS certificate of host is not trusted* | An internal CA. | Paste the CA certificate into **CA certificate (PEM)**. |
| *The TLS certificate … is not valid for the host name* | The endpoint host is not in the certificate. | Use a name from the certificate, or issue it again. |
| *The host name … cannot be resolved* | A DNS problem, or a bucket sub-domain on a store without wildcard DNS. | Check the spelling; turn on **Use path-style addressing**. |
| *HTTP 413 (nginx: client_max_body_size)* | A proxy in front of the store limits the body size. | Raise the limit there. |
| *Provider endpoint "endpoint" is not allowed* | The endpoint policy refused the address. | Use a public address, or ask the operator to open the network for your organization ([Private networks on SaaS](/guide/providers#private-networks-on-saas)). On a self-hosted install, check `DEPLOYMENT_MODE` (see above). |
| *Microsoft Entra authentication needs an https endpoint.* | Entra ID sends a bearer token, which is not sent over plain http. | Use an `https://` blob endpoint (and authority host), or another sign-in method. |
| *Key-based access is turned off for this storage account* | The Azure account disallows shared keys. | Use a SAS token or Microsoft Entra ID. |
| *The container "x" is missing* | The container does not exist. | Create it, or turn on **Create container if missing**. |
| *Azure refused the request (AuthorizationFailure)* | Rejected credentials, or the account's firewall or network access setting blocks the console. | Check the credentials; allow the console's address in the account's networking settings. |
| *The SAS token expired on …* or *Azure rejected the SAS token: it expired on …* | The SAS validity ended (the first message when the provider is saved, the second when Azure refuses a call). | Create a new SAS and replace it in the provider. |
| *Azure rejected the SAS token: it is not valid before …* | The SAS start time (`st`) is still ahead, or this server's clock is behind. | Check the start time of the SAS and the clock of the server. |
| *The connection to Azure Blob Storage was interrupted (download).* | The connection dropped while a file was being read. | Try again; if it keeps happening, check the proxies and firewalls between the console and the account. |
| *The file changed while it was being downloaded; try again.* | The blob was replaced while the console was reading it. | Download it again. |
| *The credentials do not allow "upload" … A SAS needs the c and w (create and write) permission* | The SAS lacks permission letters. | Create a SAS with `racwdl`. |
| *The storage provider is temporarily unavailable* (`503`) | The provider has been failing and calls are paused for a short time. | Fix the cause; retry in a moment. |

## Client API

Buckets are reachable with an API token. The [Files API](/api/files) lists the routes; the bucket's **API** tab has samples with your host and bucket key filled in.

```
GET    /api/client/v1/files/buckets
GET    /api/client/v1/files/buckets/:bucketKey/objects
POST   /api/client/v1/files/buckets/:bucketKey/objects
GET    /api/client/v1/files/buckets/:bucketKey/objects/:objectKey/download
DELETE /api/client/v1/files/buckets/:bucketKey/objects/:objectKey
```

An upload is JSON with the file base64-encoded in `data` (it is not multipart) and an optional `metadata` object (a text or a list is refused with `400`), a file key is one path segment (slashes are encoded), and `convertToMarkdown` is off by default on this API and, when on, converts before the response.

Without further parameters, listing is the flat list of every file in the bucket. Add `prefix` to list **one folder**, the way an object store does with a `/` delimiter:

```
GET /api/client/v1/files/buckets/:bucketKey/objects?prefix=agent-sessions/support-bot/
```

The answer then holds the files directly in that folder (`files`) and its sub-folders (`folders`, each a full path ending in `/`), found from the file keys; `prefix=` (empty) is the bucket root. Page with `nextCursor` (pass it as `cursor`). `purpose=conversation` keeps only [session files](/guide/session-files), `purpose=other` only the rest. With `search`, `prefix` just narrows the search to everything under it, however deep.

## Session files

Files attached to agent sessions are ordinary files in the bucket the agent names (**Build → Files**), under `<folder>/<agentKey>/<sessionId>/`. They carry `purpose: "conversation"`, the session they belong to (`conversationId`), the agent (`agentKey`), when they expire and who uploaded them. The Document Store's own listing adds `agentId`, the `_id` of the agent, to a session file's row so that a link to the session can be built.

Who may see a session file is who may see its session: the person who started the session, or anybody the Agents service lets view other people's sessions (`agent.session_view_others` needs Agents at Read). A role with Files access and no Agents level sees ordinary files only; session files are left out of its listings and refused by key. The folder view follows the same rule: in the listing of `<folder>/<agentKey>/` the sub-folder of a session the caller may not view is left out of `folders` (the session's id is in its name), and so are the files in it. A listing for a caller held to their own sessions is filled from the following pages, folders and files counting as entries, so a page is not short while the bucket goes on (`nextCursor` continues it). See [Authorization](/guide/authorization#sessions-and-approvals).

A bucket an agent keeps session files in cannot be deleted or disabled until the agent uses another one (`409 bucket_in_use`, naming the agents; this includes an agent whose *published* version still uses it). See [Session files](/guide/session-files) for the agent side.

To upload into a folder from the Document Store, use the **Folder** field of the Upload screen (the Document Store's own upload route takes it as `folder`, alias `prefix`). On the client API, a `keyHint` that ends in `/` names the folder and the file keeps a generated unique name inside it; any other `keyHint` is the whole key of the file, and uploading to a whole key that already has a file replaces that file.
