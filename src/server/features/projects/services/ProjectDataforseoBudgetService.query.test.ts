import { inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectDataforseoUsage } from "@/db/schema";
import { ProjectDataforseoBudgetService as service } from "./ProjectDataforseoBudgetService";

// Real in-memory SQLite with every production migration, so admission's
// lock-then-check and the summaries run as the SQL production runs. runBatch
// is libsql's atomic batch, like D1's, and fails any statement over D1's
// bound-parameter cap, which SQLite itself would accept.

const testDb = await vi.hoisted(async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const { sort } = await import("remeda");
  const client = createClient({ url: "file::memory:" });
  const migrations = sort(
    readdirSync("drizzle/sqlite").filter((file) => file.endsWith(".sql")),
    (a, b) => a.localeCompare(b),
  );
  for (const file of migrations)
    await client.executeMultiple(
      readFileSync(`drizzle/sqlite/${file}`, "utf8").replaceAll(
        "--> statement-breakpoint",
        "",
      ),
    );
  return { client, db: drizzle(client) };
});

const D1_MAX_BOUND_PARAMETERS = 100;

type Statement = Parameters<typeof testDb.db.batch>[0][number] & {
  toSQL: () => { params: unknown[] };
};

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({
  runBatch: async (build: (tx: unknown) => readonly Promise<unknown>[]) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the repository builds these query builders from testDb.db
    const statements = build(testDb.db) as unknown as [
      Statement,
      ...Statement[],
    ];
    for (const statement of statements)
      expect(statement.toSQL().params.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
    await testDb.db.batch(statements);
  },
}));

const organizationId = "organization";
const projectId = "project";

beforeEach(async () => {
  await testDb.client.executeMultiple(`
    DELETE FROM organization;
    INSERT INTO organization (id, name, slug, created_at) VALUES
      ('organization', 'Agency', 'agency', 0),
      ('other', 'Other', 'other', 0);
    INSERT INTO projects (id, organization_id, name, archived_at) VALUES
      ('project', 'organization', 'Client A', NULL),
      ('archived', 'organization', 'Client B', '2026-01-01T00:00:00.000Z'),
      ('foreign', 'other', 'Foreign', NULL);
  `);
});

const admit = (
  estimatesUsd: number[],
  scope: { organizationId: string; projectId: string } = {
    organizationId,
    projectId,
  },
) =>
  service.admit({
    ...scope,
    actorUserId: "user",
    feature: "rank_tracking",
    operation: "serp/organic/live",
    runId: "run",
    estimatesUsd,
  });

const setBudget = (budget: {
  monthlyLimitUsd: number | null;
  totalLimitUsd: number | null;
  paused?: boolean;
}) =>
  service.updateBudget({
    organizationId,
    projectId,
    actorUserId: "owner",
    paused: false,
    ...budget,
  });

const exceeded = { code: "PROJECT_BUDGET_EXCEEDED" };
const notFound = { code: "NOT_FOUND" };

/** Moves rows' startedAt, e.g. into last month or past the estimated cut-off. */
const startRowsAt = (ids: string[], startedAt: Date) =>
  testDb.db
    .update(projectDataforseoUsage)
    .set({ startedAt: startedAt.toISOString() })
    .where(inArray(projectDataforseoUsage.id, ids));

const lastMonth = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
};

describe("admission", () => {
  it("applies monthly and total limits to recorded plus pending spend, whole batches only", async () => {
    // No budget row: unlimited and not configured.
    const { usageIds: first } = await admit([1]);
    expect(
      await service.getProjectSummary(organizationId, projectId),
    ).toMatchObject({
      configured: false,
      status: "available",
      availableUsd: null,
    });

    // Zero is a limit, even for a zero estimate.
    await setBudget({ monthlyLimitUsd: 0, totalLimitUsd: null });
    await expect(admit([0])).rejects.toMatchObject(exceeded);

    // The pending $1 counts: exactly filling the month is allowed, then nothing.
    await setBudget({ monthlyLimitUsd: 2, totalLimitUsd: 3 });
    const { usageIds: second } = await admit([0.5, 0.5]);
    await expect(admit([0])).rejects.toMatchObject(exceeded);

    // Settling below the estimate frees room; a batch that does not fit
    // inserts none of its rows.
    await service.settle({
      organizationId,
      projectId,
      outcomes: [{ usageId: first[0], kind: "charged", costUsd: 0.25 }],
    });
    await expect(admit([0.25, 0.25, 0.5])).rejects.toMatchObject(exceeded);
    const { usageIds: third } = await admit([0.25, 0.5]);
    expect(
      await service.listRecentUsage(organizationId, projectId, {
        limit: 100,
        offset: 0,
      }),
    ).toHaveLength(5);

    // Last month's usage leaves this month's room but still counts in total.
    await startRowsAt([...first, ...second, ...third], lastMonth());
    await expect(admit([1.25])).rejects.toMatchObject(exceeded);
    await admit([1]);
    expect(
      await service.getProjectSummary(organizationId, projectId),
    ).toMatchObject({
      configured: true,
      monthlyLimitUsd: 2,
      totalLimitUsd: 3,
      monthRecordedUsd: 0,
      totalRecordedUsd: 0.25,
      // The backdated pending rows are past the cut-off, so they are estimated.
      inFlightUsd: 1,
      estimatedUsd: 1.75,
      monthCommittedUsd: 1,
      totalCommittedUsd: 3,
      availableUsd: 0,
      status: "total_limit_reached",
    });

    // Pause refuses regardless of room.
    await setBudget({
      monthlyLimitUsd: null,
      totalLimitUsd: null,
      paused: true,
    });
    await expect(admit([0])).rejects.toMatchObject({
      code: "PROJECT_DATAFORSEO_PAUSED",
    });
  });

  it("admits or refuses a batch spanning several insert statements whole", async () => {
    const estimates = Array.from({ length: 100 }, () => 0.01);
    await setBudget({ monthlyLimitUsd: 0.99, totalLimitUsd: null });
    await expect(admit(estimates)).rejects.toMatchObject(exceeded);
    expect(
      await service.listRecentUsage(organizationId, projectId, {
        limit: 100,
        offset: 0,
      }),
    ).toEqual([]);

    await setBudget({ monthlyLimitUsd: 1.01, totalLimitUsd: null });
    const { usageIds } = await admit(estimates);
    expect(new Set(usageIds).size).toBe(100);
    const rows = await testDb.db
      .select({ id: projectDataforseoUsage.id })
      .from(projectDataforseoUsage);
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set(usageIds));
  });

  it("counts a pending admission against the next one", async () => {
    await setBudget({ monthlyLimitUsd: 1, totalLimitUsd: null });
    await admit([0.75]);
    await expect(admit([0.75])).rejects.toMatchObject(exceeded);
    expect(
      await service.getProjectSummary(organizationId, projectId),
    ).toMatchObject({ monthCommittedUsd: 0.75 });
  });
});

describe("settlement", () => {
  it("records charges, frees releases, and reports unsettled rows as estimated until a late settle", async () => {
    const {
      usageIds: [charged, released, unknown, inFlight],
    } = await service.admit({
      organizationId,
      projectId,
      actorUserId: null,
      feature: null,
      operation: "backlinks/summary/live",
      estimatesUsd: [0.5, 0.5, 0.5, 0.5],
    });
    const outcomes = [
      {
        usageId: charged,
        kind: "charged" as const,
        costUsd: 0.25,
        feature: "backlinks" as const,
      },
      { usageId: released, kind: "released" as const },
      { usageId: unknown, kind: "unknown" as const },
    ];
    await service.settle({ organizationId, projectId, outcomes });
    // A duplicate settlement, even with a different outcome, changes nothing.
    await service.settle({
      organizationId,
      projectId,
      outcomes: [
        { usageId: charged, kind: "charged", costUsd: 9 },
        { usageId: released, kind: "charged", costUsd: 9 },
      ],
    });
    await startRowsAt([unknown], new Date(Date.now() - 31 * 60 * 1000));

    expect(
      await service.getProjectSummary(organizationId, projectId),
    ).toMatchObject({
      totalRecordedUsd: 0.25,
      inFlightUsd: 0.5,
      estimatedUsd: 0.5,
      totalCommittedUsd: 1.25,
      featureBreakdown: [
        { feature: "backlinks", recordedUsd: 0.25, estimatedUsd: 0 },
        { feature: null, recordedUsd: 0, estimatedUsd: 0.5 },
      ],
    });
    const statuses = await service.listRecentUsage(organizationId, projectId, {
      limit: 10,
      offset: 0,
    });
    expect(
      Object.fromEntries(statuses.map((row) => [row.id, row.status])),
    ).toEqual({
      [charged]: "completed",
      [released]: "released",
      [unknown]: "estimated",
      [inFlight]: "pending",
    });

    await service.settle({
      organizationId,
      projectId,
      outcomes: [{ usageId: unknown, kind: "charged", costUsd: 0.5 }],
    });
    expect(
      await service.getProjectSummary(organizationId, projectId),
    ).toMatchObject({ totalRecordedUsd: 0.75, estimatedUsd: 0 });
  });
});

describe("tenant isolation", () => {
  it("treats another organization's project as missing for every operation", async () => {
    const foreign = { organizationId: "other", projectId: "foreign" };
    const {
      usageIds: [foreignUsage],
    } = await admit([0.5], foreign);

    const asAgency = { organizationId, projectId: "foreign" };
    await expect(admit([0.5], asAgency)).rejects.toMatchObject(notFound);
    await expect(
      service.getProjectSummary(organizationId, "foreign"),
    ).rejects.toMatchObject(notFound);
    await expect(
      service.updateBudget({
        ...asAgency,
        actorUserId: "owner",
        monthlyLimitUsd: 0,
        totalLimitUsd: 0,
        paused: true,
      }),
    ).rejects.toMatchObject(notFound);
    await service.settle({
      ...asAgency,
      outcomes: [{ usageId: foreignUsage, kind: "released" }],
    });
    expect(
      await service.listRecentUsage(organizationId, "foreign", {
        limit: 10,
        offset: 0,
      }),
    ).toEqual([]);

    // The foreign project's own view is untouched.
    expect(await service.getProjectSummary("other", "foreign")).toMatchObject({
      configured: false,
      paused: false,
      inFlightUsd: 0.5,
    });
  });

  it("summarizes and exports every project of the organization, archived included, and nothing else", async () => {
    await admit([0.5], { organizationId: "other", projectId: "foreign" });
    await admit([0.25]);
    const {
      usageIds: [archivedUsage],
    } = await admit([0.5], { organizationId, projectId: "archived" });
    await service.settle({
      organizationId,
      projectId: "archived",
      outcomes: [{ usageId: archivedUsage, kind: "charged", costUsd: 0.5 }],
    });
    const now = Date.now();
    await startRowsAt([archivedUsage], new Date(now - 60 * 1000));

    expect(await service.getOrganizationSummary(organizationId)).toEqual([
      expect.objectContaining({
        projectId,
        name: "Client A",
        archived: false,
        inFlightUsd: 0.25,
        totalRecordedUsd: 0,
        status: "available",
      }),
      expect.objectContaining({
        projectId: "archived",
        archived: true,
        monthRecordedUsd: 0.5,
        totalRecordedUsd: 0.5,
      }),
    ]);

    // Oldest first.
    const exported = await service.listUsageForExport(organizationId, {
      from: new Date(now - 60 * 60 * 1000),
      to: new Date(now + 60 * 60 * 1000),
    });
    expect(exported).toEqual([
      expect.objectContaining({
        projectName: "Client B",
        status: "completed",
        costUsd: 0.5,
      }),
      expect.objectContaining({
        projectName: "Client A",
        feature: "rank_tracking",
        operation: "serp/organic/live",
        runId: "run",
        actorUserId: "user",
        status: "pending",
        estimatedCostUsd: 0.25,
        costUsd: null,
      }),
    ]);
  });
});
