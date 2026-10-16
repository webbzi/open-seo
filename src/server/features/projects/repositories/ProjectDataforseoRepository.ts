import {
  and,
  asc,
  desc,
  eq,
  gte,
  lt,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { chunk } from "remeda";
import { db } from "@/db";
import type { runBatch } from "@/db/runBatch";
import {
  projectDataforseoBudgets as budgets,
  projectDataforseoUsage as usage,
  projects,
} from "@/db/schema";
import type { CreditFeature } from "@/shared/billing-credit-features";

// Backing store for per-project DataForSEO spend (self-hosted mode). Reads run
// directly; writes are statement builders the service runs inside one
// `runBatch`, so admission's lock, check and inserts commit together.
// Every statement is scoped to the organization through projects.organization_id,
// so another organization's project behaves exactly like a missing one.

type Tx = Parameters<Parameters<typeof runBatch>[0]>[0];

/** The periods the aggregates split usage by; all ISO timestamps. */
type UsageWindow = {
  monthStart: string;
  nextMonthStart: string;
  /** Pending rows started at or before this are reported as estimated. */
  staleBefore: string;
};

// D1 caps bound parameters at ~100 per statement. The deciding insert binds 12
// fixed values plus 2 per row (id, estimate), follow-on inserts 7 plus 2.
const USAGE_ROWS_PER_INSERT = 40;

const inOrganization = (projectId: AnyColumn, organizationId: string) =>
  sql`${projectId} IN (SELECT ${projects.id} FROM ${projects} WHERE ${projects.organizationId} = ${organizationId})`;

// What one usage row commits against a limit: its estimate while pending, the
// provider cost once completed, nothing once released.
const committedAmount = sql`CASE ${usage.status} WHEN 'pending' THEN ${usage.estimatedCostUsd} WHEN 'completed' THEN ${usage.costUsd} ELSE 0 END`;

const sumWhen = (condition: SQL, amount: AnyColumn) =>
  sql<number>`COALESCE(SUM(CASE WHEN ${condition} THEN ${amount} ELSE 0 END), 0)`.mapWith(
    Number,
  );

/** The usage sums every summary reports, as select fields for a grouped query. */
function usageSums({ monthStart, nextMonthStart, staleBefore }: UsageWindow) {
  const completed = sql`${usage.status} = 'completed'`;
  const pending = sql`${usage.status} = 'pending'`;
  const inMonth = sql`${usage.startedAt} >= ${monthStart} AND ${usage.startedAt} < ${nextMonthStart}`;
  return {
    monthRecordedUsd: sumWhen(sql`${completed} AND ${inMonth}`, usage.costUsd),
    totalRecordedUsd: sumWhen(completed, usage.costUsd),
    monthPendingUsd: sumWhen(
      sql`${pending} AND ${inMonth}`,
      usage.estimatedCostUsd,
    ),
    totalPendingUsd: sumWhen(pending, usage.estimatedCostUsd),
    estimatedUsd: sumWhen(
      sql`${pending} AND ${usage.startedAt} <= ${staleBefore}`,
      usage.estimatedCostUsd,
    ),
  };
}

// --- Writes (statement builders for runBatch) -------------------------------

/** Creates the unlimited, unconfigured budget row if the project has none. */
function ensureBudget(
  tx: Tx,
  input: { organizationId: string; projectId: string; now: string },
) {
  // INSERT ... SELECT lists every column in table definition order.
  return tx
    .insert(budgets)
    .select(
      sql`SELECT ${projects.id}, NULL, NULL, false, 0, ${input.now}, ${input.now}, NULL
        FROM ${projects}
        WHERE ${projects.id} = ${input.projectId} AND ${projects.organizationId} = ${input.organizationId}`,
    )
    .onConflictDoNothing();
}

/**
 * Takes the per-project row lock. On Postgres a competing admission or
 * settings change blocks here until this transaction commits; on D1 the
 * whole batch is already serialized.
 */
function lockBudget(
  tx: Tx,
  input: { organizationId: string; projectId: string },
) {
  return tx
    .update(budgets)
    .set({ reservationVersion: sql`${budgets.reservationVersion} + 1` })
    .where(
      and(
        eq(budgets.projectId, input.projectId),
        inOrganization(budgets.projectId, input.organizationId),
      ),
    );
}

/**
 * Inserts the batch as `pending` rows only if the whole batch fits: not paused
 * and, for each configured limit, committed < limit and committed + batch
 * total <= limit. The first statement decides; follow-on chunks insert only
 * if the first row now exists, so the batch lands whole or not at all.
 * Must run after `lockBudget` in the same batch.
 */
function insertPendingUsage(
  tx: Tx,
  input: {
    organizationId: string;
    projectId: string;
    feature: CreditFeature | null;
    operation: string;
    runId: string | null;
    actorUserId: string | null;
    startedAt: string;
    monthStart: string;
    rows: Array<{ id: string; estimateUsd: number }>;
  },
) {
  const batchUsd = sql`CAST(${input.rows.reduce((sum, row) => sum + row.estimateUsd, 0)} AS double precision)`;
  const fits = (limit: AnyColumn, committed: SQL) =>
    sql`(${limit} IS NULL OR (${committed} < ${limit} AND ${committed} + ${batchUsd} <= ${limit}))`;
  const admitted = sql`EXISTS (
    SELECT 1 FROM ${budgets}
    INNER JOIN ${projects} ON ${projects.id} = ${budgets.projectId}
    CROSS JOIN (
      SELECT
        COALESCE(SUM(CASE WHEN ${usage.startedAt} >= ${input.monthStart} THEN ${committedAmount} ELSE 0 END), 0) AS month_committed,
        COALESCE(SUM(${committedAmount}), 0) AS total_committed
      FROM ${usage} WHERE ${usage.projectId} = ${input.projectId}
    ) AS committed
    WHERE ${budgets.projectId} = ${input.projectId}
      AND ${projects.organizationId} = ${input.organizationId}
      AND NOT ${budgets.paused}
      AND ${fits(budgets.monthlyLimitUsd, sql`committed.month_committed`)}
      AND ${fits(budgets.totalLimitUsd, sql`committed.total_committed`)}
  )`;
  const firstId = input.rows[0]?.id;
  const firstInserted = sql`EXISTS (SELECT 1 FROM ${usage} WHERE ${usage.id} = ${firstId})`;

  return chunk(input.rows, USAGE_ROWS_PER_INSERT).map((rows, index) => {
    // VALUES columns are named column1, column2 on both SQLite and Postgres.
    const values = sql.join(
      rows.map(
        (row) => sql`(${row.id}, CAST(${row.estimateUsd} AS double precision))`,
      ),
      sql`, `,
    );
    // INSERT ... SELECT lists every column in table definition order:
    // id, project_id, feature, operation, run_id, actor_user_id, started_at,
    // estimated_cost_usd, cost_usd, status, completed_at.
    return tx
      .insert(usage)
      .select(
        sql`SELECT batch.column1, ${input.projectId}, ${input.feature}, ${input.operation},
            ${input.runId}, ${input.actorUserId}, ${input.startedAt}, batch.column2,
            NULL, 'pending', NULL
          FROM (VALUES ${values}) AS batch
          WHERE ${index === 0 ? admitted : firstInserted}`,
      )
      .onConflictDoNothing();
  });
}

/**
 * Settles one pending row. Guarded on status = 'pending', so a duplicate or
 * late settlement of an already settled row changes nothing. A provided
 * feature fills a row admitted without one.
 */
function settleUsage(
  tx: Tx,
  input: {
    organizationId: string;
    projectId: string;
    usageId: string;
    status: "completed" | "released";
    costUsd: number | null;
    feature: CreditFeature | null;
    completedAt: string;
  },
) {
  return tx
    .update(usage)
    .set({
      status: input.status,
      costUsd: input.costUsd,
      completedAt: input.completedAt,
      ...(input.feature
        ? { feature: sql`COALESCE(${usage.feature}, ${input.feature})` }
        : {}),
    })
    .where(
      and(
        eq(usage.id, input.usageId),
        eq(usage.projectId, input.projectId),
        eq(usage.status, "pending"),
        inOrganization(usage.projectId, input.organizationId),
      ),
    );
}

/**
 * Writes the limits and pause flag, and bumps reservationVersion so it takes
 * the same row lock admissions do. Run after `ensureBudget`.
 */
function updateBudget(
  tx: Tx,
  input: {
    organizationId: string;
    projectId: string;
    actorUserId: string;
    monthlyLimitUsd: number | null;
    totalLimitUsd: number | null;
    paused: boolean;
    now: string;
  },
) {
  return tx
    .update(budgets)
    .set({
      monthlyLimitUsd: input.monthlyLimitUsd,
      totalLimitUsd: input.totalLimitUsd,
      paused: input.paused,
      reservationVersion: sql`${budgets.reservationVersion} + 1`,
      updatedAt: input.now,
      updatedByUserId: input.actorUserId,
    })
    .where(
      and(
        eq(budgets.projectId, input.projectId),
        inOrganization(budgets.projectId, input.organizationId),
      ),
    );
}

// --- Reads -------------------------------------------------------------------

/** The project (archived included) and its budget row, or null if not in the org. */
async function findProjectBudget(organizationId: string, projectId: string) {
  const [row] = await db
    .select({
      projectId: projects.id,
      monthlyLimitUsd: budgets.monthlyLimitUsd,
      totalLimitUsd: budgets.totalLimitUsd,
      paused: budgets.paused,
      updatedByUserId: budgets.updatedByUserId,
    })
    .from(projects)
    .leftJoin(budgets, eq(budgets.projectId, projects.id))
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function usageExists(
  organizationId: string,
  projectId: string,
  usageId: string,
) {
  const [row] = await db
    .select({ id: usage.id })
    .from(usage)
    .where(
      and(
        eq(usage.id, usageId),
        eq(usage.projectId, projectId),
        inOrganization(usage.projectId, organizationId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Usage sums per feature for one project. */
function sumProjectUsageByFeature(
  organizationId: string,
  projectId: string,
  window: UsageWindow,
) {
  return db
    .select({
      feature: usage.feature,
      trackingStartedAt: sql<string | null>`MIN(${usage.startedAt})`,
      ...usageSums(window),
    })
    .from(usage)
    .where(
      and(
        eq(usage.projectId, projectId),
        inOrganization(usage.projectId, organizationId),
      ),
    )
    .groupBy(usage.feature);
}

/** One row per project of the organization (archived included) with its sums. */
function sumOrganizationUsageByProject(
  organizationId: string,
  window: UsageWindow,
) {
  return db
    .select({
      projectId: projects.id,
      name: projects.name,
      archivedAt: projects.archivedAt,
      monthlyLimitUsd: budgets.monthlyLimitUsd,
      totalLimitUsd: budgets.totalLimitUsd,
      paused: budgets.paused,
      updatedByUserId: budgets.updatedByUserId,
      ...usageSums(window),
    })
    .from(projects)
    .leftJoin(budgets, eq(budgets.projectId, projects.id))
    .leftJoin(usage, eq(usage.projectId, projects.id))
    .where(eq(projects.organizationId, organizationId))
    .groupBy(
      projects.id,
      projects.name,
      projects.archivedAt,
      budgets.monthlyLimitUsd,
      budgets.totalLimitUsd,
      budgets.paused,
      budgets.updatedByUserId,
    )
    .orderBy(sql`${projects.archivedAt} IS NOT NULL`, asc(projects.name));
}

const usageRowFields = {
  id: usage.id,
  startedAt: usage.startedAt,
  completedAt: usage.completedAt,
  feature: usage.feature,
  operation: usage.operation,
  runId: usage.runId,
  actorUserId: usage.actorUserId,
  status: usage.status,
  estimatedCostUsd: usage.estimatedCostUsd,
  costUsd: usage.costUsd,
};

function listProjectUsage(
  organizationId: string,
  projectId: string,
  page: { limit: number; offset: number },
) {
  return db
    .select(usageRowFields)
    .from(usage)
    .where(
      and(
        eq(usage.projectId, projectId),
        inOrganization(usage.projectId, organizationId),
      ),
    )
    .orderBy(desc(usage.startedAt), desc(usage.id))
    .limit(page.limit)
    .offset(page.offset);
}

/** Usage rows of every project of the organization started in [from, to). */
function listOrganizationUsage(
  organizationId: string,
  range: { from: string; to: string },
) {
  return db
    .select({
      ...usageRowFields,
      projectId: projects.id,
      projectName: projects.name,
    })
    .from(usage)
    .innerJoin(projects, eq(projects.id, usage.projectId))
    .where(
      and(
        eq(projects.organizationId, organizationId),
        gte(usage.startedAt, range.from),
        lt(usage.startedAt, range.to),
      ),
    )
    .orderBy(asc(usage.startedAt), asc(usage.id));
}

export const ProjectDataforseoRepository = {
  ensureBudget,
  lockBudget,
  insertPendingUsage,
  settleUsage,
  updateBudget,
  findProjectBudget,
  usageExists,
  sumProjectUsageByFeature,
  sumOrganizationUsageByProject,
  listProjectUsage,
  listOrganizationUsage,
};
