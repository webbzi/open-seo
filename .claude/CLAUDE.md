@../AGENTS.md

## Layout

This fork is public. The records below are gitignored and live only in the main checkout, which overrides AGENTS.md's note that `docs/maintainers/` is tracked. A worktree has none of them, so a brief names their main-checkout path. Any new fork-authored plan, decision or spec gets a `.gitignore` entry before it is written.

- `docs/maintainers/decisions/<date>-<slug>.md`: decision records (context, options, choice). Read the ones that touch an area before changing it.
- `docs/maintainers/NEXT.md`: the lead's plan and what the owner owes. `.reports/`: subagent reports and handover files; scratch.
- `.claude/rules/<area>.md`: facts that bite in one area; they load when a matching file is read or edited.

## Commands

- Checks: `pnpm types:check`, `pnpm vitest run <path>`, `pnpm lint`, `pnpm knip`, `pnpm exec prettier --check <paths>`. Edit files with the Edit tool, not scripts.
- A fresh worktree has no `node_modules`, so IDE diagnostics flood with "cannot find module" until `pnpm install --frozen-lockfile --prefer-offline` runs.
- `pnpm format:check` (prettier --check .) can exit 2 with ENOENT on `.codegraph/codegraph.lock` while the codegraph indexer is writing; prettier still reports all files formatted and a rerun passes. Prettier does not ignore `.codegraph/`.
- `pnpm exec vite build` works offline in a worktree and regenerates `src/routeTree.gen.ts` after route files are added; besides the route tree it writes only to the gitignored `dist/`.
- Vitest config swallows `console.log` from passing tests, even with `--silent=false`.
- The TS lib is ES2022 (no `Array#toSorted`) and oxlint forbids `Array#sort`, so use remeda `sort`/`sortBy`/`firstBy`.
