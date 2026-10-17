import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { umamiConnections } from "@/db/schema";

export type UmamiConnection = typeof umamiConnections.$inferSelect;

type ProjectScope = { projectId: string; organizationId: string };

const inScope = (scope: ProjectScope) =>
  and(
    eq(umamiConnections.projectId, scope.projectId),
    eq(umamiConnections.organizationId, scope.organizationId),
  );

async function getByProjectId(
  scope: ProjectScope,
): Promise<UmamiConnection | null> {
  const rows = await db
    .select()
    .from(umamiConnections)
    .where(inScope(scope))
    .limit(1);
  return rows[0] ?? null;
}

async function upsert(
  input: ProjectScope & {
    websiteId: string;
    websiteName: string;
    websiteDomain: string | null;
    timeZone: string;
  },
): Promise<UmamiConnection> {
  const now = new Date().toISOString();
  const [row] = await db
    .insert(umamiConnections)
    .values({
      id: crypto.randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: umamiConnections.projectId,
      set: {
        websiteId: input.websiteId,
        websiteName: input.websiteName,
        websiteDomain: input.websiteDomain,
        timeZone: input.timeZone,
        updatedAt: now,
      },
      // The project's existing row must belong to the same organization.
      setWhere: eq(umamiConnections.organizationId, input.organizationId),
    })
    .returning();
  if (!row) throw new Error("Failed to upsert umami_connection");
  return row;
}

async function deleteByProjectId(scope: ProjectScope): Promise<void> {
  await db.delete(umamiConnections).where(inScope(scope));
}

export const UmamiConnectionRepository = {
  getByProjectId,
  upsert,
  deleteByProjectId,
};
