---
paths:
  - "src/server/lib/dataforseo/**"
  - "src/server/features/dashboard/**"
---

- DataForSEO returns HTTP 200 with an in-body `status_code` for request-level refusals (40203 cost limit, 40210 funds, 40202/40209 rate limits) and still reports a top-level `cost`; only 401/402/404/500 change the HTTP status. An `AppError` thrown after a parsed body does not mean "unbilled" or "ambiguous": use the envelope cost.
- Dashboard caches (`DashboardCacheService`) are keyed by `organizationId` and params, not `projectId`, so one project's paid refresh feeds another project's cached read in the same org.
- Per-project spend design: `docs/maintainers/decisions/2026-10-15-dataforseo-project-ledger.md`.
