# NEXT

<!-- The lead's plan, read whole at the start of a session; keep it under 2.5 KB. Now: what comes next, in order, naming branches, worktrees and PRs. Owner: what the human owes. Choices go to docs/maintainers/decisions/, standing facts to CLAUDE.md or .claude/rules/. Deployed state is queried, not written here. -->

## Now

Per-project DataForSEO budgets merged to main (PR webbzi/open-seo#1). Rollout, in order:

1. Deployed 2026-10-16 from main 32e57d5 (`pnpm deploy:selfhost --yes`; Alchemy applies pending D1 migrations; query `d1_migrations` with `cf d1 query` for state).
2. Verify attribution on real usage with limits unset: rows per project, `cost_usd` vs provider, no long-pending rows.
3. Controlled cap test on a dev project, then configure client limits and opening balances.
4. Follow-ups only on real usage: queued-task refund reconciliation (plan slice 4); a usage counter if a project passes ~100k ledger rows.

Umami per-project source (decision `docs/maintainers/decisions/2026-10-16-umami-integration-shape.md`): merged to main 254febda (PR #2); worktree, branch and test instance cleaned up. Rollout, in order:

1. Deploy main (`pnpm deploy:selfhost --yes`; applies D1 migration 0057). Without the Umami vars the deployment behaves as before.
2. Set `UMAMI_API_URL` + `UMAMI_API_KEY`, redeploy, connect one project in Settings → Integrations.
3. Check the dashboard card and `get_umami_overview` against the Umami UI for the same 28 days.

## Owner

- Go to deploy main (step 1 above).
- Umami: run Umami v3.4+, create an API key from a dedicated least-privileged Umami user that owns or manages only the websites to expose, set `UMAMI_API_URL` + `UMAMI_API_KEY` on the deployment.
- Optional: delete the remote branch `feat/umami-connection`.
- Sign in once and open Settings → API spending to confirm the new screens.
- Hosted, pre-existing, flagged only: `RankCheckWorkflow` prepare-step `INSUFFICIENT_CREDITS` loses its class across the step boundary, so the `insufficient_credits` skip reason likely never records.
