import { ProjectDataforseoBudgetService } from "@/server/features/projects/services/ProjectDataforseoBudgetService";
import { AppError } from "@/server/lib/errors";

/**
 * Self-hosted: the refusal the project's DataForSEO budget would give a paid
 * call now, or null. A read, not an admission: it lets a run that would be
 * refused skip with its reason before any work starts. The metered client
 * still decides each call.
 */
export async function projectDataforseoRefusal(
  organizationId: string,
  projectId: string,
): Promise<AppError | null> {
  const { status } = await ProjectDataforseoBudgetService.getProjectSummary(
    organizationId,
    projectId,
  );
  if (status === "available") return null;
  // The bare code is the message, like the client's refusals, so it survives
  // a workflow step boundary.
  return new AppError(
    status === "paused"
      ? "PROJECT_DATAFORSEO_PAUSED"
      : "PROJECT_BUDGET_EXCEEDED",
  );
}
