import { AppError } from "@/server/lib/errors";

/**
 * A self-hosted project's DataForSEO budget refused a paid call before it was
 * sent: its limit is reached or its paid usage is paused. A leaf module, so
 * callers that only classify the error need not load the metered client.
 */
export function isProjectDataforseoRefusal(
  error: unknown,
): error is AppError & {
  code: "PROJECT_BUDGET_EXCEEDED" | "PROJECT_DATAFORSEO_PAUSED";
} {
  return (
    error instanceof AppError &&
    (error.code === "PROJECT_BUDGET_EXCEEDED" ||
      error.code === "PROJECT_DATAFORSEO_PAUSED")
  );
}
