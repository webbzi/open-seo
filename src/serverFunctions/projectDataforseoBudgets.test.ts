import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import {
  exportOrganizationDataforseoUsage,
  getOrganizationDataforseoSpending,
  getProjectDataforseoBudget,
  listProjectDataforseoUsage,
  updateProjectDataforseoBudget,
} from "./projectDataforseoBudgets";

// The server functions run against the real budget service on in-memory
// SQLite with every production migration. The caller below stands in for the
// middleware: its organization and role come from the session, and projectId
// is passed through unchecked, so the organization scoping these tests see is
// the service's own, not ensureUserMiddleware's.

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

const { caller, isHostedServerAuthMode } = vi.hoisted(() => ({
  caller: { organizationId: "organization", userId: "user", role: "owner" },
  isHostedServerAuthMode: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({
  runBatch: async (build: (tx: unknown) => readonly Promise<unknown>[]) => {
    for (const statement of build(testDb.db)) await statement;
  },
}));
vi.mock("@/server/lib/runtime-env", () => ({ isHostedServerAuthMode }));
vi.mock("@/serverFunctions/middleware", () => ({
  requireAuthenticatedContext: [],
  requireProjectContext: [],
}));
vi.mock("@tanstack/react-start", () => {
  type Handler = (input: { data: unknown; context: unknown }) => unknown;
  const builder = (schema?: z.ZodType) => ({
    validator: (next: z.ZodType) => builder(next),
    handler:
      (handler: Handler) =>
      ({ data }: { data?: unknown } = {}) => {
        const parsed = schema?.parse(data);
        const projectId =
          typeof parsed === "object" && parsed !== null && "projectId" in parsed
            ? parsed.projectId
            : undefined;
        return handler({ data: parsed, context: { ...caller, projectId } });
      },
  });
  return { createServerFn: () => ({ middleware: () => builder() }) };
});

const limits = { monthlyLimitUsd: 10, totalLimitUsd: null, paused: false };

beforeEach(async () => {
  caller.role = "owner";
  isHostedServerAuthMode.mockResolvedValue(false);
  await testDb.client.executeMultiple(`
    DELETE FROM organization;
    INSERT INTO organization (id, name, slug, created_at) VALUES
      ('organization', 'Agency', 'agency', 0),
      ('other', 'Other', 'other', 0);
    INSERT INTO projects (id, organization_id, name) VALUES
      ('project', 'organization', 'Client A'),
      ('foreign', 'other', 'Foreign');
    INSERT INTO project_dataforseo_budgets
      (project_id, monthly_limit_usd, total_limit_usd, paused, reservation_version, updated_by_user_id)
      VALUES ('foreign', 5, NULL, false, 0, 'foreign-owner');
    INSERT INTO project_dataforseo_usage
      (id, project_id, operation, started_at, estimated_cost_usd, cost_usd, status)
      VALUES ('foreign-usage', 'foreign', 'serp.live', '2026-01-15T00:00:00.000Z', 1, 1, 'completed');
  `);
});

const foreignBudget = async () =>
  (
    await testDb.client.execute(
      "SELECT monthly_limit_usd, paused FROM project_dataforseo_budgets WHERE project_id = 'foreign'",
    )
  ).rows;

describe("project DataForSEO budget server functions", () => {
  it("lets a caller without billing permission read spending but not change limits or export usage", async () => {
    // Admins manage projects and integrations, but not billing.
    caller.role = "admin";

    await expect(
      getProjectDataforseoBudget({ data: { projectId: "project" } }),
    ).resolves.toMatchObject({ configured: false });
    await expect(
      updateProjectDataforseoBudget({
        data: { projectId: "project", ...limits },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      exportOrganizationDataforseoUsage({
        data: { from: "2026-01-01", to: "2026-12-31" },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      getProjectDataforseoBudget({ data: { projectId: "project" } }),
    ).resolves.toMatchObject({ configured: false, monthlyLimitUsd: null });
  });

  it("keeps a zero limit distinct from an unset one", async () => {
    await updateProjectDataforseoBudget({
      data: {
        projectId: "project",
        monthlyLimitUsd: 0,
        totalLimitUsd: null,
        paused: false,
      },
    });

    await expect(
      getProjectDataforseoBudget({ data: { projectId: "project" } }),
    ).resolves.toMatchObject({
      configured: true,
      monthlyLimitUsd: 0,
      totalLimitUsd: null,
      status: "monthly_limit_reached",
    });
  });

  it("neither reads nor writes another organization's project", async () => {
    const before = await foreignBudget();

    await expect(
      getProjectDataforseoBudget({ data: { projectId: "foreign" } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      listProjectDataforseoUsage({ data: { projectId: "foreign", page: 1 } }),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      updateProjectDataforseoBudget({
        data: { projectId: "foreign", ...limits, paused: true },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await foreignBudget()).toEqual(before);

    const overview = await getOrganizationDataforseoSpending();
    expect(overview.map((row) => row.projectId)).toEqual(["project"]);
    await expect(
      exportOrganizationDataforseoUsage({
        data: { from: "2026-01-01", to: "2026-12-31" },
      }),
    ).resolves.toEqual([]);
  });

  it.each([
    () => getProjectDataforseoBudget({ data: { projectId: "project" } }),
    () =>
      listProjectDataforseoUsage({ data: { projectId: "project", page: 1 } }),
    () =>
      updateProjectDataforseoBudget({
        data: { projectId: "project", ...limits },
      }),
    () => getOrganizationDataforseoSpending(),
    () =>
      exportOrganizationDataforseoUsage({
        data: { from: "2026-01-01", to: "2026-12-31" },
      }),
  ])("refuses in hosted mode (%#)", async (call) => {
    isHostedServerAuthMode.mockResolvedValue(true);
    await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
