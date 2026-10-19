---
status: active
superseded_by:
date: 2026-10-15
branch: feat/dataforseo-project-budgets
revisit_on: after the first month of real agency usage with caps enabled
---

## Context

The owner's plan (`dataforseo-project-budgets.md`, repo root, untracked) asks for per-project DataForSEO spend tracking and monthly/total USD caps in self-hosted mode: reserve an estimate before a paid call, replace it with the provider-reported cost afterwards, count in-flight estimates at admission. Hosted mode (Autumn credits) is unchanged. The plan proposes `reserved -> started -> completed|released|estimated` states, expiry deadlines with lazy cleanup writes, a migration backfill plus creation hooks for budget rows, and disabling transport retries for self-hosted paid calls.

## Options

1. The plan as written: five statuses, `expiresAt`, two-step reserve/claim, cleanup writes, backfill + creation-path hooks.
2. Same product rules, smaller state machine (below).

## Choice

Option 2. The product rules of the plan stand unchanged; only the mechanics shrink:

- Usage row statuses are `pending`, `completed`, `released`. Admission inserts rows directly as `pending` with `startedAt = now` and a fresh `crypto.randomUUID()` id per paid HTTP call. No `reserved` state, no claim step, no month-rollover recheck: admission and dispatch are the same instant in the same invocation.
- "Estimated" is derived, not written: a `pending` row older than 30 minutes is reported as an estimated (unsettled) amount. Admission arithmetic is identical either way (pending counts its estimate). A late settlement still lands because it is guarded on `status = 'pending'`. No `expiresAt`, no cleanup writes.
- Committed spend = sum(pending.estimatedCostUsd) + sum(completed.costUsd). Admission refuses when paused, or when for any configured limit `committed >= limit` or `committed + batchEstimate > limit`.
- Admission is one `runBatch`: (1) ensure the budget row exists (`INSERT ... SELECT FROM projects WHERE id AND organizationId ... ON CONFLICT DO NOTHING`), (2) `UPDATE ... reservationVersion + 1` as the per-project lock, (3) conditional insert of the batch's rows; extra rows beyond D1's ~100-bound-parameter cap go in follow-on statements in the same batch conditioned on the first row's existence. Read back by id afterwards. No backfill, no project-creation hook: a missing row means unlimited and not configured.
- Settlement for one metered invocation is one `runBatch` of guarded UPDATEs (`id`, `projectId`, `status = 'pending'`). Known charge (success, `DataforseoChargedTaskError`, or any parsed response's top-level `cost`, which covers HTTP-200 request-level refusals like 40203/40210 and billed parse failures) -> `completed`; nothing sent or HTTP 4xx -> `released`; anything ambiguous (transport, timeout, 5xx, unreadable body) -> no write, so it stays pending and later reports as estimated.
- `core.ts` default retry policy is not changed. Every billed task_post uses `maxServerErrorRetries: 0` (`postRankCheckTasks` was the one missing it and gets it, in both modes); a retried live read is one reservation and the recorded cost is the final response's.
- The client takes a project-scoped customer (`projectId` required in the type), so a caller without an authorized project does not compile; the self-hosted gate also asserts it at runtime for deserialized workflow payloads.
- Each meter entry carries an explicit operation label (e.g. `serp.live`); the feature comes from the caller's `creditFeature`/default, else from the billed path at settlement.
- Opening balances are inserted by hand as `completed` rows with operation `opening_balance`; no UI for them in v1. No budget fields in project creation in v1.

## Why

Every removed state and write was a race to reason about (claim vs cleanup, reserve vs month rollover) without changing what admission counts. Ensuring the row inside the admission batch removes a whole class of "project created by a path that forgot the hook" bugs.

## Cost accepted

A row stuck pending is reported as estimated rather than flipped to a distinct status; reports must compute that from `startedAt`. Undercount if DataForSEO ever bills a 5xx that a live read retried. Every admission sums all of the project's usage rows (total limit), so D1 rows-read grows linearly with history; fine at agency scale, revisit with a counter if a project passes ~100k rows.

## Revisit when

Real usage shows queued-task refunds matter (then add final-cost reconciliation), or pending rows pile up (then look at why settlement fails).
