# API Reference (Beta)

Base path: `api/v1`

## Authentication

- Current beta routes accept `x-user-email` for actor identity.
- Workspace authorization is enforced server-side per route.

## Workspaces

- `GET /workspaces`
- `POST /workspaces`
- `GET /workspaces/{id}`

## Membership and Sharing

- `GET /workspaces/{id}/members`
- `POST /workspaces/{id}/members`
- `PATCH /workspaces/{id}/members/{userId}`
- `POST /workspaces/{id}/invites`

## Collaboration Events and Activity

- `GET /workspaces/{id}/events`
- `POST /workspaces/{id}/events`
- `GET /activity?workspaceId=...`
- `GET /notifications?workspaceId=...`
- `PATCH /notifications`

## Finding Collaboration

- `GET /findings/{findingId}/comments?workspaceId=...`
- `POST /findings/{findingId}/comments?workspaceId=...`
- `GET /findings/{findingId}/status?workspaceId=...`
- `PATCH /findings/{findingId}/status?workspaceId=...`

## Review Sessions

- `GET /workspaces/{id}/reviews`
- `POST /workspaces/{id}/reviews`
- `GET /workspaces/{id}/reviews/{reviewId}`
- `DELETE /workspaces/{id}/reviews/{reviewId}`
- `POST /workspaces/{id}/reviews/upload-url`

## Role Notes

- Typical create/update routes require `owner/admin/editor`.
- Destructive review deletion requires `owner/admin`.
- Read operations require workspace membership.

## AI Proxy

Separate endpoint:

- `POST /api/ai/generate`

This route resolves provider credentials from server env vars and applies residency checks.
