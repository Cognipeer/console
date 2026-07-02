# Cluster API

Cluster admin endpoints. All four require an authenticated dashboard session — they are **not** part of the `/api/client/v1` token surface. Both write-side endpoints emit an audit log entry.

The concepts (nodes, queue, instance assignments) are covered in the [Cluster guide](../guide/cluster.md). This page is the request/response reference.

## Overview

```http
GET /api/cluster/overview
```

#### Response

```json
{
  "thisNodeName": "node-a",
  "defaultNodeName": "node-a",
  "nodes": [
    {
      "name": "node-a",
      "role": "all",
      "url": "https://node-a.internal:3000",
      "tags": [],
      "status": "online",
      "lastHeartbeatAt": "2026-05-18T10:00:00.000Z",
      "startedAt": "2026-05-17T22:00:00.000Z",
      "version": "0.1.0",
      "hostname": "ip-10-0-0-1",
      "pid": 1234
    }
  ],
  "assignments": [
    { "entityType": "browser", "entityId": "tenant1:brw_42", "nodeName": "node-b", "mode": "strict", "updatedBy": "u_…", "updatedAt": "…" }
  ]
}
```

## Assignable instances

```http
GET /api/cluster/instances
```

Returns every assignable entity across every tenant, annotated with its current binding (or default fallback).

#### Response

```json
{
  "instances": [
    {
      "entityType": "agent",
      "entityId": "tenant1:research-agent",
      "name": "Research Agent",
      "subtitle": "research-agent",
      "tenantId": "tenant1",
      "tenantSlug": "acme",
      "projectId": "prj_…",
      "nodeName": "node-a",
      "mode": "preferred",
      "explicit": false
    },
    {
      "entityType": "browser",
      "entityId": "tenant1:brw_42",
      "name": "research-browser",
      "subtitle": "brw_42",
      "tenantId": "tenant1",
      "tenantSlug": "acme",
      "projectId": "prj_…",
      "nodeName": "node-b",
      "mode": "strict",
      "explicit": true
    }
  ]
}
```

`explicit: true` means an assignment row exists; `false` means the entity is falling back to the resolved default node.

Entity types: `agent`, `mcp`, `browser`, `inference-server`, `alert-rule`, `automation`.

## Set assignment

```http
PUT /api/cluster/assignments/:entityType/:entityId
```

```json
{
  "nodeName": "node-b",
  "mode": "strict"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `nodeName` | string | yes | Must exist in the cluster registry. |
| `mode` | `strict \| preferred` | no | Defaults to `strict`. |

#### Response

```json
{
  "assignment": { "entityType": "browser", "entityId": "tenant1:brw_42", "nodeName": "node-b", "mode": "strict", "updatedBy": "u_…", "updatedAt": "…" }
}
```

Emits audit event `cluster.assignment.set`.

## Delete assignment

```http
DELETE /api/cluster/assignments/:entityType/:entityId
```

#### Response

```json
{ "removed": true }
```

`removed: false` if no assignment existed. Emits audit event `cluster.assignment.delete` on success.

## Errors

| Status | Cause |
|---|---|
| 400 | Unknown `entityType` or missing `nodeName`. |
| 401 | No session. |
| 500 | Internal error (incl. unknown node — returned with message). |
