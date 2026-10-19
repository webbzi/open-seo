---
paths:
  - "src/server/auth/workspace-merge.ts"
  - "src/server/auth/workspace-merge.test.ts"
---

- `workspace-merge.test.ts` creates its own tables with hand-written `CREATE TABLE` statements instead of running migrations. Any table newly re-pointed in `workspace-merge.ts` must also be created and cleared there, or the merge test fails with "no such table".
