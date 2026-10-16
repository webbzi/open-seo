# Umami analytics integration

## Status

Proposed (2026-10-16). The connection lifecycle and Integrations UI ship
first; the reporting service, the two MCP tools and the dashboard card follow
on the same design.

## Context

Some self-hosted operators measure their sites with Umami rather than Google
Analytics, typically one Umami instance shared by every project they manage.
OpenSEO should read a project's Umami website the way it reads a GA4 property:
a per-project mapping, a dashboard card, and read-only agent tools. SAM chat is
out of scope.

Umami v3.4.0 added account API keys for self-hosted instances
(`Authorization: Bearer umami_…`). They do not expire and can be revoked, and
they are disabled in Cloud mode. Earlier versions offer only username/password
login tokens. Umami Cloud has its own API keys at api.umami.is, which use a
different endpoint and authentication scheme. The API has no version endpoint. It answers 401 both
for a bad key and for a website the key cannot read. Umami websites have no
time zone setting.

## Decision

### Deployment-level credential

`UMAMI_API_URL` and `UMAMI_API_KEY` are deployment configuration, read through
the runtime environment helpers. The URL is the instance URL (an origin, plus
the instance's base path when Umami is served under one); requests go to
`{url}/api/...`. It must be `https`, except plain `http` for `localhost` or
`127.0.0.1`, and it may not carry credentials, a query or a fragment. The key
must be an account API key (the `umami_` prefix): a login token would expire
and is not supported.

Umami is "configured" only when both values are present and valid. An
unconfigured deployment, which includes hosted OpenSEO, shows no Umami
dashboard card, and its Umami MCP tools answer `umami_not_configured`. The
Integrations page shows one line
of setup guidance with a link to the self-hosting guide. The Docker preflight
and the health endpoint apply the same validation and warn when only one value
is set or a value is invalid.

Only Umami v3.4+ is supported: there is no login/password flow and no
v2 response shapes.

### Project mapping

`umami_connections` has matching SQLite and Postgres definitions:

- `id`, `project_id` (unique, cascades with the project) and `organization_id`
  (cascades with the organization);
- `website_id`, `website_name` and `website_domain` (nullable, as in Umami);
- `time_zone`, an IANA zone; and
- created and updated timestamps.

There is no user column and no secret column. The mapping belongs to the
project and organization, not to the member who chose the website. Every read
and write is keyed by both project and organization. Merging legacy
workspaces re-parents mappings like the other integration mappings.

### Selecting a website

Listing websites, selecting one and disconnecting all require the
`integration: manage` organization permission; any project member can read the
connection state. The client submits only `websiteId` (a UUID) and `timeZone`.
The service runs a fresh, fully paginated
`GET /api/websites?includeTeams=true` and accepts the website only if it is in
that response; the stored name and domain come from the response, never from
the client. Pagination follows `count` and the page size Umami applied, with a
defensive page cap, and de-duplicates rows that offset paging can repeat.

`includeTeams` lists the key user's own websites plus those of teams where the
user is an owner or manager. Websites visible only through a team member or
view-only role are not offered.

### Time zone and date ranges

The browser's resolved IANA zone is captured when the website is selected and
validated with `Intl`; UTC offsets such as `+02:00` are rejected because they
are not zones and drift across DST. Saving the same website again refreshes it.

Report date ranges are inclusive `YYYY-MM-DD` dates in that zone, converted to
Umami's `startAt`/`endAt` milliseconds at local midnights (DST-correct, without
a new date library). The zone is also passed as Umami's `timezone` for
bucketing. The default range is the last 28 complete days; an end date after
yesterday is clamped to yesterday with an `end_date_clamped` warning.

### HTTP client

Requests send `Authorization: Bearer`, refuse redirects (a redirect could carry
the key to another host), use a timeout, and validate every 2xx response with
Zod. Errors map to stable codes:

| Upstream outcome            | Code                         | Retryable             |
| --------------------------- | ---------------------------- | --------------------- |
| 401 or 403                  | `umami_unauthorized`         | no                    |
| 404                         | `umami_website_not_found`    | no                    |
| 429                         | `umami_rate_limited`         | yes, with Retry-After |
| 5xx, network error, timeout | `umami_upstream_unavailable` | yes                   |
| 400 and other 4xx           | `umami_bad_request`          | no                    |
| 2xx failing validation      | `umami_malformed_response`   | no                    |

Adapter-level codes are `umami_not_configured`, `umami_not_connected` (with
the Integrations URL) and `validation_error`. Messages
never carry the key, the raw upstream body or the instance URL. In the app,
these codes become the standard client error codes; a rejected key gets its
own code so the operator sees which variable to check.

A single website lookup treats a `null` body or a website with a deletion
date as `umami_website_not_found`: Umami answers an admin key that way for an
unknown or deleted website. A 2xx body that is not JSON is
`umami_malformed_response`, never a `null` body. Website ids are validated as
UUIDs before any request, because Umami answers a malformed id with a bodiless 500.

### Reports

Every report first looks up the mapped website (see above), then reads Umami
with explicit time windows. The previous period is a second `/stats` request
over the equal-length window before the current one, not Umami's
`compare=prev`, so it stays exact across DST changes. The daily trend comes
from `/pageviews` with `unit=day` and the connection's `timezone`; Umami
omits days without data and labels each bucket with its local date, so the
service fills missing days with zero. Zero-fill applies only to these daily
buckets. Its per-day count is `visitors` (Umami counts distinct sessions), not
visits. Umami silently replaces `unit=day` with months once a range spans more
than about seven calendar months, so for ranges over 184 days the service
skips `/pageviews`, returns an empty trend and adds the
`trend_omitted_range_too_long` warning; totals, comparison and channels are
kept. Rates are `null` when their denominator is 0, and a percent change is
`null` when the previous value is 0 or absent. The channel mix comes from
`/metrics/expanded?type=channel` and reports real visits per Umami channel key,
such as `organicSearch`, `direct` or `paidAds`.

Breakdowns read `/metrics/expanded`, fetching one row beyond the page size to
set `hasMore`, because Umami returns no total. Umami hard-codes `bounces` and
`totaltime` to 0 for page-level types, so those two columns are `null` for
`page`, `landing_page`, `exit_page`, `page_title`, `referrer_domain`,
`utm_source`, `utm_medium`, `utm_campaign` and `hostname`. They are real
values for `channel`, `country`, `device`, `browser`, `os` and `language`.
They are `null` for `event` too, because Umami reuses the fields there:
event occurrences are reported as pageviews, single-event visits as bounces
and the occurrence span as total time. For `event`, the pageviews column
counts event occurrences. Counts may arrive as strings and are coerced.

`search_engines` sends the filter `referrer=re.(<search domains>)` over
Umami's own search-engine domain list. Umami matches the filter against each
pageview's own referrer domain, not a session's first referrer. That is right
for landing pages, but on `page` it would drop internal navigation pages, so
the combination is accepted only with `landing_page` and any other dimension
is a `validation_error` before any request. Referrer domains are stored
without `www.`.

### MCP tools

Two read-only, project-scoped tools are registered unconditionally; on a
deployment without Umami they answer `umami_not_configured` with the
Integrations URL:

- `get_umami_overview`: totals with Umami's previous-period comparison, a
  daily trend and the channel mix.
- `get_umami_breakdown`: a fixed `dimension` enum, `limit`/`offset`, and
  `source: all | search_engines`.

Both use the GA4-style envelope with `source.provider = "umami"`. A metric
Umami does not compute for a dimension is `null`, never `0`.
`search_engines` is a referrer filter over Umami's own search-engine domain
list; the input and output describe it as an approximation that includes
paid-search clicks. Tools accept a `projectId` and cannot list or change the
mapping.

### Dashboard

`UmamiCard` appears only when the project is connected and has no dismissal
state. The Google Analytics connect nudge is hidden while Umami is connected.

## Alternatives considered

**A per-project or per-organization credential.** Each organization would
store an instance URL and an API key (or password), encrypted at rest. It
supports several Umami instances, but adds a secret store and turns the
user-supplied URL into an SSRF surface that needs its own validation. One
operator with one instance gains nothing from it. An operator-set URL counts
as a fixed provider URL.

**Username/password login.** It would support Umami before v3.4, but brings
the login-token lifecycle (expiry, refresh, a stored password) for versions
that are being replaced.

**Listing team websites through each team.** Walking the key user's teams
would also offer websites visible through member and view-only roles. It
costs a request per team and diverges from the single listing that also
defines what may be selected. The self-hosting guide explains the role the
key's user needs instead.

**Taking the time zone from Umami.** Umami websites have none, and an
instance-wide default would misplace day boundaries for projects in other
zones. Capturing the selecting member's zone is explicit and editable.

## Consequences

- Every organization on the deployment can map any website the key can read,
  gated only by `integration: manage`. The operator limits this by issuing the
  key from a dedicated non-admin Umami user that sees only the intended
  websites; the self-hosting guide says so. The reason is least privilege: an
  admin key can read and delete every website on the instance.
- Umami older than v3.4 and Umami Cloud are unsupported.
- Organic search is approximated by referrer, because Umami cannot filter by
  channel.

## Revisit when

A second Umami instance, or a client-hosted Umami, must be connected. The
model then moves to a per-organization credential with an encrypted key and an
SSRF-validated URL.
