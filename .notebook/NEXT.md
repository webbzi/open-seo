# NEXT

<!-- Read whole at every lead session; keep it under 2 KB. Now: what comes next, in order, with task ids. Owner: what the human owes. Choices go to decisions/, rules to rules.md, facts to `nb learn`, work to `nb task new`. Deployed state is queried, not written here. -->

## Now

Per-project DataForSEO budgets merged to main (PR webbzi/open-seo#1). Rollout, in order:
1. Deployed 2026-10-16 from main 32e57d5 (`pnpm deploy:selfhost --yes`; Alchemy applies pending D1 migrations; query `d1_migrations` with `cf d1 query` for state).
2. Verify attribution on real usage with limits unset: rows per project, `cost_usd` vs provider, no long-pending rows.
3. Controlled cap test on a dev project, then configure client limits and opening balances.
4. Follow-ups only on real usage: queued-task refund reconciliation (plan slice 4); a usage counter if a project passes ~100k ledger rows.

## Owner

- Sign in once and open Settings → API spending to confirm the new screens.
- Approve or amend decision `dataforseo-project-ledger` (proposed; built as Option 2, plus envelope-cost settlement).
- Hosted, pre-existing, flagged only: `RankCheckWorkflow` prepare-step `INSUFFICIENT_CREDITS` loses its class across the step boundary, so the `insufficient_credits` skip reason likely never records (T-0006 report).
- Decide whether the repo-root plan file and `.notebook/` get committed (on main, not a feature branch).
