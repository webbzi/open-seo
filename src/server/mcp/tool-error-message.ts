import { AppError } from "@/server/lib/errors";

/**
 * Error text an agent sees for a failed tool call. An unknown area also tells
 * the agent how to find a valid one, a provider outage gets the same note
 * that it is the provider's problem, not the request's, and a self-hosted
 * project's spending refusal says why retrying won't help (a bare code tends
 * to make the agent retry).
 */
export function toolErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof AppError)) return message;
  if (error.code === "UNKNOWN_LOCATION")
    return `${message} Call search_serp_locations and pass the returned locationName exactly.`;
  if (error.code === "UPSTREAM_UNAVAILABLE")
    return `${message} The data provider is temporarily unavailable; this is not a problem with the request.`;
  if (error.code === "PROJECT_BUDGET_EXCEEDED")
    return "This project's DataForSEO allowance is too low for this request. Retrying the same request won't help until the limit is raised in the project's API spending settings or, for a monthly limit, the next UTC month starts. Cheaper operations may still fit, and saved and cached results remain available.";
  if (error.code === "PROJECT_DATAFORSEO_PAUSED")
    return "Paid DataForSEO usage is paused for this project. Retrying this or another paid operation won't help until paid usage resumes in the project's API spending settings. Saved and cached results remain available.";
  return message;
}
