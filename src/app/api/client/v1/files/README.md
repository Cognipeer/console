# File Storage Client API Documentation

This document describes the client API endpoints for file storage operations in CognipeerAI Gateway. All endpoints require API token authentication via the `Authorization: Bearer <token>` header.

## Base URL

```
/api/client/v1/files
```

## Authentication

All requests must include a valid API token in the Authorization header:

```bash
Authorization: Bearer <your-api-token>
```

## Endpoints

### 1. List Buckets

Get all file buckets available to your tenant.

**Endpoint:** `GET /api/client/v1/files/buckets`

**Response:**
```json
{
  "buckets": [
    {
      "id": "...",
      "key": "documents",
      "name": "Customer Documents",
      "providerKey": "s3-storage",
      "description": "Storage for customer documents",
      "prefix": "documents",
      "status": "active",
      "createdBy": "...",
      "createdAt": "2025-10-09T...",
      "provider": {
        "key": "s3-storage",
        "label": "S3 Storage",
        "driver": "aws-s3",
        "type": "file",
        "status": "active",
        ...
      }
    }
  ],
  "count": 1
}
```

**Example:**
```bash
curl -X GET https://your-domain.com/api/client/v1/files/buckets \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

---

### 2. Get Bucket Details

Get details of a specific bucket.

**Endpoint:** `GET /api/client/v1/files/buckets/:bucketKey`

**Parameters:**
- `bucketKey` (path): The unique key of the bucket

**Response:**
```json
{
  "bucket": {
    "id": "...",
    "key": "documents",
    "name": "Customer Documents",
    "providerKey": "s3-storage",
    "description": "Storage for customer documents",
    "prefix": "documents",
    "status": "active",
    ...
  }
}
```

**Example:**
```bash
curl -X GET https://your-domain.com/api/client/v1/files/buckets/documents \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

---

### 3. Upload File

Upload a file to a specific bucket.

**Endpoint:** `POST /api/client/v1/files/buckets/:bucketKey/objects`

**Parameters:**
- `bucketKey` (path): The unique key of the bucket

**Request Body:**
```json
{
  "fileName": "document.pdf",
  "contentType": "application/pdf",
  "data": "base64-encoded-data",
  "metadata": {
    "description": "Invoice for order #12345",
    "category": "invoice"
  },
  "convertToMarkdown": false,
  "keyHint": "invoice-12345"
}
```

**Request Fields:**
- `fileName` (required): Name of the file
- `data` (required): Base64-encoded file data or data URL (e.g., `data:image/png;base64,...`)
- `contentType` (optional): MIME type of the file
- `metadata` (optional): Custom metadata object
- `convertToMarkdown` (optional): Whether to convert the file to markdown (default: false)
- `keyHint` (optional): Suggested key for the file (will be normalized)

**Response:**
```json
{
  "file": {
    "id": "...",
    "tenantId": "...",
    "bucketKey": "documents",
    "key": "invoice-12345-1728518400000-a1b2c3d4",
    "fileName": "document.pdf",
    "contentType": "application/pdf",
    "size": 45678,
    "etag": "...",
    "metadata": {
      "description": "Invoice for order #12345",
      "category": "invoice"
    },
    "createdBy": "...",
    "createdAt": "2025-10-09T...",
    ...
  },
  "message": "File uploaded successfully"
}
```

**Example:**
```bash
# Upload a file using base64 encoding
BASE64_DATA=$(base64 -i document.pdf)

curl -X POST https://your-domain.com/api/client/v1/files/buckets/documents/objects \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fileName": "document.pdf",
    "contentType": "application/pdf",
    "data": "'"$BASE64_DATA"'",
    "metadata": {
      "category": "invoice"
    }
  }'
```

---

### 4. List Files

List files in a specific bucket with optional filtering and pagination.

**Endpoint:** `GET /api/client/v1/files/buckets/:bucketKey/objects`

**Parameters:**
- `bucketKey` (path): The unique key of the bucket
- `search` (query, optional): Search term for file names
- `limit` (query, optional): Maximum number of files to return (default: 50)
- `cursor` (query, optional): Pagination cursor from previous response

**Response:**
```json
{
  "files": [
    {
      "id": "...",
      "tenantId": "...",
      "bucketKey": "documents",
      "key": "invoice-12345-1728518400000-a1b2c3d4",
      "fileName": "document.pdf",
      "contentType": "application/pdf",
      "size": 45678,
      "etag": "...",
      "metadata": {},
      "createdAt": "2025-10-09T...",
      ...
    }
  ],
  "count": 1,
  "nextCursor": "eyJrZXkiOiIuLi4ifQ=="
}
```

**Example:**
```bash
# List all files
curl -X GET https://your-domain.com/api/client/v1/files/buckets/documents/objects \
  -H "Authorization: Bearer YOUR_API_TOKEN"

# Search for specific files
curl -X GET "https://your-domain.com/api/client/v1/files/buckets/documents/objects?search=invoice&limit=10" \
  -H "Authorization: Bearer YOUR_API_TOKEN"

# Paginate through results
curl -X GET "https://your-domain.com/api/client/v1/files/buckets/documents/objects?cursor=eyJrZXkiOiIuLi4ifQ==" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

---

### 5. Get File Details

Get metadata and details of a specific file.

**Endpoint:** `GET /api/client/v1/files/buckets/:bucketKey/objects/:objectKey`

**Parameters:**
- `bucketKey` (path): The unique key of the bucket
- `objectKey` (path): The unique key of the file

**Response:**
```json
{
  "file": {
    "id": "...",
    "tenantId": "...",
    "bucketKey": "documents",
    "key": "invoice-12345-1728518400000-a1b2c3d4",
    "fileName": "document.pdf",
    "contentType": "application/pdf",
    "size": 45678,
    "etag": "...",
    "metadata": {
      "description": "Invoice for order #12345",
      "category": "invoice"
    },
    "markdownStatus": "completed",
    "markdownKey": "invoice-12345-1728518400000-a1b2c3d4.md",
    "createdBy": "...",
    "createdAt": "2025-10-09T...",
    ...
  }
}
```

**Example:**
```bash
curl -X GET https://your-domain.com/api/client/v1/files/buckets/documents/objects/invoice-12345-1728518400000-a1b2c3d4 \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

---

### 6. Download File

Download a file from the bucket. Returns the file content with appropriate headers.

**Endpoint:** `GET /api/client/v1/files/buckets/:bucketKey/objects/:objectKey/download`

**Parameters:**
- `bucketKey` (path): The unique key of the bucket
- `objectKey` (path): The unique key of the file
- `variant` (query, optional): Download variant - `original` (default) or `markdown`

**Response:**
- Binary file content with appropriate headers
- `Content-Type`: File MIME type
- `Content-Length`: File size in bytes
- `Content-Disposition`: Attachment with filename
- `ETag`: File entity tag (if available)
- `X-File-Metadata`: JSON-encoded metadata (if available)

**Example:**
```bash
# Download original file
curl -X GET https://your-domain.com/api/client/v1/files/buckets/documents/objects/invoice-12345-1728518400000-a1b2c3d4/download \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -o document.pdf

# Download markdown version (if available)
curl -X GET "https://your-domain.com/api/client/v1/files/buckets/documents/objects/invoice-12345-1728518400000-a1b2c3d4/download?variant=markdown" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -o document.md
```

---

### 7. Delete File

Delete a file from the bucket.

**Endpoint:** `DELETE /api/client/v1/files/buckets/:bucketKey/objects/:objectKey`

**Parameters:**
- `bucketKey` (path): The unique key of the bucket
- `objectKey` (path): The unique key of the file

**Response:**
```json
{
  "message": "File deleted successfully",
  "bucketKey": "documents",
  "objectKey": "invoice-12345-1728518400000-a1b2c3d4"
}
```

**Example:**
```bash
curl -X DELETE https://your-domain.com/api/client/v1/files/buckets/documents/objects/invoice-12345-1728518400000-a1b2c3d4 \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

---

## Error Responses

All endpoints may return error responses in the following format:

```json
{
  "error": "Error message describing what went wrong"
}
```

### Common HTTP Status Codes

- `200 OK`: Request successful
- `201 Created`: Resource created successfully
- `400 Bad Request`: Invalid request parameters or body
- `401 Unauthorized`: Missing or invalid API token
- `404 Not Found`: Resource not found
- `500 Internal Server Error`: Server error

### Authentication Errors

```json
{
  "error": "Missing or invalid authorization header"
}
```

### Validation Errors

```json
{
  "error": "fileName is required"
}
```

---

## TypeScript Client Example

```typescript
import axios, { AxiosInstance } from 'axios';

class FileStorageClient {
  private client: AxiosInstance;

  constructor(baseURL: string, apiToken: string) {
    this.client = axios.create({
      baseURL: `${baseURL}/api/client/v1/files`,
      headers: {
        'Authorization': `Bearer ${apiToken}`,
      },
    });
  }

  async listBuckets() {
    const { data } = await this.client.get('/buckets');
    return data;
  }

  async uploadFile(
    bucketKey: string,
    fileName: string,
    fileData: Buffer | string,
    options?: {
      contentType?: string;
      metadata?: Record<string, unknown>;
      convertToMarkdown?: boolean;
    }
  ) {
    const base64Data = Buffer.isBuffer(fileData) 
      ? fileData.toString('base64')
      : fileData;

    const { data } = await this.client.post(
      `/buckets/${bucketKey}/objects`,
      {
        fileName,
        data: base64Data,
        ...options,
      }
    );
    return data;
  }

  async listFiles(bucketKey: string, options?: {
    search?: string;
    limit?: number;
    cursor?: string;
  }) {
    const { data } = await this.client.get(
      `/buckets/${bucketKey}/objects`,
      { params: options }
    );
    return data;
  }

  async downloadFile(bucketKey: string, objectKey: string, variant?: 'original' | 'markdown') {
    const { data } = await this.client.get(
      `/buckets/${bucketKey}/objects/${objectKey}/download`,
      {
        params: { variant },
        responseType: 'arraybuffer',
      }
    );
    return data;
  }

  async deleteFile(bucketKey: string, objectKey: string) {
    const { data } = await this.client.delete(
      `/buckets/${bucketKey}/objects/${objectKey}`
    );
    return data;
  }
}

// Usage
const client = new FileStorageClient('https://your-domain.com', 'YOUR_API_TOKEN');

// Upload file
const fileBuffer = await fs.promises.readFile('./document.pdf');
const uploadResult = await client.uploadFile('documents', 'document.pdf', fileBuffer, {
  contentType: 'application/pdf',
  metadata: { category: 'invoice' },
});

// List files
const files = await client.listFiles('documents', { search: 'invoice', limit: 10 });

// Download file
const fileData = await client.downloadFile('documents', uploadResult.file.key);
```

---

## Python Client Example

```python
import requests
import base64
from typing import Optional, Dict, Any

class FileStorageClient:
    def __init__(self, base_url: str, api_token: str):
        self.base_url = f"{base_url}/api/client/v1/files"
        self.headers = {
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json"
        }
    
    def list_buckets(self) -> Dict[str, Any]:
        response = requests.get(
            f"{self.base_url}/buckets",
            headers=self.headers
        )
        response.raise_for_status()
        return response.json()
    
    def upload_file(
        self,
        bucket_key: str,
        file_path: str,
        content_type: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        convert_to_markdown: bool = False
    ) -> Dict[str, Any]:
        with open(file_path, 'rb') as f:
            file_data = base64.b64encode(f.read()).decode('utf-8')
        
        payload = {
            "fileName": file_path.split('/')[-1],
            "data": file_data,
            "contentType": content_type,
            "metadata": metadata,
            "convertToMarkdown": convert_to_markdown
        }
        
        response = requests.post(
            f"{self.base_url}/buckets/{bucket_key}/objects",
            headers=self.headers,
            json=payload
        )
        response.raise_for_status()
        return response.json()
    
    def download_file(
        self,
        bucket_key: str,
        object_key: str,
        output_path: str,
        variant: str = 'original'
    ):
        response = requests.get(
            f"{self.base_url}/buckets/{bucket_key}/objects/{object_key}/download",
            headers=self.headers,
            params={"variant": variant}
        )
        response.raise_for_status()
        
        with open(output_path, 'wb') as f:
            f.write(response.content)
    
    def delete_file(self, bucket_key: str, object_key: str) -> Dict[str, Any]:
        response = requests.delete(
            f"{self.base_url}/buckets/{bucket_key}/objects/{object_key}",
            headers=self.headers
        )
        response.raise_for_status()
        return response.json()

# Usage
client = FileStorageClient('https://your-domain.com', 'YOUR_API_TOKEN')

# Upload file
result = client.upload_file(
    bucket_key='documents',
    file_path='./document.pdf',
    content_type='application/pdf',
    metadata={'category': 'invoice'}
)

# Download file
client.download_file('documents', result['file']['key'], './downloaded.pdf')
```

---

## Notes

- All file data must be base64-encoded when uploading
- File keys are automatically generated to ensure uniqueness
- Markdown conversion is asynchronous and may take time for large files
- Download variant `markdown` is only available if the file was uploaded with `convertToMarkdown: true` and conversion completed successfully
- Files are scoped to tenants - you can only access files belonging to your tenant
- Maximum file size depends on your provider configuration and license tier
