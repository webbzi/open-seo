---
paths:
  - "src/server/lib/umamiClient.ts"
  - "src/server/lib/umamiClient.test.ts"
  - "src/server/features/umami/**"
  - "src/server/mcp/tools/umami-tools.test.ts"
  - "docs/SELF_HOSTING_UMAMI.md"
---

- Integration shape: `docs/maintainers/decisions/2026-10-16-umami-integration-shape.md`.
- `GET /api/websites?includeTeams=true` returns only the user's own websites plus websites of teams where the user is team-owner or team-manager. Team member and view-only users can read a website's stats but never see it in this list. `website.domain` is nullable.
- Umami 3.4 answers an admin API key with 200, all-zero stats and a null body from `/api/websites/{id}` for an unknown or deleted website; only non-admin keys get 401. A malformed website id gets a bodiless 500, so ids are validated before any request.
- `/metrics/expanded` returns some counts as strings on Postgres (coerce them). `bounces` and `totaltime` are hard-coded 0 for path, entry, exit, title, referrer, utm and hostname types; the `event` type reuses pageviews/bounces/totaltime for occurrences, single-event visits and span.
- `type=channel` ignores `limit` and `offset` (it returns every channel), so channel rows are paged locally.
- The `/pageviews` sessions series and `/metrics` counts are visitors, not visits; real visits come only from `/metrics/expanded`.
- `unit=day` silently becomes monthly buckets once a range spans more than about 7 calendar months, with no error; the service skips the daily trend above 184 days.
- Filters are `<op>.<value>`, e.g. `referrer=re.(...)`; the `s.` prefix answers 500. A referrer filter matches each pageview's own referrer, not the session's first. utm metric types are camelCase (`utmSource`).
- Fixtures and e2e seed data must give pageviews, visits and visitors distinct values: equal values hid a visits-vs-visitors mixup that the tests and the live e2e both passed.
