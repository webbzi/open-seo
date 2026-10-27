---
status: active
superseded_by:
date: 2026-10-16
branch: feat/umami-connection
revisit_on: a second Umami instance, or a client-hosted Umami, must be connected
---

## Context

The owner wants Umami as a per-project analytics source, like GA4. They run one self-hosted Umami instance for every project on this OpenSEO deployment. First version surfaces: per-project connection, a dashboard card, and MCP tools. Sam chat is out of scope.

Umami v3.4.0 (2026-09-17) added account API keys for self-hosted instances (`Authorization: Bearer umami_…`). They do not expire and can be revoked. Older instances (v2, v3.0 to v3.3) offer only username/password login tokens. The API has no version endpoint, and it answers 401 both for a bad token and for a website the key cannot read. There is no time zone setting on a website.

## Options

1. Per-project or per-org credential in the database: instance URL plus API key or password, encrypted at rest. This brings an SSRF surface for the user-supplied URL and a new secret store.
2. Deployment-level credential: `UMAMI_API_URL` and `UMAMI_API_KEY` as Worker env/secrets. Projects only choose a website.

## Choice

Option 2.

- **Config.** `UMAMI_API_URL` is the instance origin; the client calls `${origin}/api/...`. It must be `https:`, except `http://localhost` or `http://127.0.0.1` for local dev. `UMAMI_API_KEY` is a Umami v3.4+ account API key. Read both through the runtime env helpers. The feature is "configured" only when both are present and valid. Unconfigured deployments, including hosted, show no Umami dashboard card and register no Umami MCP tools. The Integrations page shows setup guidance instead.
- **Supported versions.** Umami v3.4+ only: no login/password flow and no v2 shapes.
- **Mapping.** `umami_connections` has matching SQLite and Postgres definitions. Columns: `id`; `project_id` (unique, FK cascade); `organization_id` (FK cascade); `website_id`; `website_name`; `website_domain`; `time_zone` (IANA); `created_at`; `updated_at`. There is no user column and no secret column.
- **Selecting a website.** The client submits only `websiteId` and `timeZone`. The service checks that `websiteId` appears in a fresh paginated `GET /api/websites?includeTeams=true` and copies name and domain from that response. Listing, selecting and disconnecting all require `integration: manage`.
- **Time zone.** The browser's resolved IANA zone is captured when the website is selected and validated with `Intl`. Date ranges are inclusive `YYYY-MM-DD` dates in that zone, converted to `startAt`/`endAt` ms at local midnights (DST-correct, no new date library). `timezone` is also passed for buckets. The default range is the last 28 complete days, and the end date is clamped to yesterday with an `end_date_clamped` warning.
- **HTTP client.** Requests send `Authorization: Bearer`, use `redirect: "error"` and a timeout, and validate every 2xx response with Zod. Error codes:

  | Status                | Code                         | Retryable             |
  | --------------------- | ---------------------------- | --------------------- |
  | 401/403               | `umami_unauthorized`         |                       |
  | 404                   | `umami_website_not_found`    |                       |
  | 429                   | `umami_rate_limited`         | yes, with Retry-After |
  | 5xx, network, timeout | `umami_upstream_unavailable` | yes                   |
  | 400                   | `umami_bad_request`          |                       |
  | schema failure        | `umami_malformed_response`   |                       |

  Adapter-level codes are `umami_not_configured`, `umami_not_connected` (with the Integrations URL), `validation_error` and `project_forbidden`. Messages never carry the key, the raw upstream body or the instance URL.

- **MCP tools.** Two read-only tools, registered only when Umami is configured:
  - `get_umami_overview`: totals with Umami's previous-period comparison, a daily trend and the channel mix.
  - `get_umami_breakdown`: a fixed `dimension` enum, `limit`/`offset`, and `source: all | search_engines`.
  - Both use the GA4-style envelope with `source.provider = "umami"`.
  - `search_engines` is a referrer filter over Umami's own search-engine domain list. It is described in the input and output as an approximation that includes paid-search clicks.
  - A metric Umami does not compute for a dimension is `null`, never `0`.
- **Dashboard.** `UmamiCard` shows only when the project is connected, with no dismissal state. The GA4 connect nudge is hidden while Umami is connected.
- **Plugin.** Patch bump for the new MCP tools.

## Why

There is one instance and one operator. Keeping the secret in Worker secrets removes the encrypted-secret table and the SSRF surface for a user-supplied URL; the operator-set URL counts as a fixed provider URL. It also avoids the login-token lifecycle. Projects still map websites independently, as GA4 maps properties.

## Cost accepted

- Every organization on the deployment can map any website the key can read, gated only by `integration: manage`. The operator limits this by issuing the key from a dedicated Umami user that sees only the intended websites/teams. The self-hosting doc says so.
- Umami older than v3.4 is unsupported.
- Organic search is approximated by referrer, because Umami cannot filter by channel.

## Revisit when

A second Umami instance, or a client-hosted Umami, must be connected. The model then moves to a per-org credential with an encrypted key and an SSRF-validated URL.
