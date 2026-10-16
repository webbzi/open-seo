# Per-project DataForSEO spending and limits

Implementation plan, researched 15 October 2026 against repository commit `3d45410f`.

## Goal and scope

We run OpenSEO ourselves on Cloudflare for our agency. Each project represents client work. We need to see the DataForSEO API costs attributable to that project and stop new paid requests when its agreed allowance runs out.

This is about the raw USD charged by our DataForSEO account. Hosted OpenSEO credits, Autumn, platform markup, client invoicing, OpenRouter costs, and Cloudflare infrastructure costs are outside this feature.

The implementation should be small and dependable. Reserve an estimated cost before starting paid work, replace it with the provider-reported cost afterward, and include other requests already in flight when checking a limit. A small difference caused by an estimate or floating-point arithmetic is acceptable. We do not need a financial ledger with exact decimal arithmetic, distributed transactions, or an absolute guarantee against every fraction-of-a-cent overrun.

## Recommended first version

- Show actual recorded DataForSEO spending per project and across the agency.
- Support an optional calendar-month limit and an optional total-project limit, both in USD. When both are set, both apply.
- Allow paid DataForSEO usage to be paused for a project.
- Enforce the same limits in the app, existing MCP tools, background refreshes, website setup research, and scheduled tracking jobs.
- Include estimated costs of requests already in progress when deciding whether another request fits.
- Keep saved results, cached results, free provider lookups, and collection of previously submitted tasks available after a limit is reached.
- Keep existing projects unlimited until we configure their allowances. Record their spending from the feature's activation onward.

Leave daily limits, per-feature quotas, per-user allowances, request-rate limits, email alerts, automatic budget increases, and custom billing periods for later. Monthly and total limits cover recurring retainers and fixed client engagements without a general-purpose quota system.

## What exists today

| Area                       | Current implementation                                                                                                                                                                          | Implication                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Shared client              | `src/server/lib/dataforseo/client.ts` contains `createDataforseoClient`, `meterDataforseoCall`, and `meterDataforseoCalls`.                                                                     | This is the main enforcement point.                                                                                                     |
| Self-hosted execution      | `meterDataforseoCalls` returns directly through `Promise.allSettled` when `isHostedServerAuthMode()` is false.                                                                                  | Self-hosted calls currently skip usage recording and budget enforcement. Replace that branch with project accounting.                   |
| Cost estimates             | `src/server/lib/dataforseo/pricing.ts` provides raw USD estimators for each client operation.                                                                                                   | Reuse them. Today the wrapper immediately converts estimates to hosted credits; retain the raw USD estimate for the self-hosted branch. |
| Actual costs               | `src/server/lib/dataforseo/envelope.ts` defines `DataforseoApiCallCost`, `DataforseoApiResponse`, and `DataforseoChargedTaskError`.                                                             | The client already receives provider-reported costs, including some failed-but-charged calls.                                           |
| Project attribution        | `BillingCustomerContext` in `src/server/billing/subscription.ts` includes optional `projectId`. Most feature services and workflow payloads already provide it.                                 | Require a real, authorized project for application-backed self-hosted paid calls; audit remaining callers.                              |
| Website research exception | `src/server/features/projects/services/websiteResearch.ts` imports raw `fetchLiveSerp`, accumulates costs, and calls `billResearchSpend` afterward. That billing helper skips self-hosted mode. | This path needs explicit coverage. Adding a gate only to the shared client would miss it.                                               |
| Queued work                | Rank checks, AI visibility, and local/business-data tools pay at `task_post`; result collection is exposed separately in `dataforseo/index.ts`.                                                 | Account for submission once. Polling must not consume the allowance a second time.                                                      |
| Final provider costs       | `postRankCheckTasks` documents that submission can charge full depth and completion can report a lower cost after stopping early. AI Overview loading can also be refunded.                     | An initial charge can be provisional. Be clear about this in reporting.                                                                 |
| Provider retry behavior    | `dataforseo/core.ts` can retry upstream 5xx responses. Some paid helpers already disable that, while others use the default. Website research also has its own retry loop.                      | A retry must not silently make multiple paid attempts against one reservation.                                                          |
| Database                   | `src/db/index.ts` selects D1 or Postgres. `src/db/runBatch.ts` uses atomic D1 batches or a Postgres transaction.                                                                                | Use the existing database and batch helper; retain both SQL dialects.                                                                   |
| Scheduler                  | `src/server.ts` runs rank and AI visibility scheduling. Workflows use `withPgClient` / `pgStep` where needed.                                                                                   | Put enforcement at dispatch, so all execution paths share it.                                                                           |
| Settings and permissions   | Project settings use `SettingsTabs.tsx`; `requireOrgPermission` and `billing: ["manage"]` already provide an owner permission.                                                                  | Reuse that permission for changing spending limits. Existing self-hosted delegated auth resolves an owner role.                         |
| Account usage              | `scripts/dataforseo-account-usage.ts` reads the free User Data API.                                                                                                                             | Useful for checking account totals, but it does not provide our project ledger.                                                         |

The current initial project audit sets `lighthouseStrategy: "none"` in `DashboardFirstAuditService.ts`. Do not assume every automatic audit incurs DataForSEO costs: enforce limits where paid provider calls actually occur.

## Provider research

DataForSEO supports daily cost limits at account/API/endpoint level. These remain useful as an overall account safeguard, but they do not express the agency's OpenSEO project agreements. Provider error `40203` represents a provider cost limit, which should remain distinguishable from our own project limit. [DataForSEO error codes](https://docs.dataforseo.com/v3/appendix/errors/)

DataForSEO recommends recording task IDs, tags, and costs locally for project attribution. Its dashboard does not aggregate spending by tag. We should keep `projectId` as an actual database relationship; tags can help reconcile a request, but should not become our project database. [Per-project usage tracking](https://dataforseo.com/help-center/how-to-track-api-usage-with-tag)

Queued SERP charges depend on depth, priority, and optional paid parameters. Completed tasks can expose final costs and refunds. Thus, a free `task_get` can update our record of an earlier charge without representing another paid request. [SERP task submission](https://docs.dataforseo.com/v3/serp/google/organic/task_post/)

The free User Data endpoint provides account usage and base prices, excluding additional paid parameters. Do not call it before each request or treat it as a complete cost estimator. [User Data API](https://docs.dataforseo.com/v3/appendix/user_data/)

The ID List API can help investigate missing responses: it is free, supports task metadata for the previous month, and currently permits 10 calls per minute. Historical project attribution still requires a reliable local task mapping or correlation tag. [ID List API](https://docs.dataforseo.com/v3/appendix/id_list/)

These sources were checked as documentation research. No paid API calls, production database changes, or account configuration changes were made.

## Product rules

### Limits and periods

Use these settings:

| Setting             | Meaning                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Monthly limit       | Maximum recorded and reserved DataForSEO cost in the current UTC calendar month. `null` means unlimited.                                 |
| Total-project limit | Maximum recorded and reserved cost since tracking began for the project, including any explicit opening balance. `null` means unlimited. |
| Pause paid usage    | Refuse new paid requests, regardless of remaining allowance.                                                                             |

Use USD amounts with cents precision for entered limits. Record provider costs at their reported precision using ordinary numbers. A zero limit means no new paid usage; do not confuse zero with an unset limit.

Start with UTC calendar months and display that explicitly. There is no subscription billing cycle in this self-hosted feature. If our agreements require a different calendar, settle that before activation; do not build configurable project time zones into the initial version.

The cost belongs to the month in which its paid request starts. A queued task submitted on 31 October and completed in November remains October usage. A subsequent correction stays in that original month. A request reserved before midnight but dispatched after the month changes must be rechecked for the new month.

Changing a limit does not clear usage. Raising it allows subsequent work immediately. Lowering it below spending already committed blocks new paid requests. Pausing does not cancel requests already sent to DataForSEO. Archiving and restoring a project does not reset its spending.

Limits are ceilings, rather than allocations of the DataForSEO account balance. Two projects can each have a $50 ceiling even if the provider account currently has less than $100. The provider's actual balance and account limits still apply independently.

### What counts

Count raw provider cost from live calls and queued task submissions, including provider-reported charges on failed or empty responses. Include automatic dashboard refreshes and paid tools called by the agent when they belong to a project.

Exclude cache hits, saved data, free metadata lookups, free task collection, OpenRouter/agent-model charges, browser rendering, and our own crawler. Reading a previously paid result must remain possible at zero remaining budget.

Attribute spending to the project that requested the research, including when it researches competitors. Do not derive project attribution from the domain being queried.

### Practical limit behavior

Admission checks `recorded spending + in-flight reservations + this request's estimated cost` against each configured limit. A provider call is refused before dispatch when its estimate does not fit.

For example: a project has a $50 monthly limit, $49.50 recorded usage, and two requests each estimated at $0.20. Both can start. A third $0.20 request is refused while the first two are pending. If they eventually cost $0.15 each, $0.20 becomes available again.

This prevents the ordinary concurrency problem where many requests all see the same remaining budget. It still permits a small overrun if DataForSEO charges more than our estimate. Record the real amount and block further work when the limit is exhausted; never hide the excess by clamping usage to the limit. Reuse and improve existing estimates rather than blocking entire features until a mathematically exact price bound can be proved.

## Minimal data model

Add two tables. Avoid separate wallets, period-counter tables, per-feature budget tables, and a second billing service.

### `project_dataforseo_budgets`

One row per project:

- `projectId`: primary key and foreign key to `projects`.
- `monthlyLimitUsd`: nullable number.
- `totalLimitUsd`: nullable number.
- `paused`: boolean, default false.
- `reservationVersion`: integer, default zero; incrementing this row serializes admissions for that project.
- `createdAt`, `updatedAt`, and nullable `updatedByUserId` for settings changes.

Create an unlimited row for existing projects and initialize one during project creation. Keep a cheap idempotent initialization fallback for the automatically created Default project and existing creation paths.

Use a numeric column suited to ordinary USD arithmetic: SQLite `real`, Postgres `double precision`. Validate input as finite and nonnegative with Zod. No `BigInt`, nanodollars, decimal library, or currency conversion.

### `project_dataforseo_usage`

One row per paid HTTP attempt, created before dispatch and updated afterward. An optional opening-balance import can also create explicitly labeled opening entries:

- `id`: server-generated request ID; primary key and settlement idempotency key.
- `projectId`: indexed foreign key to `projects`.
- `feature`: reuse the existing feature categories where applicable.
- `operation`: a short operation/endpoint label.
- `runId`: optional existing workflow/run identifier for investigation.
- `actorUserId`: nullable; scheduled work uses the existing system actor convention.
- `startedAt`: UTC timestamp, indexed with `projectId` for month queries.
- `estimatedCostUsd`: reservation amount.
- `costUsd`: nullable provider cost; also populated for explicitly estimated recovery entries.
- `status`: `reserved`, `started`, `completed`, `released`, or `estimated`.
- `expiresAt`: reservation recovery deadline.
- `completedAt`: nullable timestamp.

`reserved` and `started` contribute their estimate to in-flight spending. `completed` contributes `costUsd`. `estimated` contributes its conservative fallback amount and is visibly labeled as estimated. `released` contributes zero.

Store only the metadata needed to understand usage. Do not store full provider responses, prompts, API credentials, or request parameter blobs here. Existing features and persisted workflow-step results remain responsible for provider results and queued task IDs. An opening entry uses an explicit `opening_balance` operation label, so reports can distinguish it from provider-reported spending.

Calculate totals from this table with indexed SQL aggregates. At agency scale, this is simpler than maintaining synchronized month, lifetime, and feature counters. Compute the dashboard's project totals with grouped queries, avoiding a query per project. Add materialized counters only if actual query performance requires them.

Add both SQLite and Postgres schema definitions and migrations, plus schema-barrel exports and parity-test registration. Follow existing foreign-key cleanup conventions. Archive keeps history; actual project deletion follows the repository's deletion policy.

## Shared request flow

### 1. Keep the raw estimate

Change the internal metering wrapper in `dataforseo/client.ts` to carry raw USD estimates through to `meterDataforseoCalls`.

- Hosted mode continues converting them through `creditsForProviderUsd` and using the existing Autumn path.
- Self-hosted mode passes raw estimates into the project budget service.

Do not apply the hosted markup or round each self-hosted cost up to a whole hosted credit.

### 2. Reserve atomically

Add `ProjectDataforseoBudgetService` and a small repository under `src/server/features/projects/`. The service accepts an authorized organization/project, request ID, estimates, and operation metadata.

For admission, use `runBatch`:

1. Update the project's budget row with `reservationVersion = reservationVersion + 1`, scoped through its owning organization. This obtains a project row lock for the Postgres transaction; D1 executes the batch atomically.
2. Insert the reservation with `INSERT ... SELECT ... WHERE` conditions that check the current pause setting and the summed usage/reservations against both limits. The conditions must live inside SQL, after the lock, rather than in an earlier JavaScript read.
3. Read the reservation by its stable ID after the batch. Its presence identifies admission. If it was not inserted, obtain the current summary and return the appropriate project-limit error.

Use conflict-safe insertion for the request ID. Do not replay a provider request just because its reservation already exists. A duplicate in-progress invocation should be treated as already running; existing workflow persistence handles returning completed feature results.

If the budget lookup or reservation write fails, do not send the paid request. Surface the normal infrastructure error; a database failure must not be presented as an exhausted allowance. Missing project context is an implementation error, rather than permission to spend without attribution.

The row lock is held only for this short database operation. Release it before contacting DataForSEO. All project admissions use this same lock order. Changing a budget also updates this row, so a limit edit cannot race past an unrelated stale settings read.

Cloudflare documents atomic ordered batches, including rollback on failure. The existing helper maps those semantics to a Postgres transaction. Note that a conditional insert affecting zero rows is a normal refusal, not a transaction failure. [D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/)

Do not introduce a new transaction framework. `runBatch` currently returns `void`; the subsequent reservation lookup avoids changing that interface. Construct statements from the helper's supplied transaction handle, as its documentation requires.

### 3. Dispatch and finish

Before sending the paid request, atomically transition its row from `reserved` to `started` and set its started-call recovery deadline. Only the invocation that successfully claims that transition can dispatch it. If its month has changed, release it and reserve again against the current month. A pause or limit reduction applies to later admissions; a request already reserved can finish.

Then execute the provider request and update the same usage row:

- Success with valid billing metadata: `completed`, with the actual raw USD cost.
- Failed task with a known provider charge: `completed`, with that charge, then surface the feature error.
- Confirmed unbilled failure: `released`.
- Ambiguous timeout, disconnect, missing billing metadata, or worker termination: keep the reservation until recovery; do not infer zero cost from an HTTP failure.

The state and cost change in one SQL update, so an admission never observes a gap between releasing the estimate and recording the actual cost. Updates use the request/project ID and expected state so duplicate completion does not add spending twice.

Register the provider call plus settlement with `waitUntil`, following the existing client pattern, and await it normally. If persistence fails after the provider has returned data, log the request/project IDs and leave the reservation in place. Do not discard useful results or call DataForSEO again to recover a missing accounting write.

### 4. Recover abandoned reservations simply

Use a short deadline for reservations never dispatched, for example five minutes, and a longer one for started calls, for example thirty minutes. Check expired rows during the next admission or usage-summary read:

- An expired `reserved` row becomes `released`; it never claimed permission to dispatch.
- An expired `started` row becomes `estimated`, using the already reserved amount as its recorded fallback cost.

Use guarded state changes so cleanup and dispatch cannot both win. This avoids both permanently locked budgets and silently forgetting a possibly paid request. If a late provider result arrives, replace the fallback amount with its actual cost. Show estimated recovery amounts separately in reporting.

This needs no new cron, queue, outbox, or reconciliation daemon. Unknown costs should be rare enough to investigate with the existing logs and provider tooling. The normal path remains reserve, call, update.

### 5. Keep retries and batches understandable

For self-hosted paid operations, disable hidden transport retries on ambiguous 5xx responses. Retry free GET/polling operations as today. If feature code intentionally retries a paid operation, that attempt obtains its own reservation and usage row. Audit the website research retry loop as well as `core.ts` defaults.

For existing live batches, reserve the sum of raw estimates and create one usage row per paid HTTP call. Use one conditional multi-row insert guarded by the whole batch estimate, so the batch is admitted together or refused together. A series of independent conditional inserts would leave partially reserved batches. Settle each row independently afterward. Keep hosted batch admission behavior unchanged.

A queued `task_post` HTTP request gets one reservation and one usage row for its returned aggregate charge. A partially accepted provider batch still records every charge that the provider reports. Never count the response's overall total and its task totals twice.

## Coverage that must ship with enforcement

| Path                                                   | Change                                                                                                                                                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keyword, domain, backlinks, local SEO, and AI research | Shared client handles recording and refusal. Check caller project context and any catch blocks that turn an error into empty data.                                                                       |
| Dashboard/background refresh                           | Cached data stays readable. A denied paid refresh does not erase the cache or repeatedly retry on every render. Show the budget reason where refresh status is visible.                                  |
| Website setup research                                 | In self-hosted mode, route live SERP searches through the shared client. Preserve the existing hosted admitted-research behavior. `billResearchSpend` must not also record self-hosted DataForSEO usage. |
| Rank tracking                                          | Include project context and run ID for manual/live and scheduled/queued paths. Live-to-queue or queue-to-live fallback needs a fresh reservation for each new paid attempt.                              |
| AI visibility                                          | Apply the same rule to manual answers, queued answers, and fallback requests. Free collection remains available.                                                                                         |
| Local grids and business reviews/updates               | Record task submission; do not gate result polling as another paid operation.                                                                                                                            |
| Site audits                                            | Meter DataForSEO Lighthouse calls. A denied Lighthouse call should produce a skipped/limited performance result while keeping completed crawl results. The crawler itself is outside this allowance.     |
| Agent and MCP                                          | Existing tools use the same client and authorized project context. An agent cannot bypass a limit by issuing several concurrent calls or choosing another route.                                         |

Pay particular attention to parsing errors after a charged response arrives. Some fetchers parse feature data before returning their billing envelope. Preserve known cost through `DataforseoChargedTaskError`, or record an estimated recovery amount, rather than releasing the reservation because feature parsing failed.

Keep legitimate free operations outside the paid gate: provider locations/languages/categories/models, saved/cached data, and queued result collection. Raw paid imports outside the client need review; current research is the known exception. Schema/type imports from provider modules are not paid-call bypasses.

### Queued final-cost adjustments

For the first version, record the actual amount reported at submission. Label queued usage as the cost reported when posted; later provider refunds can make this conservative. The difference depends on the workload and can be meaningful for deep rank checks that stop early. This matches the information the current shared client already receives, but it is not an exact final provider statement.

Do not delay the whole feature to build automatic refund reconciliation. Once the basic tracking and limits work, add final-cost updates for queued rank/AI tasks if those refunds materially affect our monthly reports. That follow-up would persist the original usage-row ID and each task's posted/final cost, then update the parent usage row by the difference once per task. Some queued IDs currently live in workflow-step results, so do not assume a task-cost table already exists. Collection still incurs no new spend.

Preserve existing task tags: rank tasks encode keyword/device, Maps tasks encode a grid index, and AI tracking uses caller-provided tags. Do not overwrite those tags with a project ID and break result mapping. Any later correlation tag change must update its producer and parser together.

## App and MCP behavior

### Project spending page

Add an `API spending` tab under project settings, backed by TanStack server functions, the service, and the repository.

Show:

- This month's recorded cost and monthly limit.
- Total recorded project cost and total-project limit.
- In-flight reserved cost and the amount available for new work.
- Any estimated recovery cost, separately labeled.
- A simple feature breakdown and paginated recent usage: time, operation, cost, and status.
- Tracking start date, UTC month boundaries, and whether usage is paused or unlimited.

Owners can change the two limits or pause/resume paid API usage. Reuse `billing: ["manage"]` for mutation authorization and existing membership/project access checks for reads. General project-edit access must not implicitly allow changing the client's spending agreement.

The app currently sends only bare error codes through `toClientError`, so do not assume `AppError.details` will reach the browser. Use the summary query to populate amounts, the limiting allowance, and the next month boundary.

Add project-budget fields to creation where useful, persisting the budget before any paid setup work starts. Existing projects remain unlimited until configured. An explicitly chosen unlimited setting should be visible in the agency overview.

### Agency overview

Add one page/table across the current organization's projects:

| Project  | This month | Monthly limit | Total  | Total limit | In progress | Status                |
| -------- | ---------- | ------------- | ------ | ----------- | ----------- | --------------------- |
| Client A | $18.42     | $25.00        | $71.30 | Unlimited   | $0.08       | Available             |
| Client B | $40.00     | $40.00        | $94.22 | $150.00     | $0.00       | Monthly limit reached |
| Client C | $4.11      | Unlimited     | $4.11  | $30.00      | $0.00       | Paused                |

Use the same service aggregates as the project page. Include archived projects in historical agency spending, with an archive label/filter. Add a basic date-range CSV export so we can review project API expenses alongside client agreements. Export recorded and estimated amounts distinctly.

Avoid charts and forecast dashboards in the initial version. The table, feature breakdown, and recent usage answer the agency's immediate questions.

### Refusals

Add `PROJECT_BUDGET_EXCEEDED` and `PROJECT_DATAFORSEO_PAUSED` to shared error codes and user-facing copy. Treat these as expected user conditions, not internal exceptions or hosted upgrade prompts.

Suggested app copy: "This project's DataForSEO allowance has been reached. Review API spending in project settings."

Existing MCP tools should return a clear project-specific refusal and explain that retrying the same paid operation will not help until the allowance resets, increases, or usage resumes. Do not tell the agent to bypass the setting, change budgets automatically, or purchase OpenSEO credits. No new MCP tools are needed for the first version.

### Schedules and partial results

Record a distinct project-budget/paused skip reason in rank and AI visibility state. Advance schedules through their existing claim logic so a blocked project does not stay due and crowd out other clients. Show the skip reason in existing status surfaces. Do not automatically disable the schedule or replay every missed run when the budget resets.

Already submitted tasks continue collecting. A multi-step run can retain partial results if a later paid operation is refused. Prevent fallback loops from interpreting a project refusal as a provider failure and issuing another paid attempt.

## Existing spending and deployment

We cannot reliably reconstruct historical project costs from account-wide totals or queried domains. Shared competitors and keywords make that attribution ambiguous.

Start recording on deployment and show that start date. For a client already partway through an agreed allowance, initialize a clearly labeled opening-balance entry from a figure we know, or configure the remaining allowance for the initial period. Do not label inferred historical data as provider-verified costs. A small one-time import using the same usage table is sufficient if we need opening balances; no separate import product is needed.

Deploy additively:

1. Add both database schemas/migrations and start tracking with unlimited defaults. Verify attribution and compare a short sample against provider task costs.
2. Enable configured caps only after all paid paths above are covered. Configure the agency's actual project limits.
3. Add the project settings UI and agency overview in the same delivery, so we can inspect a refusal and change an allowance ourselves.

An old in-flight workflow may complete around deployment. Prefer activating limits once those pre-feature runs finish; otherwise accept and document that their pre-feature spending is outside the new ledger. There is no need for a workflow-version migration system.

Use the deployment's existing Wrangler setup and migration commands; this repository already has Wrangler configuration. Do not migrate the Cloudflare deployment or add another storage service for this feature.

## Implementation slices and files

### 1. Budget storage and aggregate service

- Add `src/db/project-dataforseo.schema.ts` and `src/db/pg/project-dataforseo.schema.ts`, schema exports, migrations, and parity coverage.
- Add a focused repository and `ProjectDataforseoBudgetService` under the projects feature.
- Implement settings, grouped spending summaries, atomic reservation, settlement, and lazy expiry recovery.
- Initialize unlimited budget rows through project creation and the Default-project fallback.

Acceptance: a real SQL-backed check proves concurrent admissions cannot both consume the same remaining allowance. Month and total sums include reservations and follow their documented date boundaries.

### 2. Shared client and all paid paths

- Update `src/server/lib/dataforseo/client.ts` to retain raw estimates and run self-hosted project admission/settlement.
- Reuse `pricing.ts`, existing feature classification, and charged-error envelopes.
- Route self-hosted searches in `websiteResearch.ts` through the client.
- Audit paid transport retries in `core.ts` and the endpoint modules; make self-hosted paid attempts individually visible.
- Pass verified project context and run IDs from workflows/services. Keep free collection outside admission.
- Review error-catching wrappers for partial results, cached data, and fallbacks.

Acceptance: representative app, MCP, website-research, Lighthouse, and scheduled calls all record raw cost and cannot dispatch when the project is denied. Hosted behavior still uses its existing credit calculations and holds.

### 3. Settings, agency reporting, and job messages

- Add `src/serverFunctions/projectDataforseoBudgets.ts`, project/organization-scoped validators, and query hooks.
- Extend `src/client/features/projects/SettingsTabs.tsx` and add the project spending route/component.
- Add the agency spending table and simple CSV export from the same grouped query.
- Update `src/shared/error-codes.ts`, `src/client/lib/error-messages.ts`, `src/server/mcp/tool-error-message.ts`, and scheduled skip-reason displays.
- Add optional limit inputs to project creation if that is the easiest place for our agency to set agreements.

Acceptance: we can configure Client A's allowance, see its recorded/pending spending, trigger a refusal, and inspect Client B without its totals or access being affected.

### 4. Optional follow-up after real usage

Automate queued-task refund adjustments if the difference between submission charges and final costs matters in our reports. Consider warning emails, daily limits, or richer exports only after we find a practical need.

No new shipped skills or MCP tools are required, so the core implementation does not require a plugin version bump. If a later change adds dedicated budget MCP tools, follow the repository's normal plugin-version and local-MCP verification rules.

## Verification

Write a small set of behavioral tests at the service/client entry points. Apply the repository's `test-audit` guidance when implementing them.

1. **Project isolation:** spending/limits for one project do not affect another; foreign-organization reads and mutations fail; non-owners cannot raise limits.
2. **Concurrent admission:** two requests competing for insufficient remaining allowance cannot both dispatch. Run this against actual SQLite/D1-compatible SQL and Postgres, not mocked ORM chains. A schema-parity test alone does not prove concurrency.
3. **Money and settings:** raw cost is recorded without hosted markup; unset and zero limits differ; monthly and total limits both apply; lowering a limit preserves spending; month rollover is correct.
4. **Settlement:** success and failed-but-charged responses record actual cost; confirmed unbilled failures release; duplicate settlement is harmless; abandoned started calls become visibly estimated rather than disappearing.
5. **Coverage:** self-hosted website research is gated; paid retry/fallback attempts reserve separately; free polling/cache reads work at zero remaining allowance; a queued batch's cost is recorded once.
6. **User behavior:** the app/MCP show a project-limit reason; scheduled runs avoid retry loops and preserve partial results; hosted client billing remains unchanged.

Use a few focused integration scenarios that cover several of these rules together. Do not create a test for every field, status literal, or formatting branch.

Run the targeted tests, schema parity, `pnpm types:check`, and lint for the implementation. Before shipping, perform one small, controlled end-to-end run on a development project with a low cap, verify the usage row against the provider-reported amount, then confirm that another operation is refused. Keep any paid verification within that development project's small allowance.

## Boundaries and choices

This feature controls paid requests sent through this OpenSEO deployment. Scripts or other applications using the same DataForSEO credentials can spend outside its project limits. Keep DataForSEO's account-level cap as an independent safety net; do not try to make our project table police every external use of the credentials.

The first version reports provider submission charges and conservatively estimated recovery costs. Automatic refund reconciliation and exact provider statement matching are follow-ups. Normal usage should still show actual returned costs and practical, enforceable project ceilings.

Choose the existing SQL database, two tables, ordinary USD numbers, indexed aggregates, and one shared reserve/call/update path. Introduce more accounting infrastructure only when actual agency usage demonstrates a need.
