import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireOrgPermission } from "@/server/auth/org-gate";
import {
  ProjectDataforseoBudgetService as budgets,
  usdLimit,
} from "@/server/features/projects/services/ProjectDataforseoBudgetService";
import { AppError } from "@/server/lib/errors";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import {
  requireAuthenticatedContext,
  requireProjectContext,
} from "@/serverFunctions/middleware";

// Self-hosted per-project DataForSEO spending: the project settings tab and
// the organization overview. Reads follow membership and project access;
// changing a client's limits and exporting its usage rows need the billing
// permission, the same one invoices and checkout use.

const RECENT_USAGE_PAGE_SIZE = 25;

/** Hosted deployments bill through Autumn credits; these surfaces do not exist there. */
async function requireSelfHosted() {
  if (await isHostedServerAuthMode()) throw new AppError("NOT_FOUND");
}

const projectScopedSchema = z.object({ projectId: z.string().min(1) });

export const getProjectDataforseoBudget = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    await requireSelfHosted();
    return budgets.getProjectSummary(context.organizationId, context.projectId);
  });

export const listProjectDataforseoUsage = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema.extend({ page: z.number().int().min(1) }))
  .handler(async ({ data, context }) => {
    await requireSelfHosted();
    // One extra row tells whether a next page exists without a count query.
    const rows = await budgets.listRecentUsage(
      context.organizationId,
      context.projectId,
      {
        limit: RECENT_USAGE_PAGE_SIZE + 1,
        offset: (data.page - 1) * RECENT_USAGE_PAGE_SIZE,
      },
    );
    return {
      rows: rows.slice(0, RECENT_USAGE_PAGE_SIZE),
      pageSize: RECENT_USAGE_PAGE_SIZE,
      hasNextPage: rows.length > RECENT_USAGE_PAGE_SIZE,
    };
  });

export const updateProjectDataforseoBudget = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    projectScopedSchema.extend({
      monthlyLimitUsd: usdLimit,
      totalLimitUsd: usdLimit,
      paused: z.boolean(),
    }),
  )
  .handler(async ({ data, context }) => {
    await requireSelfHosted();
    // Project edit access is not enough: limits are the client's agreement.
    requireOrgPermission(context, { billing: ["manage"] });
    await budgets.updateBudget({
      organizationId: context.organizationId,
      projectId: context.projectId,
      actorUserId: context.userId,
      monthlyLimitUsd: data.monthlyLimitUsd,
      totalLimitUsd: data.totalLimitUsd,
      paused: data.paused,
    });
  });

export const getOrganizationDataforseoSpending = createServerFn({
  method: "POST",
})
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) => {
    await requireSelfHosted();
    return budgets.getOrganizationSummary(context.organizationId);
  });

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole UTC days, `to` inclusive. */
const exportRangeSchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((range) => range.from <= range.to, {
    message: "The start date must not be after the end date.",
    path: ["from"],
  });

export const exportOrganizationDataforseoUsage = createServerFn({
  method: "POST",
})
  .middleware(requireAuthenticatedContext)
  .validator(exportRangeSchema)
  .handler(async ({ data, context }) => {
    await requireSelfHosted();
    requireOrgPermission(context, { billing: ["manage"] });
    return budgets.listUsageForExport(context.organizationId, {
      from: new Date(`${data.from}T00:00:00.000Z`),
      to: new Date(new Date(`${data.to}T00:00:00.000Z`).getTime() + DAY_MS),
    });
  });
