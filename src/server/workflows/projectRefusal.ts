import { isProjectDataforseoRefusal } from "@/server/lib/dataforseo/projectBudgetRefusal";
import { AppError, asAppError } from "@/server/lib/errors";

export type ProjectRefusalCode =
  | "PROJECT_BUDGET_EXCEEDED"
  | "PROJECT_DATAFORSEO_PAUSED";

/**
 * The project DataForSEO refusal a failed workflow step threw, or null. The
 * engine may hand a step's error back as a plain Error, its message prefixed
 * with the error's name, but a refusal's message is otherwise its bare code.
 *
 * Paid steps signal a refusal by throwing it rather than through their return
 * value, so their persisted outputs keep the shape that runs in flight across a
 * deploy replay.
 */
export function stepProjectRefusal(error: unknown): ProjectRefusalCode | null {
  const appError = asAppError(
    error instanceof Error && !(error instanceof AppError)
      ? new Error(error.message.replace(/^\w+: /, ""))
      : error,
  );
  return isProjectDataforseoRefusal(appError) ? appError.code : null;
}
