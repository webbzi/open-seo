---
paths:
  - "src/server/workflows/**"
  - "src/db/pg/client.ts"
  - "src/server/features/ai-visibility/services/aiVisibilityCollection.ts"
---

- In Postgres mode `pgDb` (and so `runBatch`) throws a plain Error outside a `withPgClient`/`pgStep` scope. AsyncLocalStorage does not cross `step.do`, so any DB write reached from a Workflow step, including one inside the DataForSEO client, must run inside `pgStep`.
- Cloudflare Workflows persists a step's terminal error (storage key `<cacheKey>-error` in miniflare's workflows `binding.worker.js`) and rethrows it on replay without re-running the step. The stored error is structured-cloned, so an `AppError` loses its class and only name/message survive. Recognise step errors by message: `asAppError` works only when the message is a bare `ErrorCode`.
- `markRankCheckRunFailed`'s `asAppError` check for hosted `INSUFFICIENT_CREDITS` (message is not a bare code) may never match in production, so the `insufficient_credits` skip reason likely never records.
- `RankCheckWorkflow` swallows batch errors into `batchError`; they never reach `markRankCheckRunFailed`, so `lastSkipReason` is only set from the prepare-step check.
- A paid Workflow step's persisted output shape cannot change safely: a run in flight across a deploy replays the old output, and renaming the step re-runs and re-bills it. Signal new outcomes from paid steps by throwing (or extend void-returning steps), and rebuild run-level state from step outcomes.
- `siteAuditWorkflowPhases.ts` sits exactly at oxlint's `eslint/max-lines` cap of 400 (blank and comment lines don't count, so `wc -l` shows 466). Any added code line fails `pnpm lint`: fold changes into existing lines or split the file.
