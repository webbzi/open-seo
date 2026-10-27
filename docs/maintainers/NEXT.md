# NEXT

<!-- The lead's plan, read whole at the start of a session; keep it under 2.5 KB. Now: what comes next, in order, naming branches, worktrees and PRs. Owner: what the human owes. Choices go to docs/maintainers/decisions/, standing facts to CLAUDE.md or .claude/rules/. Deployed state is queried, not written here. -->

## Now

1. Deploy main (`pnpm deploy:selfhost --yes`; applies D1 migration 0057). This covers per-project DataForSEO budgets (PR #1) and Umami (PR #2).
2. Budgets: verify attribution on real usage (rows per project, `cost_usd` vs provider, no long-pending rows), then run a cap test on a dev project, then set client limits.
3. Umami: set `UMAMI_API_URL` + `UMAMI_API_KEY`, redeploy, connect one project, and check `get_umami_overview` against the Umami UI over 28 days.
4. Serve at `openseo.webbzi.com` (decision `docs/maintainers/decisions/2026-10-27-selfhost-custom-domain.md`): the `CUSTOM_DOMAIN` PR is open from `feat/selfhost-custom-domain`. After it merges and step 1 is done, run that record's rollout as its own deploy.

Follow-ups only on real usage: queued-task refund reconciliation, and a usage counter if a project passes ~100k ledger rows.

## Owner

- Review and merge the custom-domain PR. Then follow the rollout in the decision record: a hostname rule turning Browser Integrity Check, Rocket Loader and email obfuscation off; note the Managed OAuth settings; set `CUSTOM_DOMAIN`; deploy; re-enable Managed OAuth; repoint Codex.
- Go to deploy main (Now 1).
- Umami: Umami v3.4+, an API key from a least-privileged user, set both vars.
- Optional: delete the remote branch `feat/umami-connection`.
- Hosted, pre-existing, flagged only: `RankCheckWorkflow` prepare-step `INSUFFICIENT_CREDITS` loses its class across the step boundary.
