# Rules

<!-- Standing rules for every agent in this repo, workers included: nb sends this file to each of them, so keep it under 2 KB and keep nb usage out (that is the task skill's). A fact about some files is a learning (`nb learn`); a rule for the team belongs in CLAUDE.md, through the owner. -->

- Run checks in their plain forms: `pnpm types:check`, `pnpm vitest run <path>`, `pnpm lint`, `pnpm knip`, `pnpm exec prettier --check <paths>`. Wrapping them in `timeout`, pipes into `tee`, redirects to `/tmp`, `python3` heredocs or `&&` chains makes each one wait for owner approval. Edit files with the Edit tool, not scripts.
