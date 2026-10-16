import { firstBy, identity, sortBy } from "remeda";
import { z } from "zod";
import { runBatch } from "@/db/runBatch";
import { ProjectDataforseoRepository as repo } from "@/server/features/projects/repositories/ProjectDataforseoRepository";
import { AppError } from "@/server/lib/errors";
import type { CreditFeature } from "@/shared/billing-credit-features";

// Self-hosted per-project DataForSEO spend: admission before each paid call,
// settlement after, and the summaries the settings page and agency overview
// read. Hosted mode bills through Autumn credits and never calls this.
//
// Committed spend = pending estimates + completed costs; released counts zero.
// A cost belongs to the UTC month of its row's startedAt. A pending row older
// than ESTIMATED_AFTER_MS is reported as estimated: its call's outcome was
// never confirmed, but it still counts its estimate.

const ESTIMATED_AFTER_MS = 30 * 60 * 1000;

const usdAmount = z.number().nonnegative();
/** A limit in USD: finite, at least zero, at most two decimals; null is unset. */
export const usdLimit = usdAmount
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, {
    message: "Limits have at most two decimals",
  })
  .nullable();

const budgetInput = z.object({
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
  actorUserId: z.string().min(1),
  monthlyLimitUsd: usdLimit,
  totalLimitUsd: usdLimit,
  paused: z.boolean(),
});

const pageInput = z.object({
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().nonnegative(),
});

type SettleOutcome = { usageId: string; feature?: CreditFeature | null } & (
  | { kind: "charged"; costUsd: number }
  | { kind: "released" }
  | { kind: "unknown" }
);

type BudgetStatus =
  | "available"
  | "paused"
  | "monthly_limit_reached"
  | "total_limit_reached";

type Limits = {
  monthlyLimitUsd: number | null;
  totalLimitUsd: number | null;
  paused: boolean;
};

/** UTC month boundaries and the estimated cut-off for `now`. */
function usageWindow(now: Date) {
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const nextMonthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  return {
    monthStart,
    nextMonthStart,
    iso: {
      monthStart: monthStart.toISOString(),
      nextMonthStart: nextMonthStart.toISOString(),
      staleBefore: new Date(now.getTime() - ESTIMATED_AFTER_MS).toISOString(),
    },
  };
}

/** No budget row (or a left-joined null) means unlimited and not paused. */
function limitsOf(row: {
  monthlyLimitUsd: number | null;
  totalLimitUsd: number | null;
  paused: boolean | null;
  updatedByUserId: string | null;
}) {
  return {
    configured: row.updatedByUserId !== null,
    monthlyLimitUsd: row.monthlyLimitUsd,
    totalLimitUsd: row.totalLimitUsd,
    paused: row.paused ?? false,
  };
}

/**
 * Status and remaining room, by the same rule admission applies in SQL: a
 * limit is reached once committed spend is at or above it.
 */
function budgetState(
  limits: Limits,
  monthCommittedUsd: number,
  totalCommittedUsd: number,
) {
  // Room left under each configured limit; at or below zero means reached.
  const monthRoom =
    limits.monthlyLimitUsd === null
      ? null
      : limits.monthlyLimitUsd - monthCommittedUsd;
  const totalRoom =
    limits.totalLimitUsd === null
      ? null
      : limits.totalLimitUsd - totalCommittedUsd;

  let status: BudgetStatus = "available";
  if (limits.paused) status = "paused";
  else if (totalRoom !== null && totalRoom <= 0) status = "total_limit_reached";
  else if (monthRoom !== null && monthRoom <= 0)
    status = "monthly_limit_reached";

  const rooms = [monthRoom, totalRoom].filter((room) => room !== null);
  return {
    status,
    availableUsd: rooms.length === 0 ? null : Math.max(0, Math.min(...rooms)),
  };
}

type UsageStatus = "pending" | "completed" | "released";

/** Reports a pending row past the cut-off as "estimated". */
function withDerivedStatus<
  T extends { status: UsageStatus; startedAt: string },
>(
  row: T,
  staleBefore: string,
): Omit<T, "status"> & { status: UsageStatus | "estimated" } {
  return {
    ...row,
    status:
      row.status === "pending" && row.startedAt <= staleBefore
        ? "estimated"
        : row.status,
  };
}

async function requireProjectBudget(organizationId: string, projectId: string) {
  const project = await repo.findProjectBudget(organizationId, projectId);
  if (!project) throw new AppError("NOT_FOUND");
  return project;
}

/**
 * Admits a batch of paid calls, one estimate per call, or refuses it whole.
 * One runBatch: ensure the budget row, take the per-project lock, then insert
 * the rows only if the batch fits (the check runs in SQL after the lock, so
 * concurrent admissions cannot both spend the same room). A database error
 * propagates as-is; only a refusal becomes a budget error.
 */
async function admit(input: {
  organizationId: string;
  projectId: string;
  actorUserId: string | null;
  feature: CreditFeature | null;
  operation: string;
  runId?: string | null;
  estimatesUsd: number[];
}): Promise<{ usageIds: string[] }> {
  const estimatesUsd = z.array(usdAmount).parse(input.estimatesUsd);
  if (estimatesUsd.length === 0) return { usageIds: [] };

  const now = new Date();
  const scope = {
    organizationId: input.organizationId,
    projectId: input.projectId,
  };
  const rows = estimatesUsd.map((estimateUsd) => ({
    id: crypto.randomUUID(),
    estimateUsd,
  }));
  await runBatch((tx) => [
    repo.ensureBudget(tx, { ...scope, now: now.toISOString() }),
    repo.lockBudget(tx, scope),
    ...repo.insertPendingUsage(tx, {
      ...scope,
      feature: input.feature,
      operation: input.operation,
      runId: input.runId ?? null,
      actorUserId: input.actorUserId,
      startedAt: now.toISOString(),
      monthStart: usageWindow(now).iso.monthStart,
      rows,
    }),
  ]);
  if (
    await repo.usageExists(input.organizationId, input.projectId, rows[0].id)
  ) {
    return { usageIds: rows.map((row) => row.id) };
  }

  // Refused. The decision was made in SQL; this read only names the reason.
  const project = await requireProjectBudget(
    input.organizationId,
    input.projectId,
  );
  throw new AppError(
    project.paused ? "PROJECT_DATAFORSEO_PAUSED" : "PROJECT_BUDGET_EXCEEDED",
  );
}

/**
 * Records the outcome of admitted calls in one runBatch. "charged" completes
 * the row at the provider cost, "released" frees its estimate, "unknown"
 * writes nothing so the row stays pending and later reports as estimated.
 * Settling a row that is no longer pending is a no-op.
 */
async function settle(input: {
  organizationId: string;
  projectId: string;
  outcomes: SettleOutcome[];
}): Promise<void> {
  const completedAt = new Date().toISOString();
  const updates = input.outcomes.flatMap((outcome) => {
    if (outcome.kind === "unknown") return [];
    return [
      {
        organizationId: input.organizationId,
        projectId: input.projectId,
        usageId: outcome.usageId,
        status:
          outcome.kind === "charged"
            ? ("completed" as const)
            : ("released" as const),
        costUsd:
          outcome.kind === "charged" ? usdAmount.parse(outcome.costUsd) : null,
        feature: outcome.feature ?? null,
        completedAt,
      },
    ];
  });
  if (updates.length === 0) return;
  await runBatch((tx) => updates.map((update) => repo.settleUsage(tx, update)));
}

async function getProjectSummary(
  organizationId: string,
  projectId: string,
  now = new Date(),
) {
  const project = await requireProjectBudget(organizationId, projectId);
  const window = usageWindow(now);
  const groups = await repo.sumProjectUsageByFeature(
    organizationId,
    projectId,
    window.iso,
  );

  const sum = (pick: (group: (typeof groups)[number]) => number) =>
    groups.reduce((total, group) => total + pick(group), 0);
  const monthRecordedUsd = sum((group) => group.monthRecordedUsd);
  const totalRecordedUsd = sum((group) => group.totalRecordedUsd);
  const totalPendingUsd = sum((group) => group.totalPendingUsd);
  const estimatedUsd = sum((group) => group.estimatedUsd);
  const monthCommittedUsd =
    monthRecordedUsd + sum((group) => group.monthPendingUsd);
  const totalCommittedUsd = totalRecordedUsd + totalPendingUsd;
  const trackingStartedAt = firstBy(
    groups.flatMap((group) => group.trackingStartedAt ?? []),
    identity(),
  );
  const limits = limitsOf(project);

  return {
    ...limits,
    trackingStartedAt: trackingStartedAt ? new Date(trackingStartedAt) : null,
    monthStart: window.monthStart,
    nextMonthStart: window.nextMonthStart,
    monthRecordedUsd,
    totalRecordedUsd,
    inFlightUsd: totalPendingUsd - estimatedUsd,
    estimatedUsd,
    monthCommittedUsd,
    totalCommittedUsd,
    ...budgetState(limits, monthCommittedUsd, totalCommittedUsd),
    // All-time, so it decomposes totalRecordedUsd and estimatedUsd.
    featureBreakdown: sortBy(
      groups
        .filter((group) => group.totalRecordedUsd > 0 || group.estimatedUsd > 0)
        .map((group) => ({
          feature: group.feature,
          recordedUsd: group.totalRecordedUsd,
          estimatedUsd: group.estimatedUsd,
        })),
      [(row) => row.recordedUsd, "desc"],
    ),
  };
}

/** Newest first; a pending row past the cut-off has status "estimated". */
async function listRecentUsage(
  organizationId: string,
  projectId: string,
  page: { limit: number; offset: number },
) {
  const { staleBefore } = usageWindow(new Date()).iso;
  const rows = await repo.listProjectUsage(
    organizationId,
    projectId,
    pageInput.parse(page),
  );
  return rows.map((row) => withDerivedStatus(row, staleBefore));
}

/** Every project of the organization, archived included, in one grouped query. */
async function getOrganizationSummary(
  organizationId: string,
  now = new Date(),
) {
  const window = usageWindow(now);
  const rows = await repo.sumOrganizationUsageByProject(
    organizationId,
    window.iso,
  );
  return rows.map((row) => {
    const limits = limitsOf(row);
    const monthCommittedUsd = row.monthRecordedUsd + row.monthPendingUsd;
    const totalCommittedUsd = row.totalRecordedUsd + row.totalPendingUsd;
    return {
      projectId: row.projectId,
      name: row.name,
      archived: row.archivedAt !== null,
      ...limits,
      monthRecordedUsd: row.monthRecordedUsd,
      totalRecordedUsd: row.totalRecordedUsd,
      inFlightUsd: row.totalPendingUsd - row.estimatedUsd,
      estimatedUsd: row.estimatedUsd,
      ...budgetState(limits, monthCommittedUsd, totalCommittedUsd),
    };
  });
}

/**
 * Usage rows started in [from, to) across the organization's projects, oldest
 * first. `status` tells the amounts apart: "completed" rows carry a recorded
 * costUsd, "estimated" and "pending" rows only their estimatedCostUsd.
 */
async function listUsageForExport(
  organizationId: string,
  range: { from: Date; to: Date },
) {
  const { staleBefore } = usageWindow(new Date()).iso;
  const rows = await repo.listOrganizationUsage(organizationId, {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
  });
  return rows.map((row) => withDerivedStatus(row, staleBefore));
}

/**
 * Sets the limits and pause flag. Bumps reservationVersion in the same batch,
 * so on Postgres it waits for, and is waited on by, in-flight admissions.
 */
async function updateBudget(input: {
  organizationId: string;
  projectId: string;
  actorUserId: string;
  monthlyLimitUsd: number | null;
  totalLimitUsd: number | null;
  paused: boolean;
}): Promise<void> {
  const parsed = budgetInput.parse(input);
  await requireProjectBudget(parsed.organizationId, parsed.projectId);
  const now = new Date().toISOString();
  await runBatch((tx) => [
    repo.ensureBudget(tx, { ...parsed, now }),
    repo.updateBudget(tx, { ...parsed, now }),
  ]);
}

export const ProjectDataforseoBudgetService = {
  admit,
  settle,
  getProjectSummary,
  listRecentUsage,
  getOrganizationSummary,
  listUsageForExport,
  updateBudget,
};
