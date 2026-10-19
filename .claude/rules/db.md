---
paths:
  - "src/db/**"
  - "src/server/features/**/repositories/*.ts"
  - "src/server/features/projects/services/ProjectDataforseoBudgetService.query.test.ts"
  - "src/serverFunctions/projectDataforseoBudgets.test.ts"
  - "drizzle/pg/*.sql"
---

- drizzle 0.45 `tx.insert(t).select((qb) => qb.select({...}))` does not type-check with the `d1Db`-typed `runBatch` tx. Use ``insert(t).select(sql`SELECT ...`)`` with every column in table-definition order (`ProjectWebsiteRepository` is the precedent). Postgres coerces untyped params in INSERT...SELECT to the target column types.
- Postgres migrations make `organization.created_at` timestamptz while the SQLite one is an integer, so raw seed SQL for Postgres needs `now()`, not text.
- The SQL-backed tests use in-memory libsql on one client, so batches run one at a time. A "concurrent" test there cannot exercise Postgres row locks and passes even with the lock removed. The repo has no Postgres test infrastructure (no PGlite or containers): Postgres-only SQL behaviour needs a manual check.
